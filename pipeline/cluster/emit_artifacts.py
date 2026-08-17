"""Write the four contract artifacts for one snapshot and validate them.

Outputs per pipeline/contract/cluster_contract.md section 2:
segments.geojson, segments.pmtiles, features.parquet, manifest.json.
The script then runs pipeline/contract/validate_snapshot.mjs and gates on
the validator EXIT CODE. Printed text is never the gate.

A partial snapshot (a lab input was missing) is written but not validated.
The contract section 5 says a partial run must exit 0. CI rejects partial
snapshots later.

Usage:
    python3 emit_artifacts.py --in scored.parquet --report build_report.json \
        --out SNAPSHOT_DIR [--date YYYY-MM-DD]

Exit codes: 0 success, 1 failure, 2 bad usage.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
from typing import Dict, List, Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

import compute_score as cs  # noqa: E402

# Full-city row count band from the contract. Runs outside the band are
# small-area test runs and use the validator's relaxed row count check.
#
# The band counts centerline segments, one row per segment, with a 1%
# margin either side of 491894 measured on the 2026 basemap.
#
# The previous band, [460350, 469650], was a 1% margin around 464968,
# which is the row count of snapshot0 and of the research file
# score_by_sidewalk.csv. That number counts a different thing. The
# research sampled points every 50 ft along each segment
# (dataset.ipynb cell 14, segmentize(50).extract_unique_points()),
# scored the points, then averaged back per segment, so a segment too
# short to yield a sample point never reached the output. This pipeline
# scores segments directly, which score_core.aggregate_segment_scores
# documents, so it has no such attrition and always emits one row per
# segment. Against the 2023 basemap it would emit 476398 rows, already
# above the old ceiling: the old band was unreachable here whatever the
# basemap year, because it was a bound on a quantity this pipeline does
# not produce.
#
# Of the change from 476398 to 491894, +3.25% is the 2023 to 2026
# growth of the sidewalk basemap itself, like for like.
#
# Keep these two constants equal to ROW_COUNT_MIN and ROW_COUNT_MAX in
# pipeline/contract/validate_snapshot.mjs. CI reads that copy and never
# relaxes it.
ROW_COUNT_MIN = 486975
ROW_COUNT_MAX = 496813

# tippecanoe flags mirror scripts/tiles/build_pmtiles.mjs. --drop-rate=0
# keeps every segment. The include list keeps only id and score.
TIPPECANOE_MAX_ZOOM = 14
TIPPECANOE_TIMEOUT_S = 20 * 60


def _today_utc() -> str:
    """Return today's UTC date in YYYY-MM-DD form."""
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')


def _check_date(text: str) -> None:
    """Stop when the date is not a real YYYY-MM-DD calendar date."""
    try:
        datetime.datetime.strptime(text, '%Y-%m-%d')
    except ValueError:
        pc.die(f'bad snapshot date: {text!r}. Use YYYY-MM-DD.', 2)


def _check_weights_sha(weights_path: str) -> str:
    """Hash the vendored weights and compare with the pinned contract hash.

    The hash covers the non-comment bytes only. The provenance comment
    block is not part of the ground truth. A mismatch means the vendored
    copy drifted. The run must stop.
    """
    body = pc.weights_body_bytes(weights_path)
    import hashlib
    digest = hashlib.sha256(body).hexdigest()
    if digest != pc.PINNED_WEIGHTS_SHA256:
        pc.die(
            'weights.csv drifted from the contract ground truth. '
            f'Got sha256 {digest}, pinned {pc.PINNED_WEIGHTS_SHA256}. '
            'Restore pipeline/cluster/weights.csv before running again.')
    return digest


def write_geojson(path: str, segment_ids: List[int], geom_wkt: List[str],
                  scores: List[float]) -> None:
    """Write segments.geojson. One LineString per segment with {id, score}."""
    from shapely import wkt

    features = []
    for sid, text, score in zip(segment_ids, geom_wkt, scores):
        geom = wkt.loads(text)
        features.append({
            'type': 'Feature',
            'properties': {'id': int(sid), 'score': float(score)},
            'geometry': {'type': 'LineString', 'coordinates': list(geom.coords)},
        })
    doc = {'type': 'FeatureCollection', 'features': features}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(doc, f)


def _finite_min_max(name: str, values: list) -> dict:
    """Min and max of one feature column, ignoring NaN.

    Three features carry NaN by design: pedestrian_density,
    bicycle_traffic and vehicle_traffic are NaN for every segment no
    dashcam ever drove past, which was 84,260 of 491,894 on the 2026
    basemap. The builtin min() and max() do not skip NaN the way the
    pandas calls in score.ipynb do, so they returned NaN here and
    json.dump wrote a bare NaN token. JSON has no such literal, so the
    contract validator rejected the manifest at the parse step, before
    reaching any rule. The contract also requires min and max to be
    numbers with min <= max, which NaN fails on its own terms.
    """
    finite = [v for v in values if not cs._is_nan(v)]
    if not finite:
        pc.die(f'feature {name} holds no finite value, so the manifest '
               f'cannot carry a min and max for it. The contract requires '
               f'both. Check the join that produces {name}.')
    return {'min': min(finite), 'max': max(finite)}


