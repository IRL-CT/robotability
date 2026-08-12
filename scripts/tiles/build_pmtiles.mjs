#!/usr/bin/env node
// Build and verify the PMTiles artifacts for snapshot #0 (2023-08-01).
// Inputs: public/data/sidewalks.geojson (LineStrings, score only) and
// public/data/census.geojson (block polygons).
// Outputs: segments.pmtiles, census.pmtiles, manifest.json.
// The build needs two binaries from brew: tippecanoe and pmtiles.
// Usage:
//   node scripts/tiles/build_pmtiles.mjs            Full build.
//   node scripts/tiles/build_pmtiles.mjs --verify   Verify the built archives.
//   node scripts/tiles/build_pmtiles.mjs --preprocess --input IN --output OUT
// The --preprocess mode only enriches a sidewalks-style file with ids.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enrichSidewalks, countSidewalkFeatures, InputError } from './lib/geojson_stream.mjs';
import { preprocessCensus } from './lib/census_stream.mjs';
import { requirePmtiles, ToolError } from './lib/pmtiles_tool.mjs';
import { verifyArchive, formatBytes, VerifyError } from './lib/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SIDEWALKS_PATH = path.join(ROOT, 'public/data/sidewalks.geojson');
const CENSUS_PATH = path.join(ROOT, 'public/data/census.geojson');
const WEIGHTS_PATH = path.join(ROOT, 'robotability-nyc/survey_processing/feature_weights.csv');
const PIPELINE_DIR = path.join(ROOT, 'pipeline/snapshot0');
const SNAPSHOT_DIR = path.join(ROOT, 'public/snapshots/2023-08-01');
const PUBLIC_MANIFEST = path.join(ROOT, 'public/manifest.json');
const SNAPSHOT_DATE = '2023-08-01';
const MAX_ZOOM = 14;
const SEGMENTS_GATE_BYTES = 40 * 1024 * 1024;
const CENSUS_GATE_BYTES = 2 * 1024 * 1024;
// Size-gate setting, recorded as the plan requires. Below zoom 9 all
// of NYC fits in one tile that must carry all 464968 segments. Those
// zooms cost 8.5 MiB and are too dense to render. With the minimum
// segment zoom set to 9, --drop-rate=0 keeps every segment at every
// zoom the map renders (9-14), and the archive passes the 40 MiB gate.
// Simplification alone cannot shrink the archive: every segment is a
// two-point line, so there is nothing to simplify.
const SEGMENTS_MIN_ZOOM = 9;
// Below zoom 4 the tile grid cell is larger than New York City, so
// every boundary collapses during quantization and no tile exists.
// The header minimum zoom must match the first zoom that has tiles,
// or "pmtiles verify" rejects the archive.
const CENSUS_MIN_ZOOM = 4;
// tippecanoe must finish inside this budget. A hung build must not
// block forever.
const TIPPECANOE_TIMEOUT_MS = 20 * 60 * 1000;

const log = (message) => console.log(`[build_pmtiles] ${message}`);

function requireTippecanoe() {
  const probe = spawnSync('tippecanoe', ['-v'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new ToolError('tippecanoe is not on PATH. Install it with "brew install tippecanoe".');
  }
}

// Run tippecanoe with live progress on stderr. Enforce the time budget.
function runTippecanoe(args, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    log(`${label}: tippecanoe ${args.join(' ')}`);
    const child = spawn('tippecanoe', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      reject(new ToolError(
        `${label}: tippecanoe still ran after ${seconds}s (budget ${TIPPECANOE_TIMEOUT_MS / 1000}s). ` +
        'Killed it. The partial output file may exist. Nothing was published.',
      ));
    }, TIPPECANOE_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code !== 0) {
        reject(new ToolError(`${label}: tippecanoe exited with code ${code} after ${seconds}s`));
        return;
      }
      log(`${label}: tippecanoe finished in ${seconds}s`);
      resolve(seconds);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ToolError(`${label}: failed to start tippecanoe: ${err.message}`));
    });
  });
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Build one archive, then enforce its size gate. On a gate failure,
// retry once with stronger simplification and record the setting.
async function buildArchive({ label, input, output, layer, keepProps, gateBytes, minZoom }) {
  const baseArgs = [
    `--output=${output}`, '--force', `--layer=${layer}`,
    `--minimum-zoom=${minZoom}`, `--maximum-zoom=${MAX_ZOOM}`, '--drop-rate=0',
    // Below zoom 9 all of NYC fits in one tile, which passes the
    // default 200000-feature tile limit. The byte cap is raised for
    // the same reason: --drop-rate=0 forbids feature drops, so
    // tippecanoe must not shrink tiles by dropping. Every segment
    // stays in every zoom.
    '--no-feature-limit', '--maximum-tile-bytes=20000000',
    // Keep only these attributes. tippecanoe drops every other one.
    ...keepProps.flatMap((prop) => [`--include=${prop}`]),
  ];
  const attempts = [
    { extra: ['--simplification=2', '--simplify-only-low-zooms'], note: '--simplification=2 --simplify-only-low-zooms' },
    { extra: ['--simplification=10'], note: '--simplification=10' },
  ];
  for (const attempt of attempts) {
    await runTippecanoe([...baseArgs, ...attempt.extra, input], label);
    const size = (await fs.promises.stat(output)).size;
    if (size <= gateBytes) {
      log(`${label}: size gate PASS (${formatBytes(size)} <= ${formatBytes(gateBytes)}) with ${attempt.note}`);
      return { size, simplification: attempt.note };
    }
    log(`${label}: size gate FAIL (${formatBytes(size)} > ${formatBytes(gateBytes)}) with ${attempt.note}; retrying with stronger simplification`);
  }
  throw new ToolError(
    `${label}: the size gate still fails after the strongest simplification. ` +
    'STOP: the oversized artifact is not published. Report the size and choose a setting.',
  );
}

