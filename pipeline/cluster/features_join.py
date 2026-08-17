"""Join the public datasets onto the sidewalk segments. Real mode only.

Port of the joins in robotability-nyc/feature_processing/dataset.ipynb at
segment level, plus the clutter pipeline of street_furniture.ipynb.
See NOTEBOOK_TRACE.md for the cell mapping.

Every join returns a list aligned to the segment rows. A missing input file
returns None. build_features.py records the gap and fills it with zeros.
"""

import json
import os
from typing import List, Optional, Sequence

import pipeline_common as pc  # noqa: E402 (import path set by caller)

BUFFER_50_FT = 50.0
BUFFER_25_FT = 25.0
# Scaffolding sits at a wider radius than the rest of the furniture.
# street_furniture.ipynb buffers the sidewalk by 25 ft in cell 5 and then
# buffers the shed points by a further 100 ft in cell 49, so a shed counts
# when it lies within 125 ft of the segment. _buffered_counts buffers only
# the points, so the faithful single-sided radius is the sum.
BUFFER_125_FT = BUFFER_25_FT + 100.0

# Per-dataset buffer overrides for FURNITURE_SPECS. Anything absent here
# uses BUFFER_25_FT, which is cell 5's sidewalk buffer against raw points.
FURNITURE_BUFFER_FT = {
    'scaffolding_permit_count': BUFFER_125_FT,
}

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
    'scaffolding_permit_count': ('data/street_furniture/dob_active_sheds.csv', 'xy', '', 'Longitude Point', 'Latitude Point'),
    'tree_count': ('data/street_furniture/forestry_tree_points_nyc.csv', 'xy', '', 'longitude', 'latitude'),
    'newsstand_count': ('data/street_furniture/newsstands_nyc.csv', 'wkt', 'the_geom', '', ''),
    'parking_meter_count': ('data/street_furniture/parking_meters_nyc.csv', 'wkt', 'Location', '', ''),
    'hydrant_count': ('data/street_furniture/fire_hydrants_nyc.csv', 'wkt', 'the_geom', '', ''),
    'street_sign_count': ('data/street_furniture/Street_Sign_Work_Orders.csv', 'xy_proj', '', 'sign_x_coord', 'sign_y_coord'),
    'alarm_call_box_count': ('data/street_furniture/In-Service_Alarm_Box_Locations.csv', 'wkt', 'Location Point', '', ''),
}


def extracted_dir(path: str) -> str:
    """Resolve the directory fetch_public.py unzipped an archive into.

    fetch_public.unzip_dataset writes a non-.zip destination to
    <dest>_extracted and leaves <dest> as the downloaded archive. The
    FURNITURE_SPECS paths and join_zoning name <dest>, so prefer the
    _extracted directory when it exists and fall back to the plain path
    for datasets that arrive already unpacked.
    """
    candidate = path + '_extracted'
    return candidate if os.path.isdir(candidate) else path