def _tippecanoe_cpus() -> int:
    """Return how many CPUs this process may actually use.

    Slurm gives the job a cgroup, so the count of usable CPUs is much
    smaller than the machine's. Prefer what the scheduler granted, then
    the affinity mask, then the machine.
    """
    granted = os.environ.get('SLURM_CPUS_PER_TASK')
    if granted and granted.isdigit() and int(granted) > 0:
        return int(granted)
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except AttributeError:
        return max(1, os.cpu_count() or 1)


def build_pmtiles(geojson_path: str, out_path: str) -> None:
    """Run tippecanoe. Stop with a clean error when it fails or hangs."""
    # Cap tippecanoe's thread count to the CPUs this job was granted.
    # tippecanoe sizes its work from sysconf(_SC_NPROCESSORS_ONLN), the
    # machine's online CPU count, which ignores the cgroup. It then
    # derives a shard count from that and asserts the shard count is a
    # power of two. On a 384 CPU node inside an 8 CPU allocation the
    # derivation produced 745 and the build died with
    # "Internal error: 745 shards not a power of 2" after writing
    # nothing usable; the same GeoJSON built cleanly on a 56 CPU node.
    # So the failure follows node width, not the input, and this env var
    # is the only lever tippecanoe exposes over it. An explicit value in
    # the environment wins, so an operator can still tune it by hand.
    env = dict(os.environ)
    env.setdefault('TIPPECANOE_MAX_THREADS', str(_tippecanoe_cpus()))
    pc.log(f'emit_artifacts: TIPPECANOE_MAX_THREADS='
           f'{env["TIPPECANOE_MAX_THREADS"]}')
    args = [
        'tippecanoe',
        f'--output={out_path}',
        '--force',
        '--layer=segments',
        f'--maximum-zoom={TIPPECANOE_MAX_ZOOM}',
        '--drop-rate=0',
        # These two travel with --drop-rate=0 and were missing from this
        # port. tippecanoe caps a tile at 200000 features and 500 KB and
        # shrinks an over-full tile by dropping, which --drop-rate=0
        # forbids, so it fails the build instead. On the 2026 basemap
        # tile 7/37/48 held 200001 features and stopped the run one
        # feature over the cap, having written tiles only through zoom 6.
        # scripts/tiles/build_pmtiles.mjs raises both caps for exactly
        # this reason; the values here match it.
        '--no-feature-limit',
        '--maximum-tile-bytes=20000000',
        '--include=id',
        '--include=score',
        geojson_path,
    ]
    pc.log(f'emit_artifacts: running {" ".join(args)}')
    try:
        proc = subprocess.run(args, capture_output=True, text=True,
                              timeout=TIPPECANOE_TIMEOUT_S, env=env)
    except FileNotFoundError:
        pc.die('tippecanoe is not on PATH. Install it (brew install tippecanoe).')
    except subprocess.TimeoutExpired:
        pc.die(f'tippecanoe still ran after {TIPPECANOE_TIMEOUT_S}s. Killed it.')
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        pc.die(f'tippecanoe exited with code {proc.returncode}')


