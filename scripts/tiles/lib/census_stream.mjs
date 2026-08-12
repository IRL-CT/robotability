// Reader for the census input GeoJSON.
// census.geojson is small (4.3MB), so a full parse is safe.
// The sidewalks file uses the streaming reader in geojson_stream.mjs.

import fs from 'node:fs';
import { InputError } from './geojson_stream.mjs';

// Convert census.geojson polygons into boundary lines.
// Keep only the GEOID and BoroName properties. Return { count }.
export async function preprocessCensus(inputPath, outputPath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(inputPath, 'utf8'));
  } catch (err) {
    throw new InputError(`GeoJSON parse failure in ${inputPath}: ${err.message}`);
  }
  if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new InputError(`GeoJSON structure error in ${inputPath}: not a FeatureCollection`);
  }
  const out = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  const writeLine = async (text) => {
    if (!out.write(text)) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
  };
  await writeLine('{"type":"FeatureCollection","features":[\n');
  let count = 0;
  for (const feature of parsed.features) {
    const geometry = feature.geometry;
    const props = feature.properties ?? {};
    if (typeof props.GEOID !== 'string' || typeof props.BoroName !== 'string') {
      throw new InputError(
        `GeoJSON structure error in ${inputPath}: feature ${count} lacks a string GEOID or BoroName`,
      );
    }
    let rings = [];
    if (geometry?.type === 'Polygon') {
      rings = geometry.coordinates;
    } else if (geometry?.type === 'MultiPolygon') {
      rings = geometry.coordinates.flat();
    } else {
      throw new InputError(
        `GeoJSON structure error in ${inputPath}: feature ${count} is not a polygon`,
      );
    }
    const boundary = {
      type: 'Feature',
      properties: { GEOID: props.GEOID, BoroName: props.BoroName },
      geometry: { type: 'MultiLineString', coordinates: rings },
    };
    const prefix = count > 0 ? ',\n' : '';
    await writeLine(`${prefix}${JSON.stringify(boundary)}`);
    count += 1;
  }
  await writeLine('\n]}\n');
  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });
  return { count };
}
