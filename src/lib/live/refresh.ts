/**
 * Live refresh orchestrator.
 *
 * Recomputes Robotability scores for the viewport segments from live
 * NYC OpenData queries (T7) plus the CitiBike GBFS feed. Pure logic
 * with injectable dependencies. No test needs a real network.
 *
 * Design rules:
 * - ONE query per dataset across all segment anchors. The spatial
 *   predicates of the anchors are OR-combined. Never one query per
 *   segment.
 * - Live recomputation uses ONLY the live features: the 9 proxy
 *   features and charging_station_proximity (CitiBike). Every other
 *   feature comes from the snapshot parquet row of the segment. A
 *   segment without a parquet row gets no live score. The refresh
 *   marks it unavailable instead of inventing values.
 * - Normalization uses the feature_stats of the ACTIVE snapshot entry.
 * - Results are never persisted. They live in memory only.
 */

import {
  SODAError,
  withinBox,
  withinCircle,
  type FetchImpl,
  type SodaClient,
  type SodaRow,
} from '../soda/client.ts';
import {
  PROXY_FEATURES,
  type DatasetQuerySpec,
  type LonLat,
  type ProxyFeature,
} from '../soda/features.ts';
import {
  chargingProximity,
  fetchStations,
  haversineMeters,
  type GbfsStation,
} from '../soda/citibike.ts';
import {
  crashDateFilter,
  monthRangeFilter,
  type TimeWindowPreset,
} from '../soda/timeWindows.ts';
import type { QuotaGuard } from '../soda/quotaGuard.ts';
import { computeScore, type Feature, type FeatureStats } from '../score/engine.ts';
import { FEATURES } from '../score/weights.ts';

// A viewport bounding box in WGS84 degrees.
export type BBox = {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
};

// The live refresh area cap in square kilometers. Viewports above this
// size show the zoom-in sentence and send zero requests.
export const LIVE_AREA_CAP_KM2 = 8;

// Area of a bbox in square kilometers. The sides come from haversine
// distances along the south edge and the west edge. The box is small
// enough that the flat product is accurate.
export function bboxAreaKm2(bbox: BBox): number {
  const widthM = haversineMeters(
    { lon: bbox.minLon, lat: bbox.minLat },
    { lon: bbox.maxLon, lat: bbox.minLat },
  );
  const heightM = haversineMeters(
    { lon: bbox.minLon, lat: bbox.minLat },
    { lon: bbox.minLon, lat: bbox.maxLat },
  );
  return (widthM * heightM) / 1_000_000;
}

// One segment anchor for the live refresh. The midpoint comes from the
// rendered map feature. The snapshot score is the tile score the map
// shows before the refresh.
export type SegmentAnchor = {
  readonly id: number;
  readonly midpoint: LonLat;
  readonly snapshotScore: number;
};

// One parquet row from the snapshot feature table. Keys are column
// names. Values are numbers. segment_id travels as a number.
export type SnapshotFeatureRow = Record<string, number>;

// Max anchors per batched query set. Each anchor adds one spatial
// clause to every dataset query, so the query URL grows with the
// anchor count. The cap keeps every URL under the Socrata URL length
// limit and bounds the nearest-anchor row assignment work. Anchor
// lists past the cap split into batches. Each batch still sends one
// query per dataset. One full refresh costs 26 requests (25 SODA
// datasets + 1 GBFS feed). The quota budget is 40 requests per rolling
// hour (quotaGuard.ts), so one refresh always fits with headroom.
export const MAX_SEGMENTS_PER_BATCH = 150;

// One planned SODA query. The params carry the OR-combined predicates.
export type PlannedQuery = {
  readonly dataset: string;
  readonly params: URLSearchParams;
};

// One batch of anchors with one query per dataset.
export type PlanBatch = {
  readonly segmentIds: readonly number[];
  readonly queries: readonly PlannedQuery[];
};

// ---------------------------------------------------------------------
// Batched query planning.
// ---------------------------------------------------------------------

