/**
 * Query specs for the 9 NYC OpenData proxy features.
 *
 * APPROXIMATION NOTICE. The pipeline buffers 50ft sample points along
 * each sidewalk segment and counts what falls inside those buffers
 * (dataset.ipynb + street_furniture.ipynb). The browser cannot run
 * those buffers. These specs approximate the 50ft point buffers with
 * the segment midpoint plus its two endpoints:
 * - point features use one circle around each of the 3 anchors;
 * - line and polygon features use the bounding box of the 3 anchors.
 * Live values therefore differ slightly from snapshot values. The UI
 * must say so wherever it shows live numbers.
 *
 * COORDINATE ORDER. WKT is lon-first. Socrata geospatial functions are
 * lat-first. The helpers in client.ts handle the swap. Do not build
 * geospatial SoQL by hand in this file.
 */

import type { Feature } from '../score/engine.ts';
import {
  SODAError,
  SodaClient,
  buildQuery,
  createDefaultCache,
  withinBox,
  withinCircle,
  type FetchImpl,
  type ResponseCache,
  type SodaRow,
} from './client.ts';
import {
  crashDateFilter,
  monthRangeFilter,
  type TimeWindowPreset,
} from './timeWindows.ts';
import {
  createQuotaGuard,
  type QuotaGuard,
} from './quotaGuard.ts';

/** A longitude/latitude pair in WGS84 degrees. */
export interface LonLat {
  lon: number;
  lat: number;
}

/** A sidewalk segment reduced to the 3 anchor points the live queries
 * can use: the midpoint and the two endpoints. */
export interface SegmentGeometry {
  midpoint: LonLat;
  endpoints: readonly [LonLat, LonLat];
}

/** One query against one dataset. */
export interface DatasetQuerySpec {
  dataset: string;
  description: string;
  buildQuery(segment: SegmentGeometry, preset?: TimeWindowPreset, now?: Date): URLSearchParams;
  mapResponse(rows: SodaRow[]): number;
}

/** The full spec for one proxy feature. A feature can span several
 * datasets (street furniture uses 13, traffic management uses 5). */
export interface FeatureSpec {
  feature: Feature;
  /** Primary dataset id. For multi-dataset features this is the first. */
  dataset: string;
  description: string;
  queries: DatasetQuerySpec[];
  buildQuery(segment: SegmentGeometry, preset?: TimeWindowPreset, now?: Date): URLSearchParams;
  mapResponse(rows: SodaRow[]): number;
  /** Merge one value per dataset query into the feature value. */
  combine(values: number[]): number;
}

export type ProxyFeature =
  | 'sidewalk_width'
  | 'street_furniture_density'
  | 'surface_condition'
  | 'curb_ramp_availability'
  | 'crowd_dynamics'
  | 'traffic_management'
  | 'bike_lane_availability'
  | 'intersection_safety'
  | 'zoning_laws';

// ---------------------------------------------------------------------
// Shared geometry helpers.
// ---------------------------------------------------------------------

/** 25 ft in meters. The pipeline clutter buffer radius. */
const FURNITURE_RADIUS_M = 7.62;
/** 50 ft in meters. The pipeline curb ramp and collision radius. */
const NEAR_SEGMENT_RADIUS_M = 15.24;

function anchors(segment: SegmentGeometry): LonLat[] {
  return [segment.midpoint, segment.endpoints[0], segment.endpoints[1]];
}

function segmentBounds(segment: SegmentGeometry): {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
} {
  const points = anchors(segment);
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  return {
    minLon: Math.min(...lons),
    minLat: Math.min(...lats),
    maxLon: Math.max(...lons),
    maxLat: Math.max(...lats),
  };
}

/** OR one circle per anchor around a geospatial column. */
function circlesWhere(col: string, segment: SegmentGeometry, radiusM: number): string {
  return anchors(segment)
    .map((point) => withinCircle(col, point.lon, point.lat, radiusM))
    .join(' or ');
}

