// Streaming reader for the sidewalks input GeoJSON.
// sidewalks.geojson is 96MB, so it is read line by line. One feature
// lives on each line. The whole file is never held in memory.
// The census reader lives in census_stream.mjs.

import fs from 'node:fs';
import readline from 'node:readline';

export class InputError extends Error {}

// Match the features-array opener alone, or a compact one-line header
// that ends with the opener.
const FEATURES_OPEN = /^(\{.*)?"features"\s*:\s*\[$/;

// Walk a sidewalks-style FeatureCollection line by line.
// onFeatureLine receives (rawLine, lineNumber) for each feature line.
// It may be async; the walker waits for it and applies backpressure.
// The walker validates the overall file shape and fails with a clean
// InputError on truncated or malformed input.
async function walkSidewalkLines(inputPath, onFeatureLine) {
  let phase = 'head';
  let lineNo = 0;
  const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const handleLine = async (raw) => {
    lineNo += 1;
    const line = raw.trim();
    if (line.length === 0) {
      return;
    }
    if (phase === 'head') {
      if (FEATURES_OPEN.test(line)) {
        phase = 'features';
        return;
      }
      if (line.startsWith('{') && line.includes('"type"') && line.includes('"Feature"')) {
        throw new InputError(
          `GeoJSON structure error in ${inputPath} at line ${lineNo}: feature found before the features array`,
        );
      }
      return; // Header line (type, name, crs).
    }
    if (phase === 'features') {
      if (line[0] === ']') {
        // Accept "]" alone or a compact "]}" closing.
        const rest = line.slice(1).trim();
        if (rest !== '' && rest !== '}') {
          throw new InputError(
            `GeoJSON structure error in ${inputPath} at line ${lineNo}: unexpected content after the features array`,
          );
        }
        phase = 'end';
        return;
      }
      await onFeatureLine(line, lineNo);
      return;
    }
    if (line !== '}') {
      throw new InputError(
        `GeoJSON structure error in ${inputPath} at line ${lineNo}: content after the end of the FeatureCollection`,
      );
    }
  };
  await new Promise((resolve, reject) => {
    // readline emits every line of one chunk in the same tick, so
    // pause() alone cannot serialize an async handler. A bounded queue
    // does: the reader pauses until the queue drains, then resumes.
    const queue = [];
    let closed = false;
    let failed = false;
    let processing = false;
    const fail = (err) => {
      if (failed) {
        return;
      }
      failed = true;
      rl.close();
      stream.destroy();
      reject(err);
    };
    const processQueue = async () => {
      if (processing || failed) {
        return;
      }
      processing = true;
      try {
        while (queue.length > 0 && !failed) {
          await handleLine(queue.shift());
        }
      } catch (err) {
        fail(err);
        return;
      }
      processing = false;
      if (closed) {
        resolve();
      } else {
        rl.resume();
      }
    };
    rl.on('line', (raw) => {
      queue.push(raw);
      rl.pause();
      processQueue();
    });
    rl.on('close', () => {
      closed = true;
      if (queue.length === 0 && !processing) {
        resolve();
      }
    });
    rl.on('error', fail);
    stream.on('error', fail);
  });
  if (phase !== 'end') {
    throw new InputError(
      `GeoJSON parse failure in ${inputPath}: unexpected end of file (the features array never closes; the input is truncated)`,
    );
  }
}

// Strip the trailing array comma from a feature line, when present.
function stripTrailingComma(line) {
  return line.endsWith(',') ? line.slice(0, -1) : line;
}

// Parse one sidewalks feature line. Fail cleanly on bad JSON.
function parseFeatureLine(jsonText, inputPath, lineNo) {
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new InputError(
      `GeoJSON parse failure in ${inputPath} at line ${lineNo}: ${err.message}`,
    );
  }
}

// A z14 tile grid cell is about 0.45m wide at NYC latitude, so its
// diagonal is about 0.64m. A line shorter than that can collapse to a
// single point during tile quantization and vanish from the archive.
// Segments below this length are encoded as points instead of lines.
// They stay present and queryable in the tiles. A line layer draws
// nothing for them, which matches the old map: a zero-length line
// drew nothing there either.
const MIN_LINE_METERS = 0.7;

// Return the length of a LineString in meters. Uses a flat-earth
// approximation, which is accurate enough at city scale.
function lineLengthMeters(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const [lon1, lat1] = coordinates[i - 1];
    const [lon2, lat2] = coordinates[i];
    const latAvg = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const dx = (lon2 - lon1) * 111320 * Math.cos(latAvg);
    const dy = (lat2 - lat1) * 110540;
    total += Math.hypot(dx, dy);
  }
  return total;
}