async function buildAll() {
  requireTippecanoe();
  await requirePmtiles();
  await fs.promises.mkdir(PIPELINE_DIR, { recursive: true });
  await fs.promises.mkdir(SNAPSHOT_DIR, { recursive: true });

  log('Step 1: enrich sidewalks.geojson with stable ids (streaming, line by line)');
  const enrichedPath = path.join(PIPELINE_DIR, 'segments.geojson');
  const stats = await enrichSidewalks(SIDEWALKS_PATH, enrichedPath);
  log(`Step 1 done: ${stats.count} segments, score range [${stats.scoreMin}, ${stats.scoreMax}], ` +
    `${stats.pointCount} sub-grid segments encoded as points`);

  log('Step 2: build segments.pmtiles');
  const segmentsOut = path.join(PIPELINE_DIR, 'segments.pmtiles');
  const segments = await buildArchive({
    label: 'segments', input: enrichedPath, output: segmentsOut, layer: 'segments',
    keepProps: ['id', 'score'], gateBytes: SEGMENTS_GATE_BYTES, minZoom: SEGMENTS_MIN_ZOOM,
  });

  log('Step 3: convert census.geojson polygons to boundary lines');
  const censusLinesPath = path.join(PIPELINE_DIR, 'census_boundaries.geojson');
  const censusStats = await preprocessCensus(CENSUS_PATH, censusLinesPath);
  log(`Step 3 done: ${censusStats.count} census boundary features`);

  log('Step 4: build census.pmtiles');
  const censusOut = path.join(PIPELINE_DIR, 'census.pmtiles');
  const census = await buildArchive({
    label: 'census', input: censusLinesPath, output: censusOut, layer: 'census',
    keepProps: ['GEOID', 'BoroName'], gateBytes: CENSUS_GATE_BYTES, minZoom: CENSUS_MIN_ZOOM,
  });

  log('Step 5: write manifest.json');
  const weightsSha = await sha256OfFile(WEIGHTS_PATH);
  const files = [];
  for (const [name, filePath] of [['segments.pmtiles', segmentsOut], ['census.pmtiles', censusOut]]) {
    files.push({
      name,
      sha256: await sha256OfFile(filePath),
      bytes: (await fs.promises.stat(filePath)).size,
    });
  }
  const manifest = {
    date: SNAPSHOT_DATE,
    row_count: stats.count,
    score_min: stats.scoreMin,
    score_max: stats.scoreMax,
    feature_stats: null,
    weights_sha256: weightsSha,
    partial: false,
    feature_vectors: false,
    files,
  };
  await fs.promises.writeFile(path.join(PIPELINE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  log('Step 6: copy artifacts to public/snapshots/' + SNAPSHOT_DATE);
  for (const name of ['segments.pmtiles', 'census.pmtiles', 'manifest.json']) {
    await fs.promises.copyFile(path.join(PIPELINE_DIR, name), path.join(SNAPSHOT_DIR, name));
  }

  log('Step 7: write public/manifest.json');
  const publicManifest = {
    snapshots: [{
      date: SNAPSHOT_DATE,
      tag: 'baseline',
      feature_vectors: false,
      urls: {
        tiles: `/${path.relative(path.join(ROOT, 'public'), path.join(SNAPSHOT_DIR, 'segments.pmtiles'))}`,
        census: `/${path.relative(path.join(ROOT, 'public'), path.join(SNAPSHOT_DIR, 'census.pmtiles'))}`,
        manifest: `/${path.relative(path.join(ROOT, 'public'), path.join(SNAPSHOT_DIR, 'manifest.json'))}`,
      },
    }],
  };
  await fs.promises.writeFile(PUBLIC_MANIFEST, `${JSON.stringify(publicManifest, null, 2)}\n`);

  log('SIZE REPORT');
  log(`  segments.pmtiles: ${formatBytes(segments.size)} (gate ${formatBytes(SEGMENTS_GATE_BYTES)}) [${segments.simplification}]`);
  log(`  census.pmtiles:   ${formatBytes(census.size)} (gate ${formatBytes(CENSUS_GATE_BYTES)}) [${census.simplification}]`);
  log('Build complete. Run "node scripts/tiles/build_pmtiles.mjs --verify" to check the archives.');
}

async function verifyAll() {
  await requirePmtiles();
  log('Counting input features in public/data/sidewalks.geojson (streaming)');
  const segmentsExpected = await countSidewalkFeatures(SIDEWALKS_PATH);
  log(`Input segment count: ${segmentsExpected}`);
  const censusParsed = JSON.parse(await fs.promises.readFile(CENSUS_PATH, 'utf8'));
  const censusExpected = censusParsed.features.length;
  log(`Input census count: ${censusExpected}`);

  const reports = [];
  reports.push(await verifyArchive({
    name: 'segments.pmtiles', archivePath: path.join(SNAPSHOT_DIR, 'segments.pmtiles'),
    expectedCount: segmentsExpected, idProp: 'id', idKind: 'number',
    requiredNumeric: ['score'], requiredString: [], gateBytes: SEGMENTS_GATE_BYTES,
  }));
  reports.push(await verifyArchive({
    name: 'census.pmtiles', archivePath: path.join(SNAPSHOT_DIR, 'census.pmtiles'),
    expectedCount: censusExpected, idProp: 'GEOID', idKind: 'string',
    requiredNumeric: [], requiredString: ['BoroName'], gateBytes: CENSUS_GATE_BYTES,
  }));

  log('VERIFY PASS — SIZE REPORT');
  for (const r of reports) {
    log(`  ${r.name}: ${formatBytes(r.bytes)} | features: ${r.uniqueCount} unique (expected ${r.expectedCount}) | ` +
      `${r.featureInstances} tile instances at zoom ${r.zoom} across ${r.tilesInBounds} tiles (${r.emptyTiles} empty)`);
  }
}

// Verify one archive against an explicit expected count. Used for the
// failing-first proof and for debugging.
async function verifyOne({ archive, expected, idProp, idKind }) {
  await requirePmtiles();
  const report = await verifyArchive({
    name: path.basename(archive), archivePath: archive,
    expectedCount: expected, idProp, idKind,
    requiredNumeric: idKind === 'number' && idProp === 'id' ? ['score'] : [],
    requiredString: [], gateBytes: Number.MAX_SAFE_INTEGER,
  });
  log(`VERIFY PASS: ${report.name} has ${report.uniqueCount} features (${formatBytes(report.bytes)})`);
}

function parseArgs(argv) {
  const args = { mode: 'build' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') args.mode = 'verify';
    else if (arg === '--preprocess') args.mode = 'preprocess';
    else if (arg === '--input') args.input = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--archive') args.archive = argv[++i];
    else if (arg === '--expected') args.expected = Number(argv[++i]);
    else if (arg === '--id-prop') args.idProp = argv[++i];
    else if (arg === '--id-kind') args.idKind = argv[++i];
    else throw new InputError(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'preprocess') {
    if (!args.input || !args.output) {
      throw new InputError('--preprocess needs --input and --output');
    }
    const stats = await enrichSidewalks(args.input, args.output);
    log(`Preprocessed ${stats.count} features, score range [${stats.scoreMin}, ${stats.scoreMax}]`);
    return;
  }
  if (args.mode === 'verify') {
    if (args.archive) {
      if (!Number.isFinite(args.expected)) {
        throw new InputError('--verify --archive needs --expected <count>');
      }
      await verifyOne({ archive: args.archive, expected: args.expected, idProp: args.idProp ?? 'id', idKind: args.idKind ?? 'number' });
      return;
    }
    await verifyAll();
    return;
  }
  await buildAll();
}

main().catch((err) => {
  if (err instanceof InputError || err instanceof ToolError || err instanceof VerifyError) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  throw err;
});
