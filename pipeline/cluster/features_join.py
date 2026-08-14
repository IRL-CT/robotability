"""Join the public datasets onto the sidewalk segments. Real mode only.

Port of the joins in robotability-nyc/feature_processing/dataset.ipynb at
segment level, plus the clutter pipeline of street_furniture.ipynb.
See NOTEBOOK_TRACE.md for the cell mapping.

Every join returns a list aligned to the segment rows. A missing input file
returns None. build_features.py records the gap and fills it with zeros.
"""

import json
import os
from typing import List, Optional

import pipeline_common as pc  # noqa: E402 (import path set by caller)

BUFFER_50_FT = 50.0
BUFFER_25_FT = 25.0

# Clutter weights from street_furniture.ipynb cell 56.
CLUTTER_WEIGHTS = {
    'bus_stop_count': 2.0,
    'trash_can_count': 0.5,
    'linknyc_count': 2.0,
    'citybench_count': 1.5,
    'bicycle_parking_shelter_count': 2.0,
    'bicycle_rack_count': 1.5,
    'tree_count': 0.15,
    'newsstand_count': 3.0,
    'parking_meter_count': 0.15,
    'scaffolding_permit_count': 2.0,
    'hydrant_count': 0.25,
    'street_sign_count': 0.05,
    'alarm_call_box_count': 0.15,
}

# Furniture file map. Each entry: count name -> spec tuple
# (fetched path, geometry kind, geometry column, lon column, lat column).
# kind 'wkt' reads a WKT column in WGS84. kind 'xy' builds points from
# lon/lat columns in WGS84. kind 'xy_proj' builds points already in
# EPSG:2263. kind 'dir' reads a shapefile directory.
# The file names come from fetch_public.py.
FURNITURE_SPECS = {
    'bus_stop_count': ('data/street_furniture/bus_stop_shelters_nyc.csv', 'wkt', 'the_geom', '', ''),
    'trash_can_count': ('data/street_furniture/dsny_litter_baskets_nyc.csv', 'wkt', 'point', '', ''),
    'linknyc_count': ('data/street_furniture/LinkNYC_Kiosk_Locations.csv', 'xy', '', 'Longitude', 'Latitude'),
    'citybench_count': ('data/street_furniture/citybench_nyc.csv', 'xy', '', 'Longitude', 'Latitude'),
    'bicycle_parking_shelter_count': ('data/street_furniture/bicycle_parking_shelters_nyc.csv', 'wkt', 'the_geom', '', ''),
    'bicycle_rack_count': ('data/street_furniture/bicycle_racks_nyc', 'dir', '', '', ''),
    'tree_count': ('data/street_furniture/forestry_tree_points_nyc.csv', 'xy', '', 'longitude', 'latitude'),
    'newsstand_count': ('data/street_furniture/newsstands_nyc.csv', 'wkt', 'the_geom', '', ''),
    'parking_meter_count': ('data/street_furniture/parking_meters_nyc.csv', 'wkt', 'Location', '', ''),
    'hydrant_count': ('data/street_furniture/fire_hydrants_nyc.csv', 'wkt', 'the_geom', '', ''),
    'street_sign_count': ('data/street_furniture/Street_Sign_Work_Orders.csv', 'xy_proj', '', 'sign_x_coord', 'sign_y_coord'),
    'alarm_call_box_count': ('data/street_furniture/In-Service_Alarm_Box_Locations.csv', 'wkt', 'Location Point', '', ''),
}


