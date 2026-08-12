// Thin wrapper around the pmtiles CLI (brew package "pmtiles").
// The verify step uses only CLI commands, so this module shells out.
// It does not use the npm pmtiles package. That package has no CLI.

import { execFile } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

export class ToolError extends Error {}

// Run the pmtiles CLI. Return { stdout, stderr, code }.
function runPmtiles(args, { binary = 'pmtiles', asBuffer = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const options = {
      maxBuffer: 256 * 1024 * 1024,
      timeout: timeoutMs,
      encoding: asBuffer ? 'buffer' : 'utf8',
    };
    execFile(binary, args, options, (error, stdout, stderr) => {
      const code = error === null ? 0 : (error.code ?? 1);
      resolve({ stdout, stderr, code });
    });
  });
}

// Fail with a clear message when the pmtiles binary is absent.
export async function requirePmtiles() {
  const probe = await runPmtiles(['version']);
  if (probe.code !== 0) {
    throw new ToolError(
      'The pmtiles CLI is not on PATH. Install it with "brew install pmtiles".',
    );
  }
}

// Read archive metadata as JSON (bounds, zooms, tilestats, layers).
export async function showMetadata(archivePath) {
  const { stdout, stderr, code } = await runPmtiles(['show', '--metadata', archivePath]);
  if (code !== 0) {
    throw new ToolError(
      `pmtiles show failed for ${archivePath}: ${String(stderr).trim() || 'no output'}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ToolError(`pmtiles show returned invalid JSON for ${archivePath}`);
  }
}

// Read one tile. Return the decoded MVT buffer, or null when the
// archive holds no tile at that position.
export async function readTile(archivePath, z, x, y) {
  const { stdout, code } = await runPmtiles(['tile', archivePath, String(z), String(x), String(y)], {
    asBuffer: true,
  });
  if (code !== 0 || stdout.length === 0) {
    return null;
  }
  // Tiles are gzip-compressed when the magic bytes match.
  if (stdout[0] === 0x1f && stdout[1] === 0x8b) {
    return gunzipSync(stdout);
  }
  return stdout;
}

// Run the structural archive check. Return { ok, output }.
export async function verifyStructure(archivePath) {
  const { stdout, stderr, code } = await runPmtiles(['verify', archivePath]);
  const output = `${stdout}${stderr}`.trim();
  return { ok: code === 0, output };
}

// Convert lon/lat bounds to the inclusive tile range at one zoom.
export function tileRangeForBounds(bounds, zoom) {
  const n = 2 ** zoom;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const xFromLon = (lon) => Math.floor(((lon + 180) / 360) * n);
  const yFromLat = (lat) => {
    const rad = (lat * Math.PI) / 180;
    const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    return Math.floor(y * n);
  };
  const x0 = clamp(xFromLon(minLon), 0, n - 1);
  const x1 = clamp(xFromLon(maxLon), 0, n - 1);
  // Larger latitude means smaller tile y.
  const y0 = clamp(yFromLat(maxLat), 0, n - 1);
  const y1 = clamp(yFromLat(minLat), 0, n - 1);
  return { x0, x1, y0, y1 };
}

// Parse the metadata "antimeridian_adjusted_bounds" string into
// [minLon, minLat, maxLon, maxLat].
export function boundsFromMetadata(metadata) {
  const raw = metadata.antimeridian_adjusted_bounds ?? metadata.bounds;
  if (typeof raw !== 'string' || raw.split(',').length !== 4) {
    throw new ToolError('Archive metadata has no usable bounds string');
  }
  return raw.split(',').map((part) => Number(part));
}

// Run an async worker over items with a concurrency limit.
export async function runPool(items, limit, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}
