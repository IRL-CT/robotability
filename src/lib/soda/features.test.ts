/**
 * Tests for the 9 proxy feature query specs.
 *
 * Every SODA response is mocked inline. Expected values are computed
 * by hand in this file, not by the code under test.
 */

import { describe, expect, it } from 'vitest';

import {
  FURNITURE_DATASETS,
  PROXY_FEATURES,
  TRAFFIC_DATASETS,
  type SegmentGeometry,
} from './features.ts';

// Fixed segment in Manhattan. Midpoint plus two endpoints.
const SEGMENT: SegmentGeometry = {
  midpoint: { lon: -73.99, lat: 40.74 },
  endpoints: [
    { lon: -73.995, lat: 40.742 },
    { lon: -73.985, lat: 40.738 },
  ],
};

// Fixed clock for time-windowed specs: 2026-08-12T15:00:00Z.
const NOW = new Date(Date.UTC(2026, 7, 12, 15, 0, 0));

describe('dataset ids match the pipeline sources', () => {
  it('lists exactly the 13 street furniture datasets', () => {
    // Ids resolved from robotability-nyc/feature_processing/pull_data.sh.
    expect(FURNITURE_DATASETS.map((d) => d.dataset)).toEqual([
      '8znf-7b2c', // DSNY Litter Basket Inventory
      '5bgh-vtsn', // Hydrants
      't4f2-8md7', // Bus Stop Shelters
      'dimy-qyej', // Bicycle Parking Shelters
      'yh4a-g3fj', // Bicycle Racks
      'kuxa-tauh', // City Bench Locations
      'uvpi-gqnh', // 2015 Street Tree Census
      'w9zq-xm8b', // Newsstands
      '693u-uax6', // Parking Meters Locations and Status
      's4kf-3yrf', // LinkNYC Kiosk Locations
      'v57i-gtxb', // In-Service Alarm Box Locations
      'qt6m-xctn', // Street Sign Work Orders
      'sxx4-xhzg', // Public Recycling Bins (13th id from pull_data.sh)
    ]);
  });

  it('lists exactly the 5 traffic management datasets', () => {
    expect(TRAFFIC_DATASETS.map((d) => d.dataset)).toEqual([
      '79sh-heg3', // VZV Street Improvement Projects (SIPs) Intersections
      'hz4p-9f7s', // VZV Turn Traffic Calming
      'mqt5-ctec', // VZV Leading Pedestrian Interval Signals
      'wqhs-q6wd', // VZV Street Improvement Projects (SIPs) Corridor
      '8kuj-2n3u', // Exclusive Pedestrian Signal (Barnes Dance) Locations
    ]);
  });

  it('pins the primary dataset id of every proxy feature', () => {
    expect(PROXY_FEATURES.sidewalk_width.dataset).toBe('52n9-sdep');
    expect(PROXY_FEATURES.street_furniture_density.dataset).toBe('8znf-7b2c');
    expect(PROXY_FEATURES.surface_condition.dataset).toBe('rqhp-hivt');
    expect(PROXY_FEATURES.curb_ramp_availability.dataset).toBe('ufzp-rrqu');
    expect(PROXY_FEATURES.crowd_dynamics.dataset).toBe('kdig-pewd');
    expect(PROXY_FEATURES.traffic_management.dataset).toBe('79sh-heg3');
    expect(PROXY_FEATURES.bike_lane_availability.dataset).toBe('mzxg-pwib');
    expect(PROXY_FEATURES.intersection_safety.dataset).toBe('h9gi-nx95');
    expect(PROXY_FEATURES.zoning_laws.dataset).toBe('5mad-ntua');
  });
});

