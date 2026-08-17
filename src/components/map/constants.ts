// Shared constants for the map components.
// Every map component imports these values from here.

// The 11-stop RdYlGn color ramp. Each stop is [red, green, blue], 0-255.
// Stop 0 is the worst score. Stop 10 is the best score.
// Provenance: src/components/custom/RobotabilityMap.jsx, lines 6-18.
// The values are copied verbatim from the legacy map (RobotabilityMap.jsx).
// Do not change a value without a matching change to the legend.
export const SCORE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [165, 0, 38], // Dark red
  [215, 48, 39], // Red
  [244, 109, 67], // Light red
  [253, 174, 97], // Orange-red
  [254, 224, 144], // Light orange
  [255, 255, 191], // Yellow
  [217, 239, 139], // Light yellow-green
  [166, 217, 106], // Light green
  [102, 189, 99], // Medium green
  [26, 152, 80], // Green
  [0, 104, 55], // Dark green
];

// The full domain of the Robotability score.
// Provenance: pipeline/contract/validate_snapshot.mjs rejects every score
// outside [-0.4049, 0.5952]. The bounds are the weight sums of the
// negative-polarity weights (0.40488) and the positive-polarity weights
// (0.59512) in robotability-nyc/survey_processing/feature_weights.csv,
// rounded to four decimals by the contract.
export const SCORE_DOMAIN_MIN = -0.4049;
export const SCORE_DOMAIN_MAX = 0.5952;

// The colour breaks for one snapshot: one score per ramp stop.
//
// Spreading the ramp evenly across the domain above looks reasonable and
// renders badly. The domain is what a score *could* be; a real city uses
// a fraction of it. The 2026 citywide run spans [0.020, 0.348], 33% of
// the domain, sitting between stops 4 and 8 — so the map drew the whole
// city in yellows and light greens and ten of the eleven colours never
// appeared.
//
// So a snapshot ships its own breaks: the deciles of its scores, written
// by the cluster (emit_artifacts.score_quantiles). An equal share of
// segments lands in every colour whatever the distribution's shape, and
// the legend's "Score percentile" labels become literally true.
//
// Returns null unless the value is a usable ramp: one finite, strictly
// increasing number per colour. MapLibre throws on repeated stops, and a
// bad manifest must not take the map down — the caller falls back to the
// fixed domain, which is the old behaviour.
export function parseScoreBreaks(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== SCORE_COLORS.length) return null;
  const out: number[] = [];
  for (const raw of value) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    if (out.length > 0 && raw <= out[out.length - 1]) return null;
    out.push(raw);
  }
  return out;
}

// The evenly spaced fallback breaks across the full score domain.
export function defaultScoreBreaks(): number[] {
  const span = SCORE_DOMAIN_MAX - SCORE_DOMAIN_MIN;
  const lastIndex = SCORE_COLORS.length - 1;
  return SCORE_COLORS.map((_, i) => SCORE_DOMAIN_MIN + (span * i) / lastIndex);
}

// Build a MapLibre colour ramp over `breaks` for a numeric property.
// Both the snapshot layer and the live overlay use this, so their colours
// cannot drift apart.
export function scoreRampExpression(
  property: string,
  breaks: readonly number[],
): unknown[] {
  const stops: Array<number | string> = [];
  for (let i = 0; i < SCORE_COLORS.length; i += 1) {
    const color = SCORE_COLORS[i];
    stops.push(breaks[i]);
    stops.push(`rgb(${color[0]}, ${color[1]}, ${color[2]})`);
  }
  return ['interpolate', ['linear'], ['get', property], ...stops];
}

// A single feature layer draws one normalized feature instead of the
// composite score, so a degenerate feature is visible on the map rather
// than only findable by reading the parquet.
//
// Feature values are min-max normalized to [0, 1] by the pipeline, and
// this ramp is linear over that range on purpose. The score ramp uses
// deciles, which spread any distribution across all 11 colours and would
// therefore hide exactly what this view exists to show: a feature that is
// 0 nearly everywhere must look flat, not colourful.
export function featureBreaks(): number[] {
  const lastIndex = SCORE_COLORS.length - 1;
  return SCORE_COLORS.map((_, i) => i / lastIndex);
}

// The paint expression for a feature layer. The value arrives through
// feature state, set from features.parquet, because the tiles carry only
// id and score: all 19 features quantised into the tiles measured 104.3
// MiB against GitHub Pages' 100 MiB per-file limit.
//
// A segment with no state yet — its row missing, or the table still
// loading — paints in NO_DATA_COLOR rather than defaulting to the bottom
// of the ramp, so "no value" never masquerades as "value 0". That
// distinction is the whole point of this view.
export const NO_DATA_COLOR = 'rgb(120, 120, 120)';

export function featureRampExpression(breaks: readonly number[]): unknown[] {
  const stops: Array<number | string> = [];
  for (let i = 0; i < SCORE_COLORS.length; i += 1) {
    const color = SCORE_COLORS[i];
    stops.push(breaks[i]);
    stops.push(`rgb(${color[0]}, ${color[1]}, ${color[2]})`);
  }
  return [
    'case',
    ['==', ['feature-state', 'featureValue'], null],
    NO_DATA_COLOR,
    ['interpolate', ['linear'], ['to-number', ['feature-state', 'featureValue']], ...stops],
  ];
}

// Where a score sits on the ramp, 0-100. With decile breaks this is the
// segment's true percentile among the snapshot's segments, which is what
// the breakdown panel claims to show.
export function scoreToPercent(score: number, breaks: readonly number[]): number {
  const last = breaks.length - 1;
  if (score <= breaks[0]) return 0;
  if (score >= breaks[last]) return 100;
  for (let i = 0; i < last; i += 1) {
    const lo = breaks[i];
    const hi = breaks[i + 1];
    if (score <= hi) {
      const withinBand = hi === lo ? 0 : (score - lo) / (hi - lo);
      return ((i + withinBand) / last) * 100;
    }
  }
  return 100;
}

// One deployment location with its field-video time range.
// coords keeps the legacy [lat, lon] order of the source file.
export type DeploymentSite = {
  readonly coords: readonly [number, number]; // [lat, lon], legacy order
  readonly videoId: string;
  readonly startTime: number; // seconds
  readonly endTime: number; // seconds
};

// The four deployment locations with their video time ranges.
// Provenance: src/components/custom/RobotabilityMap.jsx, lines 44-69.
// The keys and values are copied verbatim from the legacy map.
// T9 imports this constant for the deployment markers. Do not alter it.
export const DEPLOYMENTS: Readonly<Record<string, DeploymentSite>> = {
  'Elmhurst, Queens': {
    coords: [40.738536, -73.887267],
    videoId: 'o52MZ1AHyjA',
    startTime: 44,
    endTime: 62,
  },
  'Sutton Place, Manhattan': {
    coords: [40.75889, -73.958457],
    videoId: 'o52MZ1AHyjA',
    startTime: 21,
    endTime: 43,
  },
  'Herald Square, Manhattan': {
    coords: [40.748422, -73.988275],
    videoId: 'o52MZ1AHyjA',
    startTime: 63,
    endTime: 83,
  },
  'Jackson Heights, Queens': {
    coords: [40.747379, -73.88969],
    videoId: 'o52MZ1AHyjA',
    startTime: 85,
    endTime: 100,
  },
};
