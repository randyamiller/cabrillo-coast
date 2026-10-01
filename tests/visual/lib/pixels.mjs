/* Cabrillo Coast LLC — zero-tolerance PNG pixel comparison for the blog visual comparison (Node built-ins only) */
/**
 * The second layer of the visual comparison (AC-16): every channel of every
 * pixel of a screenshot must equal its baseline exactly.
 *
 * Why Playwright's matcher is not enough on its own: `toHaveScreenshot` with
 * `threshold: 0` and `maxDiffPixels: 0` counts differences with pixelmatch,
 * and Playwright 1.63 passes it only `threshold`. pixelmatch then
 *   - leaves out of the count every changed pixel it classifies as
 *     anti-aliased (`includeAA: false`), so a changed glyph or border edge
 *     can pass, and
 *   - blends each pixel with white by its alpha before comparing, so pixels
 *     that differ only in the colour behind zero alpha compare equal.
 * AC-16's criterion is literal pixel equality, so `blog-visual.spec.mjs` runs
 * `compareScreenshots` once the matcher has passed, and fails the case with
 * `strictMismatchMessage` when any pixel differs.
 *
 * Exports:
 *   decodePng(buffer)                       PNG bytes to RGBA samples
 *   encodePng(image)                        RGBA 8-bit samples to PNG bytes
 *   comparePixels(expected, actual)         exact comparison of two decoded images
 *   compareScreenshots(expectedPng, actualPng)  decode, compare, encode the diff
 *   strictMismatchMessage(name, result)     the failure message of a difference
 *   STRICT_MISMATCH                         recognises that message as reported
 *   MAX_PIXELS                              largest image decoded or compared
 *
 * Decoder: the whole static PNG format (ISO/IEC 15948): every colour type and
 * bit depth, `PLTE` and `tRNS`, the five filter types and Adam7 interlacing.
 * Each chunk's CRC is checked, and any malformed input throws an `Error`
 * naming what is wrong; nothing is guessed or repaired. Ancillary chunks
 * (`gAMA`, `iCCP`, `sRGB`, `pHYs`, `tEXt`, ...) are skipped: they say how to
 * display or describe the stored samples, never what the samples are, and
 * the samples are what is compared.
 *
 * Everything is synchronous and pure: nothing reads or writes files or
 * prints, so the spec decides where evidence goes and a unit test can run
 * every path without a browser.
 */

import { Buffer } from "node:buffer";
import zlib from "node:zlib";

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** The eight bytes every PNG file starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Largest chunk length, image width and image height the format allows (2^31 - 1). */
const FORMAT_LIMIT = 0x7fffffff;

/**
 * Most pixels decoded, encoded or compared (2^26, about 67 million). A
 * full-page blog screenshot is a few million pixels (1280px wide by a few
 * thousand tall), so the limit only refuses inputs that would exhaust
 * memory: 2^26 RGBA pixels are 256 MiB at 8 bits per sample.
 */
export const MAX_PIXELS = 2 ** 26;

/** Channels per pixel and allowed bit depths, by PNG colour type. */
const COLOR_TYPES = new Map([
  [0, { name: "greyscale", channels: 1, depths: [1, 2, 4, 8, 16] }],
  [2, { name: "truecolour", channels: 3, depths: [8, 16] }],
  [3, { name: "indexed-colour", channels: 1, depths: [1, 2, 4, 8] }],
  [4, { name: "greyscale with alpha", channels: 2, depths: [8, 16] }],
  [6, { name: "truecolour with alpha", channels: 4, depths: [8, 16] }],
]);

/** Adam7 passes as [first column, first row, column step, row step]. */
const ADAM7 = Object.freeze([
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]);

/** Most compressed bytes `encodePng` puts in one IDAT chunk. */
const IDAT_CHUNK_BYTES = 1 << 20;

/** Diff image: differing pixels are opaque red; the others are the expected pixel in faint grey. */
const DIFF_RED = Object.freeze([255, 0, 0, 255]);
const DIFF_GREY_OPACITY = 0.1;

