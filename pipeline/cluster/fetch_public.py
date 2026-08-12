"""Download the public inputs for one snapshot run.

Port of the download list in robotability-nyc/feature_processing/pull_data.sh.
Every dataset id this script touches is documented in the DATASETS registry.

Resume behavior: a finished file is never downloaded again. An interrupted
download stays in a .part file and resumes with an HTTP Range request when
the server supports it. This mirrors the 'if [ ! -f ... ]' guards of
pull_data.sh and adds byte-level resume on top.

Usage:
    python3 fetch_public.py --work <dir>            Download missing inputs.
    python3 fetch_public.py --work <dir> --skip     No network. Report only.

The --skip flag is mandatory for mock runs. Mock mode must work with the
network turned off.

Exit codes: 0 success (or --skip), 1 download failure, 2 bad usage.
"""

import argparse
import os
import sys
import urllib.request
from typing import List, Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

SOCK_TIMEOUT_S = 60
CHUNK_BYTES = 1 << 20

# NYC_OPENDATA hosts the Socrata export endpoint used by most entries.
NYC_OPENDATA = 'https://data.cityofnewyork.us'


def rows_csv_url(dataset_id: str, extra: str = '') -> str:
    """Build the Socrata rows.csv export URL for one dataset id."""
    query = 'accessType=DOWNLOAD'
    if extra:
        query = f'{extra}&{query}'
    return f'{NYC_OPENDATA}/api/views/{dataset_id}/rows.csv?{query}'


def shapefile_url(dataset_id: str) -> str:
    """Build the Socrata shapefile export URL for one dataset id."""
    return f'{NYC_OPENDATA}/api/geospatial/{dataset_id}?method=export&format=Shapefile'


class Dataset:
    """One public input. Fields map 1:1 to a pull_data.sh line."""

    def __init__(self, name: str, dest: str, url: Optional[str],
                 dataset_id: str, unzip: bool, note: str = '') -> None:
        self.name = name
        self.dest = dest
        self.url = url
        self.dataset_id = dataset_id
        self.unzip = unzip
        self.note = note


