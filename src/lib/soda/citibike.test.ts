/**
 * Tests for the CitiBike GBFS charging-station proximity feature.
 *
 * CitiBike is not a SODA dataset. The client fetches the GBFS
 * station_information.json feed. All network access is mocked.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  chargingProximity,
  fetchStations,
  haversineMeters,
  nearestStationDistance,
} from './citibike.ts';

// Two stations on the prime meridian, one degree of latitude apart.
const STATIONS = [
  { station_id: 'A', name: 'Origin', lat: 0, lon: 0 },
  { station_id: 'B', name: 'North', lat: 1, lon: 0 },
];

describe('haversineMeters', () => {
  it('measures half a degree of latitude as about 55.60 km', () => {
    // Sphere of radius 6371 km: 0.5 deg = 6371000 * (0.5 * pi / 180) m
    // = 55597.46 m.
    const d = haversineMeters({ lon: 0, lat: 0 }, { lon: 0, lat: 0.5 });
    expect(d).toBeCloseTo(55597.46, 0);
  });

  it('returns zero for identical points', () => {
    expect(haversineMeters({ lon: -74, lat: 40.7 }, { lon: -74, lat: 40.7 })).toBe(0);
  });
});

describe('nearestStationDistance', () => {
  it('picks the closer of the two stations', () => {
    // Midway point is equidistant; a point south of it is closer to A.
    const d = nearestStationDistance(STATIONS, { lon: 0, lat: 0.25 });
    // 0.25 deg of latitude = 6371000 * (0.25 * pi / 180) m = 27798.73 m.
    expect(d).toBeCloseTo(27798.73, 0);
  });
});

describe('chargingProximity (RANGE - dist) / RANGE', () => {
  it('computes RANGE as the max nearest distance across the batch', () => {
    // Midpoint 1 sits on station A: nearest distance 0.
    // Midpoint 2 sits halfway between the stations: nearest = 55592.61 m.
    // RANGE = max(0, 55592.61) = 55592.61.
    // value1 = (RANGE - 0) / RANGE = 1. value2 = (RANGE - RANGE) / RANGE = 0.
    const values = chargingProximity(STATIONS, [
      { lon: 0, lat: 0 },
      { lon: 0, lat: 0.5 },
    ]);
    expect(values).toHaveLength(2);
    expect(values[0]).toBeCloseTo(1, 10);
    expect(values[1]).toBeCloseTo(0, 10);
  });

  it('returns 0 for a single midpoint (RANGE equals its own distance)', () => {
    // With one point, RANGE = dist, so (RANGE - dist) / RANGE = 0.
    // This matches score.ipynb cell 42, where RANGE is a dataset-wide max.
    const values = chargingProximity(STATIONS, [{ lon: 0, lat: 0.25 }]);
    expect(values).toEqual([0]);
  });

  it('returns no values for no midpoints', () => {
    expect(chargingProximity(STATIONS, [])).toEqual([]);
  });

  it('returns zeros when no stations exist', () => {
    expect(chargingProximity([], [{ lon: 0, lat: 0 }])).toEqual([0]);
  });
});

describe('fetchStations', () => {
  it('parses the GBFS envelope and drops stations without coordinates', async () => {
    const body = JSON.stringify({
      last_updated: 1_700_000_000,
      ttl: 60,
      data: {
        stations: [
          { station_id: 'A', name: 'Origin', lat: 0, lon: 0, capacity: 30 },
          { station_id: 'B', name: 'North', lat: 1, lon: 0, capacity: 20 },
          { station_id: 'C', name: 'No coordinates', capacity: 10 },
        ],
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const stations = await fetchStations({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stations.map((s) => s.station_id)).toEqual(['A', 'B']);
  });

  it('throws on a non-200 GBFS response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    await expect(fetchStations({ fetchImpl })).rejects.toThrow(/station_information/);
  });
});