/** Line breaks that would split the one-line failure message. */
const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/*
 * The failure message `strictMismatchMessage` builds, as Playwright's JSON
 * reporter serialises the `Error` the spec throws with it: `Error: `, the
 * message, then a line break (before the code snippet) or the end. The size
 * clause appears only when the two images differ in size, worded as
 * Playwright words its own.
 */
export const STRICT_MISMATCH = new RegExp(
  "^Error: Strict pixel comparison failed for [^\\n]+?: " +
    "(?:Expected an image \\d+px by \\d+px, received \\d+px by \\d+px\\. )?" +
    "\\d+ pixels? \\(ratio \\d+\\.\\d{2} of all image pixels\\) differs? from the baseline at zero tolerance\\." +
    "(?:\\n|$)",
);

/**
 * CRC-32 lookup table (polynomial 0xEDB88320, as PNG and zlib use).
 * Computed here because `zlib.crc32` first shipped in Node 22.2 and
 * `package.json` allows any Node 22.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Throws the error every malformed PNG input ends in. */
function invalid(detail) {
  throw new Error(`Invalid PNG: ${detail}`);
}

/** CRC-32 of `bytes[start, end)`. */
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** True for an ASCII letter, the only bytes a chunk type may hold. */
function isLetter(byte) {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/** Bytes in one scanline of `width` pixels, without its filter byte. */
function rowBytes(width, bitsPerPixel) {
  return Math.ceil((width * bitsPerPixel) / 8);
}

/** The Paeth predictor of the PNG filter type 4. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * The sub-images the image data holds, in order: the whole image, or the
 * seven Adam7 passes, some of which are empty for images narrower or
 * shorter than eight pixels. An empty pass has no bytes at all.
 * @returns {{ x0: number, y0: number, dx: number, dy: number, width: number, height: number }[]}
 */
function subImages(header) {
  if (header.interlace === 0) {
    return [{ x0: 0, y0: 0, dx: 1, dy: 1, width: header.width, height: header.height }];
  }
  return ADAM7.map(([x0, y0, dx, dy]) => ({
    x0,
    y0,
    dx,
    dy,
    width: header.width > x0 ? Math.ceil((header.width - x0) / dx) : 0,
    height: header.height > y0 ? Math.ceil((header.height - y0) / dy) : 0,
  }));
}

/** Parses and validates the 13 bytes of IHDR. */
function parseHeader(data) {
  if (data.length !== 13) invalid(`IHDR is ${data.length} bytes long, not 13`);
  const header = {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    depth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
  const { width, height, depth, colorType } = header;
  if (width === 0 || height === 0 || width > FORMAT_LIMIT || height > FORMAT_LIMIT) {
    invalid(`the image is ${width} by ${height} pixels; each side must be 1 to ${FORMAT_LIMIT}`);
  }
  const type = COLOR_TYPES.get(colorType);
  if (type === undefined) invalid(`colour type ${colorType} is not 0, 2, 3, 4 or 6`);
  if (!type.depths.includes(depth)) {
    invalid(`bit depth ${depth} is not allowed for colour type ${colorType} (${type.name}), only ${type.depths.join(", ")}`);
  }
  if (header.compression !== 0) invalid(`compression method ${header.compression} is not 0`);
  if (header.filter !== 0) invalid(`filter method ${header.filter} is not 0`);
  if (header.interlace !== 0 && header.interlace !== 1) invalid(`interlace method ${header.interlace} is not 0 or 1`);
  if (width * height > MAX_PIXELS) {
    invalid(`the image is ${width} by ${height} pixels, more than the ${MAX_PIXELS}-pixel limit`);
  }
  return { ...header, channels: type.channels };
}

/** Validates PLTE against IHDR; returns the palette's RGB bytes. */
function parsePalette(data, header) {
  if (header.colorType === 0 || header.colorType === 4) invalid("a greyscale image has a PLTE chunk");
  if (data.length === 0 || data.length % 3 !== 0) invalid(`PLTE is ${data.length} bytes long, not a positive multiple of 3`);
  const entries = data.length / 3;
  const limit = header.colorType === 3 ? Math.min(256, 2 ** header.depth) : 256;
  if (entries > limit) invalid(`PLTE has ${entries} entries, more than the ${limit} this image allows`);
  return data;
}

/**
 * Validates tRNS against IHDR and PLTE.
 * @returns {{ grey?: number, rgb?: number[], alpha?: Uint8Array }} the
 *   transparent grey or RGB sample, or the alpha of each palette entry.
 */
function parseTransparency(data, header, palette) {
  const max = 2 ** header.depth - 1;
  const sample = (offset) => {
    const value = data.readUInt16BE(offset);
    if (value > max) invalid(`tRNS sample ${value} does not fit bit depth ${header.depth}`);
    return value;
  };
  switch (header.colorType) {
    case 0:
      if (data.length !== 2) invalid(`tRNS of a greyscale image is ${data.length} bytes long, not 2`);
      return { grey: sample(0) };
    case 2:
      if (data.length !== 6) invalid(`tRNS of a truecolour image is ${data.length} bytes long, not 6`);
      return { rgb: [sample(0), sample(2), sample(4)] };
    case 3:
      if (palette === null) invalid("tRNS comes before PLTE");
      if (data.length > palette.length / 3) {
        invalid(`tRNS has ${data.length} entries, more than the ${palette.length / 3} palette entries`);
      }
      return { alpha: data };
    default:
      return invalid(`tRNS is not allowed in an image with an alpha channel (colour type ${header.colorType})`);
  }
}

/**
 * Reverses the scanline filters of one sub-image in place.
 * @param {Buffer} raw Inflated image data.
 * @param {number} offset Where the sub-image's first filter byte is.
 * @param {number} rows Scanlines in the sub-image.
 * @param {number} stride Bytes per scanline after its filter byte.
 * @param {number} bpp Bytes per complete pixel, at least 1.
 * @param {string} where The sub-image, for error messages.
 */
function unfilter(raw, offset, rows, stride, bpp, where) {
  let previous = -1;
  for (let y = 0; y < rows; y += 1) {
    const filterAt = offset + y * (stride + 1);
    const start = filterAt + 1;
    const type = raw[filterAt];
    switch (type) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < stride; i += 1) raw[start + i] = (raw[start + i] + raw[start + i - bpp]) & 0xff;
        break;
      case 2:
        if (previous >= 0) {
          for (let i = 0; i < stride; i += 1) raw[start + i] = (raw[start + i] + raw[previous + i]) & 0xff;
        }
        break;
      case 3:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bpp ? raw[start + i - bpp] : 0;
          const up = previous >= 0 ? raw[previous + i] : 0;
          raw[start + i] = (raw[start + i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i += 1) {
          const left = i >= bpp ? raw[start + i - bpp] : 0;
          const up = previous >= 0 ? raw[previous + i] : 0;
          const upLeft = previous >= 0 && i >= bpp ? raw[previous + i - bpp] : 0;
          raw[start + i] = (raw[start + i] + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        invalid(`scanline ${y}${where} has filter type ${type}, not 0 to 4`);
    }
    previous = start;
  }
}

/**
 * Reads sample `index` of the scanline starting at byte `row`, at the
 * image's bit depth. Samples narrower than a byte are packed from the most
 * significant bit, and each scanline starts on a byte boundary.
 */
function sampleReader(raw, depth) {
  if (depth === 8) return (row, index) => raw[row + index];
  if (depth === 16) return (row, index) => (raw[row + 2 * index] << 8) | raw[row + 2 * index + 1];
  const mask = (1 << depth) - 1;
  return (row, index) => {
    const bit = index * depth;
    return (raw[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
  };
}

/** Validates a decoded image for `comparePixels`; `label` names it in the error. */
function checkDecoded(image, label) {
  if (image === null || typeof image !== "object") throw new TypeError(`comparePixels: the ${label} image is not a decoded image`);
  const { width, height, depth, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`comparePixels: the ${label} image has no positive integer width and height`);
  }
  const typed = depth === 8 ? data instanceof Uint8Array || data instanceof Uint8ClampedArray : depth === 16 && data instanceof Uint16Array;
  if (!typed) {
    throw new TypeError(`comparePixels: the ${label} image needs depth 8 with a Uint8Array or depth 16 with a Uint16Array`);
  }
  if (data.length !== width * height * 4) {
    throw new TypeError(`comparePixels: the ${label} image holds ${data.length} samples, not ${width * height * 4} (RGBA)`);
  }
}

/** One PNG chunk: length, type, data and CRC. */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

/* ------------------------------------------------------------------------ */
/* Decoding and encoding                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Decodes a PNG file to RGBA samples at its own precision: 8 bits per
 * sample for bit depths up to 8 and for palettes, 16 bits for bit depth 16.
 * Greyscale is copied to R, G and B; samples of 1, 2 and 4 bits are scaled
 * exactly to 8 bits (by 255, 85 and 17); alpha comes from the image, from
 * `tRNS` (0 for the transparent grey or RGB value, the entry's alpha for a
 * palette index) or is fully opaque.
 *
 * @example
 *   const { width, height, depth, data } = decodePng(fs.readFileSync("listing-375-light.png"));
 *   // data[(y * width + x) * 4 + 3] is the alpha of pixel (x, y)
 *
 * @param {Uint8Array} buffer The file's bytes.
 * @returns {{ width: number, height: number, depth: 8 | 16, data: Uint8Array | Uint16Array }}
 *   `data` holds `width * height * 4` samples, row by row.
 * @throws {Error} `Invalid PNG: ...` naming the defect: a missing signature,
 *   a truncated or out-of-order chunk, a bad CRC, an invalid header,
 *   palette or transparency chunk, an unknown critical chunk, image data
 *   that cannot be inflated or is not exactly the size the header implies,
 *   an unknown filter type, a palette index outside the palette, bytes after
 *   IEND, or more than MAX_PIXELS pixels.
 */
export function decodePng(buffer) {
  if (!(buffer instanceof Uint8Array)) throw new TypeError("decodePng: expected the PNG file as a Buffer or Uint8Array");
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    invalid("the file does not start with the PNG signature");
  }

  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  /** Where the walk stands relative to the IDAT run: before it, inside it or after it. */
  let idatState = "before";
  let ended = false;
  let offset = SIGNATURE.length;

  while (offset < bytes.length && !ended) {
    if (bytes.length - offset < 12) invalid(`the chunk at byte ${offset} is truncated`);
    const length = bytes.readUInt32BE(offset);
    if (length > FORMAT_LIMIT) invalid(`the chunk at byte ${offset} declares ${length} bytes, more than ${FORMAT_LIMIT}`);
    const typeAt = offset + 4;
    const dataAt = offset + 8;
    const crcAt = dataAt + length;
    if (crcAt + 4 > bytes.length) invalid(`the chunk at byte ${offset} is truncated: it declares ${length} bytes of data`);
    if (![0, 1, 2, 3].every((i) => isLetter(bytes[typeAt + i]))) {
      invalid(`the chunk at byte ${offset} has an invalid type (bytes ${bytes.subarray(typeAt, dataAt).toString("hex")})`);
    }
    const type = bytes.toString("latin1", typeAt, dataAt);
    if (crc32(bytes, typeAt, crcAt) !== bytes.readUInt32BE(crcAt)) invalid(`the ${type} chunk at byte ${offset} has a bad CRC`);
    const data = bytes.subarray(dataAt, crcAt);
    if (header === null && type !== "IHDR") invalid(`the first chunk is ${type}, not IHDR`);
    if (type !== "IDAT" && idatState === "inside") idatState = "after";

    switch (type) {
      case "IHDR":
        if (header !== null) invalid("there is more than one IHDR chunk");
        header = parseHeader(data);
        break;
      case "PLTE":
        if (palette !== null) invalid("there is more than one PLTE chunk");
        if (idatState !== "before") invalid("PLTE comes after the image data");
        if (transparency !== null) invalid("PLTE comes after tRNS");
        palette = parsePalette(data, header);
        break;
      case "tRNS":
        if (transparency !== null) invalid("there is more than one tRNS chunk");
        if (idatState !== "before") invalid("tRNS comes after the image data");
        transparency = parseTransparency(data, header, palette);
        break;
      case "IDAT":
        if (idatState === "after") invalid("the IDAT chunks are not consecutive");
        idatState = "inside";
        idat.push(data);
        break;
      case "IEND":
        if (length !== 0) invalid(`IEND holds ${length} bytes of data`);
        ended = true;
        break;
      default:
        // Bit 5 of the first byte clear (an upper-case letter) marks a chunk
        // a decoder must understand to read the image.
        if ((bytes[typeAt] & 0x20) === 0) invalid(`the critical chunk ${type} is not part of PNG`);
    }
    offset = crcAt + 4;
  }

  if (header === null) invalid("there is no IHDR chunk");
  if (!ended) invalid("there is no IEND chunk (the file is truncated)");
  if (offset !== bytes.length) invalid(`${bytes.length - offset} bytes follow the IEND chunk`);
  if (idat.length === 0) invalid("there is no IDAT chunk");
  if (header.colorType === 3 && palette === null) invalid("an indexed-colour image has no PLTE chunk");

  const { width, height, depth, colorType, channels } = header;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const parts = subImages(header);
  let expectedLength = 0;
  for (const part of parts) {
    if (part.width > 0 && part.height > 0) expectedLength += part.height * (1 + rowBytes(part.width, bitsPerPixel));
  }

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expectedLength });
  } catch (err) {
    if (err && err.code === "ERR_BUFFER_TOO_LARGE") {
      invalid(`the image data inflates to more than the ${expectedLength} bytes a ${width} by ${height} image holds`);
    }
    invalid(`the image data cannot be inflated: ${err && err.message ? err.message : String(err)}`);
  }
  if (raw.length !== expectedLength) {
    invalid(`the image data inflates to ${raw.length} bytes, not the ${expectedLength} a ${width} by ${height} image holds`);
  }

  const wide = depth === 16;
  const max = wide ? 0xffff : 0xff;
  const data = wide ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  // Samples of 1, 2 and 4 bits scale exactly to 8 bits; palette indices are not scaled.
  const scale = depth < 8 && colorType === 0 ? 255 / (2 ** depth - 1) : 1;
  const read = sampleReader(raw, depth);
  const entries = palette === null ? 0 : palette.length / 3;

  let offsetInRaw = 0;
  parts.forEach((part, index) => {
    if (part.width === 0 || part.height === 0) return;
    const stride = rowBytes(part.width, bitsPerPixel);
    const where = header.interlace === 1 ? ` of Adam7 pass ${index + 1}` : "";
    unfilter(raw, offsetInRaw, part.height, stride, bpp, where);
    for (let r = 0; r < part.height; r += 1) {
      const row = offsetInRaw + r * (stride + 1) + 1;
      const y = part.y0 + r * part.dy;
      for (let c = 0; c < part.width; c += 1) {
        const x = part.x0 + c * part.dx;
        const out = (y * width + x) * 4;
        const first = c * channels;
        if (colorType === 0) {
          const grey = read(row, first);
          const value = grey * scale;
          data[out] = value;
          data[out + 1] = value;
          data[out + 2] = value;
          data[out + 3] = transparency !== null && grey === transparency.grey ? 0 : max;
        } else if (colorType === 2) {
          const red = read(row, first);
          const green = read(row, first + 1);
          const blue = read(row, first + 2);
          data[out] = red;
          data[out + 1] = green;
          data[out + 2] = blue;
          const key = transparency === null ? null : transparency.rgb;
          data[out + 3] = key !== null && red === key[0] && green === key[1] && blue === key[2] ? 0 : max;
        } else if (colorType === 3) {
          const entry = read(row, first);
          if (entry >= entries) invalid(`pixel (${x}, ${y}) uses palette index ${entry}, but PLTE has ${entries} entries`);
          data[out] = palette[entry * 3];
          data[out + 1] = palette[entry * 3 + 1];
          data[out + 2] = palette[entry * 3 + 2];
          data[out + 3] = transparency !== null && entry < transparency.alpha.length ? transparency.alpha[entry] : 0xff;
        } else if (colorType === 4) {
          const grey = read(row, first);
          data[out] = grey;
          data[out + 1] = grey;
          data[out + 2] = grey;
          data[out + 3] = read(row, first + 1);
        } else {
          data[out] = read(row, first);
          data[out + 1] = read(row, first + 1);
          data[out + 2] = read(row, first + 2);
          data[out + 3] = read(row, first + 3);
        }
      }
    }
    offsetInRaw += part.height * (stride + 1);
  });

  return { width, height, depth: wide ? 16 : 8, data };
}