// The spatial strategy of one dataset query. The table mirrors the
// per-segment strategies in src/lib/soda/features.ts. The live refresh
// rebuilds them for many anchors at once:
// - circle: one within_circle per anchor, OR-combined;
// - box: one within_box over the union of the anchor bounds;
// - latlon: one latitude/longitude box per anchor, OR-combined;
// - global: no spatial predicate (district or citywide datasets).
type DatasetStrategy =
  | {
      readonly kind: 'circle';
      readonly dataset: string;
      readonly feature: ProxyFeature;
      readonly col: string;
      readonly radiusM: number;
      readonly andSuffix?: string;
      readonly timeFilter?: 'crash';
      readonly select?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'box';
      readonly dataset: string;
      readonly feature: ProxyFeature;
      readonly col: string;
      readonly wherePrefix?: string;
      readonly select?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'latlon';
      readonly dataset: string;
      readonly feature: ProxyFeature;
      readonly latCol: string;
      readonly lonCol: string;
      readonly radiusM: number;
      readonly select?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'global';
      readonly dataset: string;
      readonly feature: ProxyFeature;
      readonly where?: string;
      readonly select?: string;
      readonly limit?: number;
      readonly timeFilter?: 'month';
    };

// 25 ft in meters. The pipeline clutter buffer radius.
const FURNITURE_RADIUS_M = 7.62;
// 50 ft in meters. The pipeline curb ramp and collision radius.
const NEAR_SEGMENT_RADIUS_M = 15.24;
// One degree of latitude in meters. Mirrors features.ts.
const METERS_PER_DEGREE_LAT = 111_320;
// The row cap features.ts uses for the coordinate-free datasets.
const GLOBAL_ROW_LIMIT = 5000;

