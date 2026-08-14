#!/usr/bin/env python3
"""Generate the score engine parity fixture.

This script builds 100 deterministic input rows, scores them with the
Python reference (compute_reference.py), and writes
src/lib/score/__fixtures__/parity.json.

Row layout:
- 90 synthetic rows that span edge cases:
  all zeros, all ones, each feature alone at 1, each feature alone at 0
  (all others at 1), uniform 0.25/0.5/0.75, the two theoretical score
  bounds, gradient and alternating patterns, non-trivial per-row stats,
  out-of-range values that exercise the clamp, and fractional mixes.
- 10 rows with scores drawn from the observed 2023 score range
  [0.03, 0.38], found by seeded rejection sampling.

The fixture never uses degenerate stats (max == min). The max == min
behavior is covered by a dedicated unit test instead.

Flow: this script writes a temporary input CSV, runs compute_reference.py
as a subprocess, reads the JSON output, and assembles the fixture. It
deletes the temporary CSV and JSON when it finishes.

This script uses only the Python standard library.
"""

import csv
import json
import random
import subprocess
import sys
from pathlib import Path

import compute_reference

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
FIXTURE_PATH = REPO_ROOT / "src" / "lib" / "score" / "__fixtures__" / "parity.json"

FEATURES = compute_reference.FEATURES
POLARITIES = compute_reference.POLARITIES

# Theoretical score bounds. Negative-polarity weights sum to 0.40487854324919387.
# Positive-polarity weights sum to 0.5951214567508061.
SCORE_MIN = -0.4049
SCORE_MAX = 0.5952

# Observed 2023 score range for the last 10 rows.
OBSERVED_MIN = 0.03
OBSERVED_MAX = 0.38

DEFAULT_STATS = {f: {"min": 0.0, "max": 1.0} for f in FEATURES}


def build_synthetic_rows():
    """Build the 90 deterministic synthetic rows."""
    rows = []

    # 1-2: all zeros and all ones.
    rows.append(("all_zeros", {f: 0.0 for f in FEATURES}, DEFAULT_STATS))
    rows.append(("all_ones", {f: 1.0 for f in FEATURES}, DEFAULT_STATS))

    # 3-21: one feature at 1, all others at 0. Score = polarity x weight.
    for feature in FEATURES:
        values = {f: 0.0 for f in FEATURES}
        values[feature] = 1.0
        rows.append((f"single_one_{feature}", values, DEFAULT_STATS))

    # 22-40: one feature at 0, all others at 1.
    for feature in FEATURES:
        values = {f: 1.0 for f in FEATURES}
        values[feature] = 0.0
        rows.append((f"single_zero_{feature}", values, DEFAULT_STATS))

    # 41-43: uniform values.
    for level in (0.25, 0.5, 0.75):
        rows.append((f"uniform_{level}", {f: level for f in FEATURES}, DEFAULT_STATS))

    # 44-45: theoretical score bounds.
    values = {f: (1.0 if POLARITIES[f] == 1 else 0.0) for f in FEATURES}
    rows.append(("bound_max", values, DEFAULT_STATS))
    values = {f: (0.0 if POLARITIES[f] == 1 else 1.0) for f in FEATURES}
    rows.append(("bound_min", values, DEFAULT_STATS))

    # 46-51: gradient and alternating patterns.
    rows.append(
        ("gradient_up", {f: i / 18.0 for i, f in enumerate(FEATURES)}, DEFAULT_STATS)
    )
    rows.append(
        ("gradient_down", {f: 1.0 - i / 18.0 for i, f in enumerate(FEATURES)}, DEFAULT_STATS)
    )
    rows.append(
        ("alternate_0_1", {f: float(i % 2) for i, f in enumerate(FEATURES)}, DEFAULT_STATS)
    )
    rows.append(
        (
            "alternate_quarter",
            {f: 0.25 if i % 2 == 0 else 0.75 for i, f in enumerate(FEATURES)},
            DEFAULT_STATS,
        )
    )
    rows.append(
        (
            "even_one_odd_half",
            {f: 1.0 if i % 2 == 0 else 0.5 for i, f in enumerate(FEATURES)},
            DEFAULT_STATS,
        )
    )
    rows.append(
        ("mod3_steps", {f: (i % 3) / 2.0 for i, f in enumerate(FEATURES)}, DEFAULT_STATS)
    )

    # 52-71: non-trivial per-row stats. Values stay inside [min, max].
    rng = random.Random(20260812)
    for k in range(20):
        values = {}
        stats = {}
        for feature in FEATURES:
            low = round(rng.uniform(0.0, 2.0), 6)
            span = round(rng.uniform(0.25, 3.0), 6)
            stats[feature] = {"min": low, "max": low + span}
            values[feature] = round(low + rng.random() * span, 6)
        rows.append((f"nontrivial_stats_{k + 1:02d}", values, stats))

    # 72-76: out-of-range values. The clamp path must bind them to [0, 1].
    for k in range(5):
        values = {}
        stats = {}
        for i, feature in enumerate(FEATURES):
            stats[feature] = {"min": 1.0, "max": 2.0}
            if (i + k) % 2 == 0:
                values[feature] = 0.5 - 0.1 * k  # below min -> clamps to 0
            else:
                values[feature] = 2.5 + 0.1 * k  # above max -> clamps to 1
        rows.append((f"clamp_{k + 1}", values, stats))

    # 77-90: fractional mixes on a 0.25 grid.
    for k in range(1, 8):
        for r in (0, 1):
            values = {f: ((i * k + r) % 4) / 4.0 for i, f in enumerate(FEATURES)}
            rows.append((f"fractional_mix_k{k}_r{r}", values, DEFAULT_STATS))

    return rows


