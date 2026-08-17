"""Hand a validated snapshot to CI.

Stage 6, and the last mile to the site. emit_artifacts.py writes and
validates a snapshot but leaves it on lab storage; nothing on the cluster
told CI it was there. The RUNBOOK described trigger_mode as a config
setting and then described the trigger itself as two manual operator
steps, so the setting read as automation that did not exist. This module
implements it.

Modes, from the trigger_mode key of the cluster config:

    none      Do nothing. Report the artifacts and stop. A scheduled CI
              job polls the snapshots-incoming branch every 6 hours, so
              this only publishes if something else pushes that branch.
    dispatch  Call the GitHub repository_dispatch API with event type
              snapshot-ready. Needs a token, see below.
    push      Commit the artifacts to the orphan branch
              snapshots-incoming and push. Needs an SSH deploy key with
              write access on the cluster node.

Credentials never live in the config. dispatch reads the token from
GITHUB_TOKEN, and push relies on the node's configured SSH key. A mode
whose credential is missing fails loudly rather than skipping quietly: a
snapshot that silently never publishes is the failure this stage exists
to prevent.

Usage:
    python3 publish_snapshot.py --out <snapshot dir> [--config <yaml>]
    python3 publish_snapshot.py --out <dir> --dry-run

Exit codes: 0 published or nothing to do, 1 the trigger failed, 2 bad
usage.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from typing import List, Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline_common as pc  # noqa: E402

SNAPSHOT_FILES = ('segments.geojson', 'segments.pmtiles',
                  'features.parquet', 'manifest.json')
INCOMING_BRANCH = 'snapshots-incoming'
DISPATCH_EVENT = 'snapshot-ready'
VALID_MODES = ('none', 'dispatch', 'push')
HTTP_TIMEOUT_S = 60


def check_artifacts(out_dir: str) -> List[str]:
    """Return the four artifact paths. Stop when any is missing."""
    paths = []
    for name in SNAPSHOT_FILES:
        path = os.path.join(out_dir, name)
        if not os.path.isfile(path):
            pc.die(f'snapshot is missing {name}. Run emit_artifacts.py '
                   f'first and let its validator pass.')
        paths.append(path)
    return paths


def read_date(out_dir: str) -> str:
    """Read the snapshot date out of the manifest."""
    with open(os.path.join(out_dir, 'manifest.json'), encoding='utf-8') as f:
        return str(json.load(f).get('date', 'unknown'))


def trigger_dispatch(repo: str, date: str, dry_run: bool) -> None:
    """Fire repository_dispatch so the publish workflow runs now."""
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    if not token:
        pc.die('trigger_mode is dispatch but GITHUB_TOKEN is not set. '
               'Export a token with repo scope on the cluster node, or '
               'set trigger_mode to push or none.')
    url = f'https://api.github.com/repos/{repo}/dispatches'
    body = json.dumps({
        'event_type': DISPATCH_EVENT,
        'client_payload': {'date': date, 'source': 'cluster'},
    }).encode('utf-8')
    pc.log(f'publish_snapshot: POST {url} event={DISPATCH_EVENT} date={date}')
    if dry_run:
        pc.log('publish_snapshot: dry run, no request sent')
        return
    request = urllib.request.Request(url, data=body, method='POST')
    request.add_header('Authorization', f'Bearer {token}')
    request.add_header('Accept', 'application/vnd.github+json')
    request.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as resp:
            status = getattr(resp, 'status', 0)
    except urllib.error.HTTPError as err:
        pc.die(f'repository_dispatch failed: HTTP {err.code} {err.reason}. '
               f'Check that GITHUB_TOKEN has repo scope on {repo}.')
    except urllib.error.URLError as err:
        pc.die(f'repository_dispatch could not reach GitHub: {err.reason}')
    if status != 204:
        pc.die(f'repository_dispatch returned HTTP {status}, expected 204')
    pc.log('publish_snapshot: dispatch accepted (204). CI runs now.')


def _git(args: Sequence[str], cwd: str, dry_run: bool) -> str:
    """Run one git command in cwd. Stop on failure."""
    pc.log(f'publish_snapshot: git {" ".join(args)}')
    if dry_run:
        return ''
    proc = subprocess.run(['git', *args], cwd=cwd, capture_output=True,
                          text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        pc.die(f'git {args[0]} failed with code {proc.returncode}')
    return proc.stdout.strip()


def trigger_push(out_dir: str, remote: str, date: str, dry_run: bool) -> None:
    """Push the four artifacts to the orphan snapshots-incoming branch.

    The branch holds the artifacts at its root and keeps no history from
    the code branches, which is why it is orphaned. Each publish replaces
    its single commit, so the branch never accumulates the large binary
    files. The scheduled CI job polls this branch head.
    """
    import tempfile

    with tempfile.TemporaryDirectory(prefix='snapshot-push-') as work:
        _git(['init', '--quiet', '--initial-branch', INCOMING_BRANCH],
             work, dry_run)
        _git(['remote', 'add', 'origin', remote], work, dry_run)
        if not dry_run:
            import shutil
            for name in SNAPSHOT_FILES:
                shutil.copy2(os.path.join(out_dir, name),
                             os.path.join(work, name))
        _git(['add', *SNAPSHOT_FILES], work, dry_run)
        _git(['-c', 'user.name=robotability-cluster',
              '-c', 'user.email=cluster@localhost',
              'commit', '--quiet', '-m', f'snapshot {date}'], work, dry_run)
        # Force push: the branch carries one commit and is replaced whole.
        _git(['push', '--force', 'origin', INCOMING_BRANCH], work, dry_run)
    pc.log(f'publish_snapshot: pushed {INCOMING_BRANCH}. '
           f'CI picks it up on its next poll, within 6 hours.')


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description='Hand a validated snapshot to CI.')
    parser.add_argument('--out', required=True, help='snapshot directory')
    parser.add_argument('--config', default=None, help='cluster config yaml')
    parser.add_argument('--dry-run', action='store_true',
                        help='report what would happen and send nothing')
    args = parser.parse_args(argv)

    if not os.path.isdir(args.out):
        pc.die(f'snapshot directory not found: {args.out}')
    check_artifacts(args.out)
    date = read_date(args.out)

    config = pc.load_config(args.config) if args.config else {}
    mode = str(config.get('trigger_mode', 'none')).strip().lower()
    if mode not in VALID_MODES:
        pc.die(f'trigger_mode must be one of {", ".join(VALID_MODES)}, '
               f'got: {mode}')

    pc.log(f'publish_snapshot: snapshot {date} in {args.out}')
    pc.log(f'publish_snapshot: trigger_mode {mode}')

    if mode == 'none':
        pc.log('publish_snapshot: nothing to trigger. Publish by hand, or '
               'set trigger_mode to dispatch or push. See RUNBOOK section 7.')
        return 0
    if mode == 'dispatch':
        repo = str(config.get('github_repo', '')).strip()
        if not repo:
            pc.die('trigger_mode is dispatch but github_repo is not set in '
                   'the config. Use the owner/name form.')
        trigger_dispatch(repo, date, args.dry_run)
        return 0
    remote = str(config.get('git_remote', '')).strip()
    if not remote:
        pc.die('trigger_mode is push but git_remote is not set in the '
               'config. Use the SSH form, git@github.com:owner/name.git.')
    trigger_push(args.out, remote, date, args.dry_run)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
