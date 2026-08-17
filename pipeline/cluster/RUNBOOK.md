# Cluster Snapshot Pipeline Runbook

This runbook runs the Robotability snapshot pipeline on the lab cluster.
All text uses ASD-STE100 Simplified Technical English.

The pipeline computes one snapshot per run. It writes four artifacts:
`segments.geojson`, `segments.pmtiles`, `features.parquet`,
`manifest.json`. The contract is `pipeline/contract/cluster_contract.md`.

## 1. Requirements

The cluster node needs:

- Python 3.9 or newer with `pyarrow`, `geopandas`, `pandas`, `shapely`,
  `pyyaml`, `centerline`. Real runs also need `rasterio` for the DEM.
- Node.js 18 or newer (the contract validator).
- `tippecanoe` for the PMTiles build.
- A checkout of this repository on the `site-2026` branch or newer.

Optional local setup: `python3 -m venv pipeline/cluster/.venv` and install
the packages into it. `run_all.sh` prefers `pipeline/cluster/.venv/bin/python`
when it exists.

Neither `tippecanoe` nor `node` is on the cluster PATH. Create the tool env
once per checkout:

```
conda create -y -p pipeline/cluster/.tools -c conda-forge tippecanoe nodejs
```

`node` in particular is easy to get wrong. An interactive shell picks it up
from nvm in the user's home directory, so it looks installed; a batch job
does not source nvm and the validator dies with
`FileNotFoundError: 'node'` after the whole snapshot has been built. Put it
in the tool env rather than relying on the login environment.

`run_all.sh` puts `pipeline/cluster/.tools/bin` on PATH when that directory
exists, so no other setup is needed. `.tools/` is gitignored, so a fresh
checkout must run the command above before its first real run.

## 2. Running the pipeline

### 2a. Slurm (use this on the cluster)

Submit through Slurm, not from a shell. A run started with `nohup` from an
interactive shell or an agent session dies when that session ends, and the
loss is silent: the log is left at zero bytes and no stage output appears.
A batch job survives the session and records its exit state in `sacct`.

```
bash pipeline/cluster/slurm_run.sh \
  --config /share/your-lab/robotability/cluster_config.yaml \
  --out /share/your-lab/robotability/snapshots/$(date -u +%Y-%m-%d)
```

Every argument passes through to `run_all.sh`. The job writes
`slurm-<jobid>.log` next to the snapshot. Watch it with:

```
squeue -u $USER -n robotability
tail -f <out>/slurm-<jobid>.log
```

Resources default to partition `ju`, 8 cpus, 64 GB, 12 h, and are
overridden with `ROBOTABILITY_PARTITION`, `ROBOTABILITY_CPUS`,
`ROBOTABILITY_MEM`, `ROBOTABILITY_TIME`, `ROBOTABILITY_JOB_NAME`. The
prefix matters: Slurm exports its own `SLURM_*` variables into every job
and interactive session, so a `SLURM_`-prefixed name would inherit the
surrounding session's value.

A full-city run takes about 25 minutes and peaks near 32 GB.

### 2b. Resuming a failed run

`--from-stage N` starts at stage N and keeps the earlier stages' output.
The stages are 1 fetch, 2 segment, 3 build, 4 score, 5 emit. Segmentation
alone costs about 45 minutes on the full city, so after a stage 3 failure
resume rather than restart:

```
bash pipeline/cluster/slurm_run.sh --from-stage 3 --config <cfg> --out <dir>
```

### 2c. Cron setup

One cron entry runs the whole pipeline. Edit the crontab of the pipeline
user:

```
crontab -e
```

Example entry. It runs every Monday at 03:00 and writes the log next to the
output:

```
0 3 * * 1 cd /share/your-lab/robotability/repo && bash pipeline/cluster/run_all.sh --config pipeline/cluster/cluster_config.yaml --out /share/your-lab/robotability/snapshots/$(date -u +\%Y-\%m-\%d) >> /share/your-lab/robotability/logs/pipeline.log 2>&1
```

Note the escaped `\%` characters. cron treats a bare `%` as a newline.

The owner sets the schedule. The pipeline itself has no timer.

## 3. Config

Copy `cluster_config.example.yaml` to a private location. Fill in the real
lab paths. Pass the file with `--config`. Never commit the filled-in copy.
Never put real lab paths in the repo.

## 4. Small-area test run

Run a fast mock test before any real run. It needs no network and no lab
storage:

```
bash pipeline/cluster/run_all.sh --bbox -73.99,40.74,-73.97,40.76 --mock-lab-data --out /tmp/test-snapshot
```

The run is valid when the last output line shows the validator PASS:

```
emit_artifacts: validator PASS (exit code 0) for /tmp/test-snapshot
```

Mock data is deterministic. The seed is `MOCK_SEED` in
`pipeline_common.py` (value 20260812). The same seed and the same bbox
produce the same `features.parquet` bytes on every run.

## 5. Partial runs

A run with a missing lab input finishes with exit code 0 and sets
`partial: true` in the manifest. This is a signal, not a crash. Fix the
missing input and rerun. CI rejects partial snapshots.

Probe the partial path with:

```
bash pipeline/cluster/run_all.sh --bbox -73.99,40.74,-73.97,40.76 --mock-lab-data --simulate-missing surveillance_values --out /tmp/test-partial
```

## 6. Trigger CI after a successful run

The publish workflow (T6) listens for three triggers. Pick one mode and set
it in the config (`trigger_mode`).

### Option A - fine-grained PAT (primary)

