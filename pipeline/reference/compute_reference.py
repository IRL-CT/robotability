#!/usr/bin/env python3
"""Reference implementation of the Robotability score.

This script replicates the arithmetic of
robotability-nyc/feature_processing/score.ipynb:

- cell 1:   min_max_normalize(col) = (col - min) / (max - min)
- cells 15-90: COMPUTE_<feature> = normalized value x weight
- cell 92:  assert all normalized values lie in [0, 1]
- cell 96:  POLARITIES dict
- cell 97:  score = sum over features of polarity x weighted value

The score formula is:

    score = sum_f POLARITIES[f] x minmax(value_f, min_f, max_f) x WEIGHTS[f]

Input format (CSV). One header row, then one row per sample. Columns:

    row_id, <feature>, <feature>__min, <feature>__max   (per feature)

The 19 features each contribute three columns: the raw value, the
per-feature min stat, and the per-feature max stat. The stats shape
{min, max} matches feature_stats in pipeline/contract/cluster_contract.md.
Stats are per-row, so each row carries its own normalization window.

Output format (JSON). An array of rows: [{"row_id": ..., "score": ...}].

This script uses only the Python standard library (argparse, csv, json,
sys, pathlib). It runs anywhere Python 3 runs.

Degenerate stats note: score.ipynb cell 1 returns 0.0 when min == max.
The T3 engine contract returns the midpoint 0.5 instead and logs once.
This reference follows the engine contract so both implementations agree
on every input. The parity fixture never uses degenerate stats.
"""

import argparse
import csv
import json
import sys
from pathlib import Path

# The 19 computed features, in feature_weights.csv order.
# Source: robotability-nyc/survey_processing/feature_weights.csv
FEATURES = [
    "sidewalk_width",
    "pedestrian_density",
    "street_furniture_density",
    "sidewalk_roughness",
    "surface_condition",
    "communication_infrastructure",
    "slope_gradient",
    "charging_station_proximity",
    "curb_ramp_availability",
    "crowd_dynamics",
    "traffic_management",
    "surveillance_coverage",
    "zoning_laws",
    "bike_lane_availability",
    "gps_signal_strength",
    "bicycle_traffic",
    "vehicle_traffic",
    "digital_map_existence",
    "intersection_safety",
]

# Polarity per computed feature.
# Source: robotability-nyc/feature_processing/score.ipynb cell 96.
POLARITIES = {
    "sidewalk_width": 1,
    "pedestrian_density": -1,
    "street_furniture_density": -1,
    "sidewalk_roughness": -1,
    "surface_condition": 1,
    "communication_infrastructure": 1,
    "slope_gradient": -1,
    "charging_station_proximity": 1,
    "curb_ramp_availability": 1,
    "crowd_dynamics": 1,
    "traffic_management": 1,
    "surveillance_coverage": 1,
    "zoning_laws": 1,
    "bike_lane_availability": 1,
    "gps_signal_strength": 1,
    "bicycle_traffic": -1,
    "vehicle_traffic": -1,
    "digital_map_existence": 1,
    "intersection_safety": -1,
}

# Default weights file, relative to this script.
DEFAULT_WEIGHTS = (
    Path(__file__).resolve().parent.parent.parent
    / "robotability-nyc"
    / "survey_processing"
    / "feature_weights.csv"
)


def load_weights(path):
    """Read the 19 survey weights from feature_weights.csv."""
    weights = {}
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            weights[row["Feature"]] = float(row["Weight"])
    if set(weights) != set(FEATURES):
        missing = sorted(set(FEATURES) - set(weights))
        extra = sorted(set(weights) - set(FEATURES))
        raise ValueError(
            f"weights file does not match the 19 features; "
            f"missing={missing} extra={extra}"
        )
    return weights


def minmax(value, low, high):
    """Min-max normalize one value. Clamp the result to [0, 1].

    score.ipynb cell 1 computes (value - min) / (max - min).
    When max == min the engine contract returns the midpoint 0.5.
    """
    if high == low:
        return 0.5
    normalized = (value - low) / (high - low)
    if normalized < 0.0:
        return 0.0
    if normalized > 1.0:
        return 1.0
    return normalized


def score_row(values, stats, weights):
    """Compute one score. Sum polarity x normalized x weight over features."""
    score = 0.0
    for feature in FEATURES:
        normalized = minmax(values[feature], stats[feature]["min"], stats[feature]["max"])
        score += POLARITIES[feature] * normalized * weights[feature]
    return score


def required_columns():
    """List the required CSV header columns."""
    columns = ["row_id"]
    for feature in FEATURES:
        columns.append(feature)
        columns.append(feature + "__min")
        columns.append(feature + "__max")
    return columns


def parse_float(raw, row_id, column):
    """Parse one float cell. Raise a clean error on bad input."""
    try:
        return float(raw)
    except (TypeError, ValueError):
        raise ValueError(
            f"row '{row_id}': column '{column}' is not a number: {raw!r}"
        )


def read_rows(path):
    """Read the input CSV. Return a list of (row_id, values, stats)."""
    required = set(required_columns())
    rows = []
    with open(path, newline="") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        missing = sorted(required - set(header))
        if missing:
            raise ValueError("missing column(s): " + ", ".join(missing))
        for raw in reader:
            row_id = raw["row_id"]
            values = {}
            stats = {}
            for feature in FEATURES:
                values[feature] = parse_float(raw[feature], row_id, feature)
                low = parse_float(raw[feature + "__min"], row_id, feature + "__min")
                high = parse_float(raw[feature + "__max"], row_id, feature + "__max")
                stats[feature] = {"min": low, "max": high}
            rows.append((row_id, values, stats))
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Compute Robotability reference scores from a CSV."
    )
    parser.add_argument("--input", required=True, help="input CSV path")
    parser.add_argument("--output", required=True, help="output JSON path")
    parser.add_argument(
        "--weights",
        default=str(DEFAULT_WEIGHTS),
        help="feature weights CSV (default: robotability-nyc feature_weights.csv)",
    )
    args = parser.parse_args(argv)

    try:
        weights = load_weights(args.weights)
        rows = read_rows(args.input)
    except (OSError, ValueError, KeyError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    results = []
    for row_id, values, stats in rows:
        results.append({"row_id": row_id, "score": score_row(values, stats, weights)})

    with open(args.output, "w") as handle:
        json.dump(results, handle, indent=2)
        handle.write("\n")
    print(f"wrote {len(results)} rows to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
