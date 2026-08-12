#!/usr/bin/env node
// Snapshot contract validator for the Robotability pipeline.
//
// This script checks one snapshot directory against
// pipeline/contract/cluster_contract.md. The cluster and the CI publish
// workflow both run it. A snapshot must pass every rule before publication.
//
// Usage:
//   node validate_snapshot.mjs <snapshot-dir> [--relax-row-count <n>]
//   node validate_snapshot.mjs --selftest
//   node validate_snapshot.mjs --make-fixture <dir> [--rows <n>]
//
// Modes:
//   <snapshot-dir>        Validate the directory. Print every failed rule to
//                         stderr as "FAIL <rule>: <detail>".
//   --relax-row-count <n> Replace the row count band with the exact value n.
//                         Use this only for small-area test runs.
//   --selftest            Build one valid synthetic snapshot and five corrupt
//                         variants in a temp dir. Assert the exit codes.
//   --make-fixture <dir>  Write a small valid synthetic snapshot to <dir>.
//
// Exit codes: 0 = valid, 1 = validation failed, 2 = usage error.
//
// Dependencies: none (npm). This file uses only Node built-in modules.
// allow: SIZE_OK - the task spec mandates one self-contained script with zero
// npm dependencies. A split across files would break that contract.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Ground truth constants.
// Sources: robotability-nyc/survey_processing/feature_weights.csv (19 weights,
// sum = 1.0) and robotability-nyc/feature_processing/score.ipynb cells 92-97.
// The negative-polarity weights sum to 0.40488. The positive-polarity weights
// sum to 0.59512. The score band below adds a small margin for float32
// rounding. Do not change these values without a matching contract change.
// ---------------------------------------------------------------------------

// FEATURES lists the 19 model features in exact parquet column order.
export const FEATURES = [
  'sidewalk_width',
  'pedestrian_density',
  'street_furniture_density',
  'sidewalk_roughness',
  'surface_condition',
  'communication_infrastructure',
  'slope_gradient',
  'charging_station_proximity',
  'curb_ramp_availability',
  'crowd_dynamics',
  'traffic_management',
  'surveillance_coverage',
  'zoning_laws',
  'bike_lane_availability',
  'gps_signal_strength',
  'bicycle_traffic',
  'vehicle_traffic',
  'digital_map_existence',
  'intersection_safety',
];

// WEIGHTS holds the exact survey weights from feature_weights.csv.
export const WEIGHTS = {
  sidewalk_width: 0.06806833613639274,
  pedestrian_density: 0.09445576675004053,
  street_furniture_density: 0.06752114455511304,
  sidewalk_roughness: 0.04593514200834298,
  surface_condition: 0.07682933579593197,
  communication_infrastructure: 0.05845165469318187,
  slope_gradient: 0.04832231448153131,
  charging_station_proximity: 0.025316489931061576,
  curb_ramp_availability: 0.060102970276542725,
  crowd_dynamics: 0.07621927189475182,
  traffic_management: 0.04638333896814371,
  surveillance_coverage: 0.02281272971765975,
  zoning_laws: 0.04146601033693057,
  bike_lane_availability: 0.022603749599280413,
  gps_signal_strength: 0.048359700811054354,
  bicycle_traffic: 0.03068282361247861,
  vehicle_traffic: 0.04745443062510741,
  digital_map_existence: 0.04850786858987462,
  intersection_safety: 0.07050692121657998,
};

// POLARITIES holds the exact signs from score.ipynb cell 96 for the 19
// computed features. +1 means "more is better". -1 means "more is worse".
export const POLARITIES = {
  sidewalk_width: 1,
  pedestrian_density: -1,
  street_furniture_density: -1,
  sidewalk_roughness: -1,
  surface_condition: 1,
  communication_infrastructure: 1,
  slope_gradient: -1,
  charging_station_proximity: 1,
  curb_ramp_availability: 1,
  crowd_dynamics: 1,
  traffic_management: 1,
  surveillance_coverage: 1,
  zoning_laws: 1,
  bike_lane_availability: 1,
  gps_signal_strength: 1,
  bicycle_traffic: -1,
  vehicle_traffic: -1,
  digital_map_existence: 1,
  intersection_safety: -1,
};

// WEIGHTS_SHA256 pins the exact bytes of feature_weights.csv. The manifest
// must carry this hash. A different hash means the weights changed.
export const WEIGHTS_SHA256 =
  '6278272614fe5e012874a2804e9e576f21f5a9cd4b952eb9296ccb6932965beb';

export const ROW_COUNT_MIN = 460350;
export const ROW_COUNT_MAX = 469650;
export const SCORE_MIN = -0.4049;
export const SCORE_MAX = 0.5952;
export const FEATURE_MIN = 0;
export const FEATURE_MAX = 1;
export const DATE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const STATS_EPSILON = 1e-6;

