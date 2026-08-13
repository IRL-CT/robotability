# Pipeline

The pipeline produces the data the site shows. The lab cluster computes
snapshots. GitHub Actions validates and publishes them. The contract
defines what crosses that boundary.

## Contract

The contract is
[contract/cluster_contract.md](contract/cluster_contract.md). It defines
the inputs, the four output artifacts, their schemas, and the validation
rules.

The gate is [contract/validate_snapshot.mjs](contract/validate_snapshot.mjs).
Both the cluster and CI run it. A snapshot must pass every rule before
publication. The validator prints each failed rule and exits with a
non-zero code on failure. Run its self test with:

```
node pipeline/contract/validate_snapshot.mjs --selftest
```

The cluster code lives in `cluster/`. Operations are documented in
[cluster/RUNBOOK.md](cluster/RUNBOOK.md).

## Artifact layout

One snapshot directory holds the output of one cluster run. The
directory name is the snapshot date in `YYYY-MM-DD` form.

| Artifact | Contents |
| :--- | :--- |
| `segments.geojson` | One LineString per sidewalk segment. Properties are exactly `id` (int32) and `score` (float). Human-readable copy of the tile geometry. |
| `segments.pmtiles` | Map tiles for the site. Each feature carries exactly two properties: `id` (int32) and `score` (float). Segment ids are stable across snapshots. |
| `features.parquet` | One row per segment. Columns in exact order: `segment_id` (int32), the 19 normalized feature columns (float32), and `score` (float32). Every feature value lies in [0, 1]. Every score lies in [-0.4049, 0.5952]. Nulls are not allowed. |
| `census.pmtiles` | Census block boundaries for the map's census layer. Properties are `BoroName` and `GEOID`. Ships with the snapshot archive. |
| `manifest.json` | Snapshot metadata. See below. |

`manifest.json` carries these fields:

| Field | Meaning |
| :--- | :--- |
| `date` | Snapshot date (UTC), `YYYY-MM-DD`. Must be within 48 hours of validation. |
| `row_count` | Number of segments. Must equal the parquet row count. |
| `score_min`, `score_max` | Score range in the parquet. |
| `feature_stats` | One `{min, max}` entry per feature. The stats describe the normalized columns. Null only when `feature_vectors` is false. |
| `weights_sha256` | sha256 of the survey weights file. Must equal the hash pinned in the contract. |
| `partial` | True when a lab input was missing. CI rejects partial snapshots. |
| `feature_vectors` | False for snapshots without per-feature data. The 2023 baseline is such a snapshot. |
| `files` | One entry per artifact: `name`, `sha256`, `bytes`. The validator recomputes every hash. |

The 2023 baseline shows the shape without feature vectors:
[snapshot0/manifest.json](snapshot0/manifest.json).

## How to add a feature

A new score feature touches the pipeline and the client together. The
contract validator enforces the exact parquet column order, so the
schema change and the validator change must land together.

1. Update the contract. Add the column to the parquet schema in
   [contract/cluster_contract.md](contract/cluster_contract.md). Update
   the column list in
   [contract/validate_snapshot.mjs](contract/validate_snapshot.mjs).
2. Add the pipeline column. Register the feature name and polarity in
   [cluster/features_spec.py](cluster/features_spec.py). Compute the
   raw column in [cluster/build_features.py](cluster/build_features.py).
   [cluster/emit_artifacts.py](cluster/emit_artifacts.py) writes the
   parquet schema and the `feature_stats` from the same column list.
3. Add the weight and the polarity to the score engine. Edit
   [../src/lib/score/weights.ts](../src/lib/score/weights.ts) (the
   `Feature` type, the `FEATURES` order, and `WEIGHTS`) and
   [../src/lib/score/polarities.ts](../src/lib/score/polarities.ts).
4. Add the live query spec when the feature has an NYC OpenData source.
   Edit [../src/lib/soda/features.ts](../src/lib/soda/features.ts) and
   add the feature to `PROXY_FEATURES`. Add the matching dataset
   strategy in [../src/lib/live/refresh.ts](../src/lib/live/refresh.ts)
   so live refresh queries it.
5. Run the tests. The vitest suites assert the weights, the polarities,
   and the parity with the Python reference.

Adding a feature changes the metric. The survey weights, the pinned
`weights_sha256`, and the score band in the contract must all change in
the same step. Do not change the weights of the published 19 features.
The CHI '25 metric must stay intact.

## How normalization stats travel

The score engine normalizes every raw value with min-max stats. The
stats must come from the snapshot that produced the score. Otherwise
live values and snapshot values are not comparable.

The travel path is:

1. The cluster computes the min and max of each normalized feature
   column for the run. It writes them into `feature_stats` in
   `manifest.json`.
2. CI validates the manifest and appends the snapshot entry to
   [../public/manifest.json](../public/manifest.json). The entry
   carries the `feature_stats` from the validated manifest.
3. The client reads the active snapshot entry. The map passes its
   `feature_stats` to the live refresh.
4. The live refresh normalizes live raw values with those stats. It
   also inverts them to recover raw values from the stored parquet
   cells before the engine re-normalizes everything.

The gate is strict. `toFeatureStats` in
[../src/lib/live/refresh.ts](../src/lib/live/refresh.ts) returns null
when any of the 19 features lacks a finite min and max. The map then
refuses the refresh and shows: "Live refresh needs a snapshot with
feature statistics." This is why the 2023 baseline (`feature_stats:
null`) never offers live refresh.

The publish workflow that moves snapshots to releases is
[../.github/workflows/publish-snapshot.yml](../.github/workflows/publish-snapshot.yml).
The cluster entry point is [cluster/run_all.sh](cluster/run_all.sh).