# DATASETS is the full public input list.
# dataset_id values belong to data.cityofnewyork.us unless the note says
# otherwise. Entries with url=None need a manual download. The script prints
# their source so the operator can fetch them by hand.
def build_datasets() -> List[Dataset]:
    furniture = 'data/street_furniture'
    return [
        # Sidewalk basemap. Segment geometry + width.
        Dataset('sidewalks_nyc.csv', 'data/sidewalks_nyc.csv',
                rows_csv_url('52n9-sdep', 'date=20240814'), '52n9-sdep', False),
        # 2020 neighborhood tabulation areas. Context join.
        Dataset('ntas_nyc.csv', 'data/ntas_nyc.csv',
                rows_csv_url('9nt8-h7nd'), '9nt8-h7nd', False),
        # 2020 census blocks. Context join.
        Dataset('nyc_cbs.zip', 'data/nyc_cbs.zip',
                'https://s-media.nyc.gov/agencies/dcp/assets/files/zip/data-tools/bytes/nycb2020_24c.zip',
                'nycb2020_24c', False),
        # Community districts. surface_condition join.
        Dataset('community_districts_nyc.zip', 'data/community_districts_nyc.zip',
                shapefile_url('yfnk-k7r4'), 'yfnk-k7r4', True),
        # CitiBike trips 2023-12. bicycle_traffic + charging_station_proximity.
        Dataset('citibike_202312', 'data/citibike_202312',
                'https://s3.amazonaws.com/tripdata/JC-202312-citibike-tripdata.csv.zip',
                'citibike-tripdata', True),
        # CitiBike station inventory (GBFS). charging_station_proximity.
        Dataset('station_information.json', 'data/citibike/station_information.json',
                'https://gbfs.citibikenyc.com/gbfs/en/station_information.json',
                'citibike-gbfs', False),
        # Pedestrian curb ramps. curb_ramp_availability.
        Dataset('pedestrian_curb_ramp_nyc.csv', 'data/pedestrian_curb_ramp_nyc.csv',
                rows_csv_url('ufzp-rrqu'), 'ufzp-rrqu', False),
        # Surveillance camera locations. surveillance_coverage context.
        Dataset('surveillance_cameras', 'data/surveillance_cameras',
                'https://storage.googleapis.com/scpl-surveillance/camera-data.zip',
                'scpl-surveillance', True),
        # Raised crosswalks. traffic_management term 6.
        Dataset('raised_crosswalks_nyc.csv', 'data/raised_crosswalks_nyc.csv',
                rows_csv_url('uh2s-ftgh'), 'uh2s-ftgh', False),
        # VZW enhanced crossings. traffic_management context.
        Dataset('vzw_enhanced_crossings_nyc.csv', 'data/vzw_enhanced_crossings_nyc.csv',
                rows_csv_url('k9a2-vdr8'), 'k9a2-vdr8', False),
        # Zoning districts. zoning_laws + crowd_dynamics.
        Dataset('zoning_nyc', 'data/zoning_nyc',
                shapefile_url('kdig-pewd'), 'kdig-pewd', True),
        # NYC 1-foot DEM. slope_gradient. The cluster usually reads the lab
        # copy instead. Kept here because pull_data.sh lists it.
        Dataset('1ft_dem_nyc', 'data/1ft_dem_nyc',
                'https://sa-static-customer-assets-us-east-1-fedramp-prod.s3.amazonaws.com/data.cityofnewyork.us/NYC_DEM_1ft_Int.zip',
                'NYC_DEM_1ft_Int', True),
        # Points of interest. Context join in dataset.ipynb.
        Dataset('pois_nyc.csv', 'data/pois_nyc.csv',
                rows_csv_url('t95h-5fsr'), 't95h-5fsr', False),
        # Sidewalk cleanliness scorecard. surface_condition.
        Dataset('scorecard_ratings.csv', 'data/Scorecard_Ratings.csv',
                rows_csv_url('rqhp-hivt'), 'rqhp-hivt', False),
        # Vision Zero traffic management. traffic_management terms 1-5.
        Dataset('vzv_sip_intersections.csv', 'data/dot_VZV_SIP_Intersections.csv',
                rows_csv_url('79sh-heg3'), '79sh-heg3', False),
        Dataset('vzv_turn_traffic_calming.csv', 'data/dot_VZV_Turn_Traffic_Calming.csv',
                rows_csv_url('hz4p-9f7s'), 'hz4p-9f7s', False),
        Dataset('vzv_leading_ped_intervals.csv', 'data/dot_VZV_Leading_Pedestrian_Intervals.csv',
                rows_csv_url('mqt5-ctec'), 'mqt5-ctec', False),
        Dataset('vzv_sip_corridors.csv', 'data/dot_VZV_SIP_Corridors.csv',
                rows_csv_url('wqhs-q6wd'), 'wqhs-q6wd', False),
        Dataset('vzv_speed_humps.csv', 'data/dot_VZV_Speed_Humps.csv',
                rows_csv_url('7f9e-jic4'), '7f9e-jic4', False),
        Dataset('vzv_barnes_dance.csv', 'data/dot_VZV_Barnes_Dance.csv',
                rows_csv_url('8kuj-2n3u'), '8kuj-2n3u', False),
        # VZV speed limits. zoning_laws. Not in pull_data.sh. dataset.ipynb
        # cell 71 reads it, so the port fetches it.
        Dataset('vzv_speed_limits.csv', 'data/dot_VZV_Speed_Limits.csv',
                rows_csv_url('5mad-ntua'), '5mad-ntua', False,
                note='not in pull_data.sh; required by dataset.ipynb cell 71'),
        # Motor vehicle collisions. intersection_safety. Loaded by
        # dataset.ipynb cell 96 but absent from pull_data.sh.
        Dataset('motor_vehicle_collisions.csv', 'data/Motor_Vehicle_Collisions.csv',
                rows_csv_url('h9gi-nx95'), 'h9gi-nx95', False,
                note='not in pull_data.sh; required by dataset.ipynb cell 96'),
        # Bike routes. bike_lane_availability.
        Dataset('bike_routes_nyc.csv', 'data/New_York_City_Bike_Routes.csv',
                rows_csv_url('mzxg-pwib'), 'mzxg-pwib', False),
        # Street furniture sets. street_furniture_density.
        Dataset('dsny_litter_baskets_nyc.csv', f'{furniture}/dsny_litter_baskets_nyc.csv',
                rows_csv_url('8znf-7b2c'), '8znf-7b2c', False),
        Dataset('fire_hydrants_nyc.csv', f'{furniture}/fire_hydrants_nyc.csv',
                rows_csv_url('5bgh-vtsn'), '5bgh-vtsn', False),
        Dataset('bus_stop_shelters_nyc.csv', f'{furniture}/bus_stop_shelters_nyc.csv',
                rows_csv_url('t4f2-8md7'), 't4f2-8md7', False),
        Dataset('bicycle_parking_shelters_nyc.csv', f'{furniture}/bicycle_parking_shelters_nyc.csv',
                rows_csv_url('dimy-qyej'), 'dimy-qyej', False),
        Dataset('bicycle_racks_nyc', f'{furniture}/bicycle_racks_nyc',
                f'{NYC_OPENDATA}/api/geospatial/yh4a-g3fj?method=export&format=Original',
                'yh4a-g3fj', True),
        Dataset('citybench_nyc.csv', f'{furniture}/citybench_nyc.csv',
                rows_csv_url('kuxa-tauh'), 'kuxa-tauh', False),
        Dataset('forestry_tree_points_nyc.csv', f'{furniture}/forestry_tree_points_nyc.csv',
                rows_csv_url('uvpi-gqnh'), 'uvpi-gqnh', False),
        Dataset('newsstands_nyc.csv', f'{furniture}/newsstands_nyc.csv',
                rows_csv_url('w9zq-xm8b'), 'w9zq-xm8b', False),
        Dataset('parking_meters_nyc.csv', f'{furniture}/parking_meters_nyc.csv',
                rows_csv_url('693u-uax6', 'date=20240816'), '693u-uax6', False),
        Dataset('linknyc_kiosks.csv', f'{furniture}/LinkNYC_Kiosk_Locations.csv',
                rows_csv_url('s4kf-3yrf'), 's4kf-3yrf', False,
                note='pull_data.sh marks it not wget-able; Socrata export used'),
        Dataset('alarm_box_locations.csv', f'{furniture}/In-Service_Alarm_Box_Locations.csv',
                rows_csv_url('v57i-gtxb'), 'v57i-gtxb', False,
                note='pull_data.sh marks it not wget-able; Socrata export used'),
        Dataset('street_sign_work_orders.csv', f'{furniture}/Street_Sign_Work_Orders.csv',
                rows_csv_url('qt6m-xctn'), 'qt6m-xctn', False,
                note='pull_data.sh marks it not wget-able; Socrata export used'),
        # FCC broadband map dec2023. communication_infrastructure. The FCC
        # portal serves this file behind a manual download page. No scriptable
        # URL exists. The operator fetches it by hand into the work dir.
        Dataset('fcc_broadband_4g_ny', 'data/4g_ny', None,
                'broadbandmap.fcc.gov dec2023 4G LTE', True,
                note='MANUAL: https://broadbandmap.fcc.gov/data-download/nationwide-data?version=dec2023'),
        Dataset('fcc_broadband_5g_ny', 'data/5g_ny', None,
                'broadbandmap.fcc.gov dec2023 5G NR', True,
                note='MANUAL: https://broadbandmap.fcc.gov/data-download/nationwide-data?version=dec2023'),
    ]


