# Robotability

## Overview

Robotability is a research project from Cornell Tech. It measures how
suitable a city street is for robot navigation. The Robotability score
(R) gives one number to each sidewalk segment in New York City.

The score uses 19 sidewalk features. Each feature has a survey weight
and a polarity. The polarity is +1 or -1. The formula is:

```
R = Σ polarity × minmax(value) × weight
```

The sum runs over the 19 features. `minmax(value)` normalizes each raw
value into [0, 1] with the snapshot's min-max stats. The weights sum to
1.0. A segment score is the mean of the point scores on the segment.

This repository holds the project website. The site serves at
robotability.cornell.edu. The map shows the score of every sidewalk
segment. Visitors can move through time, compare two snapshots, and
refresh live data from NYC OpenData. The research was presented at CHI
'25.

- Paper: https://doi.org/10.1145/3706598.3714009
- Research code: https://github.com/FAR-LAB/robotability-nyc

## Architecture

Three layers do the work. Each layer has one job.

1. **Compute layer.** The lab cluster computes snapshots. The code
   lives in `pipeline/cluster/`. It is a Python port of the research
   notebooks. One run produces one snapshot with four artifacts. The
   cluster validates the snapshot and then triggers CI. See
   [pipeline/cluster/RUNBOOK.md](pipeline/cluster/RUNBOOK.md).
2. **Publish layer.** GitHub Actions publishes snapshots. The workflow
   is [.github/workflows/publish-snapshot.yml](.github/workflows/publish-snapshot.yml).
   Helper scripts live in `scripts/ci/`. This layer is IO-bound. It
   fetches artifacts, validates them, publishes them to GitHub
   Releases, and updates `public/manifest.json`. It does no compute.
3. **Client layer.** The site recomputes scores in the browser. The
   code lives in `src/`. Astro builds the static site. The map loads
   PMTiles snapshots listed in `public/manifest.json`. Live refresh
   queries NYC OpenData through the SODA client in `src/lib/soda/` and
   recomputes scores with the engine in `src/lib/score/`. A quota guard
   caps live refresh at 40 requests per rolling hour.

The workflow `.github/workflows/deploy.yml` deploys the site to GitHub
Pages.

## Development

The package manager is pnpm. All commands run from the repo root.

| Command | Action |
| :--- | :--- |
| `pnpm install` | Install dependencies. |
| `pnpm dev` | Start the dev server at `localhost:4321`. |
| `pnpm build` | Build the production site to `./dist/`. |
| `pnpm preview` | Serve the built site locally. |
| `pnpm test` | Run the vitest suites. |
| `pnpm playwright test` | Run the end-to-end suite in `e2e/`. Run `pnpm build` first. The config starts `pnpm preview` on port 4321. |
| `node scripts/ci/perf-gates.mjs` | Check the performance gates against `dist/`. Run `pnpm build` first. |

## Environment

The site uses one environment variable.

`PUBLIC_SODA_TOKEN`

- Purpose: a Socrata app token for NYC OpenData queries. The SODA
  client reads it at build time and appends it to every request as
  `$$app_token`.
- Source: Socrata issues app tokens through its developer portal at
  dev.socrata.com. Register the token for data.cityofnewyork.us.
- Behavior without it: the client still works. Socrata applies the
  lower anonymous quota instead. The quota guard in
  `src/lib/soda/quotaGuard.ts` keeps the client at 40 requests per
  rolling hour either way.

Astro exposes variables with the `PUBLIC_` prefix to client code. Set
the variable in the build environment. Do not commit tokens to the
repo.

## Data flow

A new snapshot travels from the cluster to the site in five steps.

1. The cluster runs `pipeline/cluster/run_all.sh`. The scripts fetch
   the public inputs, build the feature table, compute the scores, and
   write the artifacts. The manifest records per-feature min-max stats
   (`feature_stats`) and the sha256 of each file.
2. The cluster validates the snapshot with
   `pipeline/contract/validate_snapshot.mjs`. On success it triggers
   CI. The primary path is a `repository_dispatch` event of type
   `snapshot-ready`. The fallback path pushes the artifacts to the
   orphan branch `snapshots-incoming`, which CI polls every 6 hours.
3. CI validates the snapshot again with the same script. It rejects
   partial snapshots and any failed rule. It creates the release
   `snapshot-<date>` and uploads `segments.pmtiles`,
   `features.parquet`, and `manifest.json`.
4. CI appends the snapshot entry to `public/manifest.json` and commits
   to main. The entry carries the release asset URLs and the
   `feature_stats`. The commit triggers the deploy workflow.
5. The site reads `public/manifest.json`. The map loads the newest
   snapshot. Live refresh uses the entry's `feature_stats` to
   normalize live values.

`public/manifest.json` is the snapshot index. Each entry names the
snapshot date, the artifact URLs, and the `feature_vectors` flag.
Cluster snapshots also carry `feature_stats`.

`feature_stats` holds the min and max of each normalized feature
column. The client needs these numbers to normalize live raw values
with the same window the cluster used. Live refresh refuses to run when
the active snapshot has no `feature_stats`.

## Runbook

Cluster operations are documented in
[pipeline/cluster/RUNBOOK.md](pipeline/cluster/RUNBOOK.md). The runbook
covers cron setup, secret handling, trigger modes, small-area test
runs, and recovery.

Pipeline artifacts and the snapshot contract are documented in
[pipeline/README.md](pipeline/README.md).

## Language Rule

All output in this repo must use ASD-STE100 (Simplified Technical
English). This applies to documentation, code comments, and agent
conversation. Write short sentences. Use active voice. Put one idea in
each sentence. See [AGENTS.md](AGENTS.md) for the full rule.
