// Verification logic for built PMTiles archives.
// The scan opens the archive with the pmtiles CLI, reads every tile
// at the maximum zoom, and decodes the MVT bytes. It never trusts the
// tippecanoe exit code. A feature clipped at a tile border appears in
// two tiles with the same id, so the count uses unique ids.

import fs from 'node:fs';
import {
  showMetadata,
  readTile,
  verifyStructure,
  tileRangeForBounds,
  boundsFromMetadata,
  runPool,
} from './pmtiles_tool.mjs';
import { decodeTile, featureProperties } from './mvt.mjs';

export class VerifyError extends Error {}

export function formatBytes(bytes) {
  return `${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`;
}

// Scan one archive at its maximum zoom. Collect unique ids and check
// the property types of every feature instance.
export async function scanArchive(archivePath, { idProp, idKind, requiredNumeric = [], requiredString = [] }) {
  const metadata = await showMetadata(archivePath);
  const layerMeta = metadata.vector_layers?.[0];
  if (!layerMeta) {
    throw new VerifyError(`${archivePath}: metadata lists no vector layers`);
  }
  const zoom = layerMeta.maxzoom;
  const bounds = boundsFromMetadata(metadata);
  const range = tileRangeForBounds(bounds, zoom);
  const tiles = [];
  for (let x = range.x0; x <= range.x1; x += 1) {
    for (let y = range.y0; y <= range.y1; y += 1) {
      tiles.push([x, y]);
    }
  }
  const uniqueIds = new Set();
  const state = { featureInstances: 0, emptyTiles: 0, violations: [] };
  const fail = (message) => {
    if (state.violations.length < 20) {
      state.violations.push(message);
    }
  };
  const checkValue = (props, name, kind, where) => {
    const value = props[name];
    if (kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      fail(`${where}: property "${name}" is not a finite number (got ${JSON.stringify(value)})`);
      return false;
    }
    if (kind === 'string' && typeof value !== 'string') {
      fail(`${where}: property "${name}" is not a string (got ${JSON.stringify(value)})`);
      return false;
    }
    return true;
  };
  let scanned = 0;
  await runPool(tiles, 8, async ([x, y]) => {
    const buf = await readTile(archivePath, zoom, x, y);
    scanned += 1;
    if (scanned % 200 === 0) {
      process.stderr.write(`  scanned ${scanned}/${tiles.length} tiles at zoom ${zoom}\n`);
    }
    if (buf === null) {
      state.emptyTiles += 1;
      return;
    }
    for (const layer of decodeTile(buf)) {
      for (const feature of layer.features) {
        state.featureInstances += 1;
        const props = featureProperties(layer, feature);
        const where = `tile ${zoom}/${x}/${y}`;
        let idOk = false;
        if (idKind === 'number') {
          idOk = checkValue(props, idProp, 'number', where);
        } else {
          idOk = checkValue(props, idProp, 'string', where);
        }
        if (idOk) {
          uniqueIds.add(props[idProp]);
        }
        for (const name of requiredNumeric) {
          checkValue(props, name, 'number', where);
        }
        for (const name of requiredString) {
          checkValue(props, name, 'string', where);
        }
      }
    }
  });
  const tilestatsCount = metadata.tilestats?.layers?.[0]?.count ?? null;
  return {
    zoom,
    tilesInBounds: tiles.length,
    emptyTiles: state.emptyTiles,
    featureInstances: state.featureInstances,
    uniqueCount: uniqueIds.size,
    tilestatsCount,
    violations: state.violations,
  };
}

// Run all checks for one archive. Returns a report object.
// Throws VerifyError when any assertion fails.
export async function verifyArchive({ name, archivePath, expectedCount, idProp, idKind, requiredNumeric, requiredString, gateBytes }) {
  let stat;
  try {
    stat = await fs.promises.stat(archivePath);
  } catch {
    throw new VerifyError(`${name}: archive not found at ${archivePath}`);
  }
  const structure = await verifyStructure(archivePath);
  if (!structure.ok) {
    throw new VerifyError(`${name}: pmtiles verify failed: ${structure.output}`);
  }
  const scan = await scanArchive(archivePath, { idProp, idKind, requiredNumeric, requiredString });
  const problems = [];
  if (scan.uniqueCount !== expectedCount) {
    problems.push(`feature count ${scan.uniqueCount} does not equal input count ${expectedCount}`);
  }
  if (scan.tilestatsCount !== expectedCount) {
    problems.push(`tilestats count ${scan.tilestatsCount} does not equal input count ${expectedCount}`);
  }
  if (scan.violations.length > 0) {
    problems.push(`property violations: ${scan.violations.join(' | ')}`);
  }
  if (stat.size > gateBytes) {
    problems.push(`size ${formatBytes(stat.size)} exceeds the gate ${formatBytes(gateBytes)}`);
  }
  if (problems.length > 0) {
    throw new VerifyError(`${name}: ${problems.join('; ')}`);
  }
  return {
    name,
    archivePath,
    bytes: stat.size,
    expectedCount,
    uniqueCount: scan.uniqueCount,
    featureInstances: scan.featureInstances,
    zoom: scan.zoom,
    tilesInBounds: scan.tilesInBounds,
    emptyTiles: scan.emptyTiles,
  };
}
