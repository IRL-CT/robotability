/**
 * Time-window presets for the two time-aware proxy features.
 *
 * - intersection_safety (h9gi-nx95) filters on the `crash_date` column.
 * - surface_condition (rqhp-hivt) filters on the `month` column.
 *   The scorecard stores month as text in the 'YYYY / MM' format.
 *   dataset.ipynb cell 56 filters Month == '2023 / 09'. Text compare
 *   works because the year leads and both fields are fixed width.
 *
 * Every function takes an explicit `now`. Tests inject a fixed date.
 * Date math uses UTC components so results never depend on the local
 * time zone of the machine that runs the code.
 */

export type TimeWindowPreset = '30d' | '90d' | '1y' | 'all';

export interface TimeWindow {
  preset: TimeWindowPreset;
  /** Start of the window in epoch ms. Null for the all preset. */
  startMs: number | null;
  /** End of the window in epoch ms. Equals the injected now. */
  endMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_DAYS: Record<Exclude<TimeWindowPreset, 'all'>, number> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Format a Date as YYYY-MM-DD using UTC components. */
function isoDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Format a Date as the scorecard month token 'YYYY / MM'. */
function monthToken(date: Date): string {
  return `${date.getUTCFullYear()} / ${pad2(date.getUTCMonth() + 1)}`;
}

function startOf(preset: TimeWindowPreset, now: Date): Date | null {
  if (preset === 'all') {
    return null;
  }
  return new Date(now.getTime() - PRESET_DAYS[preset] * DAY_MS);
}

/**
 * Build the crash_date SoQL filter for h9gi-nx95.
 * Returns an empty string for the all preset.
 */
export function crashDateFilter(preset: TimeWindowPreset, now: Date): string {
  const start = startOf(preset, now);
  if (start === null) {
    return '';
  }
  return `crash_date between '${isoDay(start)}' and '${isoDay(now)}'`;
}

/**
 * Build the month range SoQL filter for rqhp-hivt.
 * Returns an empty string for the all preset.
 */
export function monthRangeFilter(preset: TimeWindowPreset, now: Date): string {
  const start = startOf(preset, now);
  if (start === null) {
    return '';
  }
  return `month >= '${monthToken(start)}' and month <= '${monthToken(now)}'`;
}

/** Resolve a preset into explicit epoch bounds. */
export function windowFromPreset(preset: TimeWindowPreset, now: Date): TimeWindow {
  const start = startOf(preset, now);
  return {
    preset,
    startMs: start === null ? null : start.getTime(),
    endMs: now.getTime(),
  };
}
