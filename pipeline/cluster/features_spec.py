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

# Slope gradient neighbour search. score.ipynb cell 36 takes the 10
# nearest neighbours within 50 ft, in EPSG:2263, so the 50 really is
# feet and the port carried it faithfully. The radius still had to go.
#
# The research ran over about 465k sampled POINTS along the sidewalks.
# The pipeline runs over one centroid per SEGMENT, which are far sparser
# (median nearest neighbour 26.5 ft). The same 50 ft therefore stopped
# meaning what it meant: 35.25% of segments found no neighbour at all and
# took the 0.0 fallback, so "could not measure" was written to the same
# column, and with the same value, as "flat". Taking the 10 nearest
# without a radius drops that to 0.70% and keeps the research's real
# intent, which is the ten nearest neighbours.
SLOPE_MAX_NEIGHBORS = 10

# Ignore neighbours closer than this. Slope is |height difference| over
# distance, and the code used to exclude only distance == 0. Centroids
# come as close as 0.000079 ft, a thousandth of an inch, so a single
# one-foot DEM step across that gap produced a slope near 100. The
# observed maximum was 7.69 against a p99 of 0.166, and min-max
# normalization then divided every real value by that outlier.
#
# 5 ft is where the DEM's own quantisation stops dominating: the DEM is
# integer feet, so the smallest non-zero height difference it can report
# is 1 ft, which over 5 ft is already a 20% grade.
SLOPE_MIN_BASELINE_FT = 5.0

# Clip the mean slope here before normalizing. A fixed physical ceiling
# rather than a percentile of the run, so the value does not depend on
# which segments happen to be in the snapshot.
#
# 0.30 is a 30% grade. NYC's steepest street is about 32% and an ADA
# ramp maxes at 8.3%, so nothing above this is a sidewalk a robot
# traverses; it is the integer DEM divided by a short baseline. The
# citywide p99.9 is 0.2963, so this clips about 0.1% of segments.
#
# On a full-city run enough segments clip that min_max_normalize sees a
# maximum of exactly this value, which makes the normalized feature read
# as a fraction of a 30% grade. A small bbox run need not contain one,
# and there the window is still whatever that extract spans, as it is
# for every other feature.
SLOPE_MAX_GRADE = 0.30

