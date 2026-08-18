"""Core score math for the cluster pipeline. Pure functions only.

Port of robotability-nyc/feature_processing/score.ipynb (normalize, weight,
polarity, sum) plus the segment aggregation of score_by_sidewalk.ipynb.
See NOTEBOOK_TRACE.md for the cell-by-cell mapping.

The formula is unchanged from the CHI '25 metric:

    score(point)   = sum over 19 features of polarity * normalized * weight
    score(segment) = mean of the point scores on the segment
"""


import math
import os
import sys
from typing import Dict, List, Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

from features_spec import (  # noqa: E402,F401
    FEATURES, POLARITIES, CONSTANT_ONE_FEATURES,
    TRAFFIC_MANAGEMENT_COLUMNS, SLOPE_BASELINE_FT, SLOPE_MAX_GRADE,
)


def load_weights(path: Optional[str] = None) -> Dict[str, float]:
    """Read the vendored weights. Skip provenance comment lines.

    Source: score.ipynb cell 9 reads feature_weights.csv the same way.
    """
    if path is None:
        path = pc.weights_csv_path()
    weights: Dict[str, float] = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line_number, line in enumerate(f, start=1):
            text = line.strip()
            if not text or text.startswith('#'):
                continue
            name, _, value = text.partition(',')
            if name == 'Feature':
                continue
            try:
                weights[name] = float(value)
            except ValueError:
                pc.die(f'{path}:{line_number} holds a bad weight: {text!r}')
    missing = [f for f in FEATURES if f not in weights]
    if missing:
        pc.die(f'{path} misses weights for: {", ".join(missing)}')
    return weights


def _is_nan(value: object) -> bool:
    """Report NaN for floats. Never fail on non-float input."""
    return isinstance(value, float) and math.isnan(value)


def min_max_normalize(values: Sequence[float]) -> List[float]:
    """Min-max normalize one column. Clamp the result to [0, 1].

    Port of score.ipynb cell 1. A constant column returns all zeros, exactly
    like the notebook. NaN positions stay NaN. min and max skip them.
    """
    finite = [v for v in values if not _is_nan(v)]
    if not finite:
        return [0.0 for _ in values]
    min_val = min(finite)
    max_val = max(finite)
    if min_val == max_val:
        return [0.0 if not _is_nan(v) else float('nan') for v in values]
    span = max_val - min_val
    out: List[float] = []
    for v in values:
        if _is_nan(v):
            out.append(float('nan'))
            continue
        normed = (v - min_val) / span
        out.append(min(1.0, max(0.0, normed)))
    return out


def _fillna(values: Sequence[float], fill: float) -> List[float]:
    """Replace NaN positions with the fill value."""
    return [fill if _is_nan(v) else v for v in values]


def _mean_of_finite(values: Sequence[float]) -> float:
    """Return the mean of the non-NaN values. Return 0.0 when none exist."""
    finite = [v for v in values if not _is_nan(v)]
    if not finite:
        return 0.0
    return sum(finite) / len(finite)


def _zonedist_to_indicator(value: object) -> float:
    """Map a zoning district code to the crowd-dynamics indicator.

    Port of score.ipynb cell 54. M -> 10, R -> 5, C -> 0, other -> 2.
    A missing value maps to 0.
    """
    if value is None:
        return 0.0
    text = str(value)
    if not text or text.lower() == 'nan':
        return 0.0
    if text.startswith('M'):
        return 10.0
    if text.startswith('R'):
        return 5.0
    if text.startswith('C'):
        return 0.0
    return 2.0


def _communication_indicator(up: float, down: float) -> float:
    """Return 1 when both 4g rates exceed 0. Port of score.ipynb cell 33."""
    if _is_nan(up) or _is_nan(down):
        return 0.0
    return 1.0 if (up > 0 and down > 0) else 0.0