/**
 * Encodes RGBA samples of 8 bits as a PNG file (colour type 6, bit depth 8,
 * no interlacing, filter type 0 on every scanline).
 * @param {{ width: number, height: number, data: Uint8Array | Uint8ClampedArray }} image
 *   `data` holds `width * height * 4` samples, row by row.
 * @returns {Buffer}
 * @throws {TypeError | RangeError} when the image is not RGBA at 8 bits or has
 *   more than MAX_PIXELS pixels.
 */
export function encodePng(image) {
  const { width, height, data } = image ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError("encodePng: width and height must be positive integers");
  }
  if (width > FORMAT_LIMIT || height > FORMAT_LIMIT || width * height > MAX_PIXELS) {
    throw new RangeError(`encodePng: ${width} by ${height} pixels is more than the ${MAX_PIXELS}-pixel limit`);
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError(`encodePng: data must be ${width * height * 4} RGBA samples of 8 bits (a Uint8Array)`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const compressed = zlib.deflateSync(raw);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [SIGNATURE, chunk("IHDR", header)];
  for (let at = 0; at < compressed.length; at += IDAT_CHUNK_BYTES) {
    chunks.push(chunk("IDAT", compressed.subarray(at, at + IDAT_CHUNK_BYTES)));
  }
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------------ */
/* Comparison                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Compares two decoded images pixel by pixel with zero tolerance: a pixel is
 * equal only when its R, G, B and alpha samples all are, at full precision
 * (an 8-bit sample `v` equals a 16-bit sample `v * 257`). There is no colour
 * distance, no anti-aliasing allowance and no blending by alpha. Images of
 * different sizes are compared over the larger width and the larger height:
 * a pixel that only one of them has is different, and the corner that
 * neither has (one image wider, the other taller) is not compared.
 *
 * @param {{ width: number, height: number, depth: 8 | 16, data: Uint8Array | Uint16Array }} expected
 * @param {{ width: number, height: number, depth: 8 | 16, data: Uint8Array | Uint16Array }} actual
 * @returns {{
 *   equal: boolean,
 *   differentPixels: number,
 *   totalPixels: number,
 *   expectedSize: { width: number, height: number },
 *   actualSize: { width: number, height: number },
 *   diff: { width: number, height: number, data: Uint8Array },
 * }} `diff` is an RGBA 8-bit image over the compared area: each differing
 *   pixel is opaque red, every other one the expected pixel in faint grey
 *   (white where neither image has a pixel).
 * @throws {TypeError} when either argument is not a decoded image.
 * @throws {RangeError} when the compared area exceeds MAX_PIXELS.
 */
export function comparePixels(expected, actual) {
  checkDecoded(expected, "expected");
  checkDecoded(actual, "actual");
  const width = Math.max(expected.width, actual.width);
  const height = Math.max(expected.height, actual.height);
  const totalPixels = width * height;
  if (totalPixels > MAX_PIXELS) {
    throw new RangeError(`comparePixels: comparing over ${width} by ${height} pixels is more than the ${MAX_PIXELS}-pixel limit`);
  }
  // Every sample on the 16-bit scale: 8-bit samples times 257 (0xff becomes 0xffff).
  const expectedScale = expected.depth === 8 ? 257 : 1;
  const actualScale = actual.depth === 8 ? 257 : 1;
  const expectedTo8 = expected.depth === 8 ? 1 : 1 / 257;
  const e = expected.data;
  const a = actual.data;
  const diff = new Uint8Array(totalPixels * 4);
  let differentPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      const inExpected = x < expected.width && y < expected.height;
      const inActual = x < actual.width && y < actual.height;
      const ei = (y * expected.width + x) * 4;
      let same;
      if (inExpected && inActual) {
        const ai = (y * actual.width + x) * 4;
        same =
          e[ei] * expectedScale === a[ai] * actualScale &&
          e[ei + 1] * expectedScale === a[ai + 1] * actualScale &&
          e[ei + 2] * expectedScale === a[ai + 2] * actualScale &&
          e[ei + 3] * expectedScale === a[ai + 3] * actualScale;
      } else {
        // A pixel only one image has differs; the corner neither has (one
        // image wider, the other taller) holds nothing to compare.
        same = !inExpected && !inActual;
      }
      if (same) {
        // Luma of the expected pixel, faded towards white by its own alpha
        // and the diff's grey opacity; a pixel neither image has is white.
        const luma = inExpected ? (e[ei] * 0.29889531 + e[ei + 1] * 0.58662247 + e[ei + 2] * 0.11448223) * expectedTo8 : 255;
        const opacity = inExpected ? (DIFF_GREY_OPACITY * e[ei + 3] * expectedTo8) / 255 : 0;
        const grey = Math.round(255 + (luma - 255) * opacity);
        diff[out] = grey;
        diff[out + 1] = grey;
        diff[out + 2] = grey;
        diff[out + 3] = 255;
      } else {
        differentPixels += 1;
        diff.set(DIFF_RED, out);
      }
    }
  }

  return {
    equal: differentPixels === 0,
    differentPixels,
    totalPixels,
    expectedSize: { width: expected.width, height: expected.height },
    actualSize: { width: actual.width, height: actual.height },
    diff: { width, height, data: diff },
  };
}

