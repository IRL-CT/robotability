/**
 * Vitest suite for the live refresh orchestrator (src/lib/live/refresh.ts).
 *
 * Every network call goes through an injected fetchImpl. The quota guard
 * and the clock are injected too. No test touches the real network.
 */

import { describe, expect, it } from 'vitest';

import {
  bboxAreaKm2,
  planLiveRefresh,
  runLiveRefresh,
  MAX_SEGMENTS_PER_BATCH,
  LIVE_AREA_CAP_KM2,
  type BBox,
  type SegmentAnchor,
  type SnapshotFeatureRow,
} from './refresh.ts';
import { SodaClient, MemoryCache, type FetchImpl } from '../soda/client.ts';
import {
  createQuotaGuard,
  MemoryQuotaStorage,
  type QuotaGuard,
} from '../soda/quotaGuard.ts';
import { WEIGHTS, FEATURES, type Feature } from '../score/weights.ts';
import { POLARITIES } from '../score/polarities.ts';
import type { FeatureStats } from '../score/engine.ts';

// Fixed clock for the time-window filters. 2026-03-01T00:00:00Z.
const NOW = new Date(Date.UTC(2026, 2, 1));

// One segment anchor in Queens. The canned rows sit on this midpoint.
const MIDPOINT = { lon: -73.89, lat: 40.73 };

// The 25 SODA dataset ids the live refresh queries. One query each.
const SODA_DATASETS = [
  '52n9-sdep',
  '8znf-7b2c',
  '5bgh-vtsn',
  't4f2-8md7',
  'dimy-qyej',
  'yh4a-g3fj',
  'kuxa-tauh',
  'uvpi-gqnh',
  'w9zq-xm8b',
  '693u-uax6',
  's4kf-3yrf',
  'v57i-gtxb',
  'qt6m-xctn',
  'sxx4-xhzg',
  'rqhp-hivt',
  'ufzp-rrqu',
  'kdig-pewd',
  '79sh-heg3',
  'hz4p-9f7s',
  'mqt5-ctec',
  'wqhs-q6wd',
  '8kuj-2n3u',
  'mzxg-pwib',
  'h9gi-nx95',
  '5mad-ntua',
];

// Build n anchors on a small line. Ids start at 0.
function makeAnchors(count: number): SegmentAnchor[] {
  const anchors: SegmentAnchor[] = [];
  for (let i = 0; i < count; i += 1) {
    anchors.push({
      id: i,
      midpoint: { lon: MIDPOINT.lon + i * 0.0001, lat: MIDPOINT.lat },
      snapshotScore: 0.1,
    });
  }
  return anchors;
}

// Canned SODA rows for one dataset. Spatial rows carry latitude and
// longitude on the segment midpoint so the nearest-anchor assignment
// places them on segment 7. The values are chosen so every mapResponse
// returns a hand-known number. See the expected-score math below.
function cannedRows(dataset: string): Array<Record<string, string | number>> {
  const at = { latitude: MIDPOINT.lat, longitude: MIDPOINT.lon };
  const two = [
    { ...at, n: '1' },
    { ...at, n: '2' },
  ];
  switch (dataset) {
    case '52n9-sdep':
      // width proxy = shape_area / shape_leng = 10 / 2 = 5
      return [{ ...at, shape_area: '10', shape_leng: '2' }];
    case 'uvpi-gqnh':
      // Count rows. Two rows -> 2.
      return two;
    case 'qt6m-xctn':
      return two;
    case 'sxx4-xhzg':
      return two;
    case 'rqhp-hivt':
      // Mean of acceptable_streets_previous_month = 80.
      return [{ ...at, acceptable_streets_previous_month: '80' }];
    case 'ufzp-rrqu':
      return two;
    case 'kdig-pewd':
      // Zoning class R -> 5.
      return [{ ...at, zonedist: 'R6' }];
    case '79sh-heg3':
    case 'hz4p-9f7s':
    case 'mqt5-ctec':
    case 'wqhs-q6wd':
    case '8kuj-2n3u':
      // One row each. The feature combine sums 5 datasets -> 5.
      return [{ ...at }];
    case 'mzxg-pwib':
      // Facility class II -> 2.
      return [{ ...at, facilitycl: 'II' }];
    case 'h9gi-nx95':
      // 1 injured + 1 killed -> 2.
      return [
        { ...at, number_of_pedestrians_injured: '1', number_of_pedestrians_killed: '1' },
      ];
    case '5mad-ntua':
      // Mean postvz_sl = 25.
      return [{ ...at, postvz_sl: '25' }];
    default:
      // The 10 remaining furniture datasets count rows. Two rows -> 2.
      return two;
  }
}