/** Bounding box predicate over the 3 anchors. */
function boxWhere(col: string, segment: SegmentGeometry): string {
  const b = segmentBounds(segment);
  return withinBox(col, b.minLon, b.minLat, b.maxLon, b.maxLat);
}

const METERS_PER_DEGREE_LAT = 111_320;

/** Box predicate for datasets that expose plain lat/lon columns but no
 * geospatial column. A box approximates the circle here. */
function latLonWhere(
  latCol: string,
  lonCol: string,
  segment: SegmentGeometry,
  radiusM: number,
): string {
  return anchors(segment)
    .map((point) => {
      const dLat = radiusM / METERS_PER_DEGREE_LAT;
      const dLon = radiusM / (METERS_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180));
      return (
        `(${latCol} >= ${point.lat - dLat} and ${latCol} <= ${point.lat + dLat} and ` +
        `${lonCol} >= ${point.lon - dLon} and ${lonCol} <= ${point.lon + dLon})`
      );
    })
    .join(' or ');
}

function toFinite(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function countRows(rows: SodaRow[]): number {
  return rows.length;
}

// ---------------------------------------------------------------------
// sidewalk_width — NYC Planimetric Database: Sidewalk (52n9-sdep).
// ---------------------------------------------------------------------
// The pipeline derives width from sidewalk polygon centerlines
// (sidewalk_widths.py). The live client cannot run that algorithm.
// It approximates width as polygon area divided by perimeter length.
// The dataset exposes no street column (verified 2026-08-12: columns
// are the_geom, source_id, sub_code, feat_code, status, shape_leng,
// shape_area), so the spec queries by the segment bounding box.

const sidewalkWidthSpec: DatasetQuerySpec = {
  dataset: '52n9-sdep',
  description:
    'Sidewalk polygons near the segment. Width proxy = shape_area / shape_leng.',
  buildQuery(segment: SegmentGeometry): URLSearchParams {
    return buildQuery({
      where: boxWhere('the_geom', segment),
      select: 'shape_area, shape_leng',
    });
  },
  mapResponse(rows: SodaRow[]): number {
    const widths: number[] = [];
    for (const row of rows) {
      const area = toFinite(row['shape_area']);
      const length = toFinite(row['shape_leng']);
      if (area !== null && length !== null && length > 0) {
        widths.push(area / length);
      }
    }
    return mean(widths);
  },
};

// ---------------------------------------------------------------------
// street_furniture_density — 13 datasets.
// ---------------------------------------------------------------------
// Ids resolved from robotability-nyc/feature_processing/pull_data.sh
// (STREET CLUTTER section) and street_furniture.ipynb:
//   8znf-7b2c  DSNY Litter Basket Inventory
//   5bgh-vtsn  Hydrants
//   t4f2-8md7  Bus Stop Shelters
//   dimy-qyej  Bicycle Parking Shelters
//   yh4a-g3fj  Bicycle Racks
//   kuxa-tauh  City Bench Locations (Historical)
//   uvpi-gqnh  2015 Street Tree Census - Tree Data
//   w9zq-xm8b  Newsstands
//   693u-uax6  Parking Meters Locations and Status
//   s4kf-3yrf  LinkNYC Kiosk Locations
//   v57i-gtxb  In-Service Alarm Box Locations
//   qt6m-xctn  Street Sign Work Orders
//   sxx4-xhzg  Public Recycling Bins
// The 13th id: the notebook's own 13th clutter source is DoB active
// scaffolding permits, which pull_data.sh never lists. pull_data.sh's
// STREET CLUTTER section offers two more ids: sxx4-xhzg (recycling
// bins) and 3f5t-9dqu (bollards). The notebook rejects bollards for
// lack of coordinates, so this spec uses sxx4-xhzg as the 13th id.
// Geometry strategies differ per dataset and are documented inline.

function furnitureCircleSpec(dataset: string, col: string, description: string): DatasetQuerySpec {
  return {
    dataset,
    description,
    buildQuery(segment: SegmentGeometry): URLSearchParams {
      return buildQuery({ where: circlesWhere(col, segment, FURNITURE_RADIUS_M) });
    },
    mapResponse: countRows,
  };
}

const FURNITURE_LIMIT = 5000;

const streetFurnitureDatasets: DatasetQuerySpec[] = [
  furnitureCircleSpec('8znf-7b2c', 'point', 'DSNY litter baskets. Geospatial column `point`.'),
  furnitureCircleSpec('5bgh-vtsn', 'the_geom', 'Fire hydrants.'),
  furnitureCircleSpec('t4f2-8md7', 'the_geom', 'Bus stop shelters.'),
  furnitureCircleSpec('dimy-qyej', 'the_geom', 'Bicycle parking shelters.'),
  // Metadata returned 403 on 2026-08-12. The pipeline used the
  // geospatial export, so `the_geom` is the assumed column.
  furnitureCircleSpec('yh4a-g3fj', 'the_geom', 'Bicycle racks.'),
  furnitureCircleSpec('kuxa-tauh', 'the_geom', 'CityBench seats.'),
  {
    dataset: 'uvpi-gqnh',
    description:
      'Street trees. No geospatial column. Uses latitude/longitude range boxes.',
    buildQuery(segment: SegmentGeometry): URLSearchParams {
      return buildQuery({
        where: latLonWhere('latitude', 'longitude', segment, FURNITURE_RADIUS_M),
      });
    },
    mapResponse: countRows,
  },
  furnitureCircleSpec('w9zq-xm8b', 'the_geom', 'Newsstands.'),
  furnitureCircleSpec('693u-uax6', 'location', 'Parking meters. Geospatial column `location`.'),
  furnitureCircleSpec('s4kf-3yrf', 'location', 'LinkNYC kiosks. Geospatial column `location`.'),
  furnitureCircleSpec(
    'v57i-gtxb',
    'location_point',
    'In-service alarm boxes. Geospatial column `location_point`.',
  ),
  {
    // Street sign work orders carry State Plane coordinates only
    // (sign_x_coord, sign_y_coord). SoQL cannot spatial-filter them in
    // WGS84. The live query counts current records instead. This is a
    // documented approximation of the pipeline's spatial count.
    dataset: 'qt6m-xctn',
    description: 'Street sign work orders. No WGS84 geometry. Counts current records.',
    buildQuery(): URLSearchParams {
      return buildQuery({ where: "record_type = 'Current'", limit: FURNITURE_LIMIT });
    },
    mapResponse: countRows,
  },
  {
    // Public recycling bins expose no coordinates at all. The live
    // query caps the row count and treats it as a coarse proxy.
    dataset: 'sxx4-xhzg',
    description: 'Public recycling bins. No coordinates. Capped row count only.',
    buildQuery(): URLSearchParams {
      return buildQuery({ limit: FURNITURE_LIMIT });
    },
    mapResponse: countRows,
  },
];

// ---------------------------------------------------------------------
// surface_condition — Scorecard Ratings (rqhp-hivt).
// ---------------------------------------------------------------------
// The scorecard reports at community district granularity. The
// pipeline used the 'Acceptable Streets % - Previous Month' column
// (dataset.ipynb cell 57). The live Socrata field name for that
// column is `acceptable_streets_previous_month` (verified 2026-08-12).
// Socrata field names on this dataset are generated and can drift.
// The live caller should pass rows for the segment's community
// district. mapResponse averages the rows it receives.

const surfaceConditionSpec: DatasetQuerySpec = {
  dataset: 'rqhp-hivt',
  description: 'Sidewalk cleanliness scorecard by community district.',
  buildQuery(_segment: SegmentGeometry, preset?: TimeWindowPreset, now?: Date): URLSearchParams {
    const effectivePreset = preset ?? 'all';
    const where = monthRangeFilter(effectivePreset, now ?? new Date());
    return buildQuery({
      where: where === '' ? undefined : where,
      select: 'month, borough, community_board, acceptable_streets_previous_month',
    });
  },
  mapResponse(rows: SodaRow[]): number {
    const scores: number[] = [];
    for (const row of rows) {
      const value = toFinite(row['acceptable_streets_previous_month']);
      if (value !== null) {
        scores.push(value);
      }
    }
    return mean(scores);
  },
};

// ---------------------------------------------------------------------
// curb_ramp_availability — Pedestrian Ramp Locations (ufzp-rrqu).
// ---------------------------------------------------------------------
// Count of ramps in Good Condition within 50ft of the segment anchors.
// The pipeline filtered CURBRAMP_DWS_CONDITIONS == 'Good Condition'
// (dataset.ipynb cell 50). The Socrata column is `dws_conditions`.

const curbRampSpec: DatasetQuerySpec = {
  dataset: 'ufzp-rrqu',
  description: 'Curb ramps in Good Condition within 50ft of the segment.',
  buildQuery(segment: SegmentGeometry): URLSearchParams {
    return buildQuery({
      where: `(${circlesWhere('the_geom', segment, NEAR_SEGMENT_RADIUS_M)}) and dws_conditions = 'Good Condition'`,
    });
  },
  mapResponse: countRows,
};

// ---------------------------------------------------------------------
// crowd_dynamics — Zoning Districts (kdig-pewd).
// ---------------------------------------------------------------------
// Class map from score.ipynb cell 54: M -> 10, R -> 5, C -> 0,
// anything else -> 2. No zoning row -> 0.
// NOTE: this dataset returned 404 on 2026-08-12. NYC replaced it.
// The client raises SODAError and the live refresh degrades.

const ZONING_CLASS: Record<string, number> = { M: 10, R: 5, C: 0 };

const crowdDynamicsSpec: DatasetQuerySpec = {
  dataset: 'kdig-pewd',
  description: 'Zoning district class at the segment. M=10 R=5 C=0 else=2.',
  buildQuery(segment: SegmentGeometry): URLSearchParams {
    return buildQuery({ where: boxWhere('the_geom', segment) });
  },
  mapResponse(rows: SodaRow[]): number {
    const first = rows[0];
    if (!first) {
      return 0;
    }
    const zonedist = first['zonedist'];
    if (typeof zonedist !== 'string' || zonedist.length === 0) {
      return 0;
    }
    return ZONING_CLASS[zonedist.charAt(0).toUpperCase()] ?? 2;
  },
};

// ---------------------------------------------------------------------
// traffic_management — 5 Vision Zero datasets.
// ---------------------------------------------------------------------
// Ids and names from pull_data.sh:
//   79sh-heg3  VZV Street Improvement Projects (SIPs) Intersections
//   hz4p-9f7s  VZV Turn Traffic Calming
//   mqt5-ctec  VZV Leading Pedestrian Interval Signals
//   wqhs-q6wd  VZV Street Improvement Projects (SIPs) Corridor
//   8kuj-2n3u  Exclusive Pedestrian Signal (Barnes Dance) Locations
// The pipeline also adds an in_slow_zone term from the neighborhood
// slow zones dataset. The live spec follows the plan and sums these 5.
// The first four returned empty rows on 2026-08-12. The specs still
// query them. Empty results count as zero.

function trafficSpec(dataset: string, description: string): DatasetQuerySpec {
  return {
    dataset,
    description,
    buildQuery(segment: SegmentGeometry): URLSearchParams {
      return buildQuery({ where: boxWhere('the_geom', segment) });
    },
    mapResponse: countRows,
  };
}

const trafficManagementDatasets: DatasetQuerySpec[] = [
  trafficSpec('79sh-heg3', 'VZV Street Improvement Project intersections near the segment.'),
  trafficSpec('hz4p-9f7s', 'VZV turn traffic calming near the segment.'),
  trafficSpec('mqt5-ctec', 'VZV leading pedestrian interval signals near the segment.'),
  trafficSpec('wqhs-q6wd', 'VZV Street Improvement Project corridors near the segment.'),
  trafficSpec('8kuj-2n3u', 'Barnes Dance pedestrian signal locations near the segment.'),
];

// ---------------------------------------------------------------------
// bike_lane_availability — New York City Bike Routes (mzxg-pwib).
// ---------------------------------------------------------------------
// Facility class map from dataset.ipynb cell 93: L=0.5 I=1 II=2 III=3.
// The live spec takes the MAX class near the segment. The pipeline
// averaged within 50ft. The plan mandates the max. Take the max.

const FACILITY_CLASS: Record<string, number> = { L: 0.5, I: 1, II: 2, III: 3 };

const bikeLaneSpec: DatasetQuerySpec = {
  dataset: 'mzxg-pwib',
  description: 'Highest bike lane facility class near the segment.',
  buildQuery(segment: SegmentGeometry): URLSearchParams {
    return buildQuery({
      where: `status = 'Current' and ${boxWhere('the_geom', segment)}`,
    });
  },
  mapResponse(rows: SodaRow[]): number {
    let best = 0;
    for (const row of rows) {
      const facility = row['facilitycl'];
      if (typeof facility === 'string') {
        const value = FACILITY_CLASS[facility];
        if (value !== undefined && value > best) {
          best = value;
        }
      }
    }
    return best;
  },
};

// ---------------------------------------------------------------------
// intersection_safety — Motor Vehicle Collisions (h9gi-nx95).
// ---------------------------------------------------------------------
// Pedestrians injured plus killed within 50ft of the segment anchors.
// Supports the crash_date time window.

const intersectionSafetySpec: DatasetQuerySpec = {
  dataset: 'h9gi-nx95',
  description: 'Pedestrians injured plus killed in collisions within 50ft.',
  buildQuery(segment: SegmentGeometry, preset?: TimeWindowPreset, now?: Date): URLSearchParams {
    let where = `(${circlesWhere('location', segment, NEAR_SEGMENT_RADIUS_M)})`;
    const windowFilter = crashDateFilter(preset ?? 'all', now ?? new Date());
    if (windowFilter !== '') {
      where = `${where} and ${windowFilter}`;
    }
    return buildQuery({
      where,
      select: 'number_of_pedestrians_injured, number_of_pedestrians_killed',
    });
  },
  mapResponse(rows: SodaRow[]): number {
    let total = 0;
    for (const row of rows) {
      total += toFinite(row['number_of_pedestrians_injured']) ?? 0;
      total += toFinite(row['number_of_pedestrians_killed']) ?? 0;
    }
    return total;
  },
};

// ---------------------------------------------------------------------
// zoning_laws — VZV Speed Limits (5mad-ntua).
// ---------------------------------------------------------------------
// The pipeline read dot_VZV_Speed_Limits and averaged postvz_sl within
// 50ft (dataset.ipynb cell 71-72). pull_data.sh never lists this
// dataset. The id 5mad-ntua is resolved by dataset.ipynb cell 71 and
// pipeline/cluster/fetch_public.py (T5). Verified live on 2026-08-12.

const zoningLawsSpec: DatasetQuerySpec = {
  dataset: '5mad-ntua',
  description: 'Average posted speed limit near the segment.',
  buildQuery(segment: SegmentGeometry): URLSearchParams {
    return buildQuery({
      where: boxWhere('the_geom', segment),
      select: 'postvz_sl',
    });
  },
  mapResponse(rows: SodaRow[]): number {
    const limits: number[] = [];
    for (const row of rows) {
      const value = toFinite(row['postvz_sl']);
      if (value !== null) {
        limits.push(value);
      }
    }
    return mean(limits);
  },
};

// ---------------------------------------------------------------------
// Feature spec assembly.
// ---------------------------------------------------------------------

function assembleSpec(
  feature: ProxyFeature,
  description: string,
  queries: DatasetQuerySpec[],
): FeatureSpec {
  const first = queries[0];
  return {
    feature,
    dataset: first.dataset,
    description,
    queries,
    buildQuery: (segment, preset, now) => first.buildQuery(segment, preset, now),
    mapResponse: (rows) => first.mapResponse(rows),
    combine: sum,
  };
}

/** The 13 street furniture dataset specs. Exported for tests and for
 * the live refresh batching in src/lib/live (T10). */
export const FURNITURE_DATASETS: DatasetQuerySpec[] = streetFurnitureDatasets;

/** The 5 traffic management dataset specs. */
export const TRAFFIC_DATASETS: DatasetQuerySpec[] = trafficManagementDatasets;

/** One query spec per proxy feature. */
export const PROXY_FEATURES: Record<ProxyFeature, FeatureSpec> = {
  sidewalk_width: assembleSpec(
    'sidewalk_width',
    'Sidewalk width proxy from sidewalk polygon area and length.',
    [sidewalkWidthSpec],
  ),
  street_furniture_density: assembleSpec(
    'street_furniture_density',
    'Street furniture count within 25ft of the segment anchors.',
    streetFurnitureDatasets,
  ),
  surface_condition: assembleSpec(
    'surface_condition',
    'Sidewalk cleanliness scorecard percentage for the district.',
    [surfaceConditionSpec],
  ),
  curb_ramp_availability: assembleSpec(
    'curb_ramp_availability',
    'Curb ramps in Good Condition within 50ft.',
    [curbRampSpec],
  ),
  crowd_dynamics: assembleSpec(
    'crowd_dynamics',
    'Zoning district class at the segment.',
    [crowdDynamicsSpec],
  ),
  traffic_management: assembleSpec(
    'traffic_management',
    'Vision Zero traffic management measures near the segment.',
    trafficManagementDatasets,
  ),
  bike_lane_availability: assembleSpec(
    'bike_lane_availability',
    'Highest bike lane facility class near the segment.',
    [bikeLaneSpec],
  ),
  intersection_safety: assembleSpec(
    'intersection_safety',
    'Pedestrians injured plus killed in nearby collisions.',
    [intersectionSafetySpec],
  ),
  zoning_laws: assembleSpec(
    'zoning_laws',
    'Average posted speed limit near the segment.',
    [zoningLawsSpec],
  ),
};

// ---------------------------------------------------------------------
// Facade: run one feature spec through the quota guard.
// ---------------------------------------------------------------------

export interface FetchFeatureOptions {
  /** Injectable fetch. Defaults to globalThis.fetch via SodaClient. */
  fetchImpl?: FetchImpl;
  /** Injectable response cache. Defaults to the environment cache. */
  cache?: ResponseCache;
  /** Injectable quota guard. Defaults to a fresh guard. */
  guard?: QuotaGuard;
  /** Time window preset for the two time-aware features. */
  window?: TimeWindowPreset;
  /** Injectable clock for time windows. Defaults to the current date. */
  now?: Date;
}

/**
 * Fetch every dataset of one feature spec and combine the values.
 *
 * The guard sees every network fetch:
 * - canRequest() runs before each fetch. A blocked guard throws a
 *   SODAError and no fetch happens.
 * - recordRequest() runs for every fetch, including 304 and 429.
 * - notify429() runs when any dataset answers 429. The guard then
 *   blocks later calls until the backoff expires.
 */
export async function fetchFeature(
  spec: FeatureSpec,
  segment: SegmentGeometry,
  options: FetchFeatureOptions = {},
): Promise<number> {
  const guard = options.guard ?? createQuotaGuard();
  const client = new SodaClient({
    fetchImpl: options.fetchImpl,
    cache: options.cache ?? createDefaultCache(),
  });
  const values: number[] = [];
  for (const query of spec.queries) {
    if (!guard.canRequest()) {
      throw new SODAError(
        query.dataset,
        undefined,
        `quota guard blocks the request for dataset ${query.dataset}`,
      );
    }
    guard.recordRequest();
    try {
      const rows = await client.query(
        query.dataset,
        query.buildQuery(segment, options.window, options.now),
      );
      values.push(query.mapResponse(rows));
    } catch (error) {
      if (error instanceof SODAError && error.status === 429) {
        guard.notify429();
      }
      throw error;
    }
  }
  return spec.combine(values);
}