Create a GitHub fine-grained personal access token:

- Repository access: this repository only.
- Permissions: `contents:write` scoped to the snapshots branch, and
  `actions:write`. No other scopes.
- Expiry: 90 days.

Store the token in the cluster secret store (for example `pass`, vault, or
the scheduler's secret store). Never write the token into the repo, the
config file, or a shell history file. Rotate the token every 90 days. Put a
calendar reminder one week before expiry.

Set these in the config and export the token in the job environment:

```yaml
trigger_mode: dispatch
github_repo: <owner>/<repo>
```

```
export GITHUB_TOKEN=<TOKEN>
```

Stage 6 (`publish_snapshot.py`) then fires the dispatch itself after the
validator passes. A `204` response means it was accepted. The publish
workflow runs the validator again before it publishes.

To send the dispatch by hand instead:

```
curl -X POST \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"snapshot-ready"}'
```

### Option B - SSH deploy key (fallback)

Use this mode when the cluster cannot call the GitHub API.

1. Create an SSH key pair on the cluster. Add the public key to the repo as
   a deploy key with write access.
2. Set these in the config:

   ```yaml
   trigger_mode: push
   git_remote: git@github.com:<owner>/<repo>.git
   ```

   Stage 6 then builds the orphan commit in a temporary directory and
   force-pushes it. The branch carries one commit and is replaced whole,
   so it never accumulates the large binary artifacts.

   **`segments.geojson` travels gzipped.** GitHub refuses any blob over
   100 MiB and the full-city geojson is about 101 MiB, so a raw push is
   rejected outright. Stage 6 pushes `segments.geojson.gz` (about 16 MiB,
   6.4x) and the publish workflow expands it before validation. The
   contract still names the uncompressed file and pins its sha256; gzip
   round trips byte for byte, so nothing downstream changes. If another
   artifact later crosses the limit, stage 6 stops with a clear error
   rather than letting the push fail — `segments.pmtiles` is the one to
   watch, at about 61 MiB today.

3. A scheduled CI job polls the branch head every 6 hours and publishes
   valid snapshots. See the publish workflow (T6).

To push by hand instead:

```
git clone --no-checkout git@github.com:<owner>/<repo>.git push-dir
cd push-dir
git checkout --orphan snapshots-incoming
git rm -rf . 2>/dev/null || true
cp /share/your-lab/robotability/snapshots/<date>/* .
gzip -6 segments.geojson          # required, see the note above
git add segments.geojson.gz segments.pmtiles features.parquet manifest.json
git commit -m "snapshot <date>"
git push origin snapshots-incoming
```

## 7. What CI rejects

The publish workflow runs `pipeline/contract/validate_snapshot.mjs` on every
trigger. It rejects:

- Partial snapshots (`partial: true`).
- Any failed validation rule: bad row count, feature value outside [0, 1],
  score outside [-0.4049, 0.5952], stale manifest date (over 48 h), sha256
  mismatch, wrong weights hash, broken parquet schema, missing files.

A rejected snapshot is never published. The cluster log shows the failed
rule names. Fix the cause and rerun the pipeline.

**The 48 hour clock.** `manifest_date_fresh` compares the manifest date
against the time the validator runs, not the time the snapshot was built.
CI revalidates before publishing, so a snapshot must reach CI within 48
hours of its own date. Two consequences: do not build a snapshot and sit
on it over a long weekend, and do not expect to republish last week's
directory. Rebuild instead, which is cheap now that stage 3 takes about
25 minutes.

## 8. Recovery checklist

| Symptom | Action |
| --- | --- |
| `weights.csv drifted` error | Restore `pipeline/cluster/weights.csv` from the repo. Do not edit it. |
| `tippecanoe is not on PATH` | Create the tool env, see section 1. `run_all.sh` adds `.tools/bin` to PATH itself. |
| `Too many open files` from tippecanoe | Two causes, and they look identical. First, the batch node did not inherit the login shell's file limit: `run_all.sh` raises it, so check the job ran through `run_all.sh` and not a bare `emit_artifacts.py`. Second, an over-threaded build on a wide node opens too many files whatever the limit — see the shard row below. |
| `JSON does not allow NaN`, or `Did not read any valid geometries` | A feature column reached the GeoJSON or the manifest as NaN. Aggregation must skip NaN the way `score_normalized` and `_finite_min_max` do. |
| `tile N/X/Y has 200001 features, >200000` | The tippecanoe call lost `--no-feature-limit`. It must stay paired with `--drop-rate=0`. |
| `Internal error: N shards not a power of 2` from tippecanoe | The job landed on a wide node. tippecanoe sizes itself from the machine's online CPU count and ignores the cgroup, so an 8 cpu allocation on a 384 cpu node derives a bad shard count. `emit_artifacts.build_pmtiles` caps it with `TIPPECANOE_MAX_THREADS`; check that the value it logs matches `--cpus-per-task`. The open file limit is **not** the cause here, and raising it changes nothing. |
| A run vanished with a zero-byte log | It was started from a shell instead of Slurm and died with the session. Use `slurm_run.sh`. |
| Validator rejects the row count | A full-city run must not use `--bbox`. Check the basemap fetch. If the basemap itself grew, the band needs recalibrating in **both** `emit_artifacts.py` and `pipeline/contract/validate_snapshot.mjs`. |
| Validator rejects the date | The node clock is wrong, or the snapshot is older than 48 h. Rerun. |
| Partial snapshot | One lab input is missing. Check the dashcam root, the surveillance csv, and the DEM path in the config. |