// The fetch mock. It records every URL and answers with the canned rows.
function makeFetchMock(): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    calls.push(input);
    const url = new URL(input);
    if (url.hostname === 'gbfs.citibikenyc.com') {
      // One station north-east of both midpoints. Segment 7 is the
      // farthest midpoint, so RANGE equals its own distance and its
      // proximity value is exactly 0.
      const body = {
        data: {
          stations: [{ station_id: '1', name: 'Mock Station', lat: 40.8, lon: -73.888 }],
        },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const file = url.pathname.split('/').pop() ?? '';
    const dataset = file.split('.')[0];
    return new Response(JSON.stringify(cannedRows(dataset)), { status: 200 });
  };
  return { fetchImpl, calls };
}

// A fresh guard with an injected clock and memory storage.
function makeGuard(): QuotaGuard {
  return createQuotaGuard({ storage: new MemoryQuotaStorage(), now: () => NOW.getTime() });
}

// Feature stats for the hand-computed row. Non-degenerate windows make
// the normalization visible. The three constant-style features use a
// plain [0, 1] window so the parquet passthrough is exact.
function makeStats(): Record<Feature, FeatureStats> {
  const stats = {} as Record<Feature, FeatureStats>;
  for (const feature of FEATURES) {
    stats[feature] = { min: 0, max: 1 };
  }
  stats.sidewalk_width = { min: 0, max: 10 };
  stats.street_furniture_density = { min: 0, max: 26 };
  stats.surface_condition = { min: 0, max: 100 };
  stats.curb_ramp_availability = { min: 0, max: 2 };
  stats.crowd_dynamics = { min: 0, max: 10 };
  stats.traffic_management = { min: 0, max: 5 };
  stats.bike_lane_availability = { min: 0, max: 3 };
  stats.intersection_safety = { min: 0, max: 2 };
  stats.zoning_laws = { min: 20, max: 30 };
  return stats;
}

// The parquet row for segment 7. The live features carry junk values.
// The refresh must overwrite them with the live query values. The nine
// non-live features carry the passthrough values.
function makeParquetRow(): SnapshotFeatureRow {
  const row: SnapshotFeatureRow = { segment_id: 7, score: 0.999 };
  for (const feature of FEATURES) {
    row[feature] = 0.999;
  }
  row['pedestrian_density'] = 0.25;
  row['sidewalk_roughness'] = 0.75;
  row['communication_infrastructure'] = 0.5;
  row['slope_gradient'] = 0.1;
  row['surveillance_coverage'] = 0.9;
  row['gps_signal_strength'] = 0.5;
  row['bicycle_traffic'] = 0.3;
  row['vehicle_traffic'] = 0.7;
  row['digital_map_existence'] = 1;
  return row;
}

// The expected normalized value per feature after the refresh.
// Live values come from the canned responses and the stats windows.
// Non-live values come from the parquet row passthrough.
const EXPECTED_NORMALIZED: Record<Feature, number> = {
  sidewalk_width: 0.5, // raw 5 in [0, 10]
  pedestrian_density: 0.25, // parquet passthrough
  street_furniture_density: 1, // 13 datasets x 2 rows = 26 in [0, 26]
  sidewalk_roughness: 0.75, // parquet passthrough
  surface_condition: 0.8, // raw 80 in [0, 100]
  communication_infrastructure: 0.5, // parquet passthrough
  slope_gradient: 0.1, // parquet passthrough
  charging_station_proximity: 0, // single midpoint -> RANGE collapse
  curb_ramp_availability: 1, // raw 2 in [0, 2]
  crowd_dynamics: 0.5, // zoning R -> 5 in [0, 10]
  traffic_management: 1, // 5 datasets x 1 row = 5 in [0, 5]
  surveillance_coverage: 0.9, // parquet passthrough
  zoning_laws: 0.5, // raw 25 in [20, 30]
  bike_lane_availability: 2 / 3, // class II -> 2 in [0, 3]
  gps_signal_strength: 0.5, // parquet passthrough
  bicycle_traffic: 0.3, // parquet passthrough
  vehicle_traffic: 0.7, // parquet passthrough
  digital_map_existence: 1, // parquet passthrough
  intersection_safety: 1, // raw 2 in [0, 2]
};

// Hand-computed expected score. The loop replicates the engine formula
// (polarity x normalized x weight) through an independent code path.
function expectedScore(): number {
  let total = 0;
  for (const feature of FEATURES) {
    total += POLARITIES[feature] * EXPECTED_NORMALIZED[feature] * WEIGHTS[feature];
  }
  return total;
}

describe('bboxAreaKm2', () => {
  it('computes the 8 km2 boundary box correctly', () => {
    // A 2 km x 4 km box at the NYC latitude. One latitude degree spans
    // about 111.32 km. One longitude degree spans about 84.4 km at 40.7N.
    const dLat = 2 / 111.32;
    const dLon = 4 / 84.4;
    const bbox: BBox = {
      minLon: -73.9,
      minLat: 40.7,
      maxLon: -73.9 + dLon,
      maxLat: 40.7 + dLat,
    };
    const area = bboxAreaKm2(bbox);
    expect(Math.abs(area - 8)).toBeLessThan(0.1);
    expect(LIVE_AREA_CAP_KM2).toBe(8);
  });

  it('keeps tiny boxes under the cap and huge boxes over it', () => {
    const tiny: BBox = { minLon: -73.9, minLat: 40.7, maxLon: -73.899, maxLat: 40.701 };
    expect(bboxAreaKm2(tiny)).toBeLessThan(LIVE_AREA_CAP_KM2);
    const huge: BBox = { minLon: -74.1, minLat: 40.6, maxLon: -73.7, maxLat: 40.9 };
    expect(bboxAreaKm2(huge)).toBeGreaterThan(LIVE_AREA_CAP_KM2);
  });
});

