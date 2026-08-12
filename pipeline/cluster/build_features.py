"""Build the raw per-segment feature table for one run.

Segment-level port of the joins in robotability-nyc/feature_processing/
dataset.ipynb. Real mode reads lab paths from the config and joins the
fetched public datasets. Mock mode (--mock-lab-data) generates a fully
deterministic synthetic table and needs no network and no lab storage.

Usage:
    python3 build_features.py --work DIR --out features_raw.parquet \
        --report build_report.json [--bbox minlon,minlat,maxlon,maxlat] \
        [--mock-lab-data] [--config FILE] [--simulate-missing NAME] \
        [--seed N]

Exit codes: 0 success, 1 failure, 2 bad usage.
"""

import argparse
import json
import os
import sys
from typing import Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

from mock_data import DEFAULT_MOCK_BBOX, LAB_INPUTS, generate_mock  # noqa: E402


def _fill(values: Optional[list], n: int) -> List[float]:
    """Return the values or a zero column when the source is missing."""
    if values is None:
        return [0.0] * n
    return values


def build_real(work_dir: str, bbox: Optional[tuple], config: Dict,
               simulate_missing: Optional[str]) -> Tuple[Dict[str, list], List[str]]:
    """Join the real inputs onto the sidewalk segments."""
    import features_join
    import joins_counts
    import lab_inputs

    segments = features_join.load_segments(work_dir, bbox)
    n = len(segments)
    if n == 0:
        pc.die('no sidewalk segments in the given bbox. Nothing to build.')
    missing: List[str] = []

    lab = config.get('lab', {}) if isinstance(config, dict) else {}

    def lab_blocked(name: str) -> bool:
        return simulate_missing == name

    columns: Dict[str, list] = {
        'segment_id': [int(v) for v in segments['segment_index']],
        'geometry_wkt': segments.to_crs(pc.CRS_WGS).geometry.apply(
            lambda g: g.wkt).tolist(),
        'width': [float(v) for v in segments['width']],
    }

    clutter = features_join.join_street_furniture(segments, work_dir)
    if clutter is None:
        missing.append('street_furniture')
    columns['clutter'] = _fill(clutter, n)

    quality = features_join.join_surface_condition(segments, work_dir)
    if quality is None:
        missing.append('surface_condition_scorecard')
    columns['sidewalk_quality'] = _fill(quality, n)

    comm = features_join.join_communication(segments, work_dir)
    if comm is None:
        missing.append('fcc_broadband')
        columns['4g_minup'] = [0.0] * n
        columns['4g_mindown'] = [0.0] * n
    else:
        columns['4g_minup'] = comm['4g_minup']
        columns['4g_mindown'] = comm['4g_mindown']

    zonedist = features_join.join_zoning(segments, work_dir)
    if zonedist is None:
        missing.append('zoning')
        zonedist = [''] * n
    columns['ZONEDIST'] = zonedist

    curbs = joins_counts.join_curb_ramps(segments, work_dir)
    if curbs is None:
        missing.append('curb_ramps')
    columns['CURBRAMP_count'] = _fill(curbs, n)

    traffic_mgmt = joins_counts.join_traffic_management(segments, work_dir)
    if traffic_mgmt is None:
        missing.append('traffic_management_sources')
        traffic_mgmt = {}
    for col in ('in_slow_zone', 'turn_traffic_calming_count',
                'sip_intersections_count', 'sip_corridors_count',
                'barnes_intersections_count', 'leading_ped_intervals_count'):
        columns[col] = _fill(traffic_mgmt.get(col), n)

    bike = joins_counts.join_bike_routes(segments, work_dir)
    if bike is None:
        missing.append('bike_routes')
    columns['highest_bike_lane_facility_class'] = _fill(bike, n)

    collisions = joins_counts.join_collisions(segments, work_dir)
    if collisions is None:
        missing.append('collisions')
    columns['num_peds_involved_in_collision'] = _fill(collisions, n)

    stations = joins_counts.join_charging(segments, work_dir)
    if stations is None:
        missing.append('citibike_stations')
    columns['distance_to_nearest_station'] = _fill(stations, n)

    dashcam_root = lab.get('dashcam_root', '')
    traffic = None
    if dashcam_root and not lab_blocked('dashcam_detections'):
        traffic = lab_inputs.read_dashcam_traffic(dashcam_root, segments)
    if traffic is None:
        missing.append('dashcam_detections')
        for col in ('TRAFFIC_Pedestrian', 'TRAFFIC_Bike', 'TRAFFIC_Car'):
            columns[col] = [0.0] * n
    else:
        columns.update(traffic)

    surveillance_csv = lab.get('surveillance_csv', '')
    cameras = None
    if surveillance_csv and not lab_blocked('surveillance_values'):
        cameras = lab_inputs.read_surveillance(surveillance_csv, segments)
    if cameras is None:
        missing.append('surveillance_values')
    columns['n_cameras_median'] = _fill(cameras, n)

    dem_path = lab.get('dem_path', '')
    elevations = None
    if dem_path and not lab_blocked('dem'):
        elevations = lab_inputs.sample_dem(dem_path, segments)
    if elevations is None:
        missing.append('dem')
    columns['ft_above_sea'] = _fill(elevations, n)

    columns['avg_speed_limit'] = [25.0] * n
    speed_limits_path = os.path.join(work_dir, 'data/dot_VZV_Speed_Limits.csv')
    if os.path.isfile(speed_limits_path):
        joined = joins_counts.join_speed_limits(segments, speed_limits_path)
        if joined is not None:
            columns['avg_speed_limit'] = joined
    else:
        missing.append('speed_limits')
    return columns, missing


