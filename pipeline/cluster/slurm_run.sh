#!/usr/bin/env bash
# Submit the Robotability cluster pipeline to Slurm.
#
# Run the pipeline through Slurm rather than from a shell. A run started
# with nohup from an interactive shell or an agent session dies when that
# session is torn down, and the loss is silent: the log is left at zero
# bytes and no stage output appears. A batch job survives the session and
# records its own exit state in sacct.
#
# This file is both the submit wrapper and the job script. Invoked from a
# login shell it re-submits itself with sbatch. Invoked by Slurm it runs
# run_all.sh. That keeps the stage list in run_all.sh only.
#
# Usage:
#   bash slurm_run.sh --config /share/ju/robotability-runs/cluster_config.yaml \
#       --out /share/ju/robotability-runs/nyc_citywide
#   bash slurm_run.sh --from-stage 3 --config <cfg> --out <dir>
#
# Every argument is passed through to run_all.sh untouched. See its
# --help for the full flag list. --from-stage 3 resumes after fetch and
# segmentation have already written the work dir.
#
# Resource overrides, as environment variables. They carry a ROBOTABILITY_
# prefix on purpose. Slurm exports its own SLURM_* variables into every
# job and interactive session, so a SLURM_-prefixed default silently picks
# up the surrounding session's value: SLURM_JOB_NAME is already set to
# session_ju here, which named an earlier submission session_ju and hid it
# from squeue -n robotability.
#   ROBOTABILITY_PARTITION  partition name    (default ju)
#   ROBOTABILITY_CPUS       cpus per task     (default 8)
#   ROBOTABILITY_MEM        memory            (default 64G)
#   ROBOTABILITY_TIME       wall clock limit  (default 12:00:00)
#   ROBOTABILITY_JOB_NAME   job name          (default robotability)
#
# The defaults suit a full-city run: build_features samples a 3.4 GB DEM
# and joins about 30 point sets against ~490k segments, and segmentation
# uses one worker per cpu.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Do NOT branch on SLURM_JOB_ID. An interactive session on this cluster is
# itself a Slurm allocation, so SLURM_JOB_ID is already set in a normal
# shell here. Branching on it made the script run the pipeline in the
# caller's session instead of submitting it, which is the exact failure
# this file exists to prevent. Only the sbatch call below sets the
# sentinel, so it is true in a batch job and nowhere else.
if [ -n "${ROBOTABILITY_BATCH:-}" ]; then
  # sbatch copies the job script into /var/spool/slurmd/job<id>/, so
  # BASH_SOURCE points at that copy and SCRIPT_DIR would resolve to the
  # spool directory, where run_all.sh does not exist. The submit branch
  # exports the real directory for this reason.
  SCRIPT_DIR="${ROBOTABILITY_DIR:-$SCRIPT_DIR}"
  if [ ! -f "$SCRIPT_DIR/run_all.sh" ]; then
    echo "ERROR: run_all.sh not found in $SCRIPT_DIR" >&2
    exit 2
  fi
  echo "slurm_run: job ${SLURM_JOB_ID:-unknown} on $(hostname)"
  echo "slurm_run: script dir $SCRIPT_DIR"
  echo "slurm_run: started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "slurm_run: args $*"
  # Catch the exit code rather than letting set -e abort here, so the log
  # always ends with a status line saying how the run went. The code is
  # re-raised below, so Slurm still records a failed run as FAILED.
  set +e
  bash "$SCRIPT_DIR/run_all.sh" "$@"
  status=$?
  set -e
  echo "slurm_run: finished $(date -u +%Y-%m-%dT%H:%M:%SZ) status $status"
  exit "$status"
fi

# ---- login shell path: submit ----

if ! command -v sbatch >/dev/null 2>&1; then
  echo "ERROR: sbatch not found. Run run_all.sh directly instead." >&2
  exit 2
fi

PARTITION="${ROBOTABILITY_PARTITION:-pierson}"
CPUS="${ROBOTABILITY_CPUS:-8}"
MEM="${ROBOTABILITY_MEM:-64G}"
TIME_LIMIT="${ROBOTABILITY_TIME:-12:00:00}"
JOB_NAME="${ROBOTABILITY_JOB_NAME:-robotability}"

# Park logs next to the snapshot when --out says where it goes, so a run's
# log sits with the run it produced. Fall back to the repo directory.
OUT_DIR=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--out" ] && OUT_DIR="$arg"
  prev="$arg"
done
if [ -n "$OUT_DIR" ]; then
  LOG_DIR="$OUT_DIR"
else
  LOG_DIR="$SCRIPT_DIR"
fi
mkdir -p "$LOG_DIR"

LOG_PATH="$LOG_DIR/slurm-%j.log"

echo "slurm_run: submitting job '$JOB_NAME' to partition $PARTITION"
echo "slurm_run: cpus=$CPUS mem=$MEM time=$TIME_LIMIT"
echo "slurm_run: log $LOG_PATH"
echo "slurm_run: watch with  squeue -u $USER -n $JOB_NAME"

sbatch \
  --job-name="$JOB_NAME" \
  --partition="$PARTITION" \
  --cpus-per-task="$CPUS" \
  --mem="$MEM" \
  --time="$TIME_LIMIT" \
  --output="$LOG_PATH" \
  --open-mode=append \
  --export="ALL,ROBOTABILITY_BATCH=1,ROBOTABILITY_DIR=$SCRIPT_DIR" \
  "${BASH_SOURCE[0]}" "$@"
