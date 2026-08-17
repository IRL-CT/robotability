#!/usr/bin/env python3
"""Unit test for compute_score.py.

Checks the score arithmetic against three hand-computed reference rows.
The expected scores come straight from the formula in score.ipynb cell 97:

    score = sum over 19 features of polarity * normalized * weight

Weights are the exact values from feature_weights.csv (vendored as
pipeline/cluster/weights.csv). Polarities are the exact values from
score.ipynb cell 96. Run with plain python:

    python3 pipeline/cluster/tests/test_compute_score.py

Exit code 0 means every check passed.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import compute_score as cs  # noqa: E402

# ---------------------------------------------------------------------------
# Ground truth literals. Copied from feature_weights.csv. Each weight sum
# below is a hand computation. Do not recompute them from the module under
# test. That would make the test a tautology.
# ---------------------------------------------------------------------------

W_SIDEWALK_WIDTH = 0.06806833613639274
W_PEDESTRIAN_DENSITY = 0.09445576675004053
W_STREET_FURNITURE_DENSITY = 0.06752114455511304
W_SIDEWALK_ROUGHNESS = 0.04593514200834298
W_SURFACE_CONDITION = 0.07682933579593197
W_COMMUNICATION_INFRASTRUCTURE = 0.05845165469318187
W_SLOPE_GRADIENT = 0.04832231448153131
W_CHARGING_STATION_PROXIMITY = 0.025316489931061576
W_CURB_RAMP_AVAILABILITY = 0.060102970276542725
W_CROWD_DYNAMICS = 0.07621927189475182
W_TRAFFIC_MANAGEMENT = 0.04638333896814371
W_SURVEILLANCE_COVERAGE = 0.02281272971765975
W_ZONING_LAWS = 0.04146601033693057
W_BIKE_LANE_AVAILABILITY = 0.022603749599280413
W_GPS_SIGNAL_STRENGTH = 0.048359700811054354
W_BICYCLE_TRAFFIC = 0.03068282361247861
W_VEHICLE_TRAFFIC = 0.04745443062510741
W_DIGITAL_MAP_EXISTENCE = 0.04850786858987462
W_INTERSECTION_SAFETY = 0.07050692121657998

# Hand sum of the 12 positive-polarity weights (cell 96 signs).
POS_SUM = (
    W_SIDEWALK_WIDTH + W_SURFACE_CONDITION + W_COMMUNICATION_INFRASTRUCTURE
    + W_CHARGING_STATION_PROXIMITY + W_CURB_RAMP_AVAILABILITY + W_CROWD_DYNAMICS
    + W_TRAFFIC_MANAGEMENT + W_SURVEILLANCE_COVERAGE + W_ZONING_LAWS
    + W_BIKE_LANE_AVAILABILITY + W_GPS_SIGNAL_STRENGTH + W_DIGITAL_MAP_EXISTENCE
)
# Hand sum of the 7 negative-polarity weights (cell 96 signs).
NEG_SUM = (
    W_PEDESTRIAN_DENSITY + W_STREET_FURNITURE_DENSITY + W_SIDEWALK_ROUGHNESS
    + W_SLOPE_GRADIENT + W_BICYCLE_TRAFFIC + W_VEHICLE_TRAFFIC
    + W_INTERSECTION_SAFETY
)

FAILURES = []


def check(name: str, got: float, want: float, tol: float = 1e-12) -> None:
    if math.isfinite(got) and abs(got - want) <= tol:
        print(f"ok   {name}: {got!r}")
    else:
        print(f"FAIL {name}: got {got!r}, want {want!r}")
        FAILURES.append(name)


# ---------------------------------------------------------------------------
# Reference rows for score_normalized. Three rows, hand-built:
#   row A: every non-constant feature normalized to 0, constants at 1
#   row B: every feature normalized to 1
#   row C: positive features at 0, negative features at 1, constants at 1
# sidewalk_roughness, gps_signal_strength, digital_map_existence are the
# three constant features. score.ipynb cells 26, 76, 86 set them to 1
# without min-max preprocessing.
# ---------------------------------------------------------------------------

def build_reference_rows() -> dict:
    rows = {f: [0.0, 0.0, 0.0] for f in cs.FEATURES}
    for f in cs.FEATURES:
        pol = cs.POLARITIES[f]
        if f in ('sidewalk_roughness', 'gps_signal_strength', 'digital_map_existence'):
            rows[f] = [1.0, 1.0, 1.0]
        elif pol > 0:
            rows[f] = [0.0, 1.0, 0.0]
        else:
            rows[f] = [0.0, 1.0, 1.0]
    return rows


def test_score_normalized_reference_rows() -> None:
    normalized = build_reference_rows()
    scores = cs.score_normalized(normalized)
    # Row A: only the constants contribute.
    #   -1*1*W_ROUGHNESS + 1*1*W_GPS + 1*1*W_DDM
    want_a = -W_SIDEWALK_ROUGHNESS + W_GPS_SIGNAL_STRENGTH + W_DIGITAL_MAP_EXISTENCE
    # Row B: all 19 features at 1.
    #   POS_SUM - NEG_SUM
    want_b = POS_SUM - NEG_SUM
    # Row C: all negative features at 1, positive non-constants at 0.
    #   -NEG_SUM + W_GPS + W_DDM
    want_c = -NEG_SUM + W_GPS_SIGNAL_STRENGTH + W_DIGITAL_MAP_EXISTENCE
    check('reference row A score', scores[0], want_a)
    check('reference row B score', scores[1], want_b)
    check('reference row C score', scores[2], want_c)
    # Pinned literals. They guard the hand sums above against typos.
    check('row A pinned literal', scores[0], 0.050932427392585994)
    check('row B pinned literal', scores[1], 0.1902429135016122)
    check('row C pinned literal', scores[2], -0.3080109738482649)


def test_min_max_normalize() -> None:
    got = cs.min_max_normalize([0.0, 1.0, 0.0])
    check('minmax low', got[0], 0.0)
    check('minmax high', got[1], 1.0)
    check('minmax low again', got[2], 0.0)
    # A constant column returns all zeros. This matches score.ipynb cell 1.
    got = cs.min_max_normalize([4.0, 4.0, 4.0])
    check('minmax constant row 0', got[0], 0.0)
    check('minmax constant row 1', got[1], 0.0)
    # NaN positions stay NaN. min and max skip them.
    got = cs.min_max_normalize([0.0, float('nan'), 2.0])
    check('minmax nan kept', 1.0 if math.isnan(got[1]) else -1.0, 1.0)
    check('minmax with nan endpoint', got[2], 1.0)


def test_normalize_features_raw_semantics() -> None:
    n = 3
    raw = {
        'width': [5.0, 10.0, 5.0],
        'TRAFFIC_Pedestrian': [0.0, 4.0, 4.0],
        # DOT demand level, 1 quiet to 5 busy. Normalizes to the
        # same [0, 1, 1] the dashcam column gave, so the score
        # literals below are unaffected by the source swap.
        'ped_demand': [1.0, 5.0, 5.0],
        'TRAFFIC_Bike': [0.0, 2.0, 2.0],
        'TRAFFIC_Car': [0.0, 8.0, 8.0],
        'clutter': [0.0, 3.0, 3.0],
        'sidewalk_quality': [1.0, 3.0, 1.0],
        '4g_minup': [1.0, 5.0, 0.0],
        '4g_mindown': [1.0, 5.0, 0.0],
        'ft_above_sea': [10.0, 10.0, 10.0],
        'distance_to_nearest_station': [200.0, 100.0, 200.0],
        'CURBRAMP_count': [0.0, 2.0, 2.0],
        'ZONEDIST': ['C4-2', 'M1-4', 'R6'],
        'in_slow_zone': [0.0, 1.0, 1.0],
        'turn_traffic_calming_count': [0.0, 1.0, 1.0],
        'sip_intersections_count': [0.0, 1.0, 1.0],
        'sip_corridors_count': [0.0, 1.0, 1.0],
        'barnes_intersections_count': [0.0, 1.0, 1.0],
        'leading_ped_intervals_count': [0.0, 1.0, 1.0],
        'n_cameras_median': [0.0, 5.0, 5.0],
        'avg_speed_limit': [20.0, 30.0, 20.0],
        'highest_bike_lane_facility_class': [0.0, 3.0, 3.0],
        'num_peds_involved_in_collision': [0.0, 2.0, 2.0],
    }
    out = cs.normalize_features(raw, n, slope_raw=[0.0, 0.0, 0.0])
    # communication_infrastructure: 1 only when both 4g values exceed 0.
    check('comm_infra row 0', out['communication_infrastructure'][0], 1.0)
    check('comm_infra row 2', out['communication_infrastructure'][2], 0.0)
    # crowd_dynamics: C->0, M->10, R->5, then min-max. Rows give [0,10,5].
    check('crowd row 0 (C)', out['crowd_dynamics'][0], 0.0)
    check('crowd row 1 (M)', out['crowd_dynamics'][1], 1.0)
    check('crowd row 2 (R)', out['crowd_dynamics'][2], 0.5)
    # charging_station_proximity: (RANGE - d)/RANGE with RANGE = max(d) = 200.
    # d = [200, 100, 200] -> [0.0, 0.5, 0.0], then min-max keeps [0, 1, 0].
    check('charging row 1', out['charging_station_proximity'][1], 1.0)
    check('charging row 0', out['charging_station_proximity'][0], 0.0)
    # Constants always equal 1.
    check('roughness constant', out['sidewalk_roughness'][0], 1.0)
    check('gps constant', out['gps_signal_strength'][2], 1.0)
    check('ddm constant', out['digital_map_existence'][1], 1.0)


def test_aggregate_segment_scores() -> None:
    # Two segments. Segment 10 holds two points, segment 20 holds one.
    got = cs.aggregate_segment_scores([0.1, 0.3, -0.2], [10, 10, 20])
    check('segment 10 mean', got[10], 0.2)
    check('segment 20 mean', got[20], -0.2)


def test_raw_to_score_integration() -> None:
    # Three segments far apart, so no slope neighbors exist. The slope
    # raw value is 0 for every row and normalizes to 0. Every other
    # column follows the reference pattern [0, 1, 0] for positive-polarity
    # features and [0, 1, 1] for negative-polarity features.
    raw = {
        'width': [5.0, 10.0, 5.0],
        'TRAFFIC_Pedestrian': [0.0, 4.0, 4.0],
        # DOT demand level, 1 quiet to 5 busy. Normalizes to the
        # same [0, 1, 1] the dashcam column gave, so the score
        # literals below are unaffected by the source swap.
        'ped_demand': [1.0, 5.0, 5.0],
        'TRAFFIC_Bike': [0.0, 2.0, 2.0],
        'TRAFFIC_Car': [0.0, 8.0, 8.0],
        'clutter': [0.0, 3.0, 3.0],
        'sidewalk_quality': [1.0, 3.0, 1.0],
        # Row A has a zero upload rate, so the comm indicator stays 0.
        '4g_minup': [0.0, 5.0, 0.0],
        '4g_mindown': [1.0, 5.0, 0.0],
        'ft_above_sea': [10.0, 10.0, 10.0],
        'distance_to_nearest_station': [200.0, 0.0, 200.0],
        'CURBRAMP_count': [0.0, 2.0, 0.0],
        # Empty string maps to 0, like a missing zoning value.
        'ZONEDIST': ['C4-2', 'M1-4', ''],
        'in_slow_zone': [0.0, 1.0, 0.0],
        'turn_traffic_calming_count': [0.0, 1.0, 0.0],
        'sip_intersections_count': [0.0, 1.0, 0.0],
        'sip_corridors_count': [0.0, 1.0, 0.0],
        'barnes_intersections_count': [0.0, 1.0, 0.0],
        'leading_ped_intervals_count': [0.0, 1.0, 0.0],
        'n_cameras_median': [0.0, 5.0, 0.0],
        'avg_speed_limit': [20.0, 30.0, 20.0],
        'highest_bike_lane_facility_class': [0.0, 3.0, 0.0],
        'num_peds_involved_in_collision': [0.0, 2.0, 2.0],
    }
    n = 3
    normalized = cs.normalize_features(raw, n, slope_raw=[0.0, 0.0, 0.0])
    scores = cs.score_normalized(normalized)
    # Row A: only the constants contribute.
    want_a = -W_SIDEWALK_ROUGHNESS + W_GPS_SIGNAL_STRENGTH + W_DIGITAL_MAP_EXISTENCE
    # Row B: positive features at 1. Negative features at 1 except slope.
    want_b = POS_SUM - (NEG_SUM - W_SLOPE_GRADIENT)
    # Row C: positive non-constants at 0. Negative features at 1 except slope.
    want_c = -(NEG_SUM - W_SLOPE_GRADIENT) + W_GPS_SIGNAL_STRENGTH + W_DIGITAL_MAP_EXISTENCE
    check('integration row A score', scores[0], want_a)
    check('integration row B score', scores[1], want_b)
    check('integration row C score', scores[2], want_c)
    check('integration row A literal', scores[0], 0.050932427392585994)
    check('integration row B literal', scores[1], 0.2385652279831435)
    check('integration row C literal', scores[2], -0.25968865936673363)


def main() -> int:
    test_score_normalized_reference_rows()
    test_min_max_normalize()
    test_normalize_features_raw_semantics()
    test_aggregate_segment_scores()
    test_raw_to_score_integration()
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} check(s) FAILED")
        return 1
    print("RESULT: all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
