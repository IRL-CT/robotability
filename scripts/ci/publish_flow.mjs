#!/usr/bin/env node
// Publish flow for the Robotability IO-bound CI (T6).
//
// This script is the testable core of .github/workflows/publish-snapshot.yml.
// It validates one snapshot directory and prepares its release. It performs
// no data transformation. The workflow creates the GitHub Release from the
// printed payload descriptor and commits the updated site manifest.
//
// Usage:
//   node scripts/ci/publish_flow.mjs <snapshot-dir> \
//     [--dry-run <target-manifest-path>] [--relax-row-count <n>]
//
// Flags:
//   --dry-run <path>      Write the updated site manifest to <path> instead
//                         of public/manifest.json. Tests pass a temp copy.
//   --relax-row-count <n> Pass through to the contract validator. Use this
//                         only for small-area test snapshots. Production runs
//                         use the full row count band and omit this flag.
//
// Gates, in order:
//   1. The snapshot dir must exist. manifest.json must parse.
//   2. partial must be false. Rejected with a named error. Defense in depth:
//      the validator enforces the same rule, but this gate runs first, so a
//      partial snapshot never reaches a release payload.
//   3. The manifest date must lie within 48h of now. Same rule as the
//      validator (manifest_date_fresh). Explicit early gate.
//   4. The contract validator exit code must be 0. This script gates on the
//      EXIT CODE only. It never parses validator stdout text.
// A rejected snapshot stops the flow before any release payload exists.
//
// On success the script prints one JSON object to stdout:
//   { ok, dry_run, snapshot_dir,
//     release: { tag, files: [{name, sha256, bytes}] },
//     entry: {...}, target_manifest }
// release.files lists exactly the three publishable artifacts.
// entry is the snapshot record appended to the site manifest.
//
// On rejection the script prints one line "ERROR: ..." to stderr and
// exits 1. No traceback, no stack dump.
//
// Exit codes: 0 = publishable, 1 = rejected, 2 = usage error.
// Dependencies: none (Node built-ins only).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VALIDATOR = path.join(ROOT, 'pipeline', 'contract', 'validate_snapshot.mjs');
const DEFAULT_TARGET_MANIFEST = path.join(ROOT, 'public', 'manifest.json');

// The release carries exactly these three artifacts. segments.geojson stays
// in the snapshot dir as a validator input; it is not a release asset.
const RELEASE_FILES = ['segments.pmtiles', 'features.parquet', 'manifest.json'];

// Snapshot artifacts are served by the site itself, from
// public/snapshots/<date>/. GitHub release assets carry no
// access-control-allow-origin header, so the browser cannot range-fetch the
// pmtiles from a release; same-origin sidesteps CORS entirely. The release
// remains the archive of record.
//
// The cost is that every snapshot adds about 76 MiB to git permanently, and
// GitHub Pages wants the built site under 1 GiB, so this holds roughly 13
// snapshots. Moving to an object store with CORS is the fix when that binds.
const SITE_SNAPSHOT_ROOT = '/snapshots';

// The census choropleth ships with the site under public/snapshots. It is a
// 2023 ACS layer, not snapshot output, and every snapshot points at this one
// copy.
const CENSUS_URL = `${SITE_SNAPSHOT_ROOT}/2023-08-01/census.pmtiles`;

