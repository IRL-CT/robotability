#!/usr/bin/env python3
"""Unit tests for segment_basemap.py.

Checks the centerline segmentation against hand-built polygons with
known geometry. The width rule is the research rule: width = 2 x mean
distance from the segment to the polygon boundary. Run with plain
python:

    python3 pipeline/cluster/tests/test_segment_basemap.py

Exit code 0 means every check passed.
"""

import hashlib
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import segment_basemap as sb  # noqa: E402

FAILURES = []


def check_bool(name: str, ok: bool, detail: str = '') -> None:
    if ok:
        print(f"ok   {name}{(' ' + detail) if detail else ''}")
    else:
        print(f"FAIL {name}{(' ' + detail) if detail else ''}")
        FAILURES.append(name)


def check(name: str, got: float, want: float, tol: float) -> None:
    if math.isfinite(got) and abs(got - want) <= tol:
        print(f"ok   {name}: {got!r}")
    else:
        print(f"FAIL {name}: got {got!r}, want {want!r} +/- {tol!r}")
        FAILURES.append(name)


def rect_wkt(x0: float, y0: float, x1: float, y1: float) -> str:
    return (f'POLYGON (({x0} {y0}, {x1} {y0}, {x1} {y1}, {x0} {y1}, '
            f'{x0} {y0}))')


def rect_poly(x0: float, y0: float, x1: float, y1: float):
    from shapely import wkt

    return wkt.loads(rect_wkt(x0, y0, x1, y1))


def midpoints(segments):
    """Midpoints of projected (LineString, width) pairs, in feet."""
    out = []
    for segment, _ in segments:
        mid = segment.interpolate(0.5, normalized=True)
        out.append((mid.x, mid.y))
    return out


def test_rectangle_width() -> None:
    """A 200 ft x 10 ft rectangle yields axis segments ~10 ft wide.

    The centerline of a rectangle is straight, so simplify collapses it
    to one 2-point segment spanning the long axis. One segment is the
    right answer here, not a floor to raise: an earlier revision asked
    for >= 3, which only passed because the simplify tolerance was
    3.28x too small and left Voronoi jitter in the line. The width and
    axis checks below carry the real assertion.
    """
    segments = sb.segment_polygon_proj(rect_poly(0.0, 0.0, 200.0, 10.0))
    check_bool('rectangle yields segments', len(segments) >= 1,
               f'{len(segments)} segments')
    if not segments:
        return
    widths = [w for _, w in segments]
    check_bool('rectangle widths positive', all(w > 0 for w in widths))
    central = [w for (mx, _), w in zip(midpoints(segments), widths)
               if 20.0 <= mx <= 180.0]
    check_bool('rectangle has central segments', len(central) >= 1,
               f'{len(central)} central segments')
    if central:
        mean_width = sum(central) / len(central)
        check('rectangle central mean width ~ 10 ft', mean_width, 10.0, 1.5)
    mids = midpoints(segments)
    central_y = [my for mx, my in mids if 20.0 <= mx <= 180.0]
    if central_y:
        on_axis = all(2.0 <= y <= 8.0 for y in central_y)
        check_bool('rectangle central segments lie on the axis', on_axis)


def test_l_shape_coverage() -> None:
    """An L-shaped polygon yields segments in both arms.

    Each arm is straight, so simplify leaves one 2-point segment per
    arm. Two is the right answer. The arm coverage checks below are
    what this test is actually for. See test_rectangle_width on why the
    earlier >= 4 floor was an artifact of the wrong simplify tolerance.
    """
    from shapely import wkt

    l_poly = wkt.loads('POLYGON ((0 0, 100 0, 100 10, 10 10, 10 100, '
                       '0 100, 0 0))')
    segments = sb.segment_polygon_proj(l_poly)
    check_bool('L shape yields segments', len(segments) >= 2,
               f'{len(segments)} segments')
    if not segments:
        return
    mids = midpoints(segments)
    arm_a = any(mx > 40.0 and 0.0 <= my <= 10.0 for mx, my in mids)
    arm_b = any(my > 40.0 and 0.0 <= mx <= 10.0 for mx, my in mids)
    check_bool('L shape covers the horizontal arm', arm_a)
    check_bool('L shape covers the vertical arm', arm_b)


def test_degenerate_input() -> None:
    """Empty and zero-area polygons yield no segments and no crash."""
    from shapely import wkt

    check_bool('empty polygon yields nothing',
               sb.segment_polygon_proj(wkt.loads('POLYGON EMPTY')) == [])
    check_bool('zero-area polygon yields nothing',
               sb.segment_polygon_proj(
                   wkt.loads('POLYGON ((0 0, 1 0, 0 0))')) == [])


def write_test_csv(work_dir: str) -> None:
    """Write a two-polygon basemap CSV in the fetch_public shape.

    Socrata quotes fields that carry commas. The WKT field must carry
    quotes too.
    """
    data_dir = os.path.join(work_dir, 'data')
    os.makedirs(data_dir, exist_ok=True)
    squares = [
        rect_wkt(-73.990, 40.750, -73.989, 40.7503),
        rect_wkt(-73.988, 40.750, -73.987, 40.7503),
    ]
    lines = ['the_geom']
    lines.extend(f'"{w}"' for w in squares)
    path = os.path.join(data_dir, 'sidewalks_nyc.csv')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        digest.update(f.read())
    return digest.hexdigest()


def test_end_to_end_determinism() -> None:
    """The same basemap bytes produce the same parquet bytes."""
    from shapely import wkt

    hashes = []
    rows_by_run = []
    for run in ('run-a', 'run-b'):
        work_dir = os.path.join(tempfile.gettempdir(),
                                f'segment-basemap-test-{run}')
        os.makedirs(work_dir, exist_ok=True)
        write_test_csv(work_dir)
        code = sb.main(['--work', work_dir, '--workers', '2'])
        check_bool(f'{run} exits 0', code == 0)
        out_path = os.path.join(work_dir, sb.SEGMENTS_REL)
        check_bool(f'{run} writes the parquet', os.path.isfile(out_path))
        hashes.append(sha256_of(out_path))

        import pyarrow.parquet as pq
        table = pq.read_table(out_path)
        check_bool(f'{run} schema is geometry_wkt,width',
                   table.schema.names == ['geometry_wkt', 'width'])
        rows = table.to_pylist()
        rows_by_run.append(rows)
        check_bool(f'{run} has rows', len(rows) > 0, f'{len(rows)} rows')
        kinds = set()
        for row in rows:
            geom = wkt.loads(row['geometry_wkt'])
            kinds.add(geom.geom_type)
        check_bool(f'{run} every geometry is a LineString',
                   kinds == {'LineString'}, str(kinds))
        if rows:
            check_bool(f'{run} all widths positive',
                       all(row['width'] > 0 for row in rows))
    check_bool('parquet bytes identical across runs',
               hashes[0] == hashes[1],
               f'{hashes[0][:12]} vs {hashes[1][:12]}')
    check_bool('row counts identical across runs',
               len(rows_by_run[0]) == len(rows_by_run[1]))


def main() -> int:
    test_rectangle_width()
    test_l_shape_coverage()
    test_degenerate_input()
    test_end_to_end_determinism()
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} check(s) FAILED")
        return 1
    print("RESULT: all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
