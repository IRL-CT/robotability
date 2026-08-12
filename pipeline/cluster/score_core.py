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
    TRAFFIC_MANAGEMENT_COLUMNS, SLOPE_RADIUS_FT, SLOPE_MAX_NEIGHBORS,
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
    out['pedestrian_density'] = min_max_normalize(raw['TRAFFIC_Pedestrian'])
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

    Port of score.ipynb cell 97. NaN never reaches this function. The
    normalize step fills every position first.
    """
    if weights is None:
        weights = load_weights()
    n = len(next(iter(normalized.values())))
    scores: List[float] = []
    for i in range(n):
        total = 0.0
        for f in FEATURES:
            total += POLARITIES[f] * normalized[f][i] * weights[f]
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
    elevations: Sequence[float],
    centroids_proj_xy: Sequence[tuple],
) -> List[float]:
    """Compute the mean slope to nearby points. Port of score.ipynb cell 36.

    Each point looks at most 10 nearest neighbors within 50 ft. The slope is
    the mean of |height difference| / distance over those neighbors. Points
    without a neighbor get 0. Coordinates must already be in EPSG:2263 (ft).
    """
    import numpy as np
    from shapely import STRtree, Point

    n = len(elevations)
    if n == 0:
        return []
    points = [Point(x, y) for x, y in centroids_proj_xy]
    tree = STRtree(points)
    heights = np.asarray(elevations, dtype=np.float64)
    coords = np.asarray(centroids_proj_xy, dtype=np.float64)
    out: List[float] = []
    for i in range(n):
        candidate_idx = tree.query(points[i], predicate='dwithin', distance=SLOPE_RADIUS_FT)
        keep = [int(j) for j in candidate_idx if int(j) != i]
        if not keep:
            out.append(0.0)
            continue
        deltas = coords[keep] - coords[i]
        dists = np.sqrt((deltas ** 2).sum(axis=1))
        positive = dists > 0
        keep = [j for j, ok in zip(keep, positive) if ok]
        dists = dists[positive]
        if not keep:
            out.append(0.0)
            continue
        order = np.argsort(dists)[:SLOPE_MAX_NEIGHBORS]
        nearest = [keep[k] for k in order]
        height_diffs = np.abs(heights[nearest] - heights[i])
        slopes = height_diffs / dists[order]
        out.append(float(np.abs(slopes).mean()))
    return out


