"""Shared helpers for the cluster pipeline scripts.

All text uses ASD-STE100 Simplified Technical English.
"""

import hashlib
import os
import sys
from typing import Dict, Optional, Tuple

# MOCK_SEED fixes the deterministic mock data. The same seed and the same
# bounding box always produce the same artifacts. Record any change.
MOCK_SEED = 20260812

# WGS84 longitude/latitude. The notebooks call it WGS.
CRS_WGS = 'EPSG:4326'
# NYC projected CRS in feet. The notebooks call it PROJ.
CRS_PROJ = 'EPSG:2263'

# The contract pins the sha256 of the original feature_weights.csv.
# Source: pipeline/contract/validate_snapshot.mjs (WEIGHTS_SHA256).
PINNED_WEIGHTS_SHA256 = (
    '6278272614fe5e012874a2804e9e576f21f5a9cd4b952eb9296ccb6932965beb'
)


def repo_root() -> str:
    """Return the absolute path of the repository root."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def cluster_dir() -> str:
    """Return the absolute path of pipeline/cluster."""
    return os.path.dirname(os.path.abspath(__file__))


def weights_csv_path() -> str:
    """Return the path of the vendored weights file."""
    return os.path.join(cluster_dir(), 'weights.csv')


def validator_path() -> str:
    """Return the path of the contract validator script."""
    return os.path.join(repo_root(), 'pipeline', 'contract', 'validate_snapshot.mjs')


def log(message: str) -> None:
    """Print one status line. Flush immediately so cron logs stay ordered."""
    print(message, flush=True)


def die(message: str, code: int = 1) -> None:
    """Print an error and stop the process. Do not raise a traceback."""
    sys.stderr.write(f'ERROR: {message}\n')
    sys.exit(code)


def ensure_dir(path: str) -> None:
    """Create the directory and its parents when absent."""
    os.makedirs(path, exist_ok=True)


def sha256_file(path: str) -> str:
    """Return the sha256 hex digest of one file."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def weights_body_bytes(path: str) -> bytes:
    """Return the vendored weights bytes without provenance comment lines.

    The vendored file starts with '#' comment lines. The original CSV bytes
    follow them unchanged. The contract hash covers the original bytes only.
    """
    with open(path, 'rb') as f:
        data = f.read()
    lines = data.split(b'\n')
    kept = [line for line in lines if not line.startswith(b'#')]
    return b'\n'.join(kept)


def parse_bbox(text: str) -> Tuple[float, float, float, float]:
    """Parse 'minlon,minlat,maxlon,maxlat'. Stop on a malformed value."""
    parts = text.split(',')
    if len(parts) != 4:
        die(f'bbox must have four comma-separated numbers, got: {text!r}', 2)
    try:
        minlon, minlat, maxlon, maxlat = (float(p) for p in parts)
    except ValueError:
        die(f'bbox holds a value that is not a number: {text!r}', 2)
    if not (-180.0 <= minlon <= 180.0 and -180.0 <= maxlon <= 180.0):
        die(f'bbox longitude out of range: {text!r}', 2)
    if not (-90.0 <= minlat <= 90.0 and -90.0 <= maxlat <= 90.0):
        die(f'bbox latitude out of range: {text!r}', 2)
    if minlon >= maxlon or minlat >= maxlat:
        die(f'bbox min must be smaller than max: {text!r}', 2)
    return minlon, minlat, maxlon, maxlat


def load_config(path: Optional[str]) -> Dict:
    """Read the YAML config file. Return an empty dict when path is None."""
    if path is None:
        return {}
    try:
        import yaml
    except ImportError:
        die('the config file needs PyYAML. Install it or drop --config.', 1)
    if not os.path.isfile(path):
        die(f'config file not found: {path}', 2)
    with open(path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)
    if data is None:
        return {}
    if not isinstance(data, dict):
        die(f'config file must hold a mapping: {path}', 2)
    return data