def normalize_features(
    raw: Dict[str, Sequence],
    n: int,
    slope_raw: Sequence[float],
) -> Dict[str, List[float]]:
    """Turn the raw dataset columns into the 19 normalized feature columns.

    Each branch ports one PREPROCESS/COMPUTE block of score.ipynb.
    See NOTEBOOK_TRACE.md for the cell numbers. The output values all lie
    in [0, 1], which mirrors the assert in score.ipynb cell 92.
    """
    out: Dict[str, List[float]] = {}
    out['sidewalk_width'] = min_max_normalize(raw['width'])
    # pedestrian_density now comes from the DOT Pedestrian Demand Map
    # rather than the dashcam pedestrian counts. features_join returns it
    # already turned the right way round, 1 quiet to 5 busy, so this
    # normalizes exactly as the dashcam column did. Two consequences worth
    # knowing: the feature is now a five level ordinal rather than a
    # continuous mean, and it covers every segment rather than the 83%
    # a dashcam happened to drive past. raw['TRAFFIC_Pedestrian'] is still
    # built and still written to the raw table, it just no longer feeds
    # the score.
    out['pedestrian_density'] = min_max_normalize(raw['ped_demand'])
    out['street_furniture_density'] = min_max_normalize(raw['clutter'])
    out['sidewalk_roughness'] = [1.0] * n
    surface = min_max_normalize(raw['sidewalk_quality'])
    out['surface_condition'] = _fillna(surface, _mean_of_finite(surface))
    out['communication_infrastructure'] = [
        _communication_indicator(raw['4g_minup'][i], raw['4g_mindown'][i])
        for i in range(n)
    ]
    out['slope_gradient'] = min_max_normalize(slope_raw)
    distances = raw['distance_to_nearest_station']
    finite_dist = [d for d in distances if not _is_nan(d)]
    range_max = max(finite_dist) if finite_dist else 0.0
    proximity: List[float] = []
    for d in distances:
        if _is_nan(d) or range_max <= 0:
            proximity.append(0.0)
        else:
            proximity.append((range_max - d) / range_max)
    out['charging_station_proximity'] = min_max_normalize(proximity)
    curb = _fillna(list(raw['CURBRAMP_count']), 0.0)
    out['curb_ramp_availability'] = min_max_normalize(curb)
    crowd_raw = [_zonedist_to_indicator(v) for v in raw['ZONEDIST']]
    out['crowd_dynamics'] = min_max_normalize(crowd_raw)
    traffic_sum: List[float] = []
    for i in range(n):
        total = 0.0
        for c in TRAFFIC_MANAGEMENT_COLUMNS:
            v = raw[c][i]
            total += 0.0 if _is_nan(v) else v
        traffic_sum.append(total)
    out['traffic_management'] = min_max_normalize(traffic_sum)
    cameras = _fillna(list(raw['n_cameras_median']), 0.0)
    out['surveillance_coverage'] = min_max_normalize(cameras)
    zoning = min_max_normalize(raw['avg_speed_limit'])
    out['zoning_laws'] = _fillna(zoning, 0.0)
    bike = min_max_normalize(raw['highest_bike_lane_facility_class'])
    out['bike_lane_availability'] = _fillna(bike, 0.0)
    out['gps_signal_strength'] = [1.0] * n
    # The last two features still fed by the dashcam collection, and so
    # the last two frozen at August 2023 while the rest of the snapshot
    # tracks the current basemap and current public data. They are NaN
    # for the 17% of segments no dashcam drove past; score_normalized
    # skips those terms. See the DASHCAM_DAYS note in lab_inputs.py for
    # why no citywide replacement exists.
    out['bicycle_traffic'] = min_max_normalize(raw['TRAFFIC_Bike'])
    out['vehicle_traffic'] = min_max_normalize(raw['TRAFFIC_Car'])
    out['digital_map_existence'] = [1.0] * n
    collisions = [
        0.0 if _is_nan(v) else float(int(v))
        for v in raw['num_peds_involved_in_collision']
    ]
    out['intersection_safety'] = min_max_normalize(collisions)
    return out


