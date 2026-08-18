// Tests for quantileBreaks, the per-feature colour ramp.
// The feature ramp used to be linear over [0, 1]. Every feature is
// min-max normalized, so that domain is always full, but the shapes are
// skewed: the 2026 city put 81.7% of slope_gradient in the first colour.
// These tests pin the decile behaviour and the guards MapLibre needs.
import { describe, expect, it } from 'vitest';
import { SCORE_COLORS, featureBreaks, quantileBreaks } from './constants';

const STOPS = SCORE_COLORS.length;

function strictlyIncreasing(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i] > values[i - 1])) return false;
  }
  return true;
}

describe('quantileBreaks', () => {
  it('returns one break per ramp colour', () => {
    const breaks = quantileBreaks([0, 0.25, 0.5, 0.75, 1]);
    expect(breaks).not.toBeNull();
    expect(breaks).toHaveLength(STOPS);
  });

  it('spans an even spread end to end', () => {
    const values = Array.from({ length: 101 }, (_, i) => i / 100);
    const breaks = quantileBreaks(values) as number[];
    expect(breaks[0]).toBeCloseTo(0, 10);
    expect(breaks[STOPS - 1]).toBeCloseTo(1, 10);
    expect(breaks[5]).toBeCloseTo(0.5, 10);
  });

  it('lifts a skewed distribution off the bottom stop', () => {
    // 90% of the mass under 0.1, the shape that rendered flat before.
    const values = [
      ...Array.from({ length: 900 }, (_, i) => (i / 900) * 0.1),
      ...Array.from({ length: 100 }, (_, i) => 0.1 + (i / 100) * 0.9),
    ];
    const linear = featureBreaks();
    const breaks = quantileBreaks(values) as number[];
    // The linear ramp puts the median in the first band. Deciles put it
    // at the middle stop, which is the whole point.
    expect(values[Math.floor(values.length / 2)]).toBeLessThan(linear[1]);
    expect(breaks[5]).toBeLessThan(0.1);
    expect(strictlyIncreasing(breaks)).toBe(true);
  });

  it('stays strictly increasing when every value is identical', () => {
    const breaks = quantileBreaks(Array.from({ length: 50 }, () => 1)) as number[];
    expect(breaks).toHaveLength(STOPS);
    expect(strictlyIncreasing(breaks)).toBe(true);
    expect(breaks[0]).toBe(1);
  });

  it('stays strictly increasing when the values tie at zero', () => {
    const breaks = quantileBreaks(Array.from({ length: 50 }, () => 0)) as number[];
    expect(strictlyIncreasing(breaks)).toBe(true);
    expect(breaks[0]).toBe(0);
  });

  it('stays strictly increasing with heavy ties at both ends', () => {
    const values = [
      ...Array.from({ length: 40 }, () => 0),
      0.5,
      ...Array.from({ length: 40 }, () => 1),
    ];
    expect(strictlyIncreasing(quantileBreaks(values) as number[])).toBe(true);
  });

  it('skips NaN rather than poisoning the ramp', () => {
    const values = [0, Number.NaN, 0.5, Number.NaN, 1];
    const breaks = quantileBreaks(values) as number[];
    expect(breaks.every((v) => Number.isFinite(v))).toBe(true);
    expect(breaks[0]).toBe(0);
    expect(breaks[STOPS - 1]).toBe(1);
  });

  it('returns null when no finite value exists', () => {
    expect(quantileBreaks([])).toBeNull();
    expect(quantileBreaks([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });
});
