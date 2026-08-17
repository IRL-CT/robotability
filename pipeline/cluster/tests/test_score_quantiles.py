"""Tests for emit_artifacts.score_quantiles, the map's colour breaks.

The map draws each segment by where its score falls among these breaks.
Two properties matter and neither is obvious from the happy path: the
result must be strictly increasing, because MapLibre throws on an
interpolate expression with repeated stops, and NaN must never reach it.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import emit_artifacts as ea  # noqa: E402


def _strictly_increasing(values) -> bool:
    return all(b > a for a, b in zip(values, values[1:]))


def test_even_spread_gives_deciles() -> None:
    """A uniform 0..1 sample yields the deciles."""
    q = ea.score_quantiles([i / 1000 for i in range(1001)])
    assert len(q) == 11, f'want 11 stops, got {len(q)}'
    for i, value in enumerate(q):
        assert abs(value - i / 10) < 1e-9, f'stop {i} is {value}, want {i / 10}'
    print(f'ok   uniform sample gives deciles {q[0]:.1f}..{q[-1]:.1f}')


def test_constant_scores_stay_strictly_increasing() -> None:
    """Every score identical still yields 11 usable stops.

    A real snapshot cannot hit this, but a bbox run over a tiny area can
    come close, and MapLibre rejects the layer outright when two stops
    repeat. The nudge must be upward and must not collapse.
    """
    q = ea.score_quantiles([0.5] * 100)
    assert len(q) == 11
    assert _strictly_increasing(q), f'stops repeat: {q}'
    assert abs(q[0] - 0.5) < 1e-12
    print(f'ok   constant input stays strictly increasing, span {q[-1] - q[0]:.2e}')


def test_ties_at_the_ends_stay_strictly_increasing() -> None:
    """A bimodal sample puts many identical values at both ends."""
    q = ea.score_quantiles([0.0] * 50 + [1.0] * 50)
    assert _strictly_increasing(q), f'stops repeat: {q}'
    print('ok   bimodal input stays strictly increasing')


def test_nan_is_skipped() -> None:
    """NaN scores are dropped, not propagated into a break."""
    q = ea.score_quantiles([float('nan')] * 10 + [i / 100 for i in range(101)])
    assert not any(math.isnan(v) for v in q), f'a break is NaN: {q}'
    assert abs(q[0] - 0.0) < 1e-9 and abs(q[-1] - 1.0) < 1e-9
    print('ok   NaN scores are skipped')


def test_breaks_bracket_the_data() -> None:
    """The first break is the minimum and the last is the maximum.

    The map clamps outside the end stops, so a break that sat inside the
    data would flatten the colour of everything beyond it.
    """
    scores = [0.02, 0.31, 0.18, 0.25, 0.09, 0.27, 0.22, 0.15, 0.30, 0.11]
    q = ea.score_quantiles(scores)
    assert abs(q[0] - min(scores)) < 1e-12, f'first break {q[0]} != min'
    assert abs(q[-1] - max(scores)) < 1e-12, f'last break {q[-1]} != max'
    print(f'ok   breaks bracket the data [{q[0]}, {q[-1]}]')