def score_normalized(
    normalized: Dict[str, Sequence[float]],
    weights: Optional[Dict[str, float]] = None,
) -> List[float]:
    """Sum polarity * normalized * weight over the 19 features.

    Port of score.ipynb cell 97, which aggregates with
    DataFrame.sum(axis=1). That call defaults to skipna=True, so a NaN
    feature contributes nothing and the row still scores.

    NaN does reach here. The three dashcam features carry it by design:
    PREPROCESS_pedestrian_density and its bike and vehicle counterparts
    min-max normalize without filling, and this port matches them, so any
    segment no dashcam ever drove past holds NaN in all three. That was
    84,260 of 491,894 segments on the 2026 basemap. Summing those
    positions arithmetically propagated NaN into 17% of the scores, which
    then reached the GeoJSON as the literal NaN token. That is not valid
    JSON, and tippecanoe rejected the whole file rather than one feature:
    "Did not read any valid geometries", zero tiles built.
    """
    if weights is None:
        weights = load_weights()
    n = len(next(iter(normalized.values())))
    scores: List[float] = []
    for i in range(n):
        total = 0.0
        for f in FEATURES:
            value = normalized[f][i]
            if _is_nan(value):
                continue
            total += POLARITIES[f] * value * weights[f]
        scores.append(total)
    return scores


def aggregate_segment_scores(
    scores: Sequence[float],
    segment_ids: Sequence[int],
) -> Dict[int, float]:
    """Return the mean point score per segment.

    Port of score_by_sidewalk.ipynb cell 4. At segment-level granularity the
    group holds one row, so the mean equals the row's own score.
    """
    sums: Dict[int, float] = {}
    counts: Dict[int, int] = {}
    for score, sid in zip(scores, segment_ids):
        sums[sid] = sums.get(sid, 0.0) + score
        counts[sid] = counts.get(sid, 0) + 1
    return {sid: sums[sid] / counts[sid] for sid in sums}


def slope_gradient(
    height_start: Sequence[float],
    height_end: Sequence[float],
    run_ft: Sequence[float],
) -> List[float]:
    """Grade along each segment. |height difference| over distance.

    Every segment is a two-point line, so this is the steepness a robot
    meets pushing along it. lab_inputs.sample_dem takes the two heights
    over SLOPE_BASELINE_FT at minimum, along the segment's own bearing,
    and reports the distance it actually sampled as run_ft.

    The result is clipped at SLOPE_MAX_GRADE and is never negative.
    Direction is deliberately dropped: uphill and downhill are equally
    hard, the weight polarity is negative for both, and a sidewalk
    segment carries no direction of travel, so a sign would only record
    which end the geometry starts at.

    A segment the DEM does not cover returns NaN, the no-data marker of
    contract section 3.2. Earlier ports returned 0.0 there and so wrote
    "could not measure" into the same column, with the same value, as
    "flat". NaN costs nothing in the score: score_normalized skips it,
    and a zero grade contributes polarity * 0 * weight = 0 anyway. It
    gains an honest map, which draws those segments as "No value".
    """
    import numpy as np

    n = len(height_start)
    if n == 0:
        return []
    z0 = np.asarray(height_start, dtype=np.float64)
    z1 = np.asarray(height_end, dtype=np.float64)
    run = np.asarray(run_ft, dtype=np.float64)

    with np.errstate(invalid='ignore', divide='ignore'):
        grade = np.abs(z1 - z0) / np.where(run > 0, run, np.nan)
    measured = np.isfinite(grade)
    clipped = int(np.sum(measured & (grade > SLOPE_MAX_GRADE)))
    grade = np.where(measured, np.clip(grade, 0.0, SLOPE_MAX_GRADE), np.nan)

    no_data = n - int(measured.sum())
    pc.log(f'score_core: slope over {n} segments, '
           f'{no_data} with no DEM cover ({100.0 * no_data / n:.2f}%), '
           f'{clipped} clipped at {SLOPE_MAX_GRADE:g}')
    return [float(v) for v in grade]
