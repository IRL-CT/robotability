# Notebook Trace

This file maps every non-trivial function in the cluster pipeline scripts to
its source in the original research code. All text uses ASD-STE100.

Source files (read-only):

- `robotability-nyc/feature_processing/dataset.ipynb` (120 cells)
- `robotability-nyc/feature_processing/score.ipynb` (104 cells)
- `robotability-nyc/feature_processing/score_by_sidewalk.ipynb` (6 cells)
- `robotability-nyc/feature_processing/street_furniture.ipynb` (64 cells)
- `robotability-nyc/feature_processing/traffic.py`
- `robotability-nyc/feature_processing/sidewalk_widths.py`
- `robotability-nyc/feature_processing/pull_data.sh`
- `robotability-nyc/survey_processing/feature_weights.csv`

Cell numbers are zero-based indices into the notebook cell array.

## score_core.py (score math, pure functions)

| Function | Source |
| --- | --- |
| `load_weights` | score.ipynb cell 9 (`WEIGHTS = pd.read_csv(...feature_weights.csv...)`). The vendored copy is `pipeline/cluster/weights.csv`. |
| `_is_nan` | NaN guards used by the pandas `fillna`/`dropna` calls throughout score.ipynb and dataset.ipynb. |
| `min_max_normalize` | score.ipynb cell 1 (`min_max_normalize`). Constant column returns zeros, like the notebook. The port adds a clamp to [0, 1]. |
| `_fillna` | The pandas `fillna` calls in score.ipynb cells 29, 65, 68. |
| `_mean_of_finite` | score.ipynb cell 29 (`col.fillna(col.mean())`). |
| `_zonedist_to_indicator` | score.ipynb cell 54 (`zonedist_to_indicator`: M -> 10, R -> 5, C -> 0, else -> 2, missing -> 0). |
| `_communication_indicator` | score.ipynb cell 33 (`COMPUTE_communication_infrastructure`: 1 when `4g_minup > 0 and 4g_mindown > 0`). |
| `normalize_features` | The PREPROCESS/POSTPROCESS blocks of score.ipynb: cell 14 (sidewalk_width), cell 18 (pedestrian_density), cell 22 (street_furniture_density), cell 26 (sidewalk_roughness constant 1), cell 29 (surface_condition), cell 33 (communication_infrastructure), cell 37 (slope_gradient), cells 42-44 (charging_station_proximity, `(RANGE - d)/RANGE`), cell 49 (curb_ramp_availability), cell 55 (crowd_dynamics), cell 59 (traffic_management), cell 62 (surveillance_coverage), cell 65 (zoning_laws), cell 68 (bike_lane_availability), cell 76 (gps_signal_strength constant 1), cell 80 (bicycle_traffic), cell 83 (vehicle_traffic), cell 86 (digital_map_existence constant 1), cell 89 (intersection_safety). |
| `score_normalized` | score.ipynb cell 97 (`features.drop(...).mul(pd.Series(POLARITIES)).sum(axis=1)`). |
| `aggregate_segment_scores` | score_by_sidewalk.ipynb cell 4 (`groupby('segment_index').agg({'score': 'mean'})`). At segment-level granularity the mean runs over the segment's own points. |
| `slope_gradient` | score.ipynb cell 36 (`POPULATE_slope_gradient_optimized_with_progress`: 10 nearest neighbors within 50 ft, mean of \|height diff\| / distance). The port uses a shapely STRtree instead of a scipy cKDTree. |

## features_spec.py (constants)

| Constant | Source |
| --- | --- |
| `FEATURES` | `pipeline/contract/cluster_contract.md` section 3.2 (exact parquet column order). |
| `POLARITIES` | score.ipynb cell 96 (the 19 computed features only). |
| `CONSTANT_ONE_FEATURES` | score.ipynb cells 26, 76, 86. |
| `TRAFFIC_MANAGEMENT_COLUMNS` | score.ipynb cell 58. |
| `SLOPE_MAX_NEIGHBORS` | score.ipynb cell 36. |
| `SLOPE_MIN_BASELINE_FT`, `SLOPE_MAX_GRADE` | **Not in the notebook.** Deliberate divergences, measured and justified beside the constants in `features_spec.py`. The notebook's 50 ft radius is also gone: it ran over ~465k sampled points, this runs over one centroid per segment, and at that spacing the radius left 35% of segments with no neighbour and a 0.0 that could not be told from flat ground. |

## compute_score.py (CLI wrapper)

| Function | Source |
| --- | --- |
| `_read_raw_table` | score.ipynb cell 2 (read the dataset table). |
| `_project_centroids` | dataset.ipynb cell 0 (CRS constants WGS/PROJ) and cell 2 (geometry handling). |
| `main` | score.ipynb cells 92 (assert 0-1), 99-100 (write the scored table). |

The CLI re-exports the score_core names for the tests and emit_artifacts.py.

