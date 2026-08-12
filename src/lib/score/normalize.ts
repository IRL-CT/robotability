/**
 * Min-max normalization for one value.
 *
 * Mirrors min_max_normalize in score.ipynb cell 1:
 * (value - min) / (max - min). The result is clamped to [0, 1] as a
 * safety net; score.ipynb cell 92 asserts the same range.
 */

// Module-level flag. It makes the degenerate-stats warning log once.
let degenerateStatsLogged = false;

/**
 * Normalize value into [0, 1] against the stats window [min, max].
 * When max === min the window is degenerate. The function returns the
 * midpoint 0.5 and logs once.
 */
export function minmax(value: number, min: number, max: number): number {
  if (max === min) {
    if (!degenerateStatsLogged) {
      degenerateStatsLogged = true;
      console.warn(
        'score: minmax received degenerate stats (max === min). It uses 0.5.',
      );
    }
    return 0.5;
  }
  const normalized = (value - min) / (max - min);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 1) {
    return 1;
  }
  return normalized;
}
