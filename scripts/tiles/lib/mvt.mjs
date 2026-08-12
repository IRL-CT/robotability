// Minimal Mapbox Vector Tile (MVT) decoder.
// It decodes only what the verify step needs: layer names, feature
// counts, and feature properties. It skips geometry coordinates.
// MVT is a simple protobuf format. See github.com/mapbox/vector-tile-spec.

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_BYTES = 2;
const WIRE_32 = 5;

// Read one protobuf varint. Return [value, nextOffset].
function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) {
      throw new Error('MVT varint runs past the end of the buffer');
    }
    const byte = buf[i];
    i += 1;
    // Keep the result as a JS number. All tile values here fit 2^53.
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, i];
    }
    shift += 7;
    if (shift > 63) {
      throw new Error('MVT varint is longer than 64 bits');
    }
  }
}

// Skip one protobuf field. Return the next offset.
function skipField(buf, pos, wire) {
  if (wire === WIRE_VARINT) {
    return readVarint(buf, pos)[1];
  }
  if (wire === WIRE_64) {
    return pos + 8;
  }
  if (wire === WIRE_BYTES) {
    const [len, next] = readVarint(buf, pos);
    return next + len;
  }
  if (wire === WIRE_32) {
    return pos + 4;
  }
  throw new Error(`MVT field uses unknown wire type ${wire}`);
}

// Read a length-delimited field. Return [subBuffer, nextOffset].
function readBytes(buf, pos) {
  const [len, next] = readVarint(buf, pos);
  if (next + len > buf.length) {
    throw new Error('MVT length-delimited field runs past the end of the buffer');
  }
  return [buf.subarray(next, next + len), next + len];
}

// Decode a packed repeated varint field into an array of numbers.
function readPackedVarints(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const [v, next] = readVarint(buf, pos);
    out.push(v);
    pos = next;
  }
  return out;
}

// Decode a zigzag-encoded signed varint (protobuf sint64).
function zigzagToNumber(v) {
  // v is even: positive. v is odd: negative.
  return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}

// Decode one MVT Value message into a JS value.
function parseValue(buf) {
  let pos = 0;
  let result = null;
  while (pos < buf.length) {
    const [tag, next] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    pos = next;
    if (field === 1 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      result = sub.toString('utf8');
      pos = after;
    } else if (field === 2 && wire === WIRE_32) {
      result = buf.readFloatLE(pos);
      pos += 4;
    } else if (field === 3 && wire === WIRE_64) {
      result = buf.readDoubleLE(pos);
      pos += 8;
    } else if (field === 4 && wire === WIRE_VARINT) {
      const [v, after] = readVarint(buf, pos);
      result = v;
      pos = after;
    } else if (field === 5 && wire === WIRE_VARINT) {
      const [v, after] = readVarint(buf, pos);
      result = v;
      pos = after;
    } else if (field === 6 && wire === WIRE_VARINT) {
      const [v, after] = readVarint(buf, pos);
      result = zigzagToNumber(v);
      pos = after;
    } else if (field === 7 && wire === WIRE_VARINT) {
      const [v, after] = readVarint(buf, pos);
      result = v !== 0;
      pos = after;
    } else {
      pos = skipField(buf, pos, wire);
    }
  }
  return result;
}

// Decode one MVT Feature message. Return { tags } where tags is the
// flat key/value index array. Geometry is skipped on purpose.
function parseFeature(buf) {
  let pos = 0;
  let tags = [];
  while (pos < buf.length) {
    const [tagByte, next] = readVarint(buf, pos);
    const field = Math.floor(tagByte / 8);
    const wire = tagByte % 8;
    pos = next;
    if (field === 2 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      tags = readPackedVarints(sub);
      pos = after;
    } else {
      // Skip id (field 1), type (field 3), geometry (field 4).
      pos = skipField(buf, pos, wire);
    }
  }
  return { tags };
}

// Decode one MVT Layer message.
function parseLayer(buf) {
  let pos = 0;
  const layer = { name: '', keys: [], values: [], featureCount: 0, features: [] };
  while (pos < buf.length) {
    const [tagByte, next] = readVarint(buf, pos);
    const field = Math.floor(tagByte / 8);
    const wire = tagByte % 8;
    pos = next;
    if (field === 1 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      layer.name = sub.toString('utf8');
      pos = after;
    } else if (field === 2 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      const feature = parseFeature(sub);
      layer.features.push(feature);
      layer.featureCount += 1;
      pos = after;
    } else if (field === 3 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      layer.keys.push(sub.toString('utf8'));
      pos = after;
    } else if (field === 4 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      layer.values.push(parseValue(sub));
      pos = after;
    } else {
      pos = skipField(buf, pos, wire);
    }
  }
  return layer;
}

// Decode a full MVT tile buffer. Return an array of layers.
export function decodeTile(buf) {
  let pos = 0;
  const layers = [];
  while (pos < buf.length) {
    const [tagByte, next] = readVarint(buf, pos);
    const field = Math.floor(tagByte / 8);
    const wire = tagByte % 8;
    pos = next;
    if (field === 3 && wire === WIRE_BYTES) {
      const [sub, after] = readBytes(buf, pos);
      layers.push(parseLayer(sub));
      pos = after;
    } else {
      pos = skipField(buf, pos, wire);
    }
  }
  return layers;
}

// Build the property object for one decoded feature.
export function featureProperties(layer, feature) {
  const props = {};
  const { tags } = feature;
  if (tags.length % 2 !== 0) {
    throw new Error(`MVT feature in layer "${layer.name}" has an odd tag count`);
  }
  for (let i = 0; i < tags.length; i += 2) {
    const key = layer.keys[tags[i]];
    const value = layer.values[tags[i + 1]];
    props[key] = value;
  }
  return props;
}