const PARQUET_NAME = 'features.parquet';
const REQUIRED_FILES_BASE = ['segments.geojson', 'segments.pmtiles'];

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function joinPath(base, name) {
  return base.endsWith('/') ? base + name : base + '/' + name;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

// todayUtcString returns YYYY-MM-DD for the current UTC date plus an offset
// in whole days. The selftest uses the offset to build a stale date.
function todayUtcString(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// parseUtcMidnight returns the UTC millisecond timestamp of midnight on the
// given YYYY-MM-DD date. It returns null for a malformed or impossible date.
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

// mulberry32 is a small deterministic PRNG. The fixture builder uses it so
// every selftest run produces the same snapshot.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Thrift compact protocol.
// Parquet stores its file metadata in this binary format. The writer serves
// the fixture builder. The reader serves the validator.
// ---------------------------------------------------------------------------

const T_TYPES = {
  STOP: 0,
  TRUE: 1,
  FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12,
};

function zigzag(n) {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

class ThriftWriter {
  constructor() {
    this.parts = [];
    this.fidStack = [];
    this.lastFid = 0;
  }

  uvarint(n) {
    const out = [];
    let v = n;
    while (v >= 0x80) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    this.parts.push(Buffer.from(out));
  }

  fieldHeader(type, fid) {
    const delta = fid - this.lastFid;
    if (delta > 0 && delta <= 15) {
      this.parts.push(Buffer.from([(delta << 4) | type]));
    } else {
      this.parts.push(Buffer.from([type]));
      this.uvarint(zigzag(fid));
    }
    this.lastFid = fid;
  }

  // structBody opens a nested struct, runs buildFn, and writes the STOP byte.
  structBody(buildFn) {
    this.fidStack.push(this.lastFid);
    this.lastFid = 0;
    buildFn(this);
    this.parts.push(Buffer.from([T_TYPES.STOP]));
    this.lastFid = this.fidStack.pop();
  }

  writeStructField(fid, buildFn) {
    this.fieldHeader(T_TYPES.STRUCT, fid);
    this.structBody(buildFn);
  }

  writeI32Field(fid, v) {
    this.fieldHeader(T_TYPES.I32, fid);
    this.uvarint(zigzag(v));
  }

  writeI64Field(fid, v) {
    this.fieldHeader(T_TYPES.I64, fid);
    this.uvarint(zigzag(v));
  }

  writeBinaryField(fid, value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    this.fieldHeader(T_TYPES.BINARY, fid);
    this.uvarint(buf.length);
    this.parts.push(buf);
  }

  // writeListField writes a list header and then count elements through
  // writeEach. The caller must write exactly count elements.
  writeListField(fid, elemType, count, writeEach) {
    this.fieldHeader(T_TYPES.LIST, fid);
    const sizeNibble = count < 15 ? count : 15;
    this.parts.push(Buffer.from([(sizeNibble << 4) | elemType]));
    if (count >= 15) this.uvarint(count);
    writeEach(this);
  }

  finish() {
    this.parts.push(Buffer.from([T_TYPES.STOP]));
    return Buffer.concat(this.parts);
  }
}

class ThriftReader {
  constructor(buf, off = 0) {
    this.buf = buf;
    this.off = off;
  }

  uvarint() {
    let result = 0;
    let mul = 1;
    for (;;) {
      if (this.off >= this.buf.length) throw new Error('thrift: truncated varint');
      const b = this.buf[this.off++];
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 128;
    }
  }

  zigzagDecode(n) {
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  readStruct() {
    const out = {};
    let lastFid = 0;
    for (;;) {
      if (this.off >= this.buf.length) throw new Error('thrift: truncated struct');
      const b = this.buf[this.off++];
      if (b === T_TYPES.STOP) return out;
      const type = b & 0x0f;
      const delta = b >> 4;
      const fid = delta === 0 ? this.zigzagDecode(this.uvarint()) : lastFid + delta;
      lastFid = fid;
      out[fid] = this.readValue(type);
    }
  }

  readValue(type) {
    switch (type) {
      case T_TYPES.TRUE:
        return true;
      case T_TYPES.FALSE:
        return false;
      case T_TYPES.BYTE: {
        const v = this.buf.readInt8(this.off);
        this.off += 1;
        return v;
      }
      case T_TYPES.I16:
      case T_TYPES.I32:
      case T_TYPES.I64:
        return this.zigzagDecode(this.uvarint());
      case T_TYPES.DOUBLE: {
        const v = this.buf.readDoubleLE(this.off);
        this.off += 8;
        return v;
      }
      case T_TYPES.BINARY: {
        const len = this.uvarint();
        if (this.off + len > this.buf.length) throw new Error('thrift: truncated binary');
        const v = this.buf.subarray(this.off, this.off + len);
        this.off += len;
        return v;
      }
      case T_TYPES.LIST:
      case T_TYPES.SET: {
        const h = this.buf[this.off++];
        let size = h >> 4;
        const elemType = h & 0x0f;
        if (size === 15) size = this.uvarint();
        const items = [];
        for (let i = 0; i < size; i++) items.push(this.readValue(elemType));
        return { items };
      }
      case T_TYPES.MAP: {
        const size = this.uvarint();
        const entries = [];
        if (size > 0) {
          const kv = this.buf[this.off++];
          const keyType = kv >> 4;
          const valType = kv & 0x0f;
          for (let i = 0; i < size; i++) {
            entries.push([this.readValue(keyType), this.readValue(valType)]);
          }
        }
        return { entries };
      }
      case T_TYPES.STRUCT:
        return this.readStruct();
      default:
        throw new Error(`thrift: unsupported type ${type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal parquet writer. The fixture builder uses it to produce a valid
// parquet file with zero dependencies. The file uses one row group, REQUIRED
// columns, PLAIN encoding, UNCOMPRESSED codec, and data page v1. This is the
// baseline subset the validator must always accept.
// ---------------------------------------------------------------------------

const PARQUET_TYPE = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  INT96: 3,
  FLOAT: 4,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
  FIXED_LEN_BYTE_ARRAY: 7,
};

const CODEC = { UNCOMPRESSED: 0, SNAPPY: 1, GZIP: 2 };
const PAGE_TYPE = { DATA_PAGE: 0, INDEX_PAGE: 1, DICTIONARY_PAGE: 2, DATA_PAGE_V2: 3 };
const ENC = { PLAIN: 0, PLAIN_DICTIONARY: 2, RLE: 3, RLE_DICTIONARY: 8 };

function encodePlainInt32(values) {
  const b = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) b.writeInt32LE(values[i], i * 4);
  return b;
}

function encodePlainFloat(values) {
  const b = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) b.writeFloatLE(values[i], i * 4);
  return b;
}

function buildDataPageHeader(dataSize, numValues) {
  const w = new ThriftWriter();
  w.writeI32Field(1, PAGE_TYPE.DATA_PAGE);
  w.writeI32Field(2, dataSize);
  w.writeI32Field(3, dataSize);
  w.writeStructField(5, (dph) => {
    dph.writeI32Field(1, numValues);
    dph.writeI32Field(2, ENC.PLAIN);
    dph.writeI32Field(3, ENC.RLE);
    dph.writeI32Field(4, ENC.RLE);
  });
  return w.finish();
}

function buildParquetFooter(columns, numRows, chunkMetas) {
  const w = new ThriftWriter();
  w.writeI32Field(1, 1); // version
  // Field 2: schema. The first element is the root. Then one leaf per column.
  w.writeListField(2, T_TYPES.STRUCT, columns.length + 1, (s) => {
    s.structBody((root) => {
      root.writeBinaryField(4, 'schema');
      root.writeI32Field(5, columns.length);
    });
    for (const col of columns) {
      s.structBody((leaf) => {
        leaf.writeI32Field(1, col.parquetType);
        leaf.writeI32Field(3, 0); // repetition_type REQUIRED
        leaf.writeBinaryField(4, col.name);
      });
    }
  });
  w.writeI64Field(3, numRows);
  // Field 4: row groups. The writer emits exactly one row group.
  w.writeListField(4, T_TYPES.STRUCT, 1, (s) => {
    s.structBody((rg) => {
      rg.writeListField(1, T_TYPES.STRUCT, columns.length, (c) => {
        for (const meta of chunkMetas) {
          c.structBody((cc) => {
            cc.writeI64Field(2, meta.offset);
            cc.writeStructField(3, (md) => {
              md.writeI32Field(1, meta.parquetType);
              md.writeListField(2, T_TYPES.I32, 1, (e) => e.uvarint(zigzag(ENC.PLAIN)));
              md.writeListField(3, T_TYPES.BINARY, 1, (e) => {
                const nameBuf = Buffer.from(meta.name, 'utf8');
                e.uvarint(nameBuf.length);
                e.parts.push(nameBuf);
              });
              md.writeI32Field(4, CODEC.UNCOMPRESSED);
              md.writeI64Field(5, meta.numValues);
              md.writeI64Field(6, meta.size);
              md.writeI64Field(7, meta.size);
              md.writeI64Field(9, meta.offset);
            });
          });
        }
      });
      rg.writeI64Field(2, chunkMetas.reduce((acc, m) => acc + m.size, 0));
      rg.writeI64Field(3, numRows);
    });
  });
  w.writeBinaryField(6, 'robotability-contract-fixture');
  return w.finish();
}

// writeParquetFile writes columns to filePath. Each column is
// {name, parquetType, values}. All columns must hold numRows values.
function writeParquetFile(filePath, columns, numRows) {
  for (const col of columns) {
    if (col.values.length !== numRows) {
      throw new Error(`parquet writer: column ${col.name} has the wrong length`);
    }
  }
  const pageParts = [];
  const chunkMetas = [];
  let offset = 4; // The leading PAR1 magic occupies 4 bytes.
  for (const col of columns) {
    const data =
      col.parquetType === PARQUET_TYPE.INT32
        ? encodePlainInt32(col.values)
        : encodePlainFloat(col.values);
    const header = buildDataPageHeader(data.length, numRows);
    chunkMetas.push({
      name: col.name,
      parquetType: col.parquetType,
      numValues: numRows,
      offset,
      size: header.length + data.length,
    });
    pageParts.push(header, data);
    offset += header.length + data.length;
  }
  const footer = buildParquetFooter(columns, numRows, chunkMetas);
  const footerLen = Buffer.allocUnsafe(4);
  footerLen.writeUInt32LE(footer.length, 0);
  const magic = Buffer.from('PAR1');
  fs.writeFileSync(filePath, Buffer.concat([magic, ...pageParts, footer, footerLen, magic]));
}

// ---------------------------------------------------------------------------
// Validation rules. See cluster_contract.md for the rule catalog.
// ---------------------------------------------------------------------------

function checkManifestSchema(m) {
  const errs = [];
  const need = (cond, msg) => {
    if (!cond) errs.push(msg);
  };
  need(
    parseUtcMidnight(m.date) !== null,
    'date must be a string in YYYY-MM-DD form and a real calendar date',
  );
  need(Number.isInteger(m.row_count) && m.row_count >= 0, 'row_count must be a non-negative integer');
  need(
    typeof m.score_min === 'number' && Number.isFinite(m.score_min),
    'score_min must be a finite number',
  );
  need(
    typeof m.score_max === 'number' && Number.isFinite(m.score_max),
    'score_max must be a finite number',
  );
  if (typeof m.score_min === 'number' && typeof m.score_max === 'number') {
    need(m.score_min <= m.score_max, 'score_min must not exceed score_max');
  }
  need(isHex64(m.weights_sha256), 'weights_sha256 must be a 64-char lowercase hex string');
  need(typeof m.partial === 'boolean', 'partial must be a boolean');
  need(typeof m.feature_vectors === 'boolean', 'feature_vectors must be a boolean');
  if (m.feature_vectors === false) {
    need(m.feature_stats === null, 'feature_stats must be null when feature_vectors is false');
  } else if (m.feature_vectors === true) {
    if (m.feature_stats !== null) {
      need(
        typeof m.feature_stats === 'object' && !Array.isArray(m.feature_stats),
        'feature_stats must be null or an object',
      );
      if (typeof m.feature_stats === 'object' && m.feature_stats !== null) {
        for (const f of FEATURES) {
          const entry = m.feature_stats[f];
          need(
            typeof entry === 'object' &&
              entry !== null &&
              typeof entry.min === 'number' &&
              typeof entry.max === 'number' &&
              entry.min <= entry.max,
            `feature_stats.${f} must be an object {min, max} with min <= max`,
          );
        }
        for (const key of Object.keys(m.feature_stats)) {
          need(FEATURES.includes(key), `feature_stats holds an unknown key: ${key}`);
        }
      }
    }
  }
  need(Array.isArray(m.files), 'files must be an array');
  if (Array.isArray(m.files)) {
    m.files.forEach((f, i) => {
      need(
        typeof f === 'object' &&
          f !== null &&
          typeof f.name === 'string' &&
          f.name.length > 0 &&
          isHex64(f.sha256) &&
          Number.isInteger(f.bytes) &&
          f.bytes >= 0,
        `files[${i}] must be an object {name: string, sha256: hex64, bytes: integer}`,
      );
    });
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Minimal parquet reader. It reads the subset the contract allows: data page
// v1, PLAIN and dictionary encodings, UNCOMPRESSED and SNAPPY codecs, flat
// schemas. It rejects everything else with a clear message. The reader keeps
// only per-column min/max/count stats, never the full value arrays.
// ---------------------------------------------------------------------------

function readUvarint(buf, off) {
  let result = 0;
  let mul = 1;
  for (;;) {
    if (off >= buf.length) throw new Error('truncated varint');
    const b = buf[off++];
    result += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return [result, off];
    mul *= 128;
  }
}

// snappyDecompress implements the snappy block format. Parquet writers use it
// as the default codec, so the validator must read it without npm packages.
function snappyDecompress(src) {
  let off;
  let uncompressedLen;
  [uncompressedLen, off] = readUvarint(src, 0);
  const out = Buffer.allocUnsafe(uncompressedLen);
  let outPos = 0;
  while (off < src.length) {
    const tag = src[off++];
    const type = tag & 3;
    if (type === 0) {
      // Literal run.
      let len = (tag >> 2) + 1;
      if (len > 60) {
        const extra = len - 60;
        len = src.readUIntLE(off, extra) + 1;
        off += extra;
      }
      if (off + len > src.length || outPos + len > uncompressedLen) {
        throw new Error('snappy: literal overruns buffer');
      }
      src.copy(out, outPos, off, off + len);
      off += len;
      outPos += len;
    } else {
      // Copy from history. Copies may overlap, so copy byte by byte.
      let len;
      let offset;
      if (type === 1) {
        len = ((tag >> 2) & 7) + 4;
        offset = ((tag >> 5) << 8) | src[off];
        off += 1;
      } else if (type === 2) {
        len = (tag >> 2) + 1;
        offset = src.readUInt16LE(off);
        off += 2;
      } else {
        len = (tag >> 2) + 1;
        offset = src.readUInt32LE(off);
        off += 4;
      }
      if (offset <= 0 || offset > outPos || outPos + len > uncompressedLen) {
        throw new Error('snappy: bad copy offset or length');
      }
      for (let i = 0; i < len; i++) {
        out[outPos] = out[outPos - offset];
        outPos++;
      }
    }
  }
  if (outPos !== uncompressedLen) throw new Error('snappy: size mismatch');
  return out;
}

// decodeRleHybrid decodes the parquet RLE / bit-packed hybrid encoding.
// It reads from buf at off and stops after numValues values.
function decodeRleHybrid(buf, off, bitWidth, numValues) {
  const values = [];
  if (numValues === 0) return { values, end: off };
  while (values.length < numValues) {
    let header;
    [header, off] = readUvarint(buf, off);
    if ((header & 1) === 0) {
      // RLE run.
      const runLen = Math.floor(header / 2);
      let val = 0;
      if (bitWidth > 0) {
        const byteWidth = Math.ceil(bitWidth / 8);
        val = buf.readUIntLE(off, byteWidth);
        off += byteWidth;
      }
      for (let i = 0; i < runLen && values.length < numValues; i++) values.push(val);
    } else {
      // Bit-packed run: groups of 8 values, LSB first.
      const groups = Math.floor(header / 2);
      const count = groups * 8;
      const bitLen = Math.ceil((count * bitWidth) / 8);
      if (off + bitLen > buf.length) throw new Error('rle: bit-packed overrun');
      // Copy the section plus a padded tail so 32-bit window reads stay safe.
      const section = Buffer.alloc(bitLen + 8);
      buf.copy(section, 0, off, off + bitLen);
      off += bitLen;
      const mask = bitWidth >= 31 ? 2 ** bitWidth - 1 : (1 << bitWidth) - 1;
      for (let i = 0; i < count && values.length < numValues; i++) {
        const bitPos = i * bitWidth;
        const byteIdx = bitPos >> 3;
        const bitIdx = bitPos & 7;
        const lo = section.readUInt32LE(byteIdx);
        let val;
        if (bitIdx + bitWidth <= 32) {
          val = (lo >>> bitIdx) & mask;
        } else {
          const hi = section.readUInt32LE(byteIdx + 4);
          val = (((lo >>> bitIdx) | (hi << (32 - bitIdx))) >>> 0) & mask;
        }
        values.push(val);
      }
    }
  }
  return { values, end: off };
}

function parsePlain(buf, parquetType, count) {
  if (buf.length < count * 4) throw new Error('parquet: PLAIN page too short');
  const values = new Array(count);
  if (parquetType === PARQUET_TYPE.INT32) {
    for (let i = 0; i < count; i++) values[i] = buf.readInt32LE(i * 4);
  } else if (parquetType === PARQUET_TYPE.FLOAT) {
    for (let i = 0; i < count; i++) values[i] = buf.readFloatLE(i * 4);
  } else {
    throw new Error(`parquet: unsupported physical type ${parquetType}`);
  }
  return values;
}

// readParquetForValidation parses the file and returns
// { leaves, numRows, stats }. leaves is the ordered schema:
// [{name, parquetType, repetition}]. stats maps each column name to
// {count, min, max, nullCount}.
function readParquetForValidation(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PAR1') {
    throw new Error('missing PAR1 magic at file start');
  }
  if (buf.toString('latin1', buf.length - 4) !== 'PAR1') {
    throw new Error('missing PAR1 magic at file end');
  }
  const footerLen = buf.readUInt32LE(buf.length - 8);
  if (footerLen > buf.length - 8) throw new Error('bad footer length');
  const footerStart = buf.length - 8 - footerLen;
  const meta = new ThriftReader(buf, footerStart).readStruct();

  const schemaList = meta[2] && meta[2].items;
  if (!schemaList || schemaList.length < 2) throw new Error('missing schema in footer');
  const numRows = meta[3];
  if (typeof numRows !== 'number') throw new Error('missing num_rows in footer');
  const rowGroups = meta[4] && meta[4].items;
  if (!rowGroups) throw new Error('missing row_groups in footer');

  // The first schema element is the root. The rest are the leaves.
  const leaves = [];
  for (let i = 1; i < schemaList.length; i++) {
    const el = schemaList[i];
    if (el[1] === undefined) throw new Error('schema leaf without a physical type');
    const nameBuf = el[4];
    if (!Buffer.isBuffer(nameBuf)) throw new Error('schema leaf without a name');
    leaves.push({
      name: nameBuf.toString('utf8'),
      parquetType: el[1],
      repetition: el[3] ?? 0,
    });
  }

  const stats = new Map();
  for (const leaf of leaves) {
    stats.set(leaf.name, { count: 0, min: Infinity, max: -Infinity, nullCount: 0 });
  }
  const leafByName = new Map(leaves.map((l) => [l.name, l]));

  for (const rg of rowGroups) {
    const chunks = rg[1] && rg[1].items;
    if (!chunks) throw new Error('row group without column chunks');
    for (const cc of chunks) {
      const md = cc[3];
      if (!md) throw new Error('column chunk without ColumnMetaData');
      const parquetType = md[1];
      const codec = md[4];
      const numValues = Number(md[5]);
      const dataOffset = md[9];
      const dictOffset = md[11];
      if (typeof dataOffset !== 'number') throw new Error('column chunk without data_page_offset');
      const pathList = md[3] && md[3].items;
      if (!pathList || pathList.length === 0) throw new Error('column chunk without path_in_schema');
      const name = pathList[pathList.length - 1].toString('utf8');
      const leaf = leafByName.get(name);
      if (!leaf) throw new Error(`unknown column in row group: ${name}`);
      if (codec !== CODEC.UNCOMPRESSED && codec !== CODEC.SNAPPY) {
        throw new Error(`unsupported codec ${codec}; the contract allows UNCOMPRESSED or SNAPPY`);
      }
      const st = stats.get(name);
      let pos = Number(dictOffset ?? dataOffset);
      let dictionary = null;
      let decoded = 0;
      while (decoded < numValues) {
        const tr = new ThriftReader(buf, pos);
        const ph = tr.readStruct();
        const headerEnd = tr.off;
        const pageType = ph[1];
        const compSize = ph[3];
        if (typeof compSize !== 'number') throw new Error('page without compressed_page_size');
        if (headerEnd + compSize > buf.length) throw new Error('page overruns file');
        const pageBytes = buf.subarray(headerEnd, headerEnd + compSize);
        const raw =
          codec === CODEC.UNCOMPRESSED ? pageBytes : snappyDecompress(pageBytes);
        if (pageType === PAGE_TYPE.DICTIONARY_PAGE) {
          const dph = ph[7];
          if (!dph) throw new Error('dictionary page without header');
          dictionary = parsePlain(raw, parquetType, Number(dph[1]));
        } else if (pageType === PAGE_TYPE.DATA_PAGE) {
          const dph = ph[5];
          if (!dph) throw new Error('data page without header');
          const nvals = Number(dph[1]);
          const enc = dph[2];
          let cursor = 0;
          let defLevels = null;
          if (leaf.repetition === 1) {
            // OPTIONAL column: a definition level section leads the page.
            const defLen = raw.readUInt32LE(cursor);
            cursor += 4;
            defLevels = decodeRleHybrid(raw, cursor, 1, nvals).values;
            cursor += defLen;
          }
          const present = defLevels ? defLevels.filter((v) => v === 1).length : nvals;
          st.nullCount += nvals - present;
          let values;
          if (enc === ENC.PLAIN) {
            values = parsePlain(raw.subarray(cursor), parquetType, present);
          } else if (enc === ENC.PLAIN_DICTIONARY || enc === ENC.RLE_DICTIONARY) {
            if (!dictionary) throw new Error('dictionary-encoded page before dictionary page');
            const bitWidth = raw[cursor];
            cursor += 1;
            const indices = decodeRleHybrid(raw, cursor, bitWidth, present).values;
            values = indices.map((i) => dictionary[i]);
          } else {
            throw new Error(`unsupported encoding ${enc}; the contract allows PLAIN or dictionary`);
          }
          for (const v of values) {
            if (v < st.min) st.min = v;
            if (v > st.max) st.max = v;
          }
          st.count += values.length;
          decoded += nvals;
        } else if (pageType === PAGE_TYPE.DATA_PAGE_V2) {
          throw new Error('data page v2 found; the contract mandates data page v1');
        }
        // INDEX_PAGE and unknown page types are skipped.
        pos = headerEnd + compSize;
      }
    }
  }
  return { leaves, numRows, stats };
}

// ---------------------------------------------------------------------------
// validateSnapshot runs every contract rule against one snapshot directory.
// It returns { exitCode, failures }. Each failure is { rule, detail }.
// A broken manifest schema stops the run: later checks would be unreliable.
// ---------------------------------------------------------------------------

function validateSnapshot(dir, opts) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const done = () => ({ exitCode: failures.length === 0 ? 0 : 1, failures });

  // Rule snapshot_dir: the argument must be a directory.
  let dirStat = null;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    dirStat = null;
  }
  if (!dirStat || !dirStat.isDirectory()) {
    fail('snapshot_dir', `not a directory: ${dir}`);
    return done();
  }

  // Rules manifest_missing / manifest_parse.
  const manifestPath = joinPath(dir, 'manifest.json');
  let manifestRaw;
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    fail('manifest_missing', 'manifest.json not found in the snapshot directory');
    return done();
  }
  let m;
  try {
    m = JSON.parse(manifestRaw);
  } catch (e) {
    fail('manifest_parse', `manifest.json is not valid JSON: ${e.message}`);
    return done();
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    fail('manifest_parse', 'manifest.json must hold a JSON object');
    return done();
  }

  // Rule manifest_schema: every field must exist with the right type.
  const schemaErrors = checkManifestSchema(m);
  for (const d of schemaErrors) fail('manifest_schema', d);
  if (schemaErrors.length > 0) return done();

  // Rule row_count_band: full city runs fall in [460350, 469650].
  // --relax-row-count replaces the band with one exact value.
  if (opts.relaxRowCount !== null) {
    if (m.row_count !== opts.relaxRowCount) {
      fail(
        'row_count_band',
        `row_count ${m.row_count} must equal ${opts.relaxRowCount} (relaxed band for test runs)`,
      );
    }
  } else if (m.row_count < ROW_COUNT_MIN || m.row_count > ROW_COUNT_MAX) {
    fail(
      'row_count_band',
      `row_count ${m.row_count} outside the band [${ROW_COUNT_MIN}, ${ROW_COUNT_MAX}]`,
    );
  }

  // Rule manifest_date_fresh: the date must lie within 48h of now.
  const dateMs = parseUtcMidnight(m.date);
  if (Math.abs(Date.now() - dateMs) > DATE_MAX_AGE_MS) {
    fail('manifest_date_fresh', `date ${m.date} is more than 48h away from the validation time`);
  }

  // Rule partial_flag: CI publishes only complete snapshots.
  if (m.partial !== false) {
    fail('partial_flag', `partial must be false, got ${JSON.stringify(m.partial)}`);
  }

  // Rule weights_sha256: the weights file must not change.
  if (m.weights_sha256 !== WEIGHTS_SHA256) {
    fail(
      'weights_sha256',
      `weights_sha256 must equal the pinned feature_weights.csv hash ${WEIGHTS_SHA256}, got ${m.weights_sha256}`,
    );
  }

  // Rule files_list: the manifest must list the required artifacts.
  const names = m.files.map((f) => f.name);
  const required = [...REQUIRED_FILES_BASE];
  if (m.feature_vectors) required.push(PARQUET_NAME);
  for (const req of required) {
    if (!names.includes(req)) fail('files_list', `manifest.files must list ${req}`);
  }
  if (!m.feature_vectors && names.includes(PARQUET_NAME)) {
    fail('files_list', `manifest.files must not list ${PARQUET_NAME} when feature_vectors is false`);
  }
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) fail('files_list', `duplicate file entry: ${n}`);
    seen.add(n);
  }

  // Rule file_sha256: each listed file must exist with matching size and hash.
  for (const f of m.files) {
    const p = joinPath(dir, f.name);
    let data;
    try {
      data = fs.readFileSync(p);
    } catch {
      fail('file_sha256', `${f.name}: file not found in the snapshot directory`);
      continue;
    }
    if (data.length !== f.bytes) {
      fail('file_sha256', `${f.name}: size ${data.length} does not match manifest bytes ${f.bytes}`);
    }
    const actual = sha256Hex(data);
    if (actual !== f.sha256) {
      fail('file_sha256', `${f.name}: sha256 ${actual} does not match manifest sha256 ${f.sha256}`);
    }
  }

  // Rule pmtiles_magic: the tiles file must be PMTiles v3.
  try {
    const head = fs.readFileSync(joinPath(dir, 'segments.pmtiles')).subarray(0, 8);
    if (head.length < 8 || head.toString('latin1', 0, 7) !== 'PMTiles' || head[7] !== 3) {
      fail('pmtiles_magic', 'segments.pmtiles must start with the PMTiles v3 magic');
    }
  } catch {
    // file_sha256 already reports a missing file.
  }

  // Parquet rules apply only to snapshots with feature vectors.
  if (m.feature_vectors) {
    const pqPath = joinPath(dir, PARQUET_NAME);
    let buf;
    try {
      buf = fs.readFileSync(pqPath);
    } catch {
      fail('parquet_missing', 'features.parquet not found in the snapshot directory');
      return done();
    }
    let pq;
    try {
      pq = readParquetForValidation(buf);
    } catch (e) {
      fail('parquet_parse', e.message);
      return done();
    }

    // Rule parquet_schema: exact column names, order, and types.
    const expectedCols = [
      ['segment_id', PARQUET_TYPE.INT32],
      ...FEATURES.map((f) => [f, PARQUET_TYPE.FLOAT]),
      ['score', PARQUET_TYPE.FLOAT],
    ];
    let schemaOk = true;
    if (pq.leaves.length !== expectedCols.length) {
      schemaOk = false;
      fail(
        'parquet_schema',
        `features.parquet must hold exactly ${expectedCols.length} columns, found ${pq.leaves.length}`,
      );
    } else {
      for (let i = 0; i < expectedCols.length; i++) {
        const [wantName, wantType] = expectedCols[i];
        const got = pq.leaves[i];
        if (got.name !== wantName || got.parquetType !== wantType) {
          schemaOk = false;
          fail(
            'parquet_schema',
            `column ${i} must be ${wantName} (type ${wantType}), found ${got.name} (type ${got.parquetType})`,
          );
        }
      }
    }
    for (const leaf of pq.leaves) {
      const st = pq.stats.get(leaf.name);
      if (st.nullCount > 0) {
        schemaOk = false;
        fail('parquet_schema', `column ${leaf.name} holds ${st.nullCount} null values; nulls are not allowed`);
      }
    }
    if (!schemaOk) return done();

    // Rule row_count_match: parquet rows must equal manifest row_count.
    if (pq.numRows !== m.row_count) {
      fail(
        'row_count_match',
        `features.parquet holds ${pq.numRows} rows but manifest row_count is ${m.row_count}`,
      );
    }

    // Rule feature_range: every normalized feature must lie in [0, 1].
    for (const f of FEATURES) {
      const st = pq.stats.get(f);
      if (st.count > 0 && (st.min < FEATURE_MIN || st.max > FEATURE_MAX)) {
        fail(
          'feature_range',
          `${f}: values must lie in [${FEATURE_MIN}, ${FEATURE_MAX}], found min ${st.min}, max ${st.max}`,
        );
      }
    }

    // Rule score_range: every score must lie in [-0.4049, 0.5952].
    const sc = pq.stats.get('score');
    if (sc.count > 0 && (sc.min < SCORE_MIN || sc.max > SCORE_MAX)) {
      fail(
        'score_range',
        `score values must lie in [${SCORE_MIN}, ${SCORE_MAX}], found min ${sc.min}, max ${sc.max}`,
      );
    }

    // Rule score_stats_match: manifest min/max must match the parquet data.
    if (sc.count > 0) {
      if (Math.abs(sc.min - m.score_min) > STATS_EPSILON || Math.abs(sc.max - m.score_max) > STATS_EPSILON) {
        fail(
          'score_stats_match',
          `parquet score min/max (${sc.min}, ${sc.max}) does not match manifest score_min/score_max (${m.score_min}, ${m.score_max})`,
        );
      }
    }

    // Rule feature_stats_match: declared per-feature stats must match.
    if (m.feature_stats !== null) {
      for (const f of FEATURES) {
        const declared = m.feature_stats[f];
        const st = pq.stats.get(f);
        if (!declared || st.count === 0) continue;
        if (
          Math.abs(st.min - declared.min) > STATS_EPSILON ||
          Math.abs(st.max - declared.max) > STATS_EPSILON
        ) {
          fail(
            'feature_stats_match',
            `${f}: parquet min/max (${st.min}, ${st.max}) does not match manifest feature_stats (${declared.min}, ${declared.max})`,
          );
        }
      }
    }
  }

  return done();
}

// ---------------------------------------------------------------------------
// Fixture builder. The selftest and --make-fixture both use it. It writes a
// small but fully contract-shaped snapshot: 8 rows by default.
// ---------------------------------------------------------------------------

function buildFixtureSnapshot(dir, opts = {}) {
  const rowCount = opts.rowCount ?? 8;
  const dateOffsetDays = opts.dateOffsetDays ?? 0;
  const rowCountOverride = opts.rowCountOverride ?? null;
  const corruptFeature = opts.corruptFeature ?? null; // {name, row, value}
  const corruptScore = opts.corruptScore ?? null; // {row, value}
  const postManifest = opts.postManifest ?? null; // (manifest) => manifest

  fs.mkdirSync(dir, { recursive: true });
  const rng = mulberry32(20260812);

  // Generate feature values first. Store them as float32 through Math.fround
  // so the manifest stats and the parquet bytes always agree.
  const ids = [];
  const featureVals = FEATURES.map(() => []);
  for (let i = 0; i < rowCount; i++) {
    ids.push(i + 1);
    for (let fi = 0; fi < FEATURES.length; fi++) {
      featureVals[fi].push(Math.fround(rng()));
    }
  }
  // Compute each score as the exact notebook formula:
  // score = sum over features of polarity * normalized value * weight.
  const scores = [];
  for (let i = 0; i < rowCount; i++) {
    let s = 0;
    for (let fi = 0; fi < FEATURES.length; fi++) {
      const f = FEATURES[fi];
      s += POLARITIES[f] * featureVals[fi][i] * WEIGHTS[f];
    }
    scores.push(Math.fround(s));
  }
  if (corruptFeature) {
    const fi = FEATURES.indexOf(corruptFeature.name);
    featureVals[fi][corruptFeature.row] = Math.fround(corruptFeature.value);
  }
  if (corruptScore) {
    scores[corruptScore.row] = Math.fround(corruptScore.value);
  }

  const columns = [
    { name: 'segment_id', parquetType: PARQUET_TYPE.INT32, values: ids },
    ...FEATURES.map((f, fi) => ({
      name: f,
      parquetType: PARQUET_TYPE.FLOAT,
      values: featureVals[fi],
    })),
    { name: 'score', parquetType: PARQUET_TYPE.FLOAT, values: scores },
  ];
  writeParquetFile(joinPath(dir, PARQUET_NAME), columns, rowCount);

  // segments.geojson carries {id, score} per segment, mirroring the pmtiles
  // property schema.
  const geojson = {
    type: 'FeatureCollection',
    features: ids.map((id, i) => ({
      type: 'Feature',
      properties: { id, score: scores[i] },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-73.95, 40.75 + i * 0.0001],
          [-73.949, 40.751 + i * 0.0001],
        ],
      },
    })),
  };
  fs.writeFileSync(joinPath(dir, 'segments.geojson'), JSON.stringify(geojson));

  // segments.pmtiles needs only the PMTiles v3 magic for this contract check.
  // The T4 build tooling produces real tiles.
  const pmtiles = Buffer.alloc(127);
  pmtiles.write('PMTiles', 0, 'latin1');
  pmtiles[7] = 3;
  fs.writeFileSync(joinPath(dir, 'segments.pmtiles'), pmtiles);

  const manifest = {
    date: todayUtcString(dateOffsetDays),
    row_count: rowCountOverride ?? rowCount,
    score_min: Math.min(...scores),
    score_max: Math.max(...scores),
    feature_stats: Object.fromEntries(
      FEATURES.map((f, fi) => [
        f,
        { min: Math.min(...featureVals[fi]), max: Math.max(...featureVals[fi]) },
      ]),
    ),
    weights_sha256: WEIGHTS_SHA256,
    partial: false,
    feature_vectors: true,
    files: [],
  };
  for (const name of ['segments.geojson', 'segments.pmtiles', PARQUET_NAME]) {
    const b = fs.readFileSync(joinPath(dir, name));
    manifest.files.push({ name, sha256: sha256Hex(b), bytes: b.length });
  }
  const finalManifest = postManifest ? postManifest(manifest) : manifest;
  fs.writeFileSync(joinPath(dir, 'manifest.json'), JSON.stringify(finalManifest, null, 2));
  return finalManifest;
}

// ---------------------------------------------------------------------------
// Selftest. It builds one valid snapshot and five corrupt variants, runs the
// validator CLI as a child process for each, and asserts the exit codes.
// ---------------------------------------------------------------------------

function resolveScriptPath() {
  const p = process.argv[1];
  return p.startsWith('/') ? p : joinPath(process.cwd(), p);
}

function runValidator(dir, extraArgs) {
  return spawnSync(process.execPath, [resolveScriptPath(), dir, ...extraArgs], {
    encoding: 'utf8',
  });
}

function assertCase(num, label, ok, result) {
  if (ok) {
    console.log(`ok ${num} - ${label} (exit ${result.status})`);
    return 1;
  }
  console.error(`not ok ${num} - ${label} (exit ${result.status})`);
  console.error(`--- stdout ---\n${result.stdout}`);
  console.error(`--- stderr ---\n${result.stderr}`);
  return 0;
}

function runSelftest() {
  const tmpBase = process.env.TMPDIR || '/tmp';
  const prefix = joinPath(tmpBase, 'robotability-selftest-');
  const tmp = fs.mkdtempSync(prefix);
  let passed = 0;
  const total = 6;
  try {
    // Case 1: a valid snapshot must pass. The small fixture uses the relaxed
    // row count band, exactly like a small-area test run.
    const validDir = joinPath(tmp, 'valid');
    buildFixtureSnapshot(validDir, { rowCount: 8 });
    let r = runValidator(validDir, ['--relax-row-count', '8']);
    passed += assertCase(1, 'valid snapshot accepted', r.status === 0, r);

    // Case 2: a row count outside the band must fail row_count_band.
    const d2 = joinPath(tmp, 'bad-row-count');
    buildFixtureSnapshot(d2, { rowCount: 8, rowCountOverride: 999999 });
    r = runValidator(d2, ['--relax-row-count', '8']);
    passed += assertCase(
      2,
      'bad row count rejected',
      r.status !== 0 && r.stderr.includes('row_count_band'),
      r,
    );

    // Case 3: a feature value above 1 must fail feature_range.
    const d3 = joinPath(tmp, 'feature-high');
    buildFixtureSnapshot(d3, {
      rowCount: 8,
      corruptFeature: { name: 'sidewalk_width', row: 0, value: 1.5 },
    });
    r = runValidator(d3, ['--relax-row-count', '8']);
    passed += assertCase(
      3,
      'feature above 1 rejected',
      r.status !== 0 && r.stderr.includes('feature_range'),
      r,
    );

    // Case 4: a score above the band must fail score_range.
    const d4 = joinPath(tmp, 'score-high');
    buildFixtureSnapshot(d4, { rowCount: 8, corruptScore: { row: 0, value: 0.9 } });
    r = runValidator(d4, ['--relax-row-count', '8']);
    passed += assertCase(
      4,
      'score out of bounds rejected',
      r.status !== 0 && r.stderr.includes('score_range'),
      r,
    );

    // Case 5: a date 10 days old must fail manifest_date_fresh.
    const d5 = joinPath(tmp, 'stale-date');
    buildFixtureSnapshot(d5, { rowCount: 8, dateOffsetDays: -10 });
    r = runValidator(d5, ['--relax-row-count', '8']);
    passed += assertCase(
      5,
      'stale date rejected',
      r.status !== 0 && r.stderr.includes('manifest_date_fresh'),
      r,
    );

    // Case 6: a flipped sha256 must fail file_sha256.
    const d6 = joinPath(tmp, 'sha-mismatch');
    buildFixtureSnapshot(d6, {
      rowCount: 8,
      postManifest: (m) => {
        const c = m.files[0].sha256;
        m.files[0].sha256 = (c[0] === '0' ? '1' : '0') + c.slice(1);
        return m;
      },
    });
    r = runValidator(d6, ['--relax-row-count', '8']);
    passed += assertCase(
      6,
      'sha mismatch rejected',
      r.status !== 0 && r.stderr.includes('file_sha256'),
      r,
    );
  } finally {
    // The selftest must leave no temp dirs behind.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`SELFTEST ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

function printUsage(stream) {
  stream.write(
    [
      'Usage:',
      '  node validate_snapshot.mjs <snapshot-dir> [--relax-row-count <n>]',
      '  node validate_snapshot.mjs --selftest',
      '  node validate_snapshot.mjs --make-fixture <dir> [--rows <n>]',
      '',
      'Exit codes: 0 = valid, 1 = validation failed, 2 = usage error.',
      '',
    ].join('\n'),
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage(process.stderr);
    process.exit(2);
  }
  if (args[0] === '--selftest') {
    if (args.length !== 1) {
      process.stderr.write('error: --selftest takes no extra arguments\n');
      process.exit(2);
    }
    runSelftest();
    return;
  }
  if (args[0] === '--make-fixture') {
    const dir = args[1];
    if (!dir) {
      process.stderr.write('error: --make-fixture needs a target directory\n');
      process.exit(2);
    }
    let rows = 8;
    const ri = args.indexOf('--rows');
    if (ri !== -1) {
      rows = Number(args[ri + 1]);
      if (!Number.isInteger(rows) || rows <= 0) {
        process.stderr.write('error: --rows must be a positive integer\n');
        process.exit(2);
      }
    }
    buildFixtureSnapshot(dir, { rowCount: rows });
    console.log(`fixture written to ${dir} (${rows} rows)`);
    process.exit(0);
  }
  const dir = args[0];
  let relaxRowCount = null;
  const ri = args.indexOf('--relax-row-count');
  if (ri !== -1) {
    const raw = args[ri + 1];
    relaxRowCount = Number(raw);
    if (raw === undefined || !Number.isInteger(relaxRowCount) || relaxRowCount < 0) {
      process.stderr.write('error: --relax-row-count needs a non-negative integer\n');
      process.exit(2);
    }
  }
  const result = validateSnapshot(dir, { relaxRowCount });
  for (const f of result.failures) {
    process.stderr.write(`FAIL ${f.rule}: ${f.detail}\n`);
  }
  if (result.exitCode === 0) {
    console.log(`PASS ${dir}: snapshot valid`);
  } else {
    process.stderr.write(`REJECTED ${dir}: ${result.failures.length} rule(s) failed\n`);
  }
  process.exit(result.exitCode);
}

main();
