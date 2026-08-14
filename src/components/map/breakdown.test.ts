// Unit checks for the breakdown contribution math.
// The signed contribution must equal polarity x normalized x weight.
// The sum of the 19 contributions must equal the parquet score.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildBreakdown,
  signedContribution,
  WEIGHTS,
  type FeatureRow,
} from './breakdownData';

// ESM has no __dirname. Derive this file's directory from import.meta.url.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureParquet = path.join(
  testDir,
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'fixture-a',
  'features.parquet'
);

// Hand-computed rows. Each uses real weights from weights.json.
// Row values are normalized feature values in [0, 1].
function weightOf(feature: string): number {
  const entry = WEIGHTS.find((w) => w.feature === feature);
  if (!entry) throw new Error(`No weight entry for ${feature}`);
  return Number.parseFloat(entry.weight);
}

function polarityOf(feature: string): number {
  const entry = WEIGHTS.find((w) => w.feature === feature);
  if (!entry) throw new Error(`No weight entry for ${feature}`);
  return entry.polarity;
}

describe('signedContribution', () => {
  it('computes polarity x normalized x weight for three hand rows', () => {
    // Row 1. sidewalk_width. Polarity +1, normalized 1.
    const widthWeight = weightOf('sidewalk_width');
    expect(polarityOf('sidewalk_width')).toBe(1);
    const row1 = signedContribution(1, 1, widthWeight);
    expect(row1).toBeCloseTo(widthWeight, 12);

    // Row 2. pedestrian_density. Polarity -1, normalized 0.5.
    const pedWeight = weightOf('pedestrian_density');
    expect(polarityOf('pedestrian_density')).toBe(-1);
    const row2 = signedContribution(-1, 0.5, pedWeight);
    expect(row2).toBeCloseTo(-0.5 * pedWeight, 12);

    // Row 3. intersection_safety. Polarity -1, normalized 0.25.
    const crossWeight = weightOf('intersection_safety');
    expect(polarityOf('intersection_safety')).toBe(-1);
    const row3 = signedContribution(-1, 0.25, crossWeight);
    expect(row3).toBeCloseTo(-0.25 * crossWeight, 12);
  });

  it('returns zero when the normalized value is zero', () => {
    // A negative polarity times zero yields -0. toBeCloseTo treats -0
    // and 0 as equal, which is the intended check here.
    expect(signedContribution(1, 0, weightOf('surface_condition'))).toBeCloseTo(0, 12);
    expect(signedContribution(-1, 0, weightOf('vehicle_traffic'))).toBeCloseTo(0, 12);
  });
});

describe('buildBreakdown on the fixture parquet', () => {
  it('sums the 19 contributions to the parquet score for segment 0', async () => {
    // Read the fixture parquet with hyparquet. The node entry provides
    // asyncBufferFromFile for local files.
    const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet');
    const file = await asyncBufferFromFile(fixtureParquet);
    const records = await parquetReadObjects({ file });
    expect(records.length).toBeGreaterThan(0);

    // Take the first row. The mock pipeline numbers segments from 0.
    const record = records[0];
    const row: FeatureRow = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'number' && Number.isFinite(value)) row[key] = value;
    }
    const segmentId = row['segment_id'];
    const parquetScore = row['score'];
    expect(typeof segmentId).toBe('number');
    expect(typeof parquetScore).toBe('number');

    const breakdown = buildBreakdown(row);
    expect(breakdown.entries.length).toBe(19);

    // Every contribution equals polarity x normalized x weight.
    for (const entry of breakdown.entries) {
      expect(entry.contribution).toBeCloseTo(
        entry.polarity * entry.normalized * entry.weight,
        12
      );
    }

    // The sum of the 19 contributions matches the parquet score.
    // The parquet stores a float32 score. The recomputed sum is float64.
    // A tolerance of 1e-4 covers the float32 rounding.
    expect(Math.abs(breakdown.total - parquetScore)).toBeLessThan(1e-4);
  });
});