def load_segments(work_dir: str, bbox: Optional[tuple]):
    """Load the sidewalk basemap. Port of dataset.ipynb cell 12.

    The alternate generation method reads the sidewalks CSV (52n9-sdep),
    derives the width as SHAPE_Area / SHAPE_Leng, and simplifies each
    geometry. segment_index is the row index, as in the notebook.
    """
    import geopandas as gpd
    import pandas as pd
    from shapely import box, wkt

    path = os.path.join(work_dir, 'data/sidewalks_nyc.csv')
    if not os.path.isfile(path):
        pc.die(f'sidewalk basemap missing: {path}. Run fetch_public.py first.')
    sidewalks = pd.read_csv(path)
    sidewalks = gpd.GeoDataFrame(
        sidewalks, geometry=sidewalks['the_geom'].apply(wkt.loads), crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    sidewalks['segment_index'] = sidewalks.index
    drop = [c for c in ('SUB_CODE', 'FEAT_CODE', 'STATUS', 'the_geom') if c in sidewalks.columns]
    sidewalks = sidewalks.drop(columns=drop)
    sidewalks['SHAPE_Width'] = sidewalks['SHAPE_Area'] / sidewalks['SHAPE_Leng']
    sidewalks['width'] = sidewalks['SHAPE_Width']
    sidewalks['geometry'] = sidewalks['geometry'].simplify(10)
    if bbox is not None:
        minlon, minlat, maxlon, maxlat = bbox
        clip_box = gpd.GeoDataFrame(
            geometry=[box(minlon, minlat, maxlon, maxlat)], crs=pc.CRS_WGS,
        ).to_crs(pc.CRS_PROJ)
        sidewalks = sidewalks[sidewalks.intersects(clip_box.geometry.iloc[0])]
    return sidewalks.reset_index(drop=True)


def _points_from_spec(path: str, kind: str, geom_col: str, lon_col: str, lat_col: str):
    """Read one point dataset and project it to EPSG:2263."""
    import geopandas as gpd
    import pandas as pd
    from shapely import wkt

    if kind == 'dir':
        return gpd.read_file(path).to_crs(pc.CRS_PROJ)
    frame = pd.read_csv(path)
    if kind == 'wkt':
        geom = frame[geom_col].apply(wkt.loads)
        points = gpd.GeoDataFrame(frame, geometry=geom, crs=pc.CRS_WGS)
    elif kind == 'xy':
        points = gpd.GeoDataFrame(
            frame, geometry=gpd.points_from_xy(frame[lon_col], frame[lat_col]),
            crs=pc.CRS_WGS,
        )
    else:
        points = gpd.GeoDataFrame(
            frame, geometry=gpd.points_from_xy(frame[lon_col], frame[lat_col]),
            crs=pc.CRS_PROJ,
        )
        return points
    return points.to_crs(pc.CRS_PROJ)


def _buffered_counts(segments, points, buffer_ft: float) -> List[float]:
    """Count buffered points that intersect each segment."""
    import geopandas as gpd

    if len(points) == 0:
        return [0.0] * len(segments)
    buffered = points.copy()
    buffered['geometry'] = buffered.buffer(buffer_ft)
    merged = gpd.sjoin(segments[['geometry']], buffered, how='left', predicate='intersects')
    counts = merged.groupby(level=0).size()
    # A left join with zero matches yields one row of NaN. size() would
    # count that row, so subtract it where the join key is missing.
    has_match = merged['index_right'].notna().groupby(level=0).any()
    out = []
    for i in range(len(segments)):
        if has_match.get(i, False):
            out.append(float(counts.get(i, 0)))
        else:
            out.append(0.0)
    return out


def join_street_furniture(segments, work_dir: str) -> Optional[List[float]]:
    """Compute weighted clutter per segment.

    Port of street_furniture.ipynb cells 4-59 at segment level. Each segment
    gets a 25 ft buffer. Furniture points inside the buffer are counted,
    weighted by cell 56, summed, divided by the width (cell 58), and clipped
    to the 1st-99th percentile (cell 59).
    """
    import numpy as np

    counts = {}
    for name, spec in FURNITURE_SPECS.items():
        rel, kind, geom_col, lon_col, lat_col = spec
        path = os.path.join(work_dir, rel)
        if not os.path.exists(path):
            return None
        try:
            points = _points_from_spec(path, kind, geom_col, lon_col, lat_col)
        except Exception as e:  # noqa: BLE001 - a bad file must not kill the run
            pc.log(f'features_join: street furniture {name} unreadable: {e}')
            return None
        counts[name] = _buffered_counts(segments, points, BUFFER_25_FT)
    n = len(segments)
    clutter = [0.0] * n
    for name, weight in CLUTTER_WEIGHTS.items():
        for i in range(n):
            clutter[i] += counts[name][i] * weight
    widths = list(segments['width'])
    for i in range(n):
        if widths[i] and widths[i] > 0:
            clutter[i] = clutter[i] / widths[i]
    arr = np.asarray(clutter, dtype=np.float64)
    if len(arr) > 0:
        lo, hi = np.quantile(arr, 0.01), np.quantile(arr, 0.99)
        arr = np.clip(arr, lo, hi)
    return [float(v) for v in arr]


def join_surface_condition(segments, work_dir: str) -> Optional[List[float]]:
    """Join the sidewalk cleanliness scorecard by community district.

    Port of dataset.ipynb cells 56-58. Keeps the 2023/09 month, builds the
    district code, averages the acceptable-streets rate, and joins it to the
    segments through the community district polygons.
    """
    import geopandas as gpd
    import pandas as pd

    scorecard_path = os.path.join(work_dir, 'data/Scorecard_Ratings.csv')
    cd_zip = os.path.join(work_dir, 'data/community_districts_nyc.zip')
    if not (os.path.isfile(scorecard_path) and os.path.exists(cd_zip)):
        return None
    scorecard = pd.read_csv(scorecard_path)
    scorecard = scorecard[scorecard['Month'] == '2023 / 09']
    boro_codes = {'Manhattan': 1, 'Bronx': 2, 'Brooklyn': 3, 'Queens': 4, 'Staten Island': 5}
    scorecard['boro_code'] = scorecard['Borough'].map(boro_codes).astype(str)
    scorecard['cd_code'] = (scorecard['boro_code']
                            + scorecard['Community Board'].astype(str).str.zfill(2)).astype(int)
    rate_col = [c for c in scorecard.columns if 'Acceptable Streets % - Previous Month' in c]
    if not rate_col:
        return None
    scorecard = scorecard.groupby('cd_code')[rate_col[0]].mean().reset_index()
    districts = gpd.read_file(cd_zip).to_crs(pc.CRS_PROJ)
    districts['boro_cd'] = districts['boro_cd'].astype(int)
    districts = districts.merge(scorecard, left_on='boro_cd', right_on='cd_code', how='left')
    districts['sidewalk_quality'] = districts[rate_col[0]]
    merged = gpd.sjoin(segments[['geometry']], districts[['geometry', 'sidewalk_quality']],
                       how='left', predicate='intersects')
    quality = merged.groupby(level=0)['sidewalk_quality'].first()
    return [float(quality.get(i, float('nan'))) for i in range(len(segments))]


def join_communication(segments, work_dir: str) -> Optional[dict]:
    """Join FCC 4G rates. Port of dataset.ipynb cells 29-31."""
    import geopandas as gpd

    path = os.path.join(work_dir, 'data/4g_ny')
    if not os.path.isdir(path):
        return None
    frames = gpd.read_file(path)
    frames = frames.to_crs(pc.CRS_PROJ)
    merged = gpd.sjoin(segments[['geometry']], frames, how='left', predicate='intersects')
    up = merged.groupby(level=0)['minup'].first()
    down = merged.groupby(level=0)['mindown'].first()
    n = len(segments)
    return {
        '4g_minup': [float(up.get(i, 0.0) or 0.0) for i in range(n)],
        '4g_mindown': [float(down.get(i, 0.0) or 0.0) for i in range(n)],
    }


def join_zoning(segments, work_dir: str) -> Optional[List[str]]:
    """Join the zoning district code. Port of dataset.ipynb cell 44."""
    import geopandas as gpd

    path = os.path.join(work_dir, 'data/zoning_nyc')
    if not os.path.isdir(path):
        return None
    zoning = gpd.read_file(path).to_crs(pc.CRS_PROJ)
    merged = gpd.sjoin(segments[['geometry']], zoning[['geometry', 'zonedist']],
                       how='left', predicate='intersects')
    zonedist = merged.groupby(level=0)['zonedist'].first()
    return [str(zonedist.get(i, '') or '') for i in range(len(segments))]