// 48h. The same freshness rule as the contract validator.
const DATE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function usageError(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.stderr.write(
    'usage: node scripts/ci/publish_flow.mjs <snapshot-dir> ' +
      '[--dry-run <target-manifest-path>] [--relax-row-count <n>]\n',
  );
  process.exit(2);
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// parseUtcMidnight returns the UTC millisecond timestamp of midnight on the
// given YYYY-MM-DD date. It returns null for a malformed or impossible date.
// Same rule as pipeline/contract/validate_snapshot.mjs.
function parseUtcMidnight(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, mo, d] = s.split('-').map(Number);
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
  usageError('missing snapshot directory');
}
const snapshotDir = argv[0];
let dryRunPath = null;
let relaxRowCount = null;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--dry-run') {
    dryRunPath = argv[i + 1];
    if (!dryRunPath) usageError('--dry-run needs a target manifest path');
    i += 1;
  } else if (argv[i] === '--relax-row-count') {
    const raw = argv[i + 1];
    relaxRowCount = Number(raw);
    if (raw === undefined || !Number.isInteger(relaxRowCount) || relaxRowCount < 0) {
      usageError('--relax-row-count needs a non-negative integer');
    }
    i += 1;
  } else {
    usageError(`unknown argument: ${argv[i]}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 1: read the snapshot dir and its manifest.
// ---------------------------------------------------------------------------

let dirStat = null;
try {
  dirStat = fs.statSync(snapshotDir);
} catch {
  dirStat = null;
}
if (!dirStat || !dirStat.isDirectory()) {
  die(`snapshot dir not found: ${snapshotDir}`);
}

const snapshotManifestPath = path.join(snapshotDir, 'manifest.json');
let snapshotManifestRaw;
try {
  snapshotManifestRaw = fs.readFileSync(snapshotManifestPath, 'utf8');
} catch {
  die(`manifest.json not found in ${snapshotDir}`);
}
let manifest;
try {
  manifest = JSON.parse(snapshotManifestRaw);
} catch (e) {
  die(`manifest.json is not valid JSON: ${e.message}`);
}
if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  die('manifest.json must hold a JSON object');
}

// ---------------------------------------------------------------------------
// Gate 2: reject partial snapshots with a named error.
// Defense in depth. The validator enforces the same rule. This gate runs
// first, so the error always cites partial and no release payload is built.
// ---------------------------------------------------------------------------

if (manifest.partial !== false) {
  die(
    `rejected partial snapshot: manifest partial is ` +
      `${JSON.stringify(manifest.partial)}, must be false`,
  );
}

// ---------------------------------------------------------------------------
// Gate 3: reject a manifest date older than 48h.
// Same rule as the validator (manifest_date_fresh). Explicit early gate.
// ---------------------------------------------------------------------------

const dateMs = parseUtcMidnight(manifest.date);
if (dateMs === null) {
  die(`manifest date is malformed: ${JSON.stringify(manifest.date)}`);
}
if (Math.abs(Date.now() - dateMs) > DATE_MAX_AGE_MS) {
  die(
    `rejected stale snapshot: manifest date ${manifest.date} is more than ` +
      `48h away from now`,
  );
}

// ---------------------------------------------------------------------------
// Gate 4: run the contract validator. Gate on the EXIT CODE only.
// stdout is ignored on purpose: this script never parses validator text.
// stderr is inherited so a failed CI run still shows the failed rule names.
// ---------------------------------------------------------------------------

const validatorArgs = [VALIDATOR, snapshotDir];
if (relaxRowCount !== null) {
  validatorArgs.push('--relax-row-count', String(relaxRowCount));
}
const v = spawnSync(process.execPath, validatorArgs, {
  stdio: ['ignore', 'ignore', 'inherit'],
});
if (v.error) {
  die(`validator failed to start: ${v.error.message}`);
}
if (v.status !== 0) {
  die(`contract validation failed (validator exit code ${v.status})`);
}

// ---------------------------------------------------------------------------
// Release payload descriptor. Exactly the three publishable artifacts,
// each with an independent sha256 and byte count.
// ---------------------------------------------------------------------------

const tag = `snapshot-${manifest.date}`;
const releaseFiles = [];
for (const name of RELEASE_FILES) {
  const p = path.join(snapshotDir, name);
  let data;
  try {
    data = fs.readFileSync(p);
  } catch {
    die(`release file missing from snapshot dir: ${name}`);
  }
  releaseFiles.push({ name, sha256: sha256Hex(data), bytes: data.length });
}
const release = { tag, files: releaseFiles };

// ---------------------------------------------------------------------------
// Site manifest entry. Appended to the target manifest copy. The real
// workflow passes public/manifest.json. Tests pass a temp copy via
// --dry-run. A re-publish of the same tag replaces the existing entry,
// so the flow stays idempotent.
// ---------------------------------------------------------------------------

const targetManifestPath = dryRunPath ?? DEFAULT_TARGET_MANIFEST;
let siteManifest;
try {
  siteManifest = JSON.parse(fs.readFileSync(targetManifestPath, 'utf8'));
} catch (e) {
  die(`target manifest ${targetManifestPath} is missing or invalid: ${e.message}`);
}
if (typeof siteManifest !== 'object' || siteManifest === null || !Array.isArray(siteManifest.snapshots)) {
  die(`target manifest ${targetManifestPath} must hold a snapshots array`);
}

// GITHUB_REPOSITORY is set by GitHub Actions. Local runs keep the
// placeholder; the release itself is the source of truth for the assets.
const repo = process.env.GITHUB_REPOSITORY || 'OWNER/REPO';
const assetUrlTemplate = `https://github.com/${repo}/releases/download/${tag}/{file}`;
// Site-relative, so the map fetches the artifacts from its own origin and
// needs no CORS header. The publish workflow copies the artifacts into
// public/snapshots/<date>/ to match.
const siteAsset = (file) => `${SITE_SNAPSHOT_ROOT}/${manifest.date}/${file}`;
const entry = {
  date: manifest.date,
  tag,
  // The release stays the archive of record. It is not what the browser
  // reads: release assets serve no access-control-allow-origin header,
  // so a cross-origin range fetch of the pmtiles is blocked. Verified
  // against a published asset, with and without an Origin header, and
  // the workflow's own serving check reports the same thing.
  asset_url_template: assetUrlTemplate,
  // The map reads entry.urls, and it reads it same-origin from the site.
  // An entry carrying only the template parses to nothing:
  // MapCanvas.parseManifest requires a urls record and skips the entry
  // when it is absent, so a snapshot could publish, appear in this file,
  // and never reach the map. The drop is silent there by design — one
  // bad entry must not break the whole manifest — which is exactly why
  // the producer has to emit the shape the consumer reads.
  urls: {
    segments: siteAsset('segments.pmtiles'),
    parquet: siteAsset('features.parquet'),
    manifest: siteAsset('manifest.json'),
    // The census overlay is not snapshot data. It is a 2023 ACS layer
    // shared by every snapshot, so it keeps its own fixed path.
    census: CENSUS_URL,
  },
  row_count: manifest.row_count,
  score_min: manifest.score_min,
  score_max: manifest.score_max,
  // The map's colour breaks, one per ramp stop. Absent on snapshots
  // built before the cluster emitted them; the map falls back to the
  // fixed score domain then, which is how it always behaved.
  ...(Array.isArray(manifest.score_quantiles)
    ? { score_quantiles: manifest.score_quantiles }
    : {}),
  feature_stats: manifest.feature_stats,
  weights_sha256: manifest.weights_sha256,
  // The map reads this flag to pick the breakdown panel behavior.
  feature_vectors: manifest.feature_vectors,
};

const existingIndex = siteManifest.snapshots.findIndex(
  (s) => s !== null && typeof s === 'object' && s.tag === tag,
);
if (existingIndex !== -1) {
  siteManifest.snapshots[existingIndex] = entry;
} else {
  siteManifest.snapshots.push(entry);
}
try {
  fs.writeFileSync(targetManifestPath, JSON.stringify(siteManifest, null, 2) + '\n');
} catch (e) {
  die(`failed to write target manifest ${targetManifestPath}: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Success report. The workflow and the tests parse this JSON object.
// ---------------------------------------------------------------------------

const result = {
  ok: true,
  dry_run: dryRunPath !== null,
  snapshot_dir: snapshotDir,
  release,
  entry,
  target_manifest: targetManifestPath,
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);
