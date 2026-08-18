"""Deterministic synthetic data for mock mode.

Task T5 spec: --mock-lab-data generates synthetic lab columns. The same seed
and bbox always produce the same bytes. The column set mirrors the raw
columns of dataset.ipynb cell 116 (score_dataset.csv).
"""

import random
from typing import Dict, List, Optional, Tuple

from features_spec import SLOPE_BASELINE_FT

LAB_INPUTS = ('dashcam_detections', 'surveillance_values', 'dem')

# Fallback area for mock runs without --bbox. It matches the RUNBOOK
# small-area test box.
DEFAULT_MOCK_BBOX = (-73.99, 40.74, -73.97, 40.76)

GRID_ROWS = 12
GRID_COLS = 12
# Tight spacing keeps neighbor centroids within the 50 ft slope radius.
MAX_LON_STEP_DEG = 0.00012
MAX_LAT_STEP_DEG = 0.00015
SEGMENT_HALF_LEN_DEG = 0.00004

ZONEDIST_CHOICES = ('M1-4', 'R6', 'C4-2', 'PARK', '')
SPEED_LIMIT_CHOICES = (25.0, 30.0, 35.0, float('nan'))
BIKE_CLASS_CHOICES = (0.0, 0.5, 1.0, 2.0, 3.0, float('nan'))
# ped_demand holds 6 - rank from the DOT Pedestrian Demand Map, so 5 is
# a Global Corridor and 1 is Citywide Baseline. The real distribution is
# heavily weighted to baseline: 64975 of about 127000 DOT segments are
# baseline, and only 851 are Global Corridors. These repeats approximate
# that shape so a mock run exercises a realistic spread instead of a
# uniform one. There is no NaN member: every segment takes a level, and
# the ones with no DOT street within 200 ft take baseline. See
# features_join.join_pedestrian_demand.
PED_DEMAND_CHOICES = (1.0, 1.0, 1.0, 1.0, 2.0, 2.0, 3.0, 4.0, 5.0)


def generate_mock(bbox: Tuple[float, float, float, float], seed: int,
                  simulate_missing: Optional[str]) -> Tuple[Dict[str, list], List[str]]:
    """Generate the deterministic synthetic table for mock mode.

    The same seed and bbox always produce the same bytes. The grid holds
    GRID_ROWS x GRID_COLS short LineString segments inside the bbox.
    """
    minlon, minlat, maxlon, maxlat = bbox
    lon_step = min((maxlon - minlon) / GRID_COLS, MAX_LON_STEP_DEG)
    lat_step = min((maxlat - minlat) / GRID_ROWS, MAX_LAT_STEP_DEG)
    rng = random.Random(seed)
    n = GRID_ROWS * GRID_COLS

    segment_ids: List[int] = []
    geometries: List[str] = []
    elevations: List[float] = []
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            sid = row * GRID_COLS + col
            lon = minlon + lon_step * (col + 0.5)
            lat = minlat + lat_step * (row + 0.5)
            segment_ids.append(sid)
            geometries.append(
                f'LINESTRING ({lon - SEGMENT_HALF_LEN_DEG} {lat}, '
                f'{lon + SEGMENT_HALF_LEN_DEG} {lat})')
            elevations.append(10.0 + 0.5 * row + 0.25 * col + rng.random() * 0.5)

    dashcam_missing = simulate_missing == 'dashcam_detections'
    surveillance_missing = simulate_missing == 'surveillance_values'
    dem_missing = simulate_missing == 'dem'

    def counts(scale: float) -> List[float]:
        return [0.0 if dashcam_missing else rng.random() * scale for _ in range(n)]

    columns: Dict[str, list] = {
        'segment_id': segment_ids,
        'geometry_wkt': geometries,
        # Stands in for sample_dem: a height at each end of the slope
        # baseline and the distance sampled. The rise varies by row so
        # the mock carries a spread of grades rather than one value.
        'dem_ft_start': [float('nan') if dem_missing else e
                         for e in elevations],
        'dem_ft_end': [float('nan') if dem_missing
                       else e + (i % 7) * 0.25
                       for i, e in enumerate(elevations)],
        'dem_run_ft': [float('nan') if dem_missing else SLOPE_BASELINE_FT
                       for _ in range(n)],
        'width': [4.0 + rng.random() * 10.0 for _ in range(n)],
        'TRAFFIC_Pedestrian': counts(15.0),
        'TRAFFIC_Bike': counts(5.0),
        'TRAFFIC_Car': counts(20.0),
        'clutter': [rng.random() * 8.0 for _ in range(n)],
        'sidewalk_quality': [float('nan') if i % 7 == 3 else 40.0 + rng.random() * 55.0
                             for i in range(n)],
        '4g_minup': [float(rng.choice((0, 0, 5, 10, 50))) for _ in range(n)],
        '4g_mindown': [float(rng.choice((0, 0, 5, 10, 50))) for _ in range(n)],
        'distance_to_nearest_station': [50.0 + rng.random() * 1500.0 for _ in range(n)],
        'CURBRAMP_count': [float(rng.randint(0, 3)) for _ in range(n)],
        'ZONEDIST': [rng.choice(ZONEDIST_CHOICES) for _ in range(n)],
        'in_slow_zone': [float(rng.randint(0, 1)) for _ in range(n)],
        'turn_traffic_calming_count': [float(rng.randint(0, 2)) for _ in range(n)],
        'sip_intersections_count': [float(rng.randint(0, 2)) for _ in range(n)],
        'sip_corridors_count': [float(rng.randint(0, 2)) for _ in range(n)],
        'barnes_intersections_count': [float(rng.randint(0, 2)) for _ in range(n)],
        'leading_ped_intervals_count': [float(rng.randint(0, 2)) for _ in range(n)],
        'n_cameras_median': [0.0 if surveillance_missing else float(rng.randint(0, 4))
                             for _ in range(n)],
        'avg_speed_limit': [rng.choice(SPEED_LIMIT_CHOICES) for _ in range(n)],
        'highest_bike_lane_facility_class': [rng.choice(BIKE_CLASS_CHOICES) for _ in range(n)],
        'num_peds_involved_in_collision': [
            float('nan') if i % 11 == 5 else float(rng.randint(0, 3)) for i in range(n)],
        # Keep this entry last. Each column draws from the shared rng in
        # the order it appears here, so inserting one higher up shifts
        # every column below it and changes the mock bytes for no reason.
        'ped_demand': [float(rng.choice(PED_DEMAND_CHOICES)) for _ in range(n)],
    }
    missing = [name for name, flag in (
        ('dashcam_detections', dashcam_missing),
        ('surveillance_values', surveillance_missing),
        ('dem', dem_missing),
    ) if flag]
    return columns, missing