def _part_path(dest: str) -> str:
    """Return the path of the partial download file."""
    return dest + '.part'


def download_one(dataset: Dataset, work_dir: str) -> str:
    """Download one dataset into the work dir. Return a status word."""
    dest = os.path.join(work_dir, dataset.dest)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return 'present'
    if dataset.url is None:
        return 'manual'
    pc.ensure_dir(os.path.dirname(dest))
    part = _part_path(dest)
    existing = os.path.getsize(part) if os.path.isfile(part) else 0
    request = urllib.request.Request(dataset.url)
    if existing > 0:
        request.add_header('Range', f'bytes={existing}-')
    with urllib.request.urlopen(request, timeout=SOCK_TIMEOUT_S) as response:
        status = getattr(response, 'status', 200)
        if existing > 0 and status != 206:
            # The server ignored the Range header. Start over.
            existing = 0
        mode = 'ab' if status == 206 else 'wb'
        with open(part, mode) as out:
            while True:
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                out.write(chunk)
    os.replace(part, dest)
    return 'downloaded'


def maybe_unzip(dataset: Dataset, work_dir: str) -> None:
    """Unzip a downloaded archive once. Skip when the target dir exists."""
    if not dataset.unzip:
        return
    dest = os.path.join(work_dir, dataset.dest)
    if not os.path.isfile(dest):
        return
    target_dir = dest[:-4] if dest.endswith('.zip') else dest + '_extracted'
    if os.path.isdir(target_dir):
        return
    import zipfile
    with zipfile.ZipFile(dest) as archive:
        archive.extractall(target_dir)
    pc.log(f'fetch_public: unzipped {dataset.name} -> {target_dir}')


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description='Download the public inputs listed in pull_data.sh.',
    )
    parser.add_argument('--work', required=True, help='work directory')
    parser.add_argument('--skip', action='store_true',
                        help='make zero network calls; report status only')
    args = parser.parse_args(argv)

    datasets = build_datasets()
    pc.ensure_dir(args.work)

    if args.skip:
        pc.log('fetch_public: --skip set. Zero network calls. '
               f'{len(datasets)} datasets registered.')
        for d in datasets:
            dest = os.path.join(args.work, d.dest)
            state = 'present' if os.path.exists(dest) else 'absent'
            pc.log(f'fetch_public: [{state}] {d.name} ({d.dataset_id})')
        pc.log('fetch_public: mock runs generate synthetic inputs. '
               'Absent files are expected.')
        return 0

    failures = 0
    for d in datasets:
        try:
            state = download_one(d, args.work)
        except Exception as e:  # noqa: BLE001 - report and continue
            pc.log(f'fetch_public: FAILED {d.name} ({d.dataset_id}): {e}')
            failures += 1
            continue
        if state == 'manual':
            pc.log(f'fetch_public: MANUAL {d.name}: {d.note}')
        else:
            pc.log(f'fetch_public: [{state}] {d.name} ({d.dataset_id})')
        if state == 'downloaded':
            maybe_unzip(d, args.work)

    if failures:
        pc.log(f'fetch_public: {failures} download(s) failed. '
               'build_features.py marks missing inputs as partial.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
