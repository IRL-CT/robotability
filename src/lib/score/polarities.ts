/**
 * Feature polarities for the Robotability score.
 *
 * Source: robotability-nyc/feature_processing/score.ipynb cell 96
 * (POLARITIES dict), restricted to the 19 computed features.
 * +1 means more of the feature raises the score.
 * -1 means more of the feature lowers the score.
 */

import type { Feature } from './weights.ts';

export const POLARITIES: Record<Feature, 1 | -1> = {
  // Wider sidewalks help robots. score.ipynb cell 96.
  sidewalk_width: 1,
  // More pedestrians hinder robots. score.ipynb cell 96.
  pedestrian_density: -1,
  // More street furniture hinders robots. score.ipynb cell 96.
  street_furniture_density: -1,
  // Rougher sidewalks hinder robots. score.ipynb cell 96.
  sidewalk_roughness: -1,
  // Better surface condition helps robots. score.ipynb cell 96.
  surface_condition: 1,
  // Better connectivity helps robots. score.ipynb cell 96.
  communication_infrastructure: 1,
  // Steeper slopes hinder robots. score.ipynb cell 96.
  slope_gradient: -1,
  // Nearby charging helps robots. score.ipynb cell 96.
  charging_station_proximity: 1,
  // More curb ramps help robots. score.ipynb cell 96.
  curb_ramp_availability: 1,
  // Crowd dynamics factor helps robots. score.ipynb cell 96.
  crowd_dynamics: 1,
  // Traffic calming helps robots. score.ipynb cell 96.
  traffic_management: 1,
  // Camera coverage helps robots. score.ipynb cell 96.
  surveillance_coverage: 1,
  // Favorable zoning helps robots. score.ipynb cell 96.
  zoning_laws: 1,
  // Bike lanes help robots. score.ipynb cell 96.
  bike_lane_availability: 1,
  // Strong GPS helps robots. score.ipynb cell 96.
  gps_signal_strength: 1,
  // More bike traffic hinders robots. score.ipynb cell 96.
  bicycle_traffic: -1,
  // More vehicle traffic hinders robots. score.ipynb cell 96.
  vehicle_traffic: -1,
  // A digital map helps robots. score.ipynb cell 96.
  digital_map_existence: 1,
  // More incidents mean worse safety. score.ipynb cell 96 says
  // "num incidents, so more is worse".
  intersection_safety: -1,
};
