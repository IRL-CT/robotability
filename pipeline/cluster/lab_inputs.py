"""Read the lab storage inputs. Dashcam traffic, surveillance, DEM.

These readers run only in real mode. Mock mode never calls them.
See NOTEBOOK_TRACE.md for the source mapping.

Exit behavior: a missing path returns None. build_features.py then records
the input as missing and fills the column with zeros.
"""

import os
from typing import List, Optional, Sequence

import pipeline_common as pc  # noqa: E402 (import path set by caller)
from features_spec import SLOPE_BASELINE_FT  # noqa: E402

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


def sample_dem(dem_path: str, segments) -> Optional[dict]:
    """Sample the DEM at both ends of each segment's slope baseline.

    The slope feature is the grade along the sidewalk, so it needs a
    height at each end of the segment, not one height at its centroid.
    Returns {'dem_ft_start', 'dem_ft_end', 'dem_run_ft'} aligned to the
    segments, or None when the DEM or the rasterio package is absent.

    A segment shorter than SLOPE_BASELINE_FT has its two sample points
    pushed out along its own bearing, away from the midpoint, until they
    sit that far apart. `dem_run_ft` is the distance actually sampled, so
    the caller divides by the right number.

    Height comes from bilinear interpolation over the downsampled grid,
    computed in float. Two integer steps matter here and only the second
    is avoidable. The raster is uint16, one value per whole foot, so the
    source itself is quantised. GDAL then resamples in the source dtype
    whatever out_dtype asks for, so a decimated read returns whole feet
    again and the smoothing does not smooth. Interpolating in numpy
    instead recovers the fraction between the cells, which is what keeps
    a 1 ft quantum from dominating every short baseline.

    A point outside the raster reads as NaN, not as 0.0. Elevation 0 is a
    real height in a coastal city, so the two must not share a value. The
    caller carries the NaN through to the feature column, where it is the
    no-data marker of contract section 3.2.
    """
    import math

    import numpy as np

    if not os.path.exists(dem_path):
        return None
    try:
        import rasterio
    except ImportError:
        pc.log('lab_inputs: rasterio is not installed. DEM sampling needs it. '
               'Install rasterio on the cluster for real runs.')
        return None

    factor = 10
    with rasterio.open(dem_path) as src:
        new_transform = src.transform * src.transform.scale(factor, factor)
        new_width = src.width // factor
        new_height = src.height // factor
        band = src.read(1, out_shape=(new_height, new_width)).astype('float64')
    inv = ~new_transform

    def height_at(x: float, y: float) -> float:
        """Bilinear height at a projected point. NaN outside the raster."""
        col, row = inv * (x, y)
        # The transform maps to cell corners. Shift to cell centres so
        # the interpolation weights are correct.
        col -= 0.5
        row -= 0.5
        c0 = math.floor(col)
        r0 = math.floor(row)
        fc = col - c0
        fr = row - r0
        if r0 < 0 or c0 < 0 or r0 + 1 >= new_height or c0 + 1 >= new_width:
            return float('nan')
        top = band[r0, c0] * (1.0 - fc) + band[r0, c0 + 1] * fc
        bottom = band[r0 + 1, c0] * (1.0 - fc) + band[r0 + 1, c0 + 1] * fc
        return float(top * (1.0 - fr) + bottom * fr)

    geoms = segments.geometry.to_crs(pc.CRS_PROJ)
    starts: List[float] = []
    ends: List[float] = []
    runs: List[float] = []
    for geom in geoms:
        coords = list(geom.coords)
        if len(coords) < 2:
            starts.append(float('nan'))
            ends.append(float('nan'))
            runs.append(float('nan'))
            continue
        (x0, y0), (x1, y1) = coords[0], coords[-1]
        dx = x1 - x0
        dy = y1 - y0
        length = math.hypot(dx, dy)
        if length <= 0:
            # A zero-length segment has no bearing to measure along.
            starts.append(float('nan'))
            ends.append(float('nan'))
            runs.append(float('nan'))
            continue
        run = length
        ax, ay, bx, by = x0, y0, x1, y1
        if length < SLOPE_BASELINE_FT:
            # Push both ends out along the bearing, keeping the midpoint.
            mx = (x0 + x1) / 2.0
            my = (y0 + y1) / 2.0
            ux = dx / length
            uy = dy / length
            half = SLOPE_BASELINE_FT / 2.0
            ax, ay = mx - ux * half, my - uy * half
            bx, by = mx + ux * half, my + uy * half
            run = SLOPE_BASELINE_FT
        starts.append(height_at(ax, ay))
        ends.append(height_at(bx, by))
        runs.append(run)
    return {'dem_ft_start': starts, 'dem_ft_end': ends, 'dem_run_ft': runs}