describe('mapResponse for all 9 proxy features (hand-computed)', () => {
  it('sidewalk_width: mean of area/length width proxy', () => {
    // 100/10 = 10 and 50/10 = 5. Mean = 7.5.
    const rows = [
      { shape_area: '100', shape_leng: '10' },
      { shape_area: '50', shape_leng: '10' },
    ];
    expect(PROXY_FEATURES.sidewalk_width.mapResponse(rows)).toBe(7.5);
    expect(PROXY_FEATURES.sidewalk_width.mapResponse([])).toBe(0);
  });

  it('street_furniture_density: every furniture dataset counts rows', () => {
    expect(FURNITURE_DATASETS).toHaveLength(13);
    for (const spec of FURNITURE_DATASETS) {
      expect(spec.mapResponse([{ a: '1' }, { a: '2' }, { a: '3' }])).toBe(3);
      expect(spec.mapResponse([])).toBe(0);
    }
    // The feature sums the 13 per-dataset counts.
    const perDataset = FURNITURE_DATASETS.map((spec) => spec.mapResponse([{ a: '1' }]));
    expect(PROXY_FEATURES.street_furniture_density.combine(perDataset)).toBe(13);
  });

  it('surface_condition: mean scorecard percentage', () => {
    // (85.5 + 90) / 2 = 87.75.
    const rows = [
      { acceptable_streets_previous_month: '85.5' },
      { acceptable_streets_previous_month: '90' },
    ];
    expect(PROXY_FEATURES.surface_condition.mapResponse(rows)).toBe(87.75);
    expect(PROXY_FEATURES.surface_condition.mapResponse([])).toBe(0);
  });

  it('curb_ramp_availability: count of Good ramps near the segment', () => {
    const rows = [{ rampid: '1' }, { rampid: '2' }, { rampid: '3' }, { rampid: '4' }];
    expect(PROXY_FEATURES.curb_ramp_availability.mapResponse(rows)).toBe(4);
  });

  it('crowd_dynamics: zoning class map M=10 R=5 C=0 else=2', () => {
    const spec = PROXY_FEATURES.crowd_dynamics;
    expect(spec.mapResponse([{ zonedist: 'M1-5' }])).toBe(10);
    expect(spec.mapResponse([{ zonedist: 'R7-2' }])).toBe(5);
    expect(spec.mapResponse([{ zonedist: 'C4-4' }])).toBe(0);
    expect(spec.mapResponse([{ zonedist: 'BP-1' }])).toBe(2);
    // No zoning row found near the segment.
    expect(spec.mapResponse([])).toBe(0);
    // Take the first matching district only.
    expect(spec.mapResponse([{ zonedist: 'R5' }, { zonedist: 'M1' }])).toBe(5);
  });

  it('traffic_management: sum of counts over the 5 VZV datasets', () => {
    expect(TRAFFIC_DATASETS).toHaveLength(5);
    const counts = [1, 2, 3, 0, 4];
    const values = TRAFFIC_DATASETS.map((spec, i) =>
      spec.mapResponse(Array.from({ length: counts[i] }, () => ({ x: '1' }))),
    );
    expect(values).toEqual([1, 2, 3, 0, 4]);
    expect(PROXY_FEATURES.traffic_management.combine(values)).toBe(10);
  });

  it('bike_lane_availability: max facility class L=0.5 I=1 II=2 III=3', () => {
    const spec = PROXY_FEATURES.bike_lane_availability;
    // max(0.5, 2, 1) = 2.
    expect(spec.mapResponse([
      { facilitycl: 'L' },
      { facilitycl: 'II' },
      { facilitycl: 'I' },
    ])).toBe(2);
    expect(spec.mapResponse([{ facilitycl: 'III' }])).toBe(3);
    expect(spec.mapResponse([{ facilitycl: 'L' }])).toBe(0.5);
    // Unknown class codes contribute nothing.
    expect(spec.mapResponse([{ facilitycl: 'X' }])).toBe(0);
    expect(spec.mapResponse([])).toBe(0);
  });

  it('intersection_safety: pedestrians injured plus killed', () => {
    // (2 + 1) + (0 + 0) = 3.
    const rows = [
      { number_of_pedestrians_injured: '2', number_of_pedestrians_killed: '1' },
      { number_of_pedestrians_injured: '0', number_of_pedestrians_killed: '0' },
    ];
    expect(PROXY_FEATURES.intersection_safety.mapResponse(rows)).toBe(3);
    expect(PROXY_FEATURES.intersection_safety.mapResponse([])).toBe(0);
  });

  it('zoning_laws: mean posted speed limit', () => {
    // (25 + 30) / 2 = 27.5.
    const rows = [{ postvz_sl: '25' }, { postvz_sl: '30' }];
    expect(PROXY_FEATURES.zoning_laws.mapResponse(rows)).toBe(27.5);
    expect(PROXY_FEATURES.zoning_laws.mapResponse([])).toBe(0);
  });
});

