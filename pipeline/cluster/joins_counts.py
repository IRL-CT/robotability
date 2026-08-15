"""Count-based public joins: ramps, traffic management, limits, routes,
collisions, stations. Real mode only. Port of dataset.ipynb cells 50-98.
See NOTEBOOK_TRACE.md for the cell mapping.

Every join returns a list aligned to the segment rows. A missing input file
returns None. build_features.py records the gap and fills it with zeros.
"""

import json
import os
from typing import List, Optional

import pipeline_common as pc  # noqa: E402 (import path set by caller)

BUFFER_50_FT = 50.0

from features_join import _points_from_spec, _buffered_counts  # noqa: E402


def join_curb_ramps(segments, work_dir: str) -> Optional[List[float]]:
    """Count good-condition curb ramps within 50 ft.

    Port of dataset.ipynb cells 50-51.
    """
    path = os.path.join(work_dir, 'data/pedestrian_curb_ramp_nyc.csv')
    if not os.path.isfile(path):
        return None
    points = _points_from_spec(path, 'wkt', 'the_geom', '', '')
    points = points[points['DWS_CONDITIONS'] == 'Good Condition']
    return _buffered_counts(segments, points, BUFFER_50_FT)


def join_traffic_management(segments, work_dir: str) -> Optional[dict]:
    """Count the six traffic-management datasets within 50 ft.

    Port of dataset.ipynb cells 75-91. The notebook's six terms map to:
    SIP corridors (wqhs-q6wd) as the slow-zone flag, turn calming
    (hz4p-9f7s), SIP intersections (79sh-heg3), raised crosswalks
    (uh2s-ftgh), Barnes Dance (8kuj-2n3u), leading pedestrian intervals
    (mqt5-ctec). See NOTEBOOK_TRACE.md for the mapping rationale.
    """
    sources = {
        'in_slow_zone': 'data/dot_VZV_SIP_Corridors.csv',
        'turn_traffic_calming_count': 'data/dot_VZV_Turn_Traffic_Calming.csv',
        'sip_intersections_count': 'data/dot_VZV_SIP_Intersections.csv',
        'sip_corridors_count': 'data/raised_crosswalks_nyc.csv',
        'barnes_intersections_count': 'data/dot_VZV_Barnes_Dance.csv',
        'leading_ped_intervals_count': 'data/dot_VZV_Leading_Pedestrian_Intervals.csv',
    }
    out = {}
    for col, rel in sources.items():
        path = os.path.join(work_dir, rel)
        if not os.path.isfile(path):
            return None
        points = _points_from_spec(path, 'wkt', 'the_geom', '', '')
        out[col] = _buffered_counts(segments, points, BUFFER_50_FT)
    return out


def join_speed_limits(segments, speed_limits_path: str) -> Optional[List[float]]:
    """Mean posted speed limit within 50 ft.

    Port of dataset.ipynb cells 71-72. The notebook joins the VZV speed
    limit lines to each point with a 50 ft max distance and averages the
    posted value.
    """
    import geopandas as gpd
    import pandas as pd
    from shapely import wkt

    if not os.path.isfile(speed_limits_path):
        return None
    limits = pd.read_csv(speed_limits_path)
    # Rows without a geometry cannot join. Drop them before the parse.
    limits = limits.dropna(subset=['the_geom'])
    limits = gpd.GeoDataFrame(
        limits, geometry=limits['the_geom'].apply(wkt.loads), crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    merged = gpd.sjoin_nearest(
        segments[['geometry']], limits[['geometry', 'postvz_sl']],
        how='left', distance_col='distance_to_nearest_speed_limit',
        max_distance=BUFFER_50_FT,
    )
    means = merged.groupby(level=0)['postvz_sl'].mean()
    return [float(means.get(i, float('nan'))) for i in range(len(segments))]


def join_bike_routes(segments, work_dir: str) -> Optional[List[float]]:
    """Mean bike lane facility class within 50 ft.

    Port of dataset.ipynb cells 93-94. Class map: L -> 0.5, I -> 1,
    II -> 2, III -> 3.
    """
    import geopandas as gpd
    import pandas as pd
    from shapely import wkt

    path = os.path.join(work_dir, 'data/New_York_City_Bike_Routes.csv')
    if not os.path.isfile(path):
        return None
    routes = pd.read_csv(path)
    routes = gpd.GeoDataFrame(
        routes, geometry=routes['the_geom'].apply(wkt.loads),
        crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    routes = routes[routes['status'] == 'Current']
    class_map = {'L': 0.5, 'I': 1.0, 'II': 2.0, 'III': 3.0}
    routes['facility_value'] = routes['facilitycl'].map(class_map)
    routes = routes.dropna(subset=['facility_value'])
    merged = gpd.sjoin_nearest(
        segments[['geometry']], routes[['geometry', 'facility_value']],
        how='left', distance_col='distance_to_nearest_bike_route', max_distance=BUFFER_50_FT,
    )
    means = merged.groupby(level=0)['facility_value'].mean()
    return [float(means.get(i, float('nan'))) for i in range(len(segments))]


def join_collisions(segments, work_dir: str) -> Optional[List[float]]:
    """Sum pedestrians injured+killed within 50 ft.

    Port of dataset.ipynb cells 96-98.
    """
    import geopandas as gpd
    import pandas as pd

    path = os.path.join(work_dir, 'data/Motor_Vehicle_Collisions.csv')
    if not os.path.isfile(path):
        return None
    crashes = pd.read_csv(path, low_memory=False)
    crashes = crashes.dropna(subset=['LATITUDE', 'LONGITUDE'])
    crashes['num_peds_involved'] = (
        crashes['NUMBER OF PEDESTRIANS INJURED'].fillna(0)
        + crashes['NUMBER OF PEDESTRIANS KILLED'].fillna(0)
    )
    crashes = gpd.GeoDataFrame(
        crashes, geometry=gpd.points_from_xy(crashes['LONGITUDE'], crashes['LATITUDE']),
        crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    crashes['geometry'] = crashes.buffer(BUFFER_50_FT)
    merged = gpd.sjoin(segments[['geometry']], crashes[['geometry', 'num_peds_involved']],
                       how='left', predicate='intersects')
    sums = merged.groupby(level=0)['num_peds_involved'].sum()
    return [float(sums.get(i, 0.0)) for i in range(len(segments))]


def join_charging(segments, work_dir: str) -> Optional[List[float]]:
    """Distance to the nearest CitiBike station. Port of dataset.ipynb cell 46."""
    import geopandas as gpd
    import pandas as pd

    path = os.path.join(work_dir, 'data/citibike/station_information.json')
    if not os.path.isfile(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        payload = json.load(f)
    stations = pd.json_normalize(payload['data']['stations'])
    stations = gpd.GeoDataFrame(
        stations, geometry=gpd.points_from_xy(stations['lon'], stations['lat']),
        crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    merged = gpd.sjoin_nearest(
        segments[['geometry']], stations[['geometry']],
        how='left', distance_col='distance_to_nearest_station',
    )
    nearest = merged.groupby(level=0)['distance_to_nearest_station'].first()
    return [float(nearest.get(i, float('nan'))) for i in range(len(segments))]
