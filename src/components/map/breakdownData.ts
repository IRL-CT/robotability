// Breakdown data loading and score math for the panel.
// This module fetches one snapshot's features.parquet, parses it with
// hyparquet, and caches the parsed rows in the Cache API. It also
// computes the signed contribution of every feature for one segment.
// The module is SSR-safe: it guards every Cache API call.

import weights from '../../data/weights.json';

// One parsed parquet row. Keys are column names. Values are numbers.
// The parquet stores segment_id, 19 normalized feature columns, and score.
export type FeatureRow = Record<string, number>;

// One entry in weights.json. The weight is a string float64 in the file.
export type WeightEntry = {
  readonly feature: string;
  readonly displayName: string;
  readonly weight: string;
  readonly polarity: number;
};

// The typed weights list. The JSON import carries extra fields
// (sourceType, datasetId). The structural type keeps only what the
// panel needs.
export const WEIGHTS: readonly WeightEntry[] = weights;

// One feature line in the breakdown panel.
export type BreakdownEntry = {
  readonly feature: string;
  readonly displayName: string;
  readonly normalized: number;
  readonly weight: number;
  readonly polarity: number;
  readonly contribution: number;
};

// The full breakdown for one segment plus its score total.
export type Breakdown = {
  readonly entries: readonly BreakdownEntry[];
  readonly total: number;
};

// Signed contribution of one feature. This is the score formula term.
// contribution = polarity x normalized x weight.
export function signedContribution(
  polarity: number,
  normalized: number,
  weight: number
): number {
  return polarity * normalized * weight;
}

// Build the 19-row breakdown for one parquet row. Every weights.json
// feature produces one entry. The total is the sum of the contributions.
// A missing or non-numeric cell reads as 0, so no row is ever empty
// and no value is ever NaN.
export function buildBreakdown(row: FeatureRow): Breakdown {
  const entries: BreakdownEntry[] = [];
  let total = 0;
  for (const w of WEIGHTS) {
    const weight = Number.parseFloat(w.weight);
    const raw = row[w.feature];
    const normalized = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const contribution = signedContribution(w.polarity, normalized, weight);
    total += contribution;
    entries.push({
      feature: w.feature,
      displayName: w.displayName,
      normalized,
      weight,
      polarity: w.polarity,
      contribution,
    });
  }
  return { entries, total };
}

// Cache API name and key builder. One cache holds every snapshot. Each
// parsed row set is stored under its snapshot tag.
const CACHE_NAME = 'robotability-features';

function cacheKey(tag: string): string {
  // The key must be a valid URL for the Cache API. A fake origin works.
  return `https://robotability.local/features/${tag}`;
}

// True when the Cache API exists. Astro renders on the server first, so
// every Cache API call must sit behind this guard.
function cacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

// Read one raw parquet record into a FeatureRow. hyparquet returns
// Record<string, any> rows. This converts known numeric cells and drops
// the rest. segment_id and score travel as numbers.
function toFeatureRow(record: Record<string, unknown>): FeatureRow {
  const row: FeatureRow = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      row[key] = value;
    } else if (typeof value === 'bigint') {
      row[key] = Number(value);
    }
  }
  return row;
}

// Load and parse the parquet for one snapshot. On the first call the rows
// come from the network through hyparquet. The parsed rows are cached in
// the Cache API under the snapshot tag. Later calls read the cache.
// The promise rejects when the fetch or the parse fails. The caller shows
// the retry state and keeps the map usable.
export async function loadFeatureRows(
  parquetUrl: string,
  tag: string
): Promise<readonly FeatureRow[]> {
  if (cacheAvailable()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(cacheKey(tag));
      if (hit) {
        const rows = (await hit.json()) as FeatureRow[];
        return rows;
      }
    } catch (err) {
      // A cache read failure is not fatal. Fall through to the network.
      console.warn('Feature cache read failed. Using the network.', err);
    }
  }

  const response = await fetch(parquetUrl);
  if (!response.ok) {
    throw new Error(`The feature table request failed with status ${response.status}.`);
  }
  const buffer = await response.arrayBuffer();

  // Import hyparquet here so the parser loads only when the panel opens.
  const { parquetReadObjects } = await import('hyparquet');
  const records = await parquetReadObjects({ file: buffer });
  const rows = records.map((record) => toFeatureRow(record));

  if (cacheAvailable()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const body = JSON.stringify(rows);
      await cache.put(cacheKey(tag), new Response(body));
    } catch (err) {
      // A cache write failure is not fatal. The rows are already parsed.
      console.warn('Feature cache write failed.', err);
    }
  }

  return rows;
}

// Find the row for one segment id. Returns null when the table has no
// such segment.
export function findRow(
  rows: readonly FeatureRow[],
  segmentId: number
): FeatureRow | null {
  for (const row of rows) {
    if (row['segment_id'] === segmentId) return row;
  }
  return null;
}