describe('buildQuery geometry and filters', () => {
  it('curb_ramp_availability: 50ft circles, lat-first, Good condition', () => {
    const params = PROXY_FEATURES.curb_ramp_availability.buildQuery(SEGMENT);
    // 50 ft = 15.24 m. Socrata takes lat before lon. Midpoint leads.
    expect(params.get('$where')).toBe(
      '(within_circle(the_geom, 40.74, -73.99, 15.24) or ' +
        'within_circle(the_geom, 40.742, -73.995, 15.24) or ' +
        "within_circle(the_geom, 40.738, -73.985, 15.24)) and dws_conditions = 'Good Condition'",
    );
  });

  it('street furniture: 25ft circles around midpoint and endpoints', () => {
    const litter = FURNITURE_DATASETS[0]; // 8znf-7b2c, geo column `point`.
    const params = litter.buildQuery(SEGMENT);
    // 25 ft = 7.62 m.
    expect(params.get('$where')).toBe(
      'within_circle(point, 40.74, -73.99, 7.62) or ' +
        'within_circle(point, 40.742, -73.995, 7.62) or ' +
        'within_circle(point, 40.738, -73.985, 7.62)',
    );
  });

  it('street trees: falls back to lat/lon ranges (no geo column)', () => {
    const trees = FURNITURE_DATASETS.find((d) => d.dataset === 'uvpi-gqnh');
    expect(trees).toBeDefined();
    const where = trees?.buildQuery(SEGMENT).get('$where') ?? '';
    expect(where).toContain('latitude >=');
    expect(where).toContain('latitude <=');
    expect(where).toContain('longitude >=');
    expect(where).toContain('longitude <=');
  });

  it('crowd_dynamics: bounding box with lat-first argument order', () => {
    const params = PROXY_FEATURES.crowd_dynamics.buildQuery(SEGMENT);
    expect(params.get('$where')).toBe(
      'within_box(the_geom, 40.738, -73.995, 40.742, -73.985)',
    );
  });

  it('surface_condition: month window and district columns', () => {
    const params = PROXY_FEATURES.surface_condition.buildQuery(SEGMENT, '90d', NOW);
    expect(params.get('$where')).toBe(
      "month >= '2026 / 05' and month <= '2026 / 08'",
    );
    expect(params.get('$select')).toBe(
      'month, borough, community_board, acceptable_streets_previous_month',
    );
    // The all preset sends no month filter.
    expect(PROXY_FEATURES.surface_condition.buildQuery(SEGMENT, 'all', NOW).has('$where')).toBe(
      false,
    );
  });

  it('intersection_safety: crash_date window joins the geometry filter', () => {
    const params = PROXY_FEATURES.intersection_safety.buildQuery(SEGMENT, '30d', NOW);
    expect(params.get('$where')).toBe(
      '(within_circle(location, 40.74, -73.99, 15.24) or ' +
        'within_circle(location, 40.742, -73.995, 15.24) or ' +
        "within_circle(location, 40.738, -73.985, 15.24)) and crash_date between '2026-07-13' and '2026-08-12'",
    );
    expect(params.get('$select')).toBe(
      'number_of_pedestrians_injured, number_of_pedestrians_killed',
    );
  });

  it('bike_lane_availability: keeps only Current routes in the box', () => {
    const params = PROXY_FEATURES.bike_lane_availability.buildQuery(SEGMENT);
    expect(params.get('$where')).toBe(
      "status = 'Current' and within_box(the_geom, 40.738, -73.995, 40.742, -73.985)",
    );
  });

  it('zoning_laws: box query selects the speed limit column', () => {
    const params = PROXY_FEATURES.zoning_laws.buildQuery(SEGMENT);
    expect(params.get('$where')).toBe(
      'within_box(the_geom, 40.738, -73.995, 40.742, -73.985)',
    );
    expect(params.get('$select')).toBe('postvz_sl');
  });

  it('sidewalk_width: box query selects area and length columns', () => {
    const params = PROXY_FEATURES.sidewalk_width.buildQuery(SEGMENT);
    expect(params.get('$where')).toBe(
      'within_box(the_geom, 40.738, -73.995, 40.742, -73.985)',
    );
    expect(params.get('$select')).toBe('shape_area, shape_leng');
  });
});