def load_segments(work_dir: str, bbox: Optional[tuple]):
    """Load the segmented sidewalk basemap.

    segment_basemap.py ports the research centerline step
    (sidewalk_widths.py) and writes data/sidewalk_segments.parquet.
    Each row is one LineString segment with its width in feet. The
    segment id is the row index, as in dataset.ipynb.
    """
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    import shapely
    from shapely import box

    path = os.path.join(work_dir, 'data/sidewalk_segments.parquet')
    if not os.path.isfile(path):
        pc.die(f'segmented basemap missing: {path}. '
               'Run segment_basemap.py first.')
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    # Parse the whole WKT column in one shapely call and take width
    # straight off the arrow buffer. The row-wise apply(wkt.loads) and
    # per-value float() this replaces ran 491,894 times each on a
    # full-city basemap, once per build.
    geometry = shapely.from_wkt(
        np.asarray(table.column('geometry_wkt').to_pylist(), dtype=object))
    segments = gpd.GeoDataFrame(
        {'width': table.column('width').to_numpy(zero_copy_only=False)
                       .astype(float)},
        geometry=geometry, crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    segments['segment_index'] = segments.index
    if bbox is not None:
        minlon, minlat, maxlon, maxlat = bbox
        clip_box = gpd.GeoDataFrame(
            geometry=[box(minlon, minlat, maxlon, maxlat)], crs=pc.CRS_WGS,
        ).to_crs(pc.CRS_PROJ)
        segments = segments[segments.intersects(clip_box.geometry.iloc[0])]
    return segments.reset_index(drop=True)


def _points_from_spec(path: str, kind: str, geom_col: str, lon_col: str,
                      lat_col: str, keep_cols: Sequence[str] = ()):
    """Read one point dataset and project it to EPSG:2263.

    Only the geometry columns are read, plus anything in keep_cols that a
    caller filters on afterwards. Reading the whole file is expensive
    twice over here: the work dir sits on NFS and
    Street_Sign_Work_Orders.csv alone is 2.7 GB across 25 columns when
    the join needs two of them, and every column that survives the read
    is then carried through the spatial join as join payload.
    """
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    import shapely

    if kind == 'dir':
        return gpd.read_file(extracted_dir(path)).to_crs(pc.CRS_PROJ)
    if kind == 'wkt':
        usecols = [geom_col, *keep_cols]
    else:
        usecols = [lon_col, lat_col, *keep_cols]
    frame = pd.read_csv(path, usecols=usecols)
    if kind == 'wkt':
        # shapely.from_wkt parses the whole column in one call. The
        # row-wise Series.apply(wkt.loads) it replaces ran once per point.
        geom = shapely.from_wkt(frame[geom_col].to_numpy(dtype=object))
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
        counts[name] = _buffered_counts(
            segments, points, FURNITURE_BUFFER_FT.get(name, BUFFER_25_FT))
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


# DOT Pedestrian Demand Map rank values, busiest first.
PED_DEMAND_RANKS = {1: 'Global', 2: 'Regional', 3: 'Neighborhood',
                    4: 'Community Connector', 5: 'Citywide Baseline'}
PED_DEMAND_BASELINE_RANK = 5
# How far a sidewalk segment may sit from its street centerline and still
# take that street's category. Measured over all 491,894 segments of the
# 2026 basemap: median 24 ft, p75 52 ft, p90 231 ft. Cumulative coverage
# is 74.6% within 50 ft, 80.5% within 100, 85.2% within 150, 88.4% within
# 200 and 92.3% within 300.
#
# 200 ft sits past the knee of that curve. The DOT map covers mapped city
# streets, so the segments left over are mostly sidewalks with no street
# beside them: park paths, campus and housing-development walkways. A
# street 300 ft away is weak evidence about such a path, so widening the
# radius buys coverage by weakening the match.
PED_DEMAND_MAX_FT = 200.0


def join_pedestrian_demand(segments, work_dir: str) -> Optional[List[float]]:
    """Pedestrian demand level per segment, 1 quiet to 5 busy.

    Reads the DOT Pedestrian Demand Map, which assigns every city street
    one of five categories modelled from retail, office and residential
    density, restaurants, parks, school frontages, subway ridership and
    hospitals. Each sidewalk segment takes the category of the street
    centerline nearest to it.

    The rank column in the source runs the other way from demand: rank 1
    is a Global Corridor, the busiest, and rank 5 is the Citywide
    Baseline, the quiet default. This returns 6 - rank so the value rises
    with demand, which is what pedestrian_density needs. Reading rank
    straight through would inverse the highest weighted feature in the
    model.

    A segment with no street inside PED_DEMAND_MAX_FT takes the baseline
    level. DOT applies that category to streets with relatively little
    pedestrian activity, which is the right reading of a sidewalk that
    sits far from any mapped street, and it keeps the column free of NaN.
    """
    import geopandas as gpd

    path = os.path.join(work_dir, 'data/ped_demand_nyc.geojson')
    if not os.path.isfile(path):
        return None
    demand = gpd.read_file(path, columns=['rank']).to_crs(pc.CRS_PROJ)
    demand = demand.dropna(subset=['rank'])
    if demand.empty:
        return None
    merged = gpd.sjoin_nearest(
        segments[['geometry']], demand[['geometry', 'rank']],
        how='left', distance_col='ped_demand_dist_ft',
        max_distance=PED_DEMAND_MAX_FT,
    )
    # sjoin_nearest keeps every tied street. min() takes the busiest of
    # them, since rank counts down as demand goes up.
    nearest = merged.groupby(level=0)['rank'].min()
    baseline = float(PED_DEMAND_BASELINE_RANK)
    out: List[float] = []
    for i in range(len(segments)):
        rank = nearest.get(i, baseline)
        if rank is None or (isinstance(rank, float) and rank != rank):
            rank = baseline
        out.append(float(PED_DEMAND_BASELINE_RANK + 1 - float(rank)))
    return out


def join_zoning(segments, work_dir: str) -> Optional[List[str]]:
    """Join the zoning district code. Port of dataset.ipynb cell 44."""
    import geopandas as gpd

    path = extracted_dir(os.path.join(work_dir, 'data/zoning_nyc'))
    if not os.path.isdir(path):
        return None
    # The retired kdig-pewd shapefile unzipped to a directory that
    # read_file could open directly, with a lowercase zonedist column.
    # Its replacement mm69-vrje is a file geodatabase holding six feature
    # classes, so name the zoning district layer and normalize the case.
    gdb = os.path.join(path, 'zoning.gdb')
    if os.path.isdir(gdb):
        zoning = gpd.read_file(gdb, layer='nyzd')
    else:
        zoning = gpd.read_file(path)
    zoning.columns = [c.lower() if c != zoning.geometry.name else c
                      for c in zoning.columns]
    if 'zonedist' not in zoning.columns:
        return None
    zoning = zoning.to_crs(pc.CRS_PROJ)
    merged = gpd.sjoin(segments[['geometry']], zoning[['geometry', 'zonedist']],
                       how='left', predicate='intersects')
    zonedist = merged.groupby(level=0)['zonedist'].first()
    return [str(zonedist.get(i, '') or '') for i in range(len(segments))]


