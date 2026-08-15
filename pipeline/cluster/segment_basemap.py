"""Centerline segmentation of the sidewalk basemap.

Port of robotability-nyc/feature_processing/sidewalk_widths.py. The
sidewalk basemap holds polygons. The map and the contract need one
LineString per segment. This stage turns the sidewalk polygons into
centerline segments with one width per segment:

    dissolve -> explode -> Voronoi centerline -> linemerge ->
    short dead-end removal -> simplify (1 ft) -> 2-point segments ->
    width = 2 x mean boundary distance along the segment.

The output is deterministic. The same basemap bytes produce the same
parquet bytes. Run it after fetch_public.py and before
build_features.py. Mock runs skip it. Mock mode generates its own
segments.

Usage:
    python3 segment_basemap.py --work <dir> [--workers N]

The output is <work>/data/sidewalk_segments.parquet with two columns:
geometry_wkt (WGS84 LineString) and width (feet).
"""

import argparse
import os
import sys
from multiprocessing import Pool
from typing import List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

SEGMENTS_REL = 'data/sidewalk_segments.parquet'
# Dead-end spur cap. Matches remove_short_lines in sidewalk_widths.py.
DEAD_END_MAX_FT = 5.0
# Simplify tolerance in feet. Matches try_simplify in sidewalk_widths.py.
SIMPLIFY_TOLERANCE_FT = 1.0
# Width sampling step in feet. Matches interpolate_by_distance.
WIDTH_STEP_FT = 1.0


def remove_short_lines(line):
    """Drop short dead-end spur lines. Port of the research function.

    A spur is a line whose start or end touches no other line of the
    set. Spurs longer than DEAD_END_MAX_FT stay. The rule matches
    remove_short_lines in sidewalk_widths.py.
    """
    from shapely.geometry import MultiLineString, Point

    if line is None or line.is_empty:
        return None
    if line.geom_type == 'MultiLineString':
        geoms = list(line.geoms)
        passing = []
        for i, part in enumerate(geoms):
            others = MultiLineString([x for j, x in enumerate(geoms) if j != i])
            p0 = Point(part.coords[0])
            p1 = Point(part.coords[-1])
            is_deadend = False
            if p0.disjoint(others):
                is_deadend = True
            if p1.disjoint(others):
                is_deadend = True
            if not is_deadend or part.length > DEAD_END_MAX_FT:
                passing.append(part)
        if not passing:
            return None
        return MultiLineString(passing)
    if line.geom_type == 'LineString':
        return line
    return None


def split_to_segments(line) -> List:
    """Split lines into consecutive 2-point LineStrings.

    Port of linestring_to_segments and get_segments in
    sidewalk_widths.py.
    """
    from shapely.geometry import LineString

    out: List = []
    if line is None or line.is_empty:
        return out
    geoms = list(line.geoms) if line.geom_type == 'MultiLineString' else [line]
    for linestring in geoms:
        coords = list(linestring.coords)
        for i in range(len(coords) - 1):
            seg = LineString([coords[i], coords[i + 1]])
            if seg.length > 0:
                out.append(seg)
    return out


def boundary_lines(polygon):
    """Exterior and interior rings as one MultiLineString.

    Port of polygon_to_multilinestring in sidewalk_widths.py.
    """
    from shapely.geometry import MultiLineString

    return MultiLineString(
        [polygon.exterior] + [ring for ring in polygon.interiors])


def interpolate_points(segment, step_ft: float = WIDTH_STEP_FT) -> List:
    """Sample points along one segment every step_ft.

    Port of interpolate_by_distance in sidewalk_widths.py. A segment
    shorter than the step yields its midpoint.
    """
    from shapely.geometry import Point

    count = round(segment.length / step_ft) + 1
    if count == 1:
        return [segment.interpolate(segment.length / 2)]
    return [segment.interpolate(step_ft * i) for i in range(count)]


def segment_width(segment, boundary) -> float:
    """Width of one segment: 2 x mean distance to the polygon boundary.

    Port of get_avg_distances in sidewalk_widths.py. Each sampled point
    takes its nearest boundary point. The mean distance doubles into
    the width.
    """
    from shapely.ops import nearest_points

    points = interpolate_points(segment)
    total = 0.0
    for point in points:
        p1, _ = nearest_points(boundary, point)
        total += p1.distance(point)
    return (total / len(points)) * 2


