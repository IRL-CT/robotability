/**
 * Robotability score engine.
 *
 * Reproduces the pipeline formula from score.ipynb:
 * score = sum over the 19 features of polarity x normalized x weight.
 * Cells 15-90 compute normalized x weight per feature. Cell 96 holds
 * the polarities. Cell 97 sums the weighted features.
 */

import { FEATURES, WEIGHTS } from './weights.ts';
import type { Feature } from './weights.ts';
import { POLARITIES } from './polarities.ts';
import { minmax } from './normalize.ts';

export type { Feature } from './weights.ts';

/** Per-feature normalization window. Matches feature_stats in
 * pipeline/contract/cluster_contract.md. */
export type FeatureStats = { min: number; max: number };

/** Error for bad engine input. The message names the offending feature. */
export class ScoreInputError extends Error {
  constructor(feature: Feature, problem: string) {
    super(`score input error for feature "${feature}": ${problem}`);
    this.name = 'ScoreInputError';
  }
}

function readValue(
  values: Record<Feature, number>,
  feature: Feature,
): number {
  if (!Object.prototype.hasOwnProperty.call(values, feature)) {
    throw new ScoreInputError(feature, 'missing value');
  }
  const value = values[feature];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScoreInputError(feature, 'value must be a finite number');
  }
  return value;
}

function readStats(
  stats: Record<Feature, FeatureStats>,
  feature: Feature,
): FeatureStats {
  if (!Object.prototype.hasOwnProperty.call(stats, feature)) {
    throw new ScoreInputError(feature, 'missing stats');
  }
  const stat = stats[feature];
  if (
    typeof stat?.min !== 'number' ||
    !Number.isFinite(stat.min) ||
    typeof stat?.max !== 'number' ||
    !Number.isFinite(stat.max)
  ) {
    throw new ScoreInputError(feature, 'stats must hold finite min and max numbers');
  }
  return stat;
}

/**
 * Compute the Robotability score for one segment.
 *
 * score = sum over the 19 features of
 *         polarity x minmax(value, stats.min, stats.max) x weight.
 *
 * The loop follows FEATURES order, the same order the Python reference
 * uses. Both implementations sum identical float64 terms in identical
 * order, so their results match bit for bit.
 */
export function computeScore(
  values: Record<Feature, number>,
  stats: Record<Feature, FeatureStats>,
): number {
  let score = 0;
  for (const feature of FEATURES) {
    const value = readValue(values, feature);
    const stat = readStats(stats, feature);
    score += POLARITIES[feature] * minmax(value, stat.min, stat.max) * WEIGHTS[feature];
  }
  return score;
}