// The full strategy table. Provenance: the matching spec blocks in
// src/lib/soda/features.ts, named per entry.
const DATASET_STRATEGIES: readonly DatasetStrategy[] = [
  // sidewalk_width. features.ts sidewalkWidthSpec.
  {
    kind: 'box',
    dataset: '52n9-sdep',
    feature: 'sidewalk_width',
    col: 'the_geom',
    select: 'shape_area, shape_leng',
  },
  // street_furniture_density. features.ts furnitureCircleSpec entries.
  { kind: 'circle', dataset: '8znf-7b2c', feature: 'street_furniture_density', col: 'point', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: '5bgh-vtsn', feature: 'street_furniture_density', col: 'the_geom', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 't4f2-8md7', feature: 'street_furniture_density', col: 'the_geom', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 'dimy-qyej', feature: 'street_furniture_density', col: 'the_geom', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 'yh4a-g3fj', feature: 'street_furniture_density', col: 'the_geom', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 'kuxa-tauh', feature: 'street_furniture_density', col: 'the_geom', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 'w9zq-xm8b', feature: 'street_furniture_density', col: 'the_geom', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: '693u-uax6', feature: 'street_furniture_density', col: 'location', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 's4kf-3yrf', feature: 'street_furniture_density', col: 'location', radiusM: FURNITURE_RADIUS_M },
  { kind: 'circle', dataset: 'v57i-gtxb', feature: 'street_furniture_density', col: 'location_point', radiusM: FURNITURE_RADIUS_M },
  // street_furniture_density. features.ts street tree lat/lon boxes.
  {
    kind: 'latlon',
    dataset: 'uvpi-gqnh',
    feature: 'street_furniture_density',
    latCol: 'latitude',
    lonCol: 'longitude',
    radiusM: FURNITURE_RADIUS_M,
  },
  // street_furniture_density. features.ts coordinate-free datasets.
  {
    kind: 'global',
    dataset: 'qt6m-xctn',
    feature: 'street_furniture_density',
    where: "record_type = 'Current'",
    limit: GLOBAL_ROW_LIMIT,
  },
  {
    kind: 'global',
    dataset: 'sxx4-xhzg',
    feature: 'street_furniture_density',
    limit: GLOBAL_ROW_LIMIT,
  },
  // surface_condition. features.ts surfaceConditionSpec. The month
  // window filter applies here (timeWindows.ts monthRangeFilter).
  {
    kind: 'global',
    dataset: 'rqhp-hivt',
    feature: 'surface_condition',
    select: 'month, borough, community_board, acceptable_streets_previous_month',
    timeFilter: 'month',
  },
  // curb_ramp_availability. features.ts curbRampSpec.
  {
    kind: 'circle',
    dataset: 'ufzp-rrqu',
    feature: 'curb_ramp_availability',
    col: 'the_geom',
    radiusM: NEAR_SEGMENT_RADIUS_M,
    andSuffix: "dws_conditions = 'Good Condition'",
  },
  // crowd_dynamics. features.ts crowdDynamicsSpec.
  { kind: 'box', dataset: 'kdig-pewd', feature: 'crowd_dynamics', col: 'the_geom' },
  // traffic_management. features.ts trafficSpec entries.
  { kind: 'box', dataset: '79sh-heg3', feature: 'traffic_management', col: 'the_geom' },
  { kind: 'box', dataset: 'hz4p-9f7s', feature: 'traffic_management', col: 'the_geom' },
  { kind: 'box', dataset: 'mqt5-ctec', feature: 'traffic_management', col: 'the_geom' },
  { kind: 'box', dataset: 'wqhs-q6wd', feature: 'traffic_management', col: 'the_geom' },
  { kind: 'box', dataset: '8kuj-2n3u', feature: 'traffic_management', col: 'the_geom' },
  // bike_lane_availability. features.ts bikeLaneSpec.
  {
    kind: 'box',
    dataset: 'mzxg-pwib',
    feature: 'bike_lane_availability',
    col: 'the_geom',
    wherePrefix: "status = 'Current' and",
  },
  // intersection_safety. features.ts intersectionSafetySpec. The
  // crash_date window filter applies here (timeWindows.ts
  // crashDateFilter).
  {
    kind: 'circle',
    dataset: 'h9gi-nx95',
    feature: 'intersection_safety',
    col: 'location',
    radiusM: NEAR_SEGMENT_RADIUS_M,
    timeFilter: 'crash',
    select: 'number_of_pedestrians_injured, number_of_pedestrians_killed',
  },
  // zoning_laws. features.ts zoningLawsSpec.
  {
    kind: 'box',
    dataset: '5mad-ntua',
    feature: 'zoning_laws',
    col: 'the_geom',
    select: 'postvz_sl',
  },
];

// Union bounds of all anchors.
function unionBounds(anchors: readonly LonLat[]): BBox {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const point of anchors) {
    if (point.lon < minLon) minLon = point.lon;
    if (point.lat < minLat) minLat = point.lat;
    if (point.lon > maxLon) maxLon = point.lon;
    if (point.lat > maxLat) maxLat = point.lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

// One latitude/longitude range box clause. Mirrors latLonWhere in
// features.ts for datasets without a geospatial column.
function latLonBoxClause(
  latCol: string,
  lonCol: string,
  point: LonLat,
  radiusM: number,
): string {
  const dLat = radiusM / METERS_PER_DEGREE_LAT;
  const dLon = radiusM / (METERS_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180));
  return (
    `(${latCol} >= ${point.lat - dLat} and ${latCol} <= ${point.lat + dLat} and ` +
    `${lonCol} >= ${point.lon - dLon} and ${lonCol} <= ${point.lon + dLon})`
  );
}

