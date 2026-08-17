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

# FROZEN INPUT. These fifteen days come from a lab collection made in
# 2023, so every snapshot this pipeline emits carries 2023 traffic no
# matter what date the snapshot itself bears.
#
# The fifteen are a deliberate subset, not everything on disk. The
# dashcam root holds 27 day directories: 2023-08-10 through 2023-08-31,
# then 2023-09-29 and 2023-10-20 through 2023-10-29. traffic.py used the
# August window because score.ipynb cell 4 sets CUTOFF to 2023-08-31 and
# the other features were built to match that date. Adding the September
# and October days would widen the sample and improve coverage of the
# 17% of segments no dashcam drove past, but it would also mix dates
# across features, so it is a modelling decision rather than a fix.
#
# Two scored features still read from here, bicycle_traffic and
# vehicle_traffic, together 7.8% of the model weight. pedestrian_density
# used to as well, and moved to the DOT Pedestrian Demand Map, which DOT
# maintains. See features_join.join_pedestrian_demand.
#
# So a 2026 snapshot mixes 2026 sidewalks, 2026 public data and 2023
# traffic. That is a deliberate choice, not an oversight: no citywide
# bicycle or vehicle volume model exists to replace these. The public
# count datasets (ct66-47at, 7ym2-wayt) are sparse sensor readings rather
# than citywide coverage, so substituting them would leave most segments
# with no value at all. Read these two features as a 2023 baseline.
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
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    import shapely

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

    # Vectorized port of create_semicircle in traffic.py. Each frame gets a
    # cone pointing along the camera heading, spanning MAX_DISTANCE_FT in
    # front of the lens: the lens position, ten points along a half turn,
    # then back to the lens.
    #
    # traffic.py built these one Polygon at a time in a row-wise apply. At
    # 7.7M dashcam frames that single loop was 78% of the entire feature
    # build, so it is built here as array math instead. shapely.polygons
    # reads an (n, 12, 2) coordinate array and returns the same rings;
    # shapely.equals_exact confirms the two forms agree to 1e-6.
    heading = np.radians(traffic['camera_heading'].to_numpy(dtype=float))
    lens_x = traffic.geometry.x.to_numpy()
    lens_y = traffic.geometry.y.to_numpy()
    arc = heading[:, None] + np.linspace(-np.pi / 2, np.pi / 2, 10)[None, :]
    arc_x = lens_x[:, None] + MAX_DISTANCE_FT * np.cos(arc)
    arc_y = lens_y[:, None] + MAX_DISTANCE_FT * np.sin(arc)
    ring_x = np.concatenate([lens_x[:, None], arc_x, lens_x[:, None]], axis=1)
    ring_y = np.concatenate([lens_y[:, None], arc_y, lens_y[:, None]], axis=1)
    traffic['geometry'] = shapely.polygons(
        np.stack([ring_x, ring_y], axis=-1))
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
    import shapely

    if not os.path.isfile(surveillance_csv):
        return None
    cameras = pd.read_csv(surveillance_csv,
                          usecols=['n_cameras_median', 'geometry_pano'])
    cameras = cameras.dropna(subset=['geometry_pano'])
    cameras = gpd.GeoDataFrame(
        cameras,
        geometry=shapely.from_wkt(
            cameras['geometry_pano'].to_numpy(dtype=object)),
        crs=pc.CRS_WGS,
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
