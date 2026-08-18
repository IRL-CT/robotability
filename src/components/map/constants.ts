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
// The evenly spaced fallback ramp over the normalized [0, 1] range.
// Used only when a feature column yields no usable quantiles, which
// means every value is NaN or the column is empty.
export function featureBreaks(): number[] {
  const lastIndex = SCORE_COLORS.length - 1;
  return SCORE_COLORS.map((_, i) => i / lastIndex);
}

// The next representable double above `value`. MapLibre rejects an
// interpolate expression whose stops repeat, and a skewed feature ties
// its low stops constantly, so a repeat has to be nudged rather than
// dropped. JavaScript has no Math.nextafter, so step the IEEE-754 bit
// pattern by one. This mirrors math.nextafter in the cluster's
// emit_artifacts.score_quantiles.
function nextUp(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  new Float64Array(buffer)[0] = value;
  const bits = new BigInt64Array(buffer);
  bits[0] += value > 0 ? 1n : -1n;
  return new Float64Array(buffer)[0];
}

// Evenly spaced quantiles of the finite values, one per ramp colour.
//
// A linear ramp over [0, 1] renders most features as one flat colour.
// The pipeline min-max normalizes each feature, so the column spans the
// full range, but the distributions are heavily skewed: slope_gradient
// puts 81.7% of the 2026 city in the first bucket and
// intersection_safety puts 96.3% there. Ten of the eleven colours never
// appeared, exactly as they did not for the score before it shipped its
// own breaks.
//
// Quantiles put an equal share of segments in every colour whatever the
// shape of the distribution. The legend labels a feature by percentile
// to match, so the colour keeps a true meaning.
//
// The result is strictly increasing. Returns null when no finite value
// exists, so the caller falls back to the linear ramp.
export function quantileBreaks(
  values: readonly number[],
  count: number = SCORE_COLORS.length
): number[] | null {
  const finite: number[] = [];
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0 || count < 2) return null;
  finite.sort((a, b) => a - b);
  const last = finite.length - 1;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const pos = (last * i) / (count - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, last);
    const frac = pos - lo;
    let value = finite[lo] + (finite[hi] - finite[lo]) * frac;
    if (out.length > 0 && value <= out[out.length - 1]) {
      value = nextUp(out[out.length - 1]);
    }
    out.push(value);
  }
  return out;
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

// Red always means worse for a robot, on every layer.
//
// The ramp runs dark red to dark green, and the score layer reads it
// directly because a high score is good. A feature does not: seven of
// the nineteen carry polarity -1, where a high value is what harms the
// score. Painting those the same way put flat Lower East Side blocks in
// red and the hills of the Bronx in green, the wrong way round on both
// counts, because low slope took the low end of the ramp.
//
// So a negative-polarity feature reads the colours in reverse. The
// breaks stay in ascending order, which MapLibre requires; only the
// colour paired with each one flips.
export function featureRampExpression(
  breaks: readonly number[],
  polarity: number = 1
): unknown[] {
  const stops: Array<number | string> = [];
  const last = SCORE_COLORS.length - 1;
  for (let i = 0; i < SCORE_COLORS.length; i += 1) {
    const color = SCORE_COLORS[polarity < 0 ? last - i : i];
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
