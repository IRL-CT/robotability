#!/usr/bin/env bash
# Cron entry for the Robotability cluster pipeline.
# Runs the four stages in order: fetch, build, score, emit.
# The emit stage runs the contract validator and gates on its EXIT CODE.
# A failed validator exit code fails this run. Printed text is not the gate.
#
# Usage:
#   bash run_all.sh --bbox -73.99,40.74,-73.97,40.76 --mock-lab-data \
#       --out /tmp/snapshot-test
#   bash run_all.sh --config cluster_config.yaml --out /share/group/out
#
# Flags:
#   --bbox minlon,minlat,maxlon,maxlat   Small-area run.
#   --mock-lab-data                      Synthetic lab columns. Implies
#                                        --skip on fetch_public.py.
#   --out DIR                            Snapshot directory.
#   --config FILE                        Cluster config yaml.
#   --simulate-missing NAME              Partial-run probe. NAME is one of
#                                        dashcam_detections,
#                                        surveillance_values, dem.
#   --date YYYY-MM-DD                    Snapshot date. Default: today UTC.
#   --seed N                             Mock data seed.
#   -h, --help                           Print this usage text.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BBOX=""
MOCK=0
OUT=""
CONFIG=""
SIMULATE_MISSING=""
DATE=""
SEED=""

usage() {
  sed -n '2,$p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bbox) BBOX="$2"; shift 2 ;;
    --mock-lab-data) MOCK=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --simulate-missing) SIMULATE_MISSING="$2"; shift 2 ;;
    --date) DATE="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$OUT" ]; then
  OUT="/tmp/robotability-snapshot-$(date -u +%Y-%m-%d)"
fi

# Prefer the local venv python. Fall back to the system python3.
PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
fi

WORK="$OUT/_work"
mkdir -p "$WORK"

echo "run_all: output dir $OUT"
echo "run_all: work dir $WORK"

# Stage 1: fetch public inputs. Mock mode skips the network.
FETCH_ARGS=(--work "$WORK")
if [ "$MOCK" -eq 1 ]; then
  FETCH_ARGS+=(--skip)
fi
"$PYTHON" "$SCRIPT_DIR/fetch_public.py" "${FETCH_ARGS[@]}"

# Stage 2: build the raw feature table.
BUILD_ARGS=(--work "$WORK"
            --out "$WORK/features_raw.parquet"
            --report "$WORK/build_report.json")
[ -n "$BBOX" ] && BUILD_ARGS+=(--bbox "$BBOX")
[ "$MOCK" -eq 1 ] && BUILD_ARGS+=(--mock-lab-data)
[ -n "$CONFIG" ] && BUILD_ARGS+=(--config "$CONFIG")
[ -n "$SIMULATE_MISSING" ] && BUILD_ARGS+=(--simulate-missing "$SIMULATE_MISSING")
[ -n "$SEED" ] && BUILD_ARGS+=(--seed "$SEED")
"$PYTHON" "$SCRIPT_DIR/build_features.py" "${BUILD_ARGS[@]}"

# Stage 3: normalize, weight, and score.
"$PYTHON" "$SCRIPT_DIR/compute_score.py" \
  --in "$WORK/features_raw.parquet" \
  --out "$WORK/features_scored.parquet"

# Stage 4: emit the artifacts and run the contract validator.
# The validator exit code is the gate. See emit_artifacts.run_validator.
EMIT_ARGS=(--in "$WORK/features_scored.parquet"
           --report "$WORK/build_report.json"
           --out "$OUT")
[ -n "$DATE" ] && EMIT_ARGS+=(--date "$DATE")
"$PYTHON" "$SCRIPT_DIR/emit_artifacts.py" "${EMIT_ARGS[@]}"