def build_observed_rows(weights, count=10):
    """Build rows whose scores fall in the observed 2023 range [0.03, 0.38].

    Uses seeded rejection sampling, so the output is deterministic.
    """
    rng = random.Random(987654321)
    rows = []
    while len(rows) < count:
        values = {}
        stats = {}
        for feature in FEATURES:
            low = rng.uniform(0.0, 1.5)
            span = rng.uniform(0.5, 3.0)
            stats[feature] = {"min": round(low, 6), "max": round(low + span, 6)}
            values[feature] = round(low + rng.random() * span, 6)
        score = compute_reference.score_row(values, stats, weights)
        if OBSERVED_MIN <= score <= OBSERVED_MAX:
            rows.append((f"observed_range_{len(rows) + 1:02d}", values, stats))
    return rows


def write_input_csv(rows, path):
    """Write the reference input CSV. One stats window per row."""
    columns = compute_reference.required_columns()
    with open(path, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row_id, values, stats in rows:
            record = {"row_id": row_id}
            for feature in FEATURES:
                record[feature] = repr(values[feature])
                record[feature + "__min"] = repr(stats[feature]["min"])
                record[feature + "__max"] = repr(stats[feature]["max"])
            writer.writerow(record)


def run_reference(input_csv, output_json):
    """Run compute_reference.py as a subprocess. Fail loudly on error."""
    command = [
        sys.executable,
        str(HERE / "compute_reference.py"),
        "--input",
        str(input_csv),
        "--output",
        str(output_json),
    ]
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"compute_reference.py failed with code {proc.returncode}")
    with open(output_json) as handle:
        return {item["row_id"]: item["score"] for item in json.load(handle)}


def main():
    weights = compute_reference.load_weights(compute_reference.DEFAULT_WEIGHTS)

    rows = build_synthetic_rows()
    assert len(rows) == 90, f"expected 90 synthetic rows, got {len(rows)}"
    rows.extend(build_observed_rows(weights))
    assert len(rows) == 100, f"expected 100 rows, got {len(rows)}"

    input_csv = HERE / "parity_input.csv"
    output_json = HERE / "parity_output.json"
    try:
        write_input_csv(rows, input_csv)
        scores = run_reference(input_csv, output_json)
    finally:
        # Clean up intermediate files. Only parity.json survives.
        input_csv.unlink(missing_ok=True)
        output_json.unlink(missing_ok=True)

    fixture = []
    for row_id, values, stats in rows:
        fixture.append(
            {"values": values, "stats": stats, "expected": scores[row_id]}
        )

    # Sanity checks before write.
    assert len(fixture) == 100
    for item in fixture:
        assert SCORE_MIN <= item["expected"] <= SCORE_MAX, item["expected"]
    for item in fixture[-10:]:
        assert OBSERVED_MIN <= item["expected"] <= OBSERVED_MAX, item["expected"]

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FIXTURE_PATH, "w") as handle:
        json.dump(fixture, handle, indent=2)
        handle.write("\n")

    print(f"wrote {len(fixture)} rows to {FIXTURE_PATH}")
    print(f"score range: [{min(i['expected'] for i in fixture)}, "
          f"{max(i['expected'] for i in fixture)}]")
    print(f"observed-range rows: {[round(i['expected'], 6) for i in fixture[-10:]]}")
    print("cleanup receipt: removed parity_input.csv and parity_output.json")


if __name__ == "__main__":
    main()