def write_features_parquet(path: str, segment_ids: List[int],
                           feature_arrays: Dict[str, list],
                           scores: list) -> None:
    """Write features.parquet in the exact contract column order.

    pyarrow stores the columns as OPTIONAL repetition with zero nulls.
    The validator enforces the no-null rule through the null count.
    SNAPPY codec, data page v1, dictionary encoding: the allowed subset.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    fields = [pa.field('segment_id', pa.int32(), nullable=False)]
    arrays = [pa.array(segment_ids, type=pa.int32())]
    for f in cs.FEATURES:
        fields.append(pa.field(f, pa.float32(), nullable=False))
        arrays.append(pa.array(feature_arrays[f], type=pa.float32()))
    fields.append(pa.field('score', pa.float32(), nullable=False))
    arrays.append(pa.array(scores, type=pa.float32()))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    pq.write_table(table, path, compression='snappy', data_page_version='1.0')


def _file_entry(path: str) -> Dict:
    """Build one manifest file entry with sha256 and byte count."""
    return {
        'name': os.path.basename(path),
        'sha256': pc.sha256_file(path),
        'bytes': os.path.getsize(path),
    }


def run_validator(snapshot_dir: str, row_count: int,
                  report: Dict) -> None:
    """Run the contract validator. Gate on the exit code, never on text.

    Only a test run relaxes the row count band. The build report
    identifies such a run: it has a bbox, or it uses mock data. A
    full-city run must face the real band. If the count alone selected
    the relaxed check, a full-city run with a wrong count would print
    PASS here and then get rejected by CI, which never relaxes the band.
    """
    args = ['node', pc.validator_path(), snapshot_dir]
    is_test_run = report.get('bbox') is not None or bool(report.get('mock'))
    if is_test_run:
        # Small-area test run. Relax the row count band to the exact count.
        args += ['--relax-row-count', str(row_count)]
    elif row_count < ROW_COUNT_MIN or row_count > ROW_COUNT_MAX:
        pc.log(f'emit_artifacts: WARNING full-city row count {row_count} '
               f'is outside the band [{ROW_COUNT_MIN}, {ROW_COUNT_MAX}]. '
               'The validator rejects it. CI rejects it too.')
    pc.log(f'emit_artifacts: running {" ".join(args)}')
    proc = subprocess.run(args)
    if proc.returncode != 0:
        pc.die(f'validate_snapshot.mjs rejected the snapshot '
               f'(exit code {proc.returncode}). Nothing was published.')
    pc.log(f'emit_artifacts: validator PASS (exit code 0) for {snapshot_dir}')


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description='Write the four snapshot artifacts and validate them.',
    )
    parser.add_argument('--in', dest='input', required=True,
                        help='scored parquet from compute_score.py')
    parser.add_argument('--report', required=True,
                        help='build_report.json from build_features.py')
    parser.add_argument('--out', required=True, help='snapshot directory')
    parser.add_argument('--date', default=None,
                        help='snapshot date YYYY-MM-DD (default: today UTC)')
    parser.add_argument('--weights', default=None,
                        help='weights csv (default: vendored weights.csv)')
    args = parser.parse_args(argv)

    date = args.date if args.date else _today_utc()
    _check_date(date)
    weights_sha = _check_weights_sha(args.weights or pc.weights_csv_path())

    with open(args.report, 'r', encoding='utf-8') as f:
        report = json.load(f)
    partial = bool(report.get('partial', False))

    import pyarrow.parquet as pq
    table = pq.read_table(args.input)
    if table.num_rows == 0:
        pc.die(f'scored parquet holds zero rows: {args.input}')
    if table.num_rows != report.get('row_count'):
        pc.die('scored parquet row count disagrees with the build report')

    def col(name: str) -> list:
        return table.column(name).to_pylist()

    segment_ids = [int(v) for v in col('segment_id')]
    geom_wkt = col('geometry_wkt')
    # Cast to float32 first. The manifest stats must equal the parquet bytes.
    feature_arrays = {f: [float(v) for v in col(f)] for f in cs.FEATURES}
    scores_raw = [float(v) for v in col('score')]
    import numpy as np
    feature_arrays = {
        f: [float(v) for v in np.asarray(vals, dtype=np.float32)]
        for f, vals in feature_arrays.items()
    }
    scores = [float(v) for v in np.asarray(scores_raw, dtype=np.float32)]

    pc.ensure_dir(args.out)
    geojson_path = os.path.join(args.out, 'segments.geojson')
    pmtiles_path = os.path.join(args.out, 'segments.pmtiles')
    parquet_path = os.path.join(args.out, 'features.parquet')

    pc.log('emit_artifacts: write segments.geojson')
    write_geojson(geojson_path, segment_ids, geom_wkt, scores)
    pc.log('emit_artifacts: build segments.pmtiles')
    build_pmtiles(geojson_path, pmtiles_path)
    pc.log('emit_artifacts: write features.parquet')
    write_features_parquet(parquet_path, segment_ids, feature_arrays, scores)

    feature_stats = {f: _finite_min_max(f, feature_arrays[f])
                     for f in cs.FEATURES}
    manifest = {
        'date': date,
        'row_count': len(segment_ids),
        'score_min': min(scores),
        'score_max': max(scores),
        'feature_stats': feature_stats,
        'weights_sha256': weights_sha,
        'partial': partial,
        'feature_vectors': True,
        'files': [
            _file_entry(geojson_path),
            _file_entry(pmtiles_path),
            _file_entry(parquet_path),
        ],
    }
    manifest_path = os.path.join(args.out, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    pc.log(f'emit_artifacts: wrote {manifest_path} '
           f'(rows {len(segment_ids)}, score [{min(scores)}, {max(scores)}], '
           f'partial {str(partial).lower()})')

    if partial:
        pc.log('emit_artifacts: partial snapshot. Validator skipped. '
               'CI rejects partial snapshots. Fix the missing lab input '
               'and rerun.')
        return 0
    run_validator(args.out, len(segment_ids), report)
    return 0


if __name__ == '__main__':
    sys.exit(main())