## build_features.py

| Function | Source |
| --- | --- |
| `_fill` | Contract section 5 partial policy: a missing input is filled so the run can finish. |
| `build_real` | dataset.ipynb as a whole: the join sequence of cells 6-98, with the final table assembly of cell 116. |
| `write_raw_parquet` | dataset.ipynb cell 116 (`sidewalk_nyc.to_csv("../data/processed/score_dataset.csv")`). The port writes parquet instead of CSV. |
| `main` | Task T5 spec (CLI orchestration). |

## mock_data.py

| Function | Source |
| --- | --- |
| `generate_mock` | No notebook source. Task T5 spec: deterministic synthetic lab columns for mock mode. The column set mirrors the raw columns of dataset.ipynb cell 116 (`score_dataset.csv`). Seed: `MOCK_SEED` in pipeline_common.py. |

## features_join.py

| Function | Source |
| --- | --- |
| `load_segments` | dataset.ipynb cell 12 (sidewalk basemap load, `SHAPE_Area / SHAPE_Leng` width, `simplify(10)`, `segment_index = index`). The width method itself comes from sidewalk_widths.py (`width = distance * 2` per centerline segment, written to `sidewalk_widths.geojson`). |
| `_points_from_spec` | The repeated point-load pattern in street_furniture.ipynb cells 7-31 and dataset.ipynb cells 36, 50, 60, 71, 78, 81, 84, 87, 90, 96-97. |
| `_buffered_counts` | The buffer + sjoin + groupby-count pattern: dataset.ipynb cells 37 (cameras, 50 ft), 51 (curb ramps, 50 ft), 79, 82, 85, 88, 91 (traffic calming, 50 ft), 97-98 (collisions, 50 ft); street_furniture.ipynb cells 4-5, 36-48 (furniture, 25 ft). |
| `join_street_furniture` | street_furniture.ipynb cells 4-5 (25 ft buffer), cells 36-48 (sjoin each furniture set), cell 50 (per-set counts), cells 56-57 (weighted clutter sum), cell 58 (divide by width), cell 59 (clip to 1st-99th percentile). Segment-level port: the buffer wraps the segment line, not a 50 ft point. |
| `join_surface_condition` | dataset.ipynb cells 56-58 (scorecard month filter, district code build, community district join). |
| `join_communication` | dataset.ipynb cells 29-31 (4G LTE shapefile sjoin, `4g_minup`/`4g_mindown`). |
| `join_zoning` | dataset.ipynb cell 44 (zoning sjoin, `ZONEDIST`). |

## joins_counts.py

| Function | Source |
| --- | --- |
| `join_curb_ramps` | dataset.ipynb cells 50-51 (Good Condition filter, 50 ft buffer, count). |
| `join_traffic_management` | dataset.ipynb cells 75-91 (six 50 ft buffer count joins). Term mapping: the notebook's `in_slow_zone` (Neighborhood Slow Zones, not in pull_data.sh) maps to SIP corridors `wqhs-q6wd`; `sip_corridors_count` maps to raised crosswalks `uh2s-ftgh`. The six-term sum structure of score.ipynb cell 58 is unchanged. |
| `join_speed_limits` | dataset.ipynb cells 71-72 (sjoin_nearest within 50 ft, mean `postvz_sl`). |
| `join_bike_routes` | dataset.ipynb cells 93-94 (status Current, class map L/I/II/III, sjoin_nearest within 50 ft, mean). |
| `join_collisions` | dataset.ipynb cells 96-98 (pedestrians injured + killed, 50 ft buffer, sum). |
| `join_charging` | dataset.ipynb cell 46 (CitiBike GBFS stations, `sjoin_nearest` distance). |

## lab_inputs.py

| Function | Source |
| --- | --- |
| `read_dashcam_traffic` | traffic.py: `LOCAL_PATH`/`DoCs` day list and per-day `detections.csv` + `md.csv` merge (traffic.py blocks 2-3), point build from `gps_info.*` (block 5), `DIR_MAPPING` heading snap (block 8), `create_semicircle` 150 ft cone (block 9), sjoin to sidewalk points and per-segment mean of columns `0`, `1`, `2` (blocks 11-13). The port joins to segments instead of 50 ft points. Input format `{LOCAL_PATH}/{day}/detections.csv` is the contract section 1.1 pattern. |
| `read_surveillance` | dataset.ipynb cells 35-37 (`counts_per_intersections.csv`, `n_cameras_median`, 50 ft buffer, count per segment). |
| `sample_dem` | dataset.ipynb cells 18-20 (open raster, downsample by 10 with bilinear resampling, sample elevations at positions). The port reads the raster from the lab DEM path in the config. |

## fetch_public.py

