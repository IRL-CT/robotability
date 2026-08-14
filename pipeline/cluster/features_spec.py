"""Feature spec constants: names, polarities, and ported notebook constants.

Sources: pipeline/contract/cluster_contract.md section 3.2 (parquet column
order), score.ipynb cell 96 (polarities), cells 26/76/86 (constant-one
features), cell 58 (traffic-management sum), cell 36 (slope search).
"""

from typing import Dict, List

# FEATURES lists the 19 computed features in exact parquet column order.
# Source: pipeline/contract/cluster_contract.md section 3.2.
FEATURES: List[str] = [
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
]

# POLARITIES holds the exact signs from score.ipynb cell 96 for the 19
# computed features. +1 means "more is better". -1 means "more is worse".
# The cell lists 24 features. Only the 19 computed features appear here,
# because only they exist in the parquet contract. The five excluded names
# (local_attitudes, weather_conditions, street_lighting, shade_availability,
# pedestrian_flow) never get a column in score.ipynb.
POLARITIES: Dict[str, int] = {
    'sidewalk_width': 1,
    'pedestrian_density': -1,
    'street_furniture_density': -1,
    'sidewalk_roughness': -1,
    'surface_condition': 1,
    'communication_infrastructure': 1,
    'slope_gradient': -1,
    'charging_station_proximity': 1,
    'curb_ramp_availability': 1,
    'crowd_dynamics': 1,
    'traffic_management': 1,
    'surveillance_coverage': 1,
    'zoning_laws': 1,
    'bike_lane_availability': 1,
    'gps_signal_strength': 1,
    'bicycle_traffic': -1,
    'vehicle_traffic': -1,
    'digital_map_existence': 1,
    'intersection_safety': -1,
}

# These three features skip preprocessing in score.ipynb. Cells 26, 76 and 86
# set the normalized value to 1 directly. Do not run min-max on them.
CONSTANT_ONE_FEATURES = (
    'sidewalk_roughness',
    'gps_signal_strength',
    'digital_map_existence',
)

# The six traffic-management count columns. score.ipynb cell 58 sums them.
TRAFFIC_MANAGEMENT_COLUMNS = (
    'in_slow_zone',
    'turn_traffic_calming_count',
    'sip_intersections_count',
    'sip_corridors_count',
    'barnes_intersections_count',
    'leading_ped_intervals_count',
)

# Slope neighbor search radius and neighbor cap from score.ipynb cell 36.
SLOPE_RADIUS_FT = 50.0
SLOPE_MAX_NEIGHBORS = 10

