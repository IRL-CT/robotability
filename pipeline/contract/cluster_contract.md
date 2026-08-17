# Cluster Snapshot Contract

This contract defines the data that crosses the boundary between the lab
cluster and the Robotability site. The cluster computes snapshots. The CI
publish workflow validates and publishes them. Both sides run
`pipeline/contract/validate_snapshot.mjs`. A snapshot must pass every rule in
section 4 before publication.

All text in this document uses ASD-STE100 Simplified Technical English.

## 1. Inputs

### 1.1 Lab storage inputs (cluster only)

The cluster reads these inputs from lab storage. Do not commit lab data or
real lab paths to the repo. The paths below are patterns. The real paths live
in the cluster config file (`pipeline/cluster/cluster_config.example.yaml`,
built in task T5).

| Input | Path pattern | Format | Used for |
| --- | --- | --- | --- |
| Dashcam detections | `<LAB_DASHCAM_ROOT>/{day}/detections.csv` | One CSV per day. Columns `0`, `1`, `2` hold detection counts (see `traffic.py`). **Frozen at August 2023**, see note below. | vehicle_traffic, bicycle_traffic |
| Dashcam metadata | `<LAB_DASHCAM_ROOT>/{day}/md.csv` | One CSV per day. Frame metadata. **Frozen at August 2023.** | Same as above |
| DOT Pedestrian Demand Map | `data/ped_demand_nyc.geojson` (`fwpa-qxaf`) | GeoJSON, one record per city street, `rank` 1 (Global, busiest) to 5 (Citywide Baseline). Maintained by DOT. | pedestrian_density |
| Surveillance camera values | `<LAB_SURVEILLANCE_ROOT>/counts_per_intersections.csv` | Camera counts per intersection. From the "Surveilling the Surveillance" dataset. | surveillance_coverage |
| NYC 1-foot DEM | `<LAB_DEM_ROOT>/` | Raster (unzipped `NYC_DEM_1ft_Int`). | slope_gradient |
| Shared work area | `/share/<group>/robotability/<date>/` | Intermediate and output files. | All stages |

**Input freshness.** Every input above refreshes with the snapshot except
the dashcam collection, which is fifteen fixed days in August 2023 chosen
to match the `CUTOFF` of 2023-08-31 in the research notebook. The lab root
holds 27 day directories in all, running to late October 2023; the unused
ones are listed in `lab_inputs.DASHCAM_DAYS`.
`bicycle_traffic` and `vehicle_traffic` therefore describe
2023 conditions in every snapshot, whatever date the manifest carries,
and together they hold 7.8% of the model weight. `pedestrian_density`
previously shared that limitation and now reads the DOT Pedestrian Demand
Map instead, which DOT maintains. No citywide bicycle or vehicle volume
model exists to do the same for the remaining two: the public count
datasets (`ct66-47at`, `7ym2-wayt`) are sparse sensor readings, not
citywide coverage. Treat those two features as a 2023 baseline when
reading a snapshot.

If a lab input is missing, the cluster must set `partial: true` in the
manifest (see section 5).

### 1.2 Public downloads

The cluster downloads the public inputs with the same sources as
`robotability-nyc/feature_processing/pull_data.sh`. Dataset ids belong to
`data.cityofnewyork.us` unless noted.