def segment_polygon_proj(polygon) -> List[Tuple[object, float]]:
    """Segment one projected polygon. Returns (LineString, width) pairs.

    The core centerline step. Input and output live in the projected
    CRS (feet). The empty list marks a polygon that yields no
    centerline. The research drops such polygons too.
    """
    from centerline.geometry import Centerline
    from shapely.ops import linemerge

    if polygon is None or polygon.is_empty or polygon.area <= 0:
        return []
    try:
        centerline = Centerline(polygon)
    except Exception:  # noqa: BLE001 - a bad polygon must not kill the run
        return []
    geom = centerline.geometry
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type not in ('LineString', 'MultiLineString'):
        return []
    merged = linemerge(geom)
    cleaned = remove_short_lines(merged)
    if cleaned is None or cleaned.is_empty:
        return []
    cleaned = cleaned.simplify(SIMPLIFY_TOLERANCE_FT, preserve_topology=True)
    segments = split_to_segments(cleaned)
    if not segments:
        return []
    boundary = boundary_lines(polygon)
    return [(segment, segment_width(segment, boundary)) for segment in segments]


def segment_polygon(wkt_text: str) -> List[Tuple[str, float]]:
    """Segment one projected polygon WKT.

    Worker entry point. Returns (WGS84 WKT, width) pairs. The empty
    list marks a polygon that yields no centerline.
    """
    import pyproj
    from shapely import wkt
    from shapely.ops import transform

    to_wgs = pyproj.Transformer.from_crs(pc.CRS_PROJ, pc.CRS_WGS, always_xy=True)
    polygon = wkt.loads(wkt_text)
    out: List[Tuple[str, float]] = []
    for segment, width in segment_polygon_proj(polygon):
        seg_wgs = transform(to_wgs.transform, segment)
        out.append((seg_wgs.wkt, float(width)))
    return out


def load_basemap(work_dir: str):
    """Read the sidewalk basemap and project it to EPSG:2263."""
    import geopandas as gpd
    import pandas as pd
    from shapely import wkt

    path = os.path.join(work_dir, 'data/sidewalks_nyc.csv')
    if not os.path.isfile(path):
        pc.die(f'sidewalk basemap missing: {path}. Run fetch_public.py first.')
    frame = pd.read_csv(path)
    geo = gpd.GeoDataFrame(
        frame, geometry=frame['the_geom'].apply(wkt.loads), crs=pc.CRS_WGS,
    ).to_crs(pc.CRS_PROJ)
    return geo


def dissolve_polygons(geo) -> List[str]:
    """Dissolve the basemap and return one WKT per merged polygon.

    Port of the unary_union + explode steps in sidewalk_widths.py.
    Dissolving merges adjacent sidewalk polygons first. The centerline
    of a merged shape avoids spurs along shared edges.
    """
    import geopandas as gpd

    union = gpd.GeoSeries(geo.geometry).unary_union
    parts = union.geoms if hasattr(union, 'geoms') else [union]
    wkts: List[str] = []
    for part in parts:
        if part.geom_type == 'Polygon' and not part.is_empty and part.area > 0:
            wkts.append(part.wkt)
    return wkts


def write_segments(path: str, rows: Sequence[Tuple[str, float]]) -> None:
    """Write the segment table. Columns: geometry_wkt, width."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    fields = [pa.field('geometry_wkt', pa.string(), nullable=False),
              pa.field('width', pa.float64(), nullable=False)]
    geometry_wkt = [row[0] for row in rows]
    width = [row[1] for row in rows]
    table = pa.Table.from_arrays(
        [pa.array(geometry_wkt, type=pa.string()),
         pa.array(width, type=pa.float64())],
        schema=pa.schema(fields))
    pq.write_table(table, path, compression='snappy', data_page_version='1.0')


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description='segment the sidewalk basemap')
    parser.add_argument('--work', required=True, help='pipeline work directory')
    parser.add_argument('--workers', type=int, default=os.cpu_count() or 1,
                        help='worker process count (default: cpu count)')
    args = parser.parse_args(argv)

    geo = load_basemap(args.work)
    pc.log(f'segment_basemap: {len(geo)} basemap polygons loaded')
    wkts = dissolve_polygons(geo)
    pc.log(f'segment_basemap: {len(wkts)} dissolved polygons to segment')

    rows: List[Tuple[str, float]] = []
    dropped = 0
    workers = max(1, args.workers)
    with Pool(workers) as pool:
        for i, result in enumerate(
                pool.imap(segment_polygon, wkts, chunksize=32)):
            if result:
                rows.extend(result)
            else:
                dropped += 1
            if (i + 1) % 500 == 0 or i + 1 == len(wkts):
                pc.log(f'segment_basemap: segmented {i + 1}/{len(wkts)} '
                       f'polygons, {len(rows)} segments so far')

    if not rows:
        pc.die('segment_basemap produced no segments. Check the basemap.')
    out_path = os.path.join(args.work, SEGMENTS_REL)
    pc.ensure_dir(os.path.dirname(out_path))
    write_segments(out_path, rows)
    pc.log(f'segment_basemap: {len(rows)} segments from '
           f'{len(wkts) - dropped} polygons ({dropped} dropped)')
    pc.log(f'segment_basemap: wrote {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