/**
 * Decodes two PNG screenshots and compares them with `comparePixels`.
 *
 * @example
 *   const result = compareScreenshots(baselineBytes, screenshotBytes);
 *   if (!result.equal) fs.writeFileSync("listing-375-light-diff.png", result.diffPng);
 *
 * @param {Uint8Array} expectedPng The baseline file.
 * @param {Uint8Array} actualPng The new screenshot.
 * @returns {ReturnType<typeof comparePixels> & { diffPng?: Buffer }} the
 *   comparison, plus the diff image encoded as PNG when they differ.
 * @throws {Error} when either file cannot be decoded, naming which and why.
 */
export function compareScreenshots(expectedPng, actualPng) {
  const decode = (png, label) => {
    try {
      return decodePng(png);
    } catch (err) {
      throw new Error(`the ${label} image cannot be decoded: ${err.message}`, { cause: err });
    }
  };
  const result = comparePixels(decode(expectedPng, "expected"), decode(actualPng, "actual"));
  return result.equal ? result : { ...result, diffPng: encodePng(result.diff) };
}

/**
 * The one-line message a case fails with when `comparePixels` found a
 * difference. The ratio is rounded up to hundredths of the compared area,
 * as Playwright rounds its own, and the size clause is Playwright's wording.
 *
 * @example
 *   strictMismatchMessage("listing-375-light.png", result)
 *   // "Strict pixel comparison failed for listing-375-light.png: 1 pixel (ratio 0.01 of all image pixels)
 *   //  differs from the baseline at zero tolerance."   (one line)
 *
 * @param {string} name Screenshot file name.
 * @param {ReturnType<typeof comparePixels>} result A comparison that found a difference.
 * @returns {string} a message that STRICT_MISMATCH recognises once prefixed with `Error: `.
 * @throws {TypeError} when `result` reports no difference.
 */
export function strictMismatchMessage(name, result) {
  if (result === null || typeof result !== "object" || result.equal !== false || !(result.differentPixels >= 1)) {
    throw new TypeError("strictMismatchMessage: the comparison found no difference");
  }
  const { expectedSize, actualSize, differentPixels, totalPixels } = result;
  const size =
    expectedSize.width !== actualSize.width || expectedSize.height !== actualSize.height
      ? `Expected an image ${expectedSize.width}px by ${expectedSize.height}px, ` +
        `received ${actualSize.width}px by ${actualSize.height}px. `
      : "";
  const ratio = Math.ceil((differentPixels / totalPixels) * 100) / 100;
  const pixels = differentPixels === 1 ? "1 pixel" : `${differentPixels} pixels`;
  const verb = differentPixels === 1 ? "differs" : "differ";
  const label = String(name).replace(LINE_BREAKS, " ");
  return (
    `Strict pixel comparison failed for ${label}: ${size}${pixels} ` +
    `(ratio ${ratio.toFixed(2)} of all image pixels) ${verb} from the baseline at zero tolerance.`
  );
}