// Build one planned query for one dataset over all batch anchors.
function buildPlannedQuery(
  strategy: DatasetStrategy,
  anchors: readonly LonLat[],
  preset: TimeWindowPreset,
  now: Date,
): PlannedQuery {
  const params = new URLSearchParams();
  let where: string | undefined;
  if (strategy.kind === 'circle') {
    const circles = anchors.map((point) =>
      withinCircle(strategy.col, point.lon, point.lat, strategy.radiusM),
    );
    where = circles.join(' or ');
    if (strategy.andSuffix !== undefined) {
      where = `(${where}) and ${strategy.andSuffix}`;
    }
    if (strategy.timeFilter === 'crash') {
      const filter = crashDateFilter(preset, now);
      if (filter !== '') {
        where = `${where} and ${filter}`;
      }
    }
  } else if (strategy.kind === 'box') {
    const bounds = unionBounds(anchors);
    where = withinBox(strategy.col, bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat);
    if (strategy.wherePrefix !== undefined) {
      where = `${strategy.wherePrefix} ${where}`;
    }
  } else if (strategy.kind === 'latlon') {
    const clauses = anchors.map((point) =>
      latLonBoxClause(strategy.latCol, strategy.lonCol, point, strategy.radiusM),
    );
    where = clauses.join(' or ');
  } else {
    where = strategy.where;
    if (strategy.timeFilter === 'month') {
      const filter = monthRangeFilter(preset, now);
      where = filter === '' ? undefined : filter;
    }
  }
  if (where !== undefined) {
    params.set('$where', where);
  }
  if (strategy.select !== undefined) {
    params.set('$select', strategy.select);
  }
  if (strategy.limit !== undefined) {
    params.set('$limit', String(strategy.limit));
  }
  return { dataset: strategy.dataset, params };
}

// Plan the batched live queries. One query per dataset per batch.
// Anchor lists past MAX_SEGMENTS_PER_BATCH split into extra batches.
export function planLiveRefresh(
  segments: readonly SegmentAnchor[],
  preset: TimeWindowPreset,
  now: Date = new Date(),
): PlanBatch[] {
  const batches: PlanBatch[] = [];
  for (let start = 0; start < segments.length; start += MAX_SEGMENTS_PER_BATCH) {
    const slice = segments.slice(start, start + MAX_SEGMENTS_PER_BATCH);
    const anchors = slice.map((segment) => segment.midpoint);
    const queries = DATASET_STRATEGIES.map((strategy) =>
      buildPlannedQuery(strategy, anchors, preset, now),
    );
    batches.push({ segmentIds: slice.map((segment) => segment.id), queries });
  }
  return batches;
}

// ---------------------------------------------------------------------
// Response mapping.
// ---------------------------------------------------------------------

// Dataset id to its T7 query spec. The mapResponse and combine
// functions come straight from features.ts.
const DATASET_QUERY_LOOKUP: ReadonlyMap<string, DatasetQuerySpec> = new Map(
  Object.values(PROXY_FEATURES).flatMap((spec) =>
    spec.queries.map((query): [string, DatasetQuerySpec] => [query.dataset, query]),
  ),
);

// Columns that can carry a GeoJSON-like geometry object in a SODA JSON
// response. The names match the geospatial columns in features.ts.
const GEO_OBJECT_COLUMNS = ['the_geom', 'point', 'location', 'location_point'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Pull the first lon/lat position out of a GeoJSON-like coordinates
// value. Point shapes return their position. Other shapes return the
// first position. The assignment only needs an approximate anchor.
function extractPosition(value: unknown): LonLat | null {
  if (!Array.isArray(value)) return null;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return { lon: value[0], lat: value[1] };
  }
  for (const item of value) {
    const nested = extractPosition(item);
    if (nested !== null) return nested;
  }
  return null;
}

// The position of one response row, or null when the row exposes none.
// Plain latitude/longitude columns win. A geometry object column is the
// fallback. Socrata returns geospatial columns as objects in JSON.
function rowPosition(row: SodaRow): LonLat | null {
  const view: Record<string, unknown> = row;
  const lat = toFiniteNumber(view['latitude'] ?? view['lat']);
  const lon = toFiniteNumber(view['longitude'] ?? view['lon']);
  if (lat !== null && lon !== null) {
    return { lon, lat };
  }
  for (const col of GEO_OBJECT_COLUMNS) {
    const geo = view[col];
    if (!isRecord(geo)) continue;
    const position = extractPosition(geo['coordinates']);
    if (position !== null) return position;
  }
  return null;
}

