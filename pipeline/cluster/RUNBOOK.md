# Cluster Snapshot Pipeline Runbook

This runbook runs the Robotability snapshot pipeline on the lab cluster.
All text uses ASD-STE100 Simplified Technical English.

The pipeline computes one snapshot per run. It writes four artifacts:
`segments.geojson`, `segments.pmtiles`, `features.parquet`,
`manifest.json`. The contract is `pipeline/contract/cluster_contract.md`.

## 1. Requirements

The cluster node needs:

- Python 3.9 or newer with `pyarrow`, `geopandas`, `pandas`, `shapely`,
  `pyyaml`. Real runs also need `rasterio` for the DEM.
- Node.js 18 or newer (the contract validator).
- `tippecanoe` for the PMTiles build.
- A checkout of this repository on the `site-2026` branch or newer.

Optional local setup: `python3 -m venv pipeline/cluster/.venv` and install
the packages into it. `run_all.sh` prefers `pipeline/cluster/.venv/bin/python`
when it exists.

## 2. Cron setup

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

Trigger the workflow with `repository_dispatch`:

```
curl -X POST \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/dispatches \
  -d '{"event_type":"snapshot-ready"}'
```

A `204` response means the dispatch was accepted. The publish workflow runs
the validator again before it publishes.

### Option B - SSH deploy key (fallback)

Use this mode when the cluster cannot call the GitHub API.

1. Create an SSH key pair on the cluster. Add the public key to the repo as
   a deploy key with write access.
2. Push the snapshot artifacts to the orphan branch `snapshots-incoming`:

   ```
   git clone --no-checkout git@github.com:<owner>/<repo>.git push-dir
   cd push-dir
   git checkout --orphan snapshots-incoming
   git rm -rf . 2>/dev/null || true
   cp /share/your-lab/robotability/snapshots/<date>/* .
   git add segments.geojson segments.pmtiles features.parquet manifest.json
   git commit -m "snapshot <date>"
   git push origin snapshots-incoming
   ```

3. A scheduled CI job polls the branch head every 6 hours and publishes
   valid snapshots. See the publish workflow (T6).

## 7. What CI rejects

The publish workflow runs `pipeline/contract/validate_snapshot.mjs` on every
trigger. It rejects:

- Partial snapshots (`partial: true`).
- Any failed validation rule: bad row count, feature value outside [0, 1],
  score outside [-0.4049, 0.5952], stale manifest date (over 48 h), sha256
  mismatch, wrong weights hash, broken parquet schema, missing files.

A rejected snapshot is never published. The cluster log shows the failed
rule names. Fix the cause and rerun the pipeline.

## 8. Recovery checklist

| Symptom | Action |
| --- | --- |
| `weights.csv drifted` error | Restore `pipeline/cluster/weights.csv` from the repo. Do not edit it. |
| `tippecanoe is not on PATH` | Install tippecanoe on the cluster node. |
| Validator rejects the row count | A full-city run must not use `--bbox`. Check the basemap fetch. |
| Validator rejects the date | The node clock is wrong, or the snapshot is older than 48 h. Rerun. |
| Partial snapshot | One lab input is missing. Check the dashcam root, the surveillance csv, and the DEM path in the config. |
