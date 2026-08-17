"""Tests for score_core.slope_gradient.

The three properties here are the three defects the 2026 citywide run
exposed, so each test fails against the previous implementation:
a neighbour 0.000079 ft away must not dominate, a segment must not be
limited to a 50 ft radius that its spacing makes meaningless, and an
absurd grade must not survive into normalization.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import score_core as sc  # noqa: E402
from features_spec import (  # noqa: E402
    SLOPE_MAX_GRADE,
    SLOPE_MIN_BASELINE_FT,
)


def test_flat_ground_is_zero() -> None:
    """Equal elevations give a zero slope, whatever the spacing."""
    coords = [(0.0, 0.0), (30.0, 0.0), (60.0, 0.0), (90.0, 0.0)]
    out = sc.slope_gradient([12.0] * 4, coords)
    assert all(abs(v) < 1e-12 for v in out), out
    print('ok   flat ground reads 0')


def test_known_grade() -> None:
    """A 1 ft rise every 20 ft is a 5% grade."""
    coords = [(0.0, 0.0), (20.0, 0.0), (40.0, 0.0)]
    out = sc.slope_gradient([0.0, 1.0, 2.0], coords)
    # The middle point sees both neighbours at 20 ft, each 1 ft away in
    # height: mean slope 0.05 exactly.
    assert abs(out[1] - 0.05) < 1e-12, f'middle segment is {out[1]}, want 0.05'
    print(f'ok   1 ft per 20 ft reads {out[1]:.4f}')


def test_near_coincident_neighbour_is_ignored() -> None:
    """A neighbour under the baseline must not create a huge slope.

    This is the citywide failure in miniature: two centroids a
    thousandth of an inch apart, one whole DEM foot different, which the
    old code turned into a slope near 100 and which then set the top of
    the min-max range for the entire city.
    """
    coords = [(0.0, 0.0), (0.000079, 0.0), (25.0, 0.0), (50.0, 0.0)]
    elev = [10.0, 11.0, 10.0, 10.0]
    out = sc.slope_gradient(elev, coords)
    assert max(out) <= SLOPE_MAX_GRADE, f'a slope exceeded the cap: {out}'
    # The 0.000079 ft pair contributes nothing; point 0 sees only the
    # neighbours at 25 ft and 50 ft, both at the same elevation.
    assert abs(out[0]) < 1e-12, f'point 0 is {out[0]}, want 0'
    print(f'ok   sub-baseline neighbour ignored, max {max(out):.4f}')


def test_baseline_boundary() -> None:
    """A neighbour exactly at the baseline counts; just inside does not."""
    at = sc.slope_gradient([0.0, 1.0], [(0.0, 0.0), (SLOPE_MIN_BASELINE_FT, 0.0)])
    assert at[0] > 0, 'a neighbour at exactly the baseline must count'
    inside = sc.slope_gradient(
        [0.0, 1.0], [(0.0, 0.0), (SLOPE_MIN_BASELINE_FT - 0.5, 0.0)]
    )
    assert inside[0] == 0.0, 'a neighbour inside the baseline must not count'
    print('ok   baseline boundary is inclusive')


def test_no_radius_cap() -> None:
    """Distant neighbours are still measured, not written off as flat.

    Under the old 50 ft radius both of these segments returned 0.0,
    indistinguishable from level ground. 35.25% of the city was in this
    state.
    """
    coords = [(0.0, 0.0), (400.0, 0.0)]
    out = sc.slope_gradient([0.0, 20.0], coords)
    assert out[0] > 0, 'a neighbour beyond 50 ft must still be measured'
    assert abs(out[0] - 20.0 / 400.0) < 1e-12, out
    print(f'ok   400 ft neighbour measured, {out[0]:.4f}')


def test_clip_at_max_grade() -> None:
    """An implausible grade is clipped, not passed through."""
    coords = [(0.0, 0.0), (SLOPE_MIN_BASELINE_FT, 0.0)]
    out = sc.slope_gradient([0.0, 100.0], coords)
    assert out[0] == SLOPE_MAX_GRADE, f'{out[0]} should clip to {SLOPE_MAX_GRADE}'
    print(f'ok   absurd grade clipped to {SLOPE_MAX_GRADE}')


def test_degenerate_inputs() -> None:
    """Empty and single-segment inputs do not crash."""
    assert sc.slope_gradient([], []) == []
    assert sc.slope_gradient([5.0], [(0.0, 0.0)]) == [0.0]
    print('ok   empty and single inputs handled')