// Assign response rows to segment buckets. A row with a position goes
// to the nearest segment midpoint. A row without a position applies to
// every segment in the batch (district and citywide datasets).
function assignDatasetRows(
  rows: readonly SodaRow[],
  segments: readonly SegmentAnchor[],
): Map<number, SodaRow[]> {
  const buckets = new Map<number, SodaRow[]>();
  for (const segment of segments) {
    buckets.set(segment.id, []);
  }
  for (const row of rows) {
    const position = rowPosition(row);
    if (position === null) {
      for (const bucket of buckets.values()) {
        bucket.push(row);
      }
      continue;
    }
    let bestId: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const segment of segments) {
      const distance = haversineMeters(position, segment.midpoint);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = segment.id;
      }
    }
    if (bestId !== null) {
      buckets.get(bestId)?.push(row);
    }
  }
  return buckets;
}

// ---------------------------------------------------------------------
// Score assembly.
// ---------------------------------------------------------------------

// The live features. The 9 proxy features come from the SODA queries.
// charging_station_proximity comes from the CitiBike GBFS feed.
function isProxyFeature(feature: Feature): feature is ProxyFeature {
  return Object.prototype.hasOwnProperty.call(PROXY_FEATURES, feature);
}

// Convert a manifest feature_stats object into the engine stats shape.
// Returns null when any of the 19 features lacks a finite min/max.
export function toFeatureStats(
  raw: Record<string, { min: number; max: number }> | undefined,
): Record<Feature, FeatureStats> | null {
  if (!raw) return null;
  const stats: { [K in Feature]?: FeatureStats } = {};
  for (const feature of FEATURES) {
    const entry = raw[feature];
    if (
      !entry ||
      typeof entry.min !== 'number' ||
      typeof entry.max !== 'number' ||
      !Number.isFinite(entry.min) ||
      !Number.isFinite(entry.max)
    ) {
      return null;
    }
    stats[feature] = { min: entry.min, max: entry.max };
  }
  return stats as Record<Feature, FeatureStats>;
}

// Invert the min-max normalization for one parquet cell. The engine
// normalizes raw values with the snapshot stats. The parquet stores
// normalized values, so the refresh feeds the engine the raw value
// that normalizes back to the stored number. Degenerate windows
// (max == min) always normalize to 0.5 inside the engine. That is a
// documented approximation for constant features.
function denormalize(normalized: number, stat: FeatureStats): number {
  return normalized * (stat.max - stat.min) + stat.min;
}

// The per-segment result of one live refresh.
export type LiveSegmentResult =
  | {
      readonly id: number;
      readonly status: 'scored';
      readonly snapshotScore: number;
      readonly liveScore: number;
      readonly delta: number;
    }
  | { readonly id: number; readonly status: 'unavailable' };

// The outcome of one live refresh run.
// - disabled: the quota guard blocked the run, or a dataset answered
//   429. The UI shows the disabled sentence.
// - error: a network or parse failure. The message is safe to show.
// - ok: per-segment results. Segments without a parquet row are
//   unavailable because the non-live features have no source.
export type LiveRefreshResult =
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ok'; readonly results: readonly LiveSegmentResult[] };

export type RunLiveRefreshOptions = {
  readonly client: SodaClient;
  readonly guard: QuotaGuard;
  // The feature_stats of the ACTIVE snapshot entry. The engine
  // normalizes the live raw values with these windows.
  readonly stats: Record<Feature, FeatureStats>;
  readonly segments: readonly SegmentAnchor[];
  // The time window preset. It applies only to intersection_safety
  // (crash_date) and surface_condition (month). The other dataset
  // strategies ignore it. See the two timeFilter entries in
  // DATASET_STRATEGIES above.
  readonly window: TimeWindowPreset;
  // Fetch for the CitiBike GBFS feed. Defaults to globalThis.fetch.
  readonly fetchImpl?: FetchImpl;
  // The parquet rows of the active snapshot. Segments without a row
  // come back unavailable.
  readonly parquetRows?: readonly SnapshotFeatureRow[] | null;
  // Injectable clock for the time windows. Tests must inject.
  readonly now?: Date;
};

