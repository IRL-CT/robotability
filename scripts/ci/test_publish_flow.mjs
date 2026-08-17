#!/usr/bin/env node
// Acceptance tests for scripts/ci/publish_flow.mjs (T6).
//
// Three assertions:
//   1. Valid fixture dir. The publish flow exits 0. The release payload
//      lists exactly three files. The temp target manifest gains exactly
//      one appended entry with the correct date and tag.
//   2. Partial fixture. The publish flow exits 1 before any release
//      payload exists. The error cites partial.
//   3. Stale fixture (date older than 48h). The publish flow exits 1.
//      The error cites date.
//
// The tests gate on exit codes and file bytes only. They never inspect
// printed validator text. This matches the publish flow contract.
//
// Fixture freshness: the committed valid fixture carries its generation
// date. A manifest date goes stale after 48h. So assertion 1 copies the
// fixture to a temp dir and refreshes the date first. manifest.json carries
// no self-hash, so the refresh keeps every file hash valid. Assertions 2
// and 3 need no refresh: the partial gate fires before the date gate, and
// the stale fixture must stay stale.
//
// Usage: node scripts/ci/test_publish_flow.mjs
// Exit code: 0 = all assertions pass, 1 = at least one fails.
// Dependencies: none (Node built-ins only).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PUBLISH_FLOW = path.join(HERE, 'publish_flow.mjs');
const FIXTURES = path.join(HERE, 'fixtures');
const SITE_MANIFEST = path.join(ROOT, 'public', 'manifest.json');

// The mock pipeline fixture holds 144 segments. The publish flow passes
// this count to the validator as the relaxed row count band.
const ROW_COUNT = 144;

const RELEASE_FILE_ORDER = 'segments.pmtiles,features.parquet,manifest.json';

let tmpRoot = null;
let failures = 0;

function report(num, label, ok, details) {
  if (ok) {
    console.log(`PASS ${num} - ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${num} - ${label}`);
  }
  if (details) console.log(details);
}

// todayUtcString returns YYYY-MM-DD for the current UTC date.
function todayUtcString() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// stageFixture copies one committed fixture into the temp root. It returns
// the copy path. With refreshDate=true it rewrites the manifest date to
// today so the 48h freshness gate passes.
function stageFixture(name, refreshDate) {
  const src = path.join(FIXTURES, name);
  const dst = path.join(tmpRoot, name);
  fs.cpSync(src, dst, { recursive: true });
  if (refreshDate) {
    const p = path.join(dst, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.date = todayUtcString();
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  }
  return dst;
}

// freshTargetManifest copies public/manifest.json into the temp root.
// The publish flow appends its entry to this copy, never to the real file.
function freshTargetManifest(label) {
  const p = path.join(tmpRoot, `target-${label}.json`);
  fs.copyFileSync(SITE_MANIFEST, p);
  return p;
}

function runPublishFlow(args) {
  return spawnSync(process.execPath, [PUBLISH_FLOW, ...args], {
    encoding: 'utf8',
  });
}

// Assertion 1: the valid fixture publishes.
function assertion1() {
  const label =
    'valid fixture: exit 0, release payload lists exactly 3 files, ' +
    'temp manifest gains exactly one entry with correct date and tag';
  const dir = stageFixture('valid-snapshot', true);
  const fixtureManifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
  );
  const target = freshTargetManifest('valid');
  const before = JSON.parse(fs.readFileSync(target, 'utf8'));
  const r = runPublishFlow([
    dir,
    '--dry-run',
    target,
    '--relax-row-count',
    String(ROW_COUNT),
  ]);
  if (r.status !== 0) {
    report(1, label, false, `  exit ${r.status}\n  stderr: ${r.stderr.trim()}`);
    return;
  }
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch (e) {
    report(1, label, false, `  stdout is not JSON: ${e.message}\n  stdout: ${r.stdout}`);
    return;
  }
  const files = (out.release && out.release.files) || [];
  const filesOk =
    files.length === 3 &&
    files.map((f) => f.name).join(',') === RELEASE_FILE_ORDER &&
    files.every(
      (f) =>
        typeof f.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(f.sha256) &&
        Number.isInteger(f.bytes) &&
        f.bytes > 0,
    );
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  const appended = after.snapshots.length - before.snapshots.length;
  // Find the entry by tag rather than assuming it was appended last.
  // publish_flow upserts: a re-publish of the same tag replaces the
  // existing entry so the flow stays idempotent. The fixture's date is
  // refreshed to today, so when the site manifest already carries a
  // snapshot published today the correct result is a replacement and no
  // growth. Asserting a growth of exactly 1 made this test fail on any
  // day a snapshot had already been published, which says nothing about
  // publish_flow.
  const tag = `snapshot-${fixtureManifest.date}`;
  const existedBefore = before.snapshots.some((s) => s && s.tag === tag);
  const last = after.snapshots.find((s) => s && s.tag === tag);
  const entryOk =
    appended === (existedBefore ? 0 : 1) &&
    last !== undefined &&
    last.date === fixtureManifest.date &&
    last.tag === tag;
  // The map reads entry.urls and drops any entry without it, silently.
  // An entry that carried only asset_url_template published a snapshot
  // that never reached the map, so assert the shape the consumer needs:
  // a urls record with site-relative segments and parquet paths under
  // the snapshot's own date.
  const urls = last && last.urls;
  const expectedPrefix = `/snapshots/${fixtureManifest.date}/`;
  const urlsOk =
    urls !== null &&
    typeof urls === 'object' &&
    urls.segments === `${expectedPrefix}segments.pmtiles` &&
    urls.parquet === `${expectedPrefix}features.parquet` &&
    typeof urls.census === 'string' &&
    urls.census.endsWith('.pmtiles');
  const ok = filesOk && entryOk && urlsOk;
  report(
    1,
    label,
    ok,
    `  exit ${r.status}, release files ok: ${filesOk}, ` +
      `appended: ${appended} (tag existed before: ${existedBefore}), ` +
      `date: ${last && last.date}, tag: ${last && last.tag}, ` +
      `urls ok: ${urlsOk} (segments: ${urls && urls.segments})`,
  );
}