| Source | Dataset / URL | Used for |
| --- | --- | --- |
| NYC sidewalks | `52n9-sdep` (CSV export) | Segment geometry, sidewalk_width |
| NYC 2020 NTAs | `9nt8-h7nd` | Area joins |
| NYC 2020 census blocks | `nycb2020_24c.zip` (s-media.nyc.gov) | Census context |
| Community districts | `yfnk-k7r4` (Shapefile export) | surface_condition join |
| Sidewalk cleanliness scorecard | `rqhp-hivt` | surface_condition |
| FCC broadband map (dec2023) | broadbandmap.fcc.gov (4G LTE + 5G NR) | communication_infrastructure |
| CitiBike tripdata 2023-12 | `s3.amazonaws.com/tripdata` | bicycle_traffic, charging_station_proximity |
| Pedestrian curb ramps | `ufzp-rrqu` | curb_ramp_availability |
| Surveillance camera locations | `storage.googleapis.com/scpl-surveillance/camera-data.zip` | surveillance_coverage |
| Raised crosswalks | `uh2s-ftgh` | traffic_management |
| VZW enhanced crossings | `k9a2-vdr8` | traffic_management |
| NYC zoning | `kdig-pewd` (Shapefile export) | zoning_laws, crowd_dynamics |
| NYC 1-foot DEM | NYC_DEM_1ft_Int.zip (data.cityofnewyork.us asset) | slope_gradient |
| NYC points of interest | `t95h-5fsr` | Context joins |
| NYC bike routes | `mzxg-pwib` | bike_lane_availability |
| Street furniture (13 sets) | `8znf-7b2c` litter baskets, `5bgh-vtsn` hydrants, `t4f2-8md7` bus shelters, `dimy-qyej` bicycle parking shelters, `yh4a-g3fj` bicycle racks, `kuxa-tauh` citybenches, `uvpi-gqnh` trees, `w9zq-xm8b` newsstands, `693u-uax6` parking meters, `s4kf-3yrf` LinkNYC kiosks, `v57i-gtxb` alarm boxes, `qt6m-xctn` street sign work orders, plus one clutter set from the claustrophobic streets analysis | street_furniture_density |
| Vision Zero traffic management | `79sh-heg3` SIP intersections, `hz4p-9f7s` turn calming, `mqt5-ctec` leading pedestrian intervals, `wqhs-q6wd` SIP corridors, `7f9e-jic4` speed humps, `8kuj-2n3u` Barnes Dance signals | traffic_management |
| Motor vehicle collisions | `h9gi-nx95` (loaded in `dataset.ipynb`; not in pull_data.sh) | intersection_safety |
| GPS signal strength | Model output, per the paper | gps_signal_strength |
| Digital map existence | Model output, per the paper | digital_map_existence |

## 2. Outputs per snapshot date

One snapshot directory holds the output of one cluster run. The directory
name must be the snapshot date in `YYYY-MM-DD` form. The cluster writes four
artifacts into the directory:

| Artifact | Purpose |
| --- | --- |
| `segments.geojson` | Human-readable geometry. One LineString feature per sidewalk segment. |
| `segments.pmtiles` | Map tiles for the site. Built from `segments.geojson` by the T4 tooling. |
| `features.parquet` | One row per segment: the 19 normalized feature values and the score. Absent in snapshots without feature vectors (see `feature_vectors` below). |
| `manifest.json` | Metadata: date, row count, score range, per-feature stats, weights hash, flags, and a signed file list. |

The cluster must run `validate_snapshot.mjs` on the directory before it
triggers CI. CI runs the validator again and rejects any failure.

## 3. Schemas

### 3.1 `segments.pmtiles`

PMTiles v3. Each feature carries exactly two properties:

| Property | Type | Meaning |
| --- | --- | --- |
| `id` | int32 | Segment id. Stable across snapshots. |
| `score` | float | Segment Robotability score. |

No other properties are allowed. The T4 build tool verifies the tile
contents. The contract validator checks the file magic and integrity.

### 3.2 `features.parquet`

Columns must appear in this exact order:

| # | Column | Type |
| --- | --- | --- |
| 0 | `segment_id` | int32 |
| 1 | `sidewalk_width` | float32 |
| 2 | `pedestrian_density` | float32 |
| 3 | `street_furniture_density` | float32 |
| 4 | `sidewalk_roughness` | float32 |
| 5 | `surface_condition` | float32 |
| 6 | `communication_infrastructure` | float32 |
| 7 | `slope_gradient` | float32 |
| 8 | `charging_station_proximity` | float32 |
| 9 | `curb_ramp_availability` | float32 |
| 10 | `crowd_dynamics` | float32 |
| 11 | `traffic_management` | float32 |
| 12 | `surveillance_coverage` | float32 |
| 13 | `zoning_laws` | float32 |
| 14 | `bike_lane_availability` | float32 |
| 15 | `gps_signal_strength` | float32 |
| 16 | `bicycle_traffic` | float32 |
| 17 | `vehicle_traffic` | float32 |
| 18 | `digital_map_existence` | float32 |
| 19 | `intersection_safety` | float32 |
| 20 | `score` | float32 |

Constraints:

