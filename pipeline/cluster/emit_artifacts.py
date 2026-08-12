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
ROW_COUNT_MIN = 460350
ROW_COUNT_MAX = 469650

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


def build_pmtiles(geojson_path: str, out_path: str) -> None:
    """Run tippecanoe. Stop with a clean error when it fails or hangs."""
    args = [
        'tippecanoe',
        f'--output={out_path}',
        '--force',
        '--layer=segments',
        f'--maximum-zoom={TIPPECANOE_MAX_ZOOM}',
        '--drop-rate=0',
        '--include=id',
        '--include=score',
        geojson_path,
    ]
    pc.log(f'emit_artifacts: running {" ".join(args)}')
    try:
        proc = subprocess.run(args, capture_output=True, text=True,
                              timeout=TIPPECANOE_TIMEOUT_S)
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


def run_validator(snapshot_dir: str, row_count: int) -> None:
    """Run the contract validator. Gate on the exit code, never on text."""
    args = ['node', pc.validator_path(), snapshot_dir]
    if row_count < ROW_COUNT_MIN or row_count > ROW_COUNT_MAX:
        # Small-area test run. Relax the row count band to the exact count.
        args += ['--relax-row-count', str(row_count)]
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

    feature_stats = {
        f: {'min': min(feature_arrays[f]), 'max': max(feature_arrays[f])}
        for f in cs.FEATURES
    }
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
    run_validator(args.out, len(segment_ids))
    return 0


if __name__ == '__main__':
    sys.exit(main())