// Assertion 2: the partial fixture is rejected before any release payload.
function assertion2() {
  const label =
    'partial fixture: exit 1 before any release payload, error cites partial';
  const dir = stageFixture('partial-snapshot', false);
  const target = freshTargetManifest('partial');
  const beforeBytes = fs.readFileSync(target);
  const r = runPublishFlow([
    dir,
    '--dry-run',
    target,
    '--relax-row-count',
    String(ROW_COUNT),
  ]);
  const afterBytes = fs.readFileSync(target);
  // Proof of "before any release payload": the target manifest bytes are
  // unchanged and stdout carries no release descriptor.
  const targetUnchanged = beforeBytes.equals(afterBytes);
  const noPayload = !r.stdout.includes('"release"');
  const citesPartial = /partial/i.test(r.stderr);
  const ok = r.status === 1 && targetUnchanged && noPayload && citesPartial;
  report(
    2,
    label,
    ok,
    `  exit ${r.status}, target manifest unchanged: ${targetUnchanged}, ` +
      `no payload on stdout: ${noPayload}, cites partial: ${citesPartial}\n` +
      `  stderr: ${r.stderr.trim()}`,
  );
}

// Assertion 3: the stale fixture is rejected and the error cites the date.
function assertion3() {
  const label = 'stale fixture: exit 1, error cites date';
  const dir = stageFixture('stale-snapshot', false);
  const target = freshTargetManifest('stale');
  const r = runPublishFlow([
    dir,
    '--dry-run',
    target,
    '--relax-row-count',
    String(ROW_COUNT),
  ]);
  const citesDate = /date/i.test(r.stderr);
  const ok = r.status === 1 && citesDate;
  report(
    3,
    label,
    ok,
    `  exit ${r.status}, cites date: ${citesDate}\n  stderr: ${r.stderr.trim()}`,
  );
}

function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'robotability-t6-test-'));
  try {
    assertion1();
    assertion2();
    assertion3();
  } finally {
    // The test must leave no temp dirs behind.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(
    failures === 0 ? 'RESULT: 3/3 PASS' : `RESULT: ${3 - failures}/3 PASS`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
