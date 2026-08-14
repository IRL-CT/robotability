"""Read the lab storage inputs. Dashcam traffic, surveillance, DEM.

These readers run only in real mode. Mock mode never calls them.
See NOTEBOOK_TRACE.md for the source mapping.

Exit behavior: a missing path returns None. build_features.py then records
the input as missing and fills the column with zeros.
"""

import os
from typing import List, Optional, Sequence

import pipeline_common as pc  # noqa: E402 (import path set by caller)

# Traffic cone constants from traffic.py.
MAX_DISTANCE_FT = 150
DASHCAM_DAYS = (
    '2023-08-11', '2023-08-12', '2023-08-13', '2023-08-14', '2023-08-17',
    '2023-08-18', '2023-08-20', '2023-08-21', '2023-08-22', '2023-08-23',
    '2023-08-24', '2023-08-28', '2023-08-29', '2023-08-30', '2023-08-31',
)

# Direction to heading map from traffic.py.
DIR_MAPPING = {
    'NORTH': 0, 'NORTH_EAST': 45, 'EAST': 90, 'SOUTH_EAST': 135,
    'SOUTH': 180, 'SOUTH_WEST': 225, 'WEST': 270, 'NORTH_WEST': 315,
}


def read_dashcam_traffic(dashcam_root: str, segments) -> Optional[dict]:
    """Compute mean detection counts per segment. Port of traffic.py.

    Input format: {dashcam_root}/{day}/detections.csv plus md.csv per day.
    detections.csv columns '0', '1', '2' hold pedestrian, bike, car counts.
    md.csv holds frame GPS positions and camera headings.
    Returns {'TRAFFIC_Pedestrian': [...], 'TRAFFIC_Bike': [...],
    'TRAFFIC_Car': [...]} aligned to the segments, or None when the root
    does not exist.
    """
    import math

    import geopandas as gpd
    import numpy as np
    import pandas as pd
    from shapely.geometry import Point, Polygon

    if not os.path.isdir(dashcam_root):
        return None
    day_frames = []
    for day in DASHCAM_DAYS:
        det_path = os.path.join(dashcam_root, day, 'detections.csv')
        md_path = os.path.join(dashcam_root, day, 'md.csv')
        if not (os.path.isfile(det_path) and os.path.isfile(md_path)):
            pc.log(f'lab_inputs: skip day {day}, file missing')
            continue
        detections = pd.read_csv(det_path, index_col=0)[['0', '1', '2']].fillna(0)
        metadata = pd.read_csv(md_path, index_col=0)
        day_frames.append(metadata.merge(detections, left_on='frame_id', right_index=True))
    if not day_frames:
        return None
    traffic = pd.concat(day_frames)
    traffic = gpd.GeoDataFrame(
        traffic,
        geometry=gpd.points_from_xy(traffic['gps_info.longitude'],
                                    traffic['gps_info.latitude']),
        crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    traffic['camera_heading'] = traffic['direction'].map(DIR_MAPPING)
    traffic = traffic.dropna(subset=['camera_heading'])

    def semicircle(row):
        # Port of create_semicircle in traffic.py. The cone points along
        # the camera heading. It spans MAX_DISTANCE_FT in front of the lens.
        heading_rad = math.radians(row['camera_heading'])
        angles = np.linspace(heading_rad - np.pi / 2, heading_rad + np.pi / 2, 10)
        pts = [row['geometry']]
        for angle in angles:
            pts.append(Point(row['geometry'].x + MAX_DISTANCE_FT * np.cos(angle),
                             row['geometry'].y + MAX_DISTANCE_FT * np.sin(angle)))
        pts.append(row['geometry'])
        return Polygon(pts)

    traffic['geometry'] = traffic.apply(semicircle, axis=1)
    joined = gpd.sjoin(traffic, segments[['geometry']], how='inner', predicate='intersects')
    means = joined.groupby('index_right')[['0', '1', '2']].mean()
    n = len(segments)
    out = {
        'TRAFFIC_Pedestrian': [float('nan')] * n,
        'TRAFFIC_Bike': [float('nan')] * n,
        'TRAFFIC_Car': [float('nan')] * n,
    }
    keys = ('TRAFFIC_Pedestrian', 'TRAFFIC_Bike', 'TRAFFIC_Car')
    for idx, row in means.iterrows():
        if 0 <= idx < n:
            for key, col in zip(keys, ('0', '1', '2')):
                out[key][idx] = float(row[col])
    return out


def read_surveillance(surveillance_csv: str, segments) -> Optional[List[float]]:
    """Count cameras near each segment. Port of dataset.ipynb cells 35-37.

    The csv holds n_cameras_median and a WKT panorama geometry per
    intersection. Each camera gets a 50 ft buffer. The function counts the
    buffered cameras that intersect each segment.
    """
    import geopandas as gpd
    import pandas as pd
    from shapely import wkt

    if not os.path.isfile(surveillance_csv):
        return None
    cameras = pd.read_csv(surveillance_csv)
    cameras = cameras[['n_cameras_median', 'geometry_pano']].dropna(subset=['geometry_pano'])
    cameras = gpd.GeoDataFrame(
        cameras, geometry=cameras['geometry_pano'].apply(wkt.loads), crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    cameras['geometry'] = cameras.buffer(50)
    merged = gpd.sjoin(segments[['geometry']], cameras, how='left', predicate='intersects')
    counts = merged.groupby(level=0)['n_cameras_median'].count()
    return [float(counts.get(i, 0)) for i in range(len(segments))]


def sample_dem(dem_path: str, segments) -> Optional[List[float]]:
    """Sample the 1-foot DEM at each segment centroid.

    Port of dataset.ipynb cells 18-20. The raster is downsampled by a factor
    of 10 with bilinear resampling, then sampled at the point positions.
    Returns feet above sea level per segment, or None when the DEM or the
    rasterio package is absent.
    """
    if not os.path.exists(dem_path):
        return None
    try:
        import rasterio
        from rasterio.enums import Resampling
    except ImportError:
        pc.log('lab_inputs: rasterio is not installed. DEM sampling needs it. '
               'Install rasterio on the cluster for real runs.')
        return None
    factor = 10
    with rasterio.open(dem_path) as src:
        new_transform = src.transform * src.transform.scale(factor, factor)
        new_width = src.width // factor
        new_height = src.height // factor
        band = src.read(
            1,
            out_shape=(new_height, new_width),
            resampling=Resampling.bilinear,
        )
    centroids = segments.geometry.to_crs(pc.CRS_PROJ).centroid
    out: List[float] = []
    for point in centroids:
        row, col = rasterio.transform.rowcol(new_transform, point.x, point.y)
        if 0 <= row < new_height and 0 <= col < new_width:
            out.append(float(band[row, col]))
        else:
            out.append(0.0)
    return out