// Stream sidewalks.geojson and write an enriched copy.
// The enriched copy gets a stable id: the feature index in file order.
// Returns { count, scoreMin, scoreMax, pointCount }.
export async function enrichSidewalks(inputPath, outputPath) {
  const out = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  const writeLine = async (text) => {
    if (!out.write(text)) {
      await new Promise((resolve) => out.once('drain', resolve));
    }
  };
  await writeLine('{\n"type": "FeatureCollection",\n"features": [\n');
  let count = 0;
  let pointCount = 0;
  let scoreMin = Infinity;
  let scoreMax = -Infinity;
  let pending = null; // The previous feature line, waiting for a comma.
  await walkSidewalkLines(inputPath, async (line, lineNo) => {
    const bare = stripTrailingComma(line);
    const feature = parseFeatureLine(bare, inputPath, lineNo);
    if (feature.type !== 'Feature' || feature.geometry?.type !== 'LineString') {
      throw new InputError(
        `GeoJSON structure error in ${inputPath} at line ${lineNo}: expected a LineString feature`,
      );
    }
    const props = feature.properties ?? {};
    if (props.id !== undefined) {
      throw new InputError(
        `GeoJSON structure error in ${inputPath} at line ${lineNo}: feature already has an id`,
      );
    }
    if (typeof props.score !== 'number' || !Number.isFinite(props.score)) {
      throw new InputError(
        `GeoJSON structure error in ${inputPath} at line ${lineNo}: score is missing or not a number`,
      );
    }
    scoreMin = Math.min(scoreMin, props.score);
    scoreMax = Math.max(scoreMax, props.score);
    // The tile score is rounded to 4 decimals. Full-precision scores
    // are 17 digits long and bloat every tile at every zoom. 4 decimals
    // is 0.01% precision: enough for the map ramp and the percent
    // display. The manifest keeps the full-precision min and max.
    const roundedScore = Math.round(props.score * 1e4) / 1e4;
    // Sub-grid segments become a point at their midpoint. See
    // MIN_LINE_METERS for the reason.
    let geometry = feature.geometry;
    if (lineLengthMeters(feature.geometry.coordinates) < MIN_LINE_METERS) {
      const coords = feature.geometry.coordinates;
      const [x1, y1] = coords[0];
      const [x2, y2] = coords[coords.length - 1];
      geometry = { type: 'Point', coordinates: [(x1 + x2) / 2, (y1 + y2) / 2] };
      pointCount += 1;
    }
    const enriched = JSON.stringify({
      type: 'Feature',
      properties: { id: count, score: roundedScore },
      geometry,
    });
    if (pending !== null) {
      await writeLine(`${pending},\n`);
    }
    pending = enriched;
    count += 1;
  });
  if (pending !== null) {
    await writeLine(`${pending}\n`);
  }
  await writeLine(']\n}\n');
  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });
  if (count === 0) {
    throw new InputError(`GeoJSON parse failure in ${inputPath}: no features found`);
  }
  return { count, scoreMin, scoreMax, pointCount };
}

// Count sidewalks features without a full JSON parse.
// The walker still validates the file shape.
export async function countSidewalkFeatures(inputPath) {
  let count = 0;
  await walkSidewalkLines(inputPath, (line, lineNo) => {
    const bare = stripTrailingComma(line);
    if (!bare.startsWith('{') || !bare.endsWith('}') || !/"type"\s*:\s*"Feature"/.test(bare)) {
      throw new InputError(
        `GeoJSON parse failure in ${inputPath} at line ${lineNo}: line is not a Feature object`,
      );
    }
    count += 1;
  });
  return count;
}

