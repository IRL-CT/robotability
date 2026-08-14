/**
 * CitiBike GBFS client for the charging_station_proximity feature.
 *
 * CitiBike stations are not a SODA dataset. They come from the GBFS
 * station_information.json feed. This module uses the same injectable
 * fetch pattern as the SODA client so tests mock everything.
 *
 * Feature semantics follow score.ipynb cell 42:
 *   value = (RANGE - dist) / RANGE
 * where dist is the distance from the segment midpoint to the nearest
 * station, and RANGE is the MAX nearest-station distance across the
 * whole queried batch. The pipeline used the dataset-wide maximum for
 * RANGE. The live client approximates that with the maximum across the
 * queried bbox. With a single midpoint, RANGE equals its own distance
 * and the value is 0. With no stations, every value is 0.
 */

import type { LonLat } from './features.ts';

export const CITIBIKE_GBFS_URL = 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json';

/** One CitiBike station from the GBFS feed. */
export interface GbfsStation {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in meters between two lon/lat points. */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from a point to its nearest station. Infinity when the
 * station list is empty. */
export function nearestStationDistance(stations: GbfsStation[], point: LonLat): number {
  let best = Number.POSITIVE_INFINITY;
  for (const station of stations) {
    const d = haversineMeters(point, station);
    if (d < best) {
      best = d;
    }
  }
  return best;
}

/**
 * Compute the charging proximity value for each segment midpoint.
 *
 * RANGE is the max nearest-station distance across the batch. This
 * matches the pipeline, where RANGE is a dataset-wide maximum. The
 * live client narrows that maximum to the queried bbox. Document this
 * approximation wherever the values are shown.
 */
export function chargingProximity(stations: GbfsStation[], midpoints: LonLat[]): number[] {
  if (midpoints.length === 0) {
    return [];
  }
  if (stations.length === 0) {
    return midpoints.map(() => 0);
  }
  const distances = midpoints.map((point) => nearestStationDistance(stations, point));
  const range = Math.max(...distances);
  if (range <= 0) {
    // Every midpoint sits exactly on a station. No spread exists.
    return midpoints.map(() => 0);
  }
  return distances.map((d) => (range - d) / range);
}

export interface CitibikeFetchOptions {
  /** Defaults to globalThis.fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Feed URL. Tests point this at a mock. */
  url?: string;
}

interface RawGbfsStation {
  station_id?: string | number;
  name?: string;
  lat?: number;
  lon?: number;
}

interface RawGbfsPayload {
  data?: { stations?: RawGbfsStation[] };
}

/** Fetch and parse the GBFS station list. Drops stations without
 * usable coordinates. Throws on any non-200 response. */
export async function fetchStations(options: CitibikeFetchOptions = {}): Promise<GbfsStation[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = options.url ?? CITIBIKE_GBFS_URL;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `GBFS station_information.json request failed with status ${response.status}`,
    );
  }
  const payload = (await response.json()) as RawGbfsPayload;
  const raw = payload.data?.stations ?? [];
  const stations: GbfsStation[] = [];
  for (const entry of raw) {
    if (
      typeof entry.lat === 'number' &&
      Number.isFinite(entry.lat) &&
      typeof entry.lon === 'number' &&
      Number.isFinite(entry.lon)
    ) {
      stations.push({
        station_id: String(entry.station_id ?? ''),
        name: entry.name ?? '',
        lat: entry.lat,
        lon: entry.lon,
      });
    }
  }
  return stations;
}
