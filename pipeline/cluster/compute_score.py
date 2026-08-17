"""Score one run. CLI wrapper around score_core.

Usage:
    python3 compute_score.py --in features_raw.parquet --out scored.parquet

Exit codes: 0 success, 1 bad input or compute failure, 2 bad usage.
"""

import argparse
import os
import sys
from typing import Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

# Re-export the core names. Tests and emit_artifacts.py import them here.
from score_core import (  # noqa: E402,F401
    FEATURES,
    POLARITIES,
    CONSTANT_ONE_FEATURES,
    TRAFFIC_MANAGEMENT_COLUMNS,
    SLOPE_MAX_NEIGHBORS,
    SLOPE_MIN_BASELINE_FT,
    SLOPE_MAX_GRADE,
    _is_nan,
    load_weights,
    min_max_normalize,
    normalize_features,
    score_normalized,
    aggregate_segment_scores,
    slope_gradient,
)


def _read_raw_table(path: str):
    """Read the raw feature parquet. Stop with a clean error on empty input."""
    import pyarrow.parquet as pq

    if not os.path.isfile(path):
        pc.die(f'input file not found: {path}')
    table = pq.read_table(path)
    if table.num_rows == 0:
        pc.die(f'input file holds zero rows: {path}. Nothing to score.')
    return table


def _project_centroids(geom_wkt: Sequence[str]):
    """Return segment centroids in EPSG:2263 feet for the slope search."""
    from pyproj import Transformer
    from shapely import wkt

    transformer = Transformer.from_crs(pc.CRS_WGS, pc.CRS_PROJ, always_xy=True)
    out = []
    for text in geom_wkt:
        centroid = wkt.loads(text).centroid
        x, y = transformer.transform(centroid.x, centroid.y)
        out.append((x, y))
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description='Normalize features and compute Robotability scores.',
    )
    parser.add_argument('--in', dest='input', required=True,
                        help='raw feature parquet from build_features.py')
    parser.add_argument('--out', dest='output', required=True,
                        help='output parquet with normalized features + score')
    parser.add_argument('--weights', default=None,
                        help='weights csv (default: vendored weights.csv)')
    args = parser.parse_args(argv)

    table = _read_raw_table(args.input)
    columns = table.column_names
    required = [
        'segment_id', 'geometry_wkt', 'ft_above_sea', 'width',
        'TRAFFIC_Pedestrian', 'TRAFFIC_Bike', 'TRAFFIC_Car', 'clutter',
        'ped_demand',
        'sidewalk_quality', '4g_minup', '4g_mindown',
        'distance_to_nearest_station', 'CURBRAMP_count', 'ZONEDIST',
        'n_cameras_median', 'avg_speed_limit',
        'highest_bike_lane_facility_class', 'num_peds_involved_in_collision',
    ] + list(TRAFFIC_MANAGEMENT_COLUMNS)
    missing = [c for c in required if c not in columns]
    if missing:
        pc.die(f'input parquet misses columns: {", ".join(missing)}')

    n = table.num_rows
    pc.log(f'compute_score: {n} segments read from {args.input}')

    def col(name: str) -> list:
        return table.column(name).to_pylist()

    pc.log('compute_score: project centroids and compute slope gradient')
    centroids = _project_centroids(col('geometry_wkt'))
    slope_raw = slope_gradient(col('ft_above_sea'), centroids)

    raw = {name: col(name) for name in required
           if name not in ('segment_id', 'geometry_wkt')}
    weights = load_weights(args.weights)
    normalized = normalize_features(raw, n, slope_raw)
    scores = score_normalized(normalized, weights)

    segment_ids = col('segment_id')
    segment_score = aggregate_segment_scores(scores, segment_ids)
    final_scores = [segment_score[sid] for sid in segment_ids]

    pc.log('compute_score: assert normalized values lie in [0, 1]')
    for f in FEATURES:
        finite = [v for v in normalized[f] if not _is_nan(v)]
        if finite and (min(finite) < 0.0 or max(finite) > 1.0):
            pc.die(f'normalized {f} left [0, 1]: min {min(finite)}, max {max(finite)}')

    import pyarrow as pa
    import pyarrow.parquet as pq

    fields = [pa.field('segment_id', pa.int32(), nullable=False),
              pa.field('geometry_wkt', pa.string(), nullable=False)]
    arrays = [pa.array(segment_ids, type=pa.int32()),
              pa.array(col('geometry_wkt'), type=pa.string())]
    for f in FEATURES:
        fields.append(pa.field(f, pa.float64(), nullable=False))
        arrays.append(pa.array(normalized[f], type=pa.float64()))
    fields.append(pa.field('score', pa.float64(), nullable=False))
    arrays.append(pa.array(final_scores, type=pa.float64()))
    out_table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    pc.ensure_dir(os.path.dirname(os.path.abspath(args.output)))
    pq.write_table(out_table, args.output)
    pc.log(f'compute_score: wrote {args.output} ({n} rows)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
