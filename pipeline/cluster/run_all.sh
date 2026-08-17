#!/usr/bin/env bash
# Cron entry for the Robotability cluster pipeline.
# Runs the five stages in order: fetch, segment, build, score, emit.
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
#   --from-stage N                       Start at stage N (1-5). Default 1.
#                                        Stages: 1 fetch, 2 segment, 3 build,
#                                        4 score, 5 emit. Use this to resume
#                                        a run whose earlier stages already
#                                        wrote their outputs to the work dir.
#                                        Stage 2 costs about 45 min on the
#                                        full city, so resuming at 3 after a
#                                        failed build is worth the flag.
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
FROM_STAGE=1

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
    --from-stage) FROM_STAGE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

case "$FROM_STAGE" in
  1|2|3|4|5) ;;
  *) echo "ERROR: --from-stage must be 1-5, got: $FROM_STAGE" >&2; exit 2 ;;
esac

if [ -z "$OUT" ]; then
  OUT="/tmp/robotability-snapshot-$(date -u +%Y-%m-%d)"
fi

# Prefer the local venv python. Fall back to the system python3.
PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
fi

# Put the local tool env on PATH. emit_artifacts.py shells out to
# tippecanoe for the PMTiles build and looks for it on PATH only. The
# conda env in .tools carries it, but a batch job starts from a login
# profile that never sources that env, so a run reaching stage 5 died on
# "tippecanoe is not on PATH" with the binary sitting right there.
if [ -d "$SCRIPT_DIR/.tools/bin" ]; then
  PATH="$SCRIPT_DIR/.tools/bin:$PATH"
  export PATH
fi

# Raise the open file limit for tippecanoe. It shards a city-scale tile
# build across many temporary files at once and dies with "Too many open
# files" under a low limit. A batch job does not always inherit the login
# shell's limit, so set it here rather than assuming. Best effort: a
# shell that refuses the raise still runs, it just keeps its old limit.
if [ -n "${BASH_VERSION:-}" ]; then
  hard_nofile="$(ulimit -Hn 2>/dev/null || echo '')"
  if [ -n "$hard_nofile" ] && [ "$hard_nofile" != "unlimited" ]; then
    ulimit -n "$hard_nofile" 2>/dev/null || true
  else
    ulimit -n 65536 2>/dev/null || true
  fi
fi
echo "run_all: open file limit $(ulimit -Sn)"

WORK="$OUT/_work"
mkdir -p "$WORK"

echo "run_all: output dir $OUT"
echo "run_all: work dir $WORK"

if [ "$FROM_STAGE" -gt 1 ]; then
  echo "run_all: starting at stage $FROM_STAGE"
fi

# Stage 1: fetch public inputs. Mock mode skips the network.
if [ "$FROM_STAGE" -le 1 ]; then
  FETCH_ARGS=(--work "$WORK")
  if [ "$MOCK" -eq 1 ]; then
    FETCH_ARGS+=(--skip)
  fi
  "$PYTHON" "$SCRIPT_DIR/fetch_public.py" "${FETCH_ARGS[@]}"
fi

# Stage 2: segment the sidewalk basemap into centerlines. Mock mode
# generates its own segments, so it skips this stage.
if [ "$FROM_STAGE" -le 2 ] && [ "$MOCK" -eq 0 ]; then
  "$PYTHON" "$SCRIPT_DIR/segment_basemap.py" --work "$WORK"
fi

# Stage 3: build the raw feature table.
if [ "$FROM_STAGE" -le 3 ]; then
  BUILD_ARGS=(--work "$WORK"
              --out "$WORK/features_raw.parquet"
              --report "$WORK/build_report.json")
  # Use the --flag=value form. A bbox starts with a minus sign. argparse
  # reads a separate value that starts with a minus sign as a flag.
  [ -n "$BBOX" ] && BUILD_ARGS+=("--bbox=$BBOX")
  [ "$MOCK" -eq 1 ] && BUILD_ARGS+=(--mock-lab-data)
  [ -n "$CONFIG" ] && BUILD_ARGS+=(--config "$CONFIG")
  [ -n "$SIMULATE_MISSING" ] && BUILD_ARGS+=(--simulate-missing "$SIMULATE_MISSING")
  [ -n "$SEED" ] && BUILD_ARGS+=(--seed "$SEED")
  "$PYTHON" "$SCRIPT_DIR/build_features.py" "${BUILD_ARGS[@]}"
fi

# Stage 4: normalize, weight, and score.
if [ "$FROM_STAGE" -le 4 ]; then
  "$PYTHON" "$SCRIPT_DIR/compute_score.py" \
    --in "$WORK/features_raw.parquet" \
    --out "$WORK/features_scored.parquet"
fi

# Stage 5: emit the artifacts and run the contract validator.
# The validator exit code is the gate. See emit_artifacts.run_validator.
EMIT_ARGS=(--in "$WORK/features_scored.parquet"
           --report "$WORK/build_report.json"
           --out "$OUT")
[ -n "$DATE" ] && EMIT_ARGS+=(--date "$DATE")
"$PYTHON" "$SCRIPT_DIR/emit_artifacts.py" "${EMIT_ARGS[@]}"

# Stage 6: hand the snapshot to CI. Only reached when stage 5 exits 0,
# which means the contract validator passed, so this never publishes a
# rejected snapshot. What it does depends on trigger_mode in the config,
# and trigger_mode none makes it a no-op.
PUBLISH_ARGS=(--out "$OUT")
[ -n "$CONFIG" ] && PUBLISH_ARGS+=(--config "$CONFIG")
"$PYTHON" "$SCRIPT_DIR/publish_snapshot.py" "${PUBLISH_ARGS[@]}"
