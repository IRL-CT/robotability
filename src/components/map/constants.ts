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
