#!/usr/bin/env python3
"""Unit tests for the slope_gradient feature.

Slope is the grade ALONG the sidewalk: the height difference between the
two ends of the segment over the distance between them. It is not the
relief around the segment, which is what the two earlier ports measured.

Run:
    python3 pipeline/cluster/tests/test_slope_gradient.py
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import score_core as sc  # noqa: E402
from features_spec import SLOPE_BASELINE_FT, SLOPE_MAX_GRADE  # noqa: E402

FAILURES = []


def check(name, got, want, tol=1e-12):
    ok = (math.isnan(got) and math.isnan(want)) or abs(got - want) <= tol
    print(f'{"ok  " if ok else "FAIL"} {name}: {got}')
    if not ok:
        FAILURES.append(f'{name}: got {got}, want {want}')


def test_flat_ground_is_zero():
    got = sc.slope_gradient([12.0], [12.0], [40.0])
    check('flat ground reads 0', got[0], 0.0)


def test_known_grade():
    # 1 ft of rise over 20 ft of run is a 5% grade.
    got = sc.slope_gradient([0.0], [1.0], [20.0])
    check('1 ft per 20 ft reads 0.0500', got[0], 0.05)


def test_downhill_matches_uphill():
    # The score needs the magnitude. A segment has no direction of
    # travel, so a sign would only record which end came first.
    up = sc.slope_gradient([0.0], [2.0], [40.0])[0]
    down = sc.slope_gradient([2.0], [0.0], [40.0])[0]
    check('downhill equals uphill', down, up)
    check('grade is never negative', min(up, down) >= 0.0, True)


def test_clip_at_max_grade():
    got = sc.slope_gradient([0.0], [100.0], [40.0])
    check('absurd grade clipped', got[0], SLOPE_MAX_GRADE)


def test_no_dem_cover_is_nan():
    # NaN is the no-data marker of contract section 3.2. It must not
    # collapse to 0.0, which is a real and different answer: flat.
    got = sc.slope_gradient([float('nan'), 0.0], [5.0, 0.0], [40.0, 40.0])
    check('missing height reads NaN', got[0], float('nan'))
    check('flat neighbour still reads 0', got[1], 0.0)


def test_zero_run_is_nan():
    got = sc.slope_gradient([0.0], [1.0], [0.0])
    check('zero run reads NaN', got[0], float('nan'))


def test_degenerate_inputs():
    check('empty input returns empty', len(sc.slope_gradient([], [], [])), 0)
    one = sc.slope_gradient([3.0], [3.0], [SLOPE_BASELINE_FT])
    check('single segment handled', one[0], 0.0)


def test_run_length_divides():
    # The same rise over a longer run is a gentler grade. This is what
    # the neighbour-based port could not express.
    steep = sc.slope_gradient([0.0], [2.0], [20.0])[0]
    gentle = sc.slope_gradient([0.0], [2.0], [80.0])[0]
    check('longer run gives gentler grade', gentle, steep / 4.0)


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
    if FAILURES:
        print('\nRESULT: FAILURES')
        for f in FAILURES:
            print('  ' + f)
        return 1
    print('\nRESULT: all checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