- Every feature column holds normalized values in [0, 1]. This mirrors the
  assert in `score.ipynb` cell 92.
- Every `score` lies in [-0.4049, 0.5952]. See section 4 for the derivation.
- Columns must be REQUIRED. Null values are not allowed.
- Data pages must use version 1.
- The codec must be UNCOMPRESSED or SNAPPY.
- The encoding must be PLAIN or dictionary (PLAIN_DICTIONARY / RLE_DICTIONARY).

These constraints keep the validator dependency-free. The validator reads
this exact parquet subset with no npm packages.

The score formula (unchanged from the CHI '25 metric):

```
score(point) = sum over the 19 features of polarity(f) * normalized(f) * weight(f)
score(segment) = mean of the point scores on the segment
```

Weights come from `robotability-nyc/survey_processing/feature_weights.csv`
(19 weights, sum = 1.0). Polarities come from `score.ipynb` cell 96. The
table below is informational. The CSV and the notebook are the ground truth.

| Feature | Polarity | Weight |
| --- | --- | --- |
| sidewalk_width | +1 | 0.06806833613639274 |
| pedestrian_density | -1 | 0.09445576675004053 |
| street_furniture_density | -1 | 0.06752114455511304 |
| sidewalk_roughness | -1 | 0.04593514200834298 |
| surface_condition | +1 | 0.07682933579593197 |
| communication_infrastructure | +1 | 0.05845165469318187 |
| slope_gradient | -1 | 0.04832231448153131 |
| charging_station_proximity | +1 | 0.025316489931061576 |
| curb_ramp_availability | +1 | 0.060102970276542725 |
| crowd_dynamics | +1 | 0.07621927189475182 |
| traffic_management | +1 | 0.04638333896814371 |
| surveillance_coverage | +1 | 0.02281272971765975 |
| zoning_laws | +1 | 0.04146601033693057 |
| bike_lane_availability | +1 | 0.022603749599280413 |
| gps_signal_strength | +1 | 0.048359700811054354 |
| bicycle_traffic | -1 | 0.03068282361247861 |
| vehicle_traffic | -1 | 0.04745443062510741 |
| digital_map_existence | +1 | 0.04850786858987462 |
| intersection_safety | -1 | 0.07050692121657998 |

The seven negative-polarity weights sum to 0.40488. The twelve
positive-polarity weights sum to 0.59512.

### 3.3 `segments.geojson`

A GeoJSON `FeatureCollection`. Each feature is a LineString with properties:

| Property | Type | Meaning |
| --- | --- | --- |
| `id` | int32 | Segment id. Must match the pmtiles `id`. |
| `score` | float | Segment score. Must match the pmtiles `score`. |

### 3.4 `manifest.json`

A JSON object with these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `date` | string, `YYYY-MM-DD` | Snapshot date (UTC). Must be a real calendar date. |
| `row_count` | integer | Number of segments. Must equal the parquet row count. |
| `score_min` | number | Minimum score in the parquet. |
| `score_max` | number | Maximum score in the parquet. |
| `feature_stats` | object or null | One entry per feature: `{min, max}` of the normalized column. Must be null when `feature_vectors` is false. |
| `weights_sha256` | string, 64 hex chars | sha256 of `feature_weights.csv`. Must equal the pinned hash in the validator. |
| `partial` | boolean | True when a lab input was missing. Must be false for publication. |
| `feature_vectors` | boolean | False for snapshots without per-feature data (snapshot #0, the 2023 baseline). |
| `files` | array of `{name, sha256, bytes}` | One entry per artifact in the directory. `sha256` is 64 lowercase hex chars. |

The pinned weights hash is
`6278272614fe5e012874a2804e9e576f21f5a9cd4b952eb9296ccb6932965beb`.

## 4. Validation rules

`validate_snapshot.mjs` enforces every rule below. On failure it prints each
failed rule to stderr as `FAIL <rule>: <detail>` and exits with code 1. On
success it prints one `PASS` line to stdout and exits with code 0. Usage
errors exit with code 2.

| Rule | Check | Ground truth |
| --- | --- | --- |
| `snapshot_dir` | The argument is a directory. | CLI contract |
| `manifest_missing` | `manifest.json` exists. | Section 2 |
| `manifest_parse` | `manifest.json` is a JSON object. | Section 3.4 |
| `manifest_schema` | Every field exists with the right type. | Section 3.4 |
| `row_count_band` | `row_count` lies in [486975, 496813]. One row per centerline segment, a 1% margin around the 491,894 segments of the 2026 basemap. Superseded [460350, 469650], which bounded the research's point-sampled count of 464,968 rather than the segment count this pipeline emits. | NYC sidewalk count |
| `manifest_date_fresh` | The manifest date lies within 48h of the validation time. The date parses as UTC midnight. | Freshness policy |
| `partial_flag` | `partial` is false. | Section 5 |
| `weights_sha256` | The hash equals the pinned `feature_weights.csv` hash. The weights must not change. | `feature_weights.csv` |
| `files_list` | The file list names `segments.geojson`, `segments.pmtiles`, and (when `feature_vectors` is true) `features.parquet`. No duplicates. | Section 2 |
| `file_sha256` | Every listed file exists. Size and sha256 match. | Integrity |
| `pmtiles_magic` | `segments.pmtiles` starts with the PMTiles v3 magic. | PMTiles v3 spec |
| `parquet_missing` | `features.parquet` exists when `feature_vectors` is true. | Section 2 |
| `parquet_parse` | The parquet parses within the allowed subset. | Section 3.2 |
| `parquet_schema` | Column names, order, and types match section 3.2 exactly. No nulls. | Section 3.2 |
| `row_count_match` | Parquet row count equals manifest `row_count`. | Section 3.4 |
| `feature_range` | Every normalized feature lies in [0, 1]. | `score.ipynb` cell 92 assert |
| `score_range` | Every score lies in [-0.4049, 0.5952]. | Derived below |
| `score_stats_match` | Parquet score min/max match `score_min`/`score_max` (tolerance 1e-6). | Section 3.4 |
| `feature_stats_match` | Parquet per-feature min/max match `feature_stats` (tolerance 1e-6). | Section 3.4 |

Derivation of the score band: all normalized values lie in [0, 1]. The most
negative score puts every negative-polarity feature at 1 and every
positive-polarity feature at 0: it equals minus the negative-polarity weight
sum, -0.40488. The most positive score equals the positive-polarity weight
sum, 0.59512. The band [-0.4049, 0.5952] adds a small margin for float32
rounding.

Validator CLI:

```
node pipeline/contract/validate_snapshot.mjs <snapshot-dir> [--relax-row-count <n>]
node pipeline/contract/validate_snapshot.mjs --selftest
node pipeline/contract/validate_snapshot.mjs --make-fixture <dir> [--rows <n>]
```

- `--relax-row-count <n>` replaces the row count band with the exact value
  `n`. Small-area test runs use it. Full-city runs must not use it.
- `--selftest` builds one valid synthetic snapshot and five corrupt variants
  in a temp dir. It asserts the exit codes and prints `SELFTEST 6/6 PASS`.
- `--make-fixture <dir>` writes a small valid synthetic snapshot for tests.

## 5. Partial-flag policy

A cluster run can lose access to a lab input (dashcam detections,
surveillance values, DEM, or a `/share` path). When that happens:

1. The cluster must still finish the run with the inputs it has.
2. The cluster must set `partial: true` in the manifest.
3. The cluster must exit with code 0. A partial run is not a crash. It is a
   signal.

The validator requires `partial === false`. CI rejects partial snapshots. A
partial snapshot is for lab debugging only. Do not publish it. Do not copy it
to the release branch.

## 6. Trigger modes

The snapshot pipeline supports four trigger modes. The runbook (T5) documents
the setup for each.

| Mode | Source | Use |
| --- | --- | --- |
| Cron | Lab cluster scheduler | The normal cadence. The owner sets the schedule. |
| `repository_dispatch` | Cluster calls the GitHub API with event type `snapshot-ready` after a successful run | The primary push path. |
| `workflow_dispatch` | A human presses the run button in GitHub | Manual reruns and debugging. |
| Schedule poll | CI checks the `snapshots-incoming` branch head every 6 hours | The fallback path when the cluster can only push by SSH deploy key. |

The publish workflow (T6) runs the validator on every trigger. It publishes
only snapshots that pass every rule.