| Function | Source |
| --- | --- |
| `rows_csv_url` | pull_data.sh Socrata pattern `https://data.cityofnewyork.us/api/views/<id>/rows.csv?accessType=DOWNLOAD`. |
| `shapefile_url` | pull_data.sh Socrata pattern `https://data.cityofnewyork.us/api/geospatial/<id>?method=export&format=Shapefile`. |
| `Dataset.__init__` | Registry record for one pull_data.sh line. |
| `build_datasets` | pull_data.sh as a whole (lines 1-150). Additions required by dataset.ipynb but absent from pull_data.sh are marked in their `note` field: scorecard `rqhp-hivt` (cell 56), VZV sets (cells 75-91), speed limits `5mad-ntua` (cell 71), collisions `h9gi-nx95` (cell 96), bike routes `mzxg-pwib` (cell 93), GBFS station inventory (cell 46). FCC broadband entries are manual downloads per the contract section 1.2. |
| `_part_path` | Resume support for the pull_data.sh download guards. The `.part` suffix marks an unfinished download. |
| `download_one` | The `if [ ! -f ... ]` resume guards of pull_data.sh, extended with HTTP Range resume through a `.part` file. |
| `maybe_unzip` | The `unzip` steps of pull_data.sh lines 22-27, 33-38, 49-54, 58-63, 103-108. |
| `main` | Task T5 spec (`--skip` for mock mode). |

## emit_artifacts.py

| Function | Source |
| --- | --- |
| `_today_utc` | Contract section 3.4 (`date` field, UTC). |
| `_check_date` | Contract section 4 rule `manifest_date_fresh`. |
| `_check_weights_sha` | Contract section 3.4 (`weights_sha256` must equal the pinned hash of `feature_weights.csv`). |
| `write_geojson` | Contract section 3.3 (LineStrings with `{id, score}`). |
| `build_pmtiles` | Contract section 3.1 plus the tippecanoe flag pattern of `scripts/tiles/build_pmtiles.mjs` (`--drop-rate=0`, `--include` per kept property, maxzoom 14). |
| `write_features_parquet` | Contract section 3.2 (exact column order, float32, no nulls, SNAPPY, data page v1). |
| `_file_entry` | Contract section 3.4 (`files` entries with sha256 + bytes). |
| `run_validator` | Contract section 2 ("The cluster must run validate_snapshot.mjs on the directory before it triggers CI") and section 4 (`--relax-row-count` for small-area runs). |
| `main` | Task T5 spec (artifact assembly order). |

## pipeline_common.py

| Function | Source |
| --- | --- |
| `repo_root`, `cluster_dir`, `weights_csv_path`, `validator_path` | Pipeline infrastructure. No notebook source. |
| `log`, `die`, `ensure_dir` | Pipeline infrastructure. No notebook source. |
| `sha256_file` | Contract section 3.4 file hashes. |
| `weights_body_bytes` | Contract section 3.4 weights hash, applied to the vendored file with its provenance comment block stripped. |
| `parse_bbox` | Task T5 spec (`--bbox` flag). |
| `load_config` | Task T5 spec (`cluster_config.example.yaml`). |
| `MOCK_SEED` | Task T5 spec (deterministic mock data). Value: 20260812. |

## tests/test_compute_score.py

| Function | Source |
| --- | --- |
| `build_reference_rows` | score.ipynb cells 96-97 (polarity and sum structure). |
| `test_score_normalized_reference_rows` | Hand arithmetic over `feature_weights.csv` weights and cell 96 polarities. |
| `test_min_max_normalize` | score.ipynb cell 1. |
| `test_normalize_features_raw_semantics` | score.ipynb cells 33, 42-44, 54, 26, 76, 86. |
| `test_aggregate_segment_scores` | score_by_sidewalk.ipynb cell 4. |
| `test_raw_to_score_integration` | Full formula: score.ipynb cells 1, 9, 96, 97. |

`check` and `main` in the test file are harness functions. They have no
notebook source.

## Known deviations from the notebooks

1. Segment level, not point level. The notebooks segmentize sidewalks into
   50 ft points (dataset.ipynb cell 14) and score each point. The cluster
   port scores whole sidewalk segments. score_by_sidewalk.ipynb cell 4 then
   reduces to one row per segment anyway, so the port skips the point stage.
   Buffers that wrapped points now wrap segment lines.
2. Slope search uses a shapely STRtree instead of a scipy cKDTree. The
   radius (50 ft) and the neighbor cap (10) are unchanged.
3. `in_slow_zone` (VZV Neighborhood Slow Zones) is not in pull_data.sh.
   The port uses SIP corridors (`wqhs-q6wd`) for that sum term and raised
   crosswalks (`uh2s-ftgh`) for the corridor term. The six-term sum of
   score.ipynb cell 58 is unchanged.
4. pyarrow writes OPTIONAL repetition with zero nulls. The contract text
   says REQUIRED. The validator enforces the no-null rule through the null
   count, which is zero.
5. Mock mode is synthetic. It exercises the full arithmetic but does not
   reproduce the NYC data distributions.