// Run one live refresh. The guard sees every network request. The
// results are returned, never persisted.
export async function runLiveRefresh(
  options: RunLiveRefreshOptions,
): Promise<LiveRefreshResult> {
  const { client, guard, stats, segments, fetchImpl } = options;
  const preset = options.window;
  const now = options.now ?? new Date();

  if (segments.length === 0) {
    return { status: 'ok', results: [] };
  }
  // The guard gates the whole run. A blocked guard sends zero requests.
  if (!guard.canRequest()) {
    return { status: 'disabled' };
  }

  const parquetById = new Map<number, SnapshotFeatureRow>();
  for (const row of options.parquetRows ?? []) {
    const id = row['segment_id'];
    if (typeof id === 'number' && Number.isFinite(id)) {
      parquetById.set(id, row);
    }
  }

  const plan = planLiveRefresh(segments, preset, now);
  const rowsByDataset = new Map<string, SodaRow[]>();
  let stations: GbfsStation[];

  try {
    for (const batch of plan) {
      for (const query of batch.queries) {
        if (!guard.canRequest()) {
          return { status: 'disabled' };
        }
        guard.recordRequest();
        const rows = await client.query(query.dataset, query.params);
        const bucket = rowsByDataset.get(query.dataset) ?? [];
        rowsByDataset.set(query.dataset, bucket.concat(rows));
      }
    }
    if (!guard.canRequest()) {
      return { status: 'disabled' };
    }
    guard.recordRequest();
    stations = await fetchStations({ fetchImpl });
  } catch (error) {
    if (error instanceof SODAError && error.status === 429) {
      guard.notify429();
      return { status: 'disabled' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message };
  }

  // Assign every dataset response to the segment buckets once.
  const assignments = new Map<string, Map<number, SodaRow[]>>();
  for (const [dataset, rows] of rowsByDataset) {
    assignments.set(dataset, assignDatasetRows(rows, segments));
  }

  // CitiBike proximity aligns with the segments array by index.
  const proximity = chargingValues(stations, segments);

  const results: LiveSegmentResult[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const parquetRow = parquetById.get(segment.id);
    if (!parquetRow) {
      // No parquet row: the non-live features have no source. The
      // refresh refuses to invent them.
      results.push({ id: segment.id, status: 'unavailable' });
      continue;
    }
    const values: { [K in Feature]?: number } = {};
    let complete = true;
    for (const feature of FEATURES) {
      if (isProxyFeature(feature)) {
        const spec = PROXY_FEATURES[feature];
        const parts: number[] = [];
        for (const query of spec.queries) {
          const rows = assignments.get(query.dataset)?.get(segment.id) ?? [];
          parts.push(query.mapResponse(rows));
        }
        values[feature] = spec.combine(parts);
      } else if (feature === 'charging_station_proximity') {
        values[feature] = proximity[index];
      } else {
        const cell = parquetRow[feature];
        if (typeof cell !== 'number' || !Number.isFinite(cell)) {
          complete = false;
          break;
        }
        values[feature] = denormalize(cell, stats[feature]);
      }
    }
    if (!complete) {
      results.push({ id: segment.id, status: 'unavailable' });
      continue;
    }
    const liveScore = computeScore(values as Record<Feature, number>, stats);
    results.push({
      id: segment.id,
      status: 'scored',
      snapshotScore: segment.snapshotScore,
      liveScore,
      delta: liveScore - segment.snapshotScore,
    });
  }
  return { status: 'ok', results };
}

// CitiBike charging proximity per segment. The values align with the
// segments array by index.
function chargingValues(
  stations: readonly GbfsStation[],
  segments: readonly SegmentAnchor[],
): number[] {
  const stationList: GbfsStation[] = [...stations];
  return chargingProximity(stationList, segments.map((segment) => segment.midpoint));
}