def write_raw_parquet(path: str, columns: Dict[str, list]) -> int:
    """Write the raw table. Return the row count."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    n = len(columns['segment_id'])
    fields = [pa.field('segment_id', pa.int32(), nullable=False),
              pa.field('geometry_wkt', pa.string(), nullable=False)]
    arrays = [pa.array(columns['segment_id'], type=pa.int32()),
              pa.array(columns['geometry_wkt'], type=pa.string())]
    for name, values in columns.items():
        if name in ('segment_id', 'geometry_wkt'):
            continue
        if name == 'ZONEDIST':
            fields.append(pa.field(name, pa.string(), nullable=False))
            arrays.append(pa.array([str(v) for v in values], type=pa.string()))
        else:
            fields.append(pa.field(name, pa.float64(), nullable=False))
            arrays.append(pa.array([float(v) for v in values], type=pa.float64()))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    pc.ensure_dir(os.path.dirname(os.path.abspath(path)))
    pq.write_table(table, path)
    return n


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description='Build the raw per-segment feature table.',
    )
    parser.add_argument('--work', required=True, help='work directory')
    parser.add_argument('--out', required=True, help='output raw parquet path')
    parser.add_argument('--report', required=True, help='output build report json path')
    parser.add_argument('--bbox', default=None,
                        help='minlon,minlat,maxlon,maxlat filter box')
    parser.add_argument('--mock-lab-data', action='store_true',
                        help='generate deterministic synthetic data; no lab storage')
    parser.add_argument('--config', default=None, help='cluster config yaml')
    parser.add_argument('--simulate-missing', default=None, choices=LAB_INPUTS,
                        help='treat one lab input as missing (partial run)')
    parser.add_argument('--seed', type=int, default=pc.MOCK_SEED,
                        help=f'mock data seed (default {pc.MOCK_SEED})')
    args = parser.parse_args(argv)

    bbox = pc.parse_bbox(args.bbox) if args.bbox else None

    if args.mock_lab_data:
        box = bbox if bbox is not None else DEFAULT_MOCK_BBOX
        pc.log(f'build_features: mock mode, seed {args.seed}, bbox {box}')
        columns, missing = generate_mock(box, args.seed, args.simulate_missing)
    else:
        config = pc.load_config(args.config)
        columns, missing = build_real(args.work, bbox, config, args.simulate_missing)

    row_count = write_raw_parquet(args.out, columns)
    report = {
        'row_count': row_count,
        'missing_inputs': missing,
        'partial': len(missing) > 0,
        'mock': args.mock_lab_data,
        'seed': args.seed if args.mock_lab_data else None,
        'bbox': list(bbox) if bbox else None,
    }
    pc.ensure_dir(os.path.dirname(os.path.abspath(args.report)))
    with open(args.report, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
        f.write('\n')
    if missing:
        pc.log(f'build_features: missing inputs: {", ".join(missing)}. '
               'The snapshot will carry partial: true.')
    pc.log(f'build_features: wrote {args.out} ({row_count} segments)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
