/**
 * Survey weights for the Robotability score.
 *
 * Source of every value: robotability-nyc/survey_processing/feature_weights.csv
 * (19 rows, weights sum to 1.0). The pinned sha256 of that file is in
 * pipeline/contract/cluster_contract.md. Do not edit these values by hand.
 */

/** The 19 computed features. The names match feature_weights.csv exactly. */
export type Feature =
  | 'sidewalk_width'
  | 'pedestrian_density'
  | 'street_furniture_density'
  | 'sidewalk_roughness'
  | 'surface_condition'
  | 'communication_infrastructure'
  | 'slope_gradient'
  | 'charging_station_proximity'
  | 'curb_ramp_availability'
  | 'crowd_dynamics'
  | 'traffic_management'
  | 'surveillance_coverage'
  | 'zoning_laws'
  | 'bike_lane_availability'
  | 'gps_signal_strength'
  | 'bicycle_traffic'
  | 'vehicle_traffic'
  | 'digital_map_existence'
  | 'intersection_safety';

/** Feature names in feature_weights.csv order. The engine sums in this order. */
export const FEATURES: readonly Feature[] = [
  'sidewalk_width',
  'pedestrian_density',
  'street_furniture_density',
  'sidewalk_roughness',
  'surface_condition',
  'communication_infrastructure',
  'slope_gradient',
  'charging_station_proximity',
  'curb_ramp_availability',
  'crowd_dynamics',
  'traffic_management',
  'surveillance_coverage',
  'zoning_laws',
  'bike_lane_availability',
  'gps_signal_strength',
  'bicycle_traffic',
  'vehicle_traffic',
  'digital_map_existence',
  'intersection_safety',
];

/**
 * Weight per feature. Each literal is copied verbatim from the Weight
 * column of feature_weights.csv. The comment names the source row.
 */
export const WEIGHTS: Record<Feature, number> = {
  // feature_weights.csv, Feature=sidewalk_width
  sidewalk_width: 0.06806833613639274,
  // feature_weights.csv, Feature=pedestrian_density
  pedestrian_density: 0.09445576675004053,
  // feature_weights.csv, Feature=street_furniture_density
  street_furniture_density: 0.06752114455511304,
  // feature_weights.csv, Feature=sidewalk_roughness
  sidewalk_roughness: 0.04593514200834298,
  // feature_weights.csv, Feature=surface_condition
  surface_condition: 0.07682933579593197,
  // feature_weights.csv, Feature=communication_infrastructure
  communication_infrastructure: 0.05845165469318187,
  // feature_weights.csv, Feature=slope_gradient
  slope_gradient: 0.04832231448153131,
  // feature_weights.csv, Feature=charging_station_proximity
  charging_station_proximity: 0.025316489931061576,
  // feature_weights.csv, Feature=curb_ramp_availability
  curb_ramp_availability: 0.060102970276542725,
  // feature_weights.csv, Feature=crowd_dynamics
  crowd_dynamics: 0.07621927189475182,
  // feature_weights.csv, Feature=traffic_management
  traffic_management: 0.04638333896814371,
  // feature_weights.csv, Feature=surveillance_coverage
  surveillance_coverage: 0.02281272971765975,
  // feature_weights.csv, Feature=zoning_laws
  zoning_laws: 0.04146601033693057,
  // feature_weights.csv, Feature=bike_lane_availability
  bike_lane_availability: 0.022603749599280413,
  // feature_weights.csv, Feature=gps_signal_strength
  gps_signal_strength: 0.048359700811054354,
  // feature_weights.csv, Feature=bicycle_traffic
  bicycle_traffic: 0.03068282361247861,
  // feature_weights.csv, Feature=vehicle_traffic
  vehicle_traffic: 0.04745443062510741,
  // feature_weights.csv, Feature=digital_map_existence
  digital_map_existence: 0.04850786858987462,
  // feature_weights.csv, Feature=intersection_safety
  intersection_safety: 0.07050692121657998,
};
