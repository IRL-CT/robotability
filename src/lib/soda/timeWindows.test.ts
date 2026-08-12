/**
 * Tests for the time-window presets.
 *
 * Every test injects a fixed `now`. No test reads the real clock.
 * The collision dataset h9gi-nx95 filters on `crash_date`.
 * The scorecard dataset rqhp-hivt filters on `month`, whose values
 * use the 'YYYY / MM' text format (verified against the live dataset
 * and dataset.ipynb cell 56, which filters Month == '2023 / 09').
 */

import { describe, expect, it } from 'vitest';

import {
  crashDateFilter,
  monthRangeFilter,
  windowFromPreset,
} from './timeWindows.ts';

// Fixed clock: 2026-08-12T15:00:00Z.
const NOW = new Date(Date.UTC(2026, 7, 12, 15, 0, 0));

describe('crashDateFilter (h9gi-nx95)', () => {
  it('builds the exact 30d window', () => {
    expect(crashDateFilter('30d', NOW)).toBe(
      "crash_date between '2026-07-13' and '2026-08-12'",
    );
  });

  it('builds the exact 90d window', () => {
    expect(crashDateFilter('90d', NOW)).toBe(
      "crash_date between '2026-05-14' and '2026-08-12'",
    );
  });

  it('builds the exact 1y window', () => {
    expect(crashDateFilter('1y', NOW)).toBe(
      "crash_date between '2025-08-12' and '2026-08-12'",
    );
  });

  it('builds no filter for the all preset', () => {
    expect(crashDateFilter('all', NOW)).toBe('');
  });
});

describe('monthRangeFilter (rqhp-hivt)', () => {
  it('builds the exact 30d month range', () => {
    expect(monthRangeFilter('30d', NOW)).toBe(
      "month >= '2026 / 07' and month <= '2026 / 08'",
    );
  });

  it('builds the exact 90d month range', () => {
    expect(monthRangeFilter('90d', NOW)).toBe(
      "month >= '2026 / 05' and month <= '2026 / 08'",
    );
  });

  it('builds the exact 1y month range', () => {
    expect(monthRangeFilter('1y', NOW)).toBe(
      "month >= '2025 / 08' and month <= '2026 / 08'",
    );
  });

  it('builds no filter for the all preset', () => {
    expect(monthRangeFilter('all', NOW)).toBe('');
  });
});

describe('windowFromPreset', () => {
  it('carries the preset and the computed start instant', () => {
    const window30 = windowFromPreset('30d', NOW);
    expect(window30.preset).toBe('30d');
    expect(window30.endMs).toBe(NOW.getTime());
    expect(window30.startMs).toBe(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

    const windowAll = windowFromPreset('all', NOW);
    expect(windowAll.startMs).toBeNull();
  });
});