describe('planLiveRefresh batching', () => {
  it('builds exactly one query per dataset for 50 segments', () => {
    const plan = planLiveRefresh(makeAnchors(50), 'all', NOW);
    expect(plan).toHaveLength(1);
    const batch = plan[0];
    expect(batch.segmentIds).toHaveLength(50);
    expect(batch.queries).toHaveLength(SODA_DATASETS.length);
    const datasets = batch.queries.map((query) => query.dataset);
    expect(new Set(datasets).size).toBe(SODA_DATASETS.length);
    for (const dataset of SODA_DATASETS) {
      expect(datasets).toContain(dataset);
    }
  });

  it('clusters anchors past the batch cap into extra batches', () => {
    const count = MAX_SEGMENTS_PER_BATCH + 5;
    const plan = planLiveRefresh(makeAnchors(count), 'all', NOW);
    expect(plan).toHaveLength(2);
    expect(plan[0].segmentIds).toHaveLength(MAX_SEGMENTS_PER_BATCH);
    expect(plan[1].segmentIds).toHaveLength(5);
    // Every batch still holds one query per dataset.
    for (const batch of plan) {
      expect(batch.queries).toHaveLength(SODA_DATASETS.length);
    }
  });

  it('applies the time window only to intersection_safety and surface_condition', () => {
    const plan = planLiveRefresh(makeAnchors(3), '30d', NOW);
    const batch = plan[0];
    const crashes = batch.queries.find((query) => query.dataset === 'h9gi-nx95');
    const surface = batch.queries.find((query) => query.dataset === 'rqhp-hivt');
    expect(crashes).toBeDefined();
    expect(surface).toBeDefined();
    // The two time-aware queries carry the window filter.
    expect(crashes?.params.get('$where') ?? '').toContain('crash_date between');
    expect(surface?.params.get('$where') ?? '').toContain('month >=');
    // No other dataset query mentions the window columns.
    for (const query of batch.queries) {
      if (query.dataset === 'h9gi-nx95' || query.dataset === 'rqhp-hivt') continue;
      const where = query.params.get('$where') ?? '';
      expect(where).not.toContain('crash_date');
      expect(where).not.toContain('month');
    }
  });
});

describe('runLiveRefresh', () => {
  it('returns disabled and makes zero fetches when the guard blocks', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const guard = makeGuard();
    guard.notify429(); // The backoff disables the guard.
    const result = await runLiveRefresh({
      client: new SodaClient({ fetchImpl, cache: new MemoryCache() }),
      guard,
      stats: makeStats(),
      segments: makeAnchors(1),
      window: 'all',
      fetchImpl,
      parquetRows: [makeParquetRow()],
      now: NOW,
    });
    expect(result.status).toBe('disabled');
    expect(calls).toHaveLength(0);
  });

  it('scores a segment with the entry feature_stats (hand-computed row)', async () => {
    const { fetchImpl, calls } = makeFetchMock();
    const segments: SegmentAnchor[] = [
      { id: 7, midpoint: MIDPOINT, snapshotScore: 0.1 },
      // Segment 8 has no parquet row. It must come back unavailable.
      { id: 8, midpoint: { lon: MIDPOINT.lon + 0.001, lat: MIDPOINT.lat }, snapshotScore: 0.2 },
    ];
    const result = await runLiveRefresh({
      client: new SodaClient({ fetchImpl, cache: new MemoryCache() }),
      guard: makeGuard(),
      stats: makeStats(),
      segments,
      window: 'all',
      fetchImpl,
      parquetRows: [makeParquetRow()],
      now: NOW,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // 25 SODA queries + 1 GBFS feed = 26 network calls.
    expect(calls).toHaveLength(SODA_DATASETS.length + 1);

    const scored = result.results.find((entry) => entry.id === 7);
    expect(scored).toBeDefined();
    if (!scored || scored.status !== 'scored') return;
    // The live score matches the independent hand computation. The
    // hand math uses the injected stats windows. A refresh that ignored
    // those windows would clamp raw values like 5 and 25 to 1 and miss
    // the tolerance by a wide margin.
    expect(Math.abs(scored.liveScore - expectedScore())).toBeLessThan(1e-9);
    // Delta compares the live score with the snapshot tile score.
    expect(Math.abs(scored.delta - (scored.liveScore - 0.1))).toBeLessThan(1e-12);

    const missing = result.results.find((entry) => entry.id === 8);
    expect(missing).toBeDefined();
    expect(missing?.status).toBe('unavailable');
  });
});

