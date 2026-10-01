/* Cabrillo Coast LLC — unit proof of the zero-tolerance screenshot comparison (AC-16, F-018) */
/**
 * AC-16 holds the blog's screenshots to literal pixel equality. Playwright's
 * `toHaveScreenshot` with `threshold: 0` and `maxDiffPixels: 0` does not
 * give that on its own: its pixelmatch comparator leaves anti-aliased pixels
 * out of the count and blends every pixel with white by its alpha. So
 * `tests/visual/blog-visual.spec.mjs` compares each screenshot again with
 * `tests/visual/lib/pixels.mjs`. This suite proves that module and its
 * place in the runner:
 *   - `encodePng` output round-trips through `decodePng` and through
 *     Playwright's own decoder;
 *   - `decodePng` decodes every colour type and bit depth, `PLTE` and
 *     `tRNS`, the five filter types and Adam7 interlacing (empty passes
 *     included), from PNG files this suite writes itself, and refuses
 *     malformed files with a message naming the defect;
 *   - `comparePixels` finds a one-unit change in any channel, a size
 *     difference, and treats an 8-bit sample `v` as equal to a 16-bit
 *     `v * 257`;
 *   - an anti-alias-only difference and a difference behind zero alpha,
 *     which Playwright's comparator accepts at `threshold: 0` and
 *     `maxDiffPixels: 0`, are each one differing pixel here, with a diff;
 *   - `strictMismatchMessage`, as Playwright 1.63 reports the thrown
 *     `Error`, matches `STRICT_MISMATCH`, and no other failure does;
 *   - `classifyComparison` in `tests/visual/run-visual.mjs` counts a case
 *     failed solely by the strict comparison, with its actual image, as a
 *     screenshot difference, and anything else as a problem.
 *
 * Runs with `node --test tests/unit/visual-pixels.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no Jekyll build, no git, no
 * browser and no network, and writes no files. Playwright's comparator is
 * loaded from the installed `playwright-core` (`npm ci`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

import {
  MAX_PIXELS,
  STRICT_MISMATCH,
  comparePixels,
  compareScreenshots,
  decodePng,
  encodePng,
  strictMismatchMessage,
} from '../visual/lib/pixels.mjs';
import { classifyComparison } from '../visual/run-visual.mjs';

const require = createRequire(import.meta.url);
const { getComparator } = require('playwright-core/lib/coreBundle').utils;

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Playwright's PNG comparator, as `toHaveScreenshot` uses it. */
const playwrightCompare = getComparator('image/png');

/** The options every `toHaveScreenshot` call in blog-visual.spec.mjs passes. */
const SPEC_OPTIONS = Object.freeze({ threshold: 0, maxDiffPixels: 0 });

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel by colour type. */
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

/** Adam7 passes as [first column, first row, column step, row step]. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** Case titles of blog-visual.spec.mjs: two pages, three widths, two schemes. */
const CASES = ['listing', 'article'].flatMap((page) =>
  [375, 800, 1280].flatMap((width) => ['light', 'dark'].map((scheme) => ({ page, width, scheme }))),
);

/** How Playwright 1.63's JSON reporter follows a thrown error's message: a blank line, then the code snippet. */
const SNIPPET =
  '\n\n  175 |     log("x");\n  176 |   }\n> 177 |   throw new Error(strictMismatchMessage(file, result));\n      |         ^';

/* ------------------------------------------------------------------------ */
/* A small PNG writer, independent of the module under test                  */
/* ------------------------------------------------------------------------ */

/** CRC-32 bit by bit (polynomial 0xEDB88320), unlike the module's table. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One chunk: length, type, data and its CRC. */
function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The 13 bytes of IHDR; `fields` overrides compression, filter and interlace. */
function ihdr(width, height, depth, colorType, fields = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colorType;
  data[10] = fields.compression ?? 0;
  data[11] = fields.filter ?? 0;
  data[12] = fields.interlace ?? 0;
  return chunk('IHDR', data);
}

/** A PNG file of the given chunks. */
function png(...chunks) {
  return Buffer.concat([SIGNATURE, ...chunks]);
}

/** `samples` packed into bytes at `depth`, most significant bits first. */
function packRow(samples, depth) {
  if (depth === 8) return Buffer.from(samples);
  if (depth === 16) {
    const out = Buffer.alloc(samples.length * 2);
    samples.forEach((value, i) => out.writeUInt16BE(value, i * 2));
    return out;
  }
  const out = Buffer.alloc(Math.ceil((samples.length * depth) / 8));
  samples.forEach((value, i) => {
    const bit = i * depth;
    out[bit >> 3] |= value << (8 - depth - (bit & 7));
  });
  return out;
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

/** One scanline filtered with `type` (0 to 4), filter byte first. */
function filterRow(row, previous, bpp, type) {
  const out = Buffer.alloc(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = previous === null ? 0 : previous[i];
    const upLeft = previous !== null && i >= bpp ? previous[i - bpp] : 0;
    const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type] ?? 0;
    out[i + 1] = (row[i] - predictor) & 0xff;
  }
  return out;
}

/**
 * Uncompressed image data: `pixels[y][x]` holds a pixel's samples in its
 * colour type's order, rows are packed at `depth`, split into the Adam7
 * passes when `interlace` is 1, and scanline n is filtered with `filter(n)`.
 */
function imageData({ pixels, depth, colorType, interlace = 0, filter = () => 0 }) {
  const height = pixels.length;
  const width = pixels[0].length;
  const bpp = Math.max(1, (CHANNELS[colorType] * depth) >> 3);
  const parts = [];
  let scanline = 0;
  for (const [x0, y0, dx, dy] of interlace === 1 ? ADAM7 : [[0, 0, 1, 1]]) {
    let previous = null;
    for (let y = y0; y < height; y += dy) {
      const samples = [];
      for (let x = x0; x < width; x += dx) samples.push(...pixels[y][x]);
      // An empty pass has no scanlines at all.
      if (samples.length === 0) break;
      const row = packRow(samples, depth);
      parts.push(filterRow(row, previous, bpp, filter(scanline)));
      scanline += 1;
      previous = row;
    }
  }
  return Buffer.concat(parts);
}

/**
 * A PNG file of `pixels` (see `imageData`), with `before` chunks (PLTE,
 * tRNS, ancillary) between IHDR and IDAT.
 */
function makePng({ pixels, depth, colorType, interlace = 0, filter, before = [] }) {
  const data = imageData({ pixels, depth, colorType, interlace, filter });
  return png(
    ihdr(pixels[0].length, pixels.length, depth, colorType, { interlace }),
    ...before,
    chunk('IDAT', zlib.deflateSync(data)),
    chunk('IEND'),
  );
}

/** A `height` × `width` grid of `pixel(x, y)`. */
function grid(width, height, pixel) {
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => pixel(x, y)));
}

/** Deterministic pseudo-random integers in [0, limit) (mulberry32). */
function random(seed) {
  let state = seed >>> 0;
  return (limit) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit);
  };
}

/** A decoded RGBA image from per-pixel [r, g, b, a] values. */
function rgba(width, height, pixel, depth = 8) {
  const data = depth === 16 ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, depth, data };
}

/** Samples of pixel (x, y) of a decoded image. */
function at(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(i, i + 4));
}

/** A valid 2 × 2 RGBA 8-bit file, the base of the malformed-file cases. */
function validFile() {
  return makePng({ pixels: grid(2, 2, (x, y) => [x * 100, y * 100, 50, 255]), depth: 8, colorType: 6 });
}

/** Offset of the first chunk of `type` in a PNG file. */
function chunkOffset(file, type) {
  let offset = 8;
  while (offset < file.length) {
    if (file.toString('latin1', offset + 4, offset + 8) === type) return offset;
    offset += 12 + file.readUInt32BE(offset);
  }
  throw new Error(`no ${type} chunk`);
}

/**
 * A Playwright 1.63 JSON report of the 12-case comparison run: every case
 * passed except those `failures` replaces with its own result.
 */
function report(failures = {}) {
  const specs = CASES.map(({ page, width, scheme }) => {
    const title = `[AC-16][F-018] ${page} ${width}px ${scheme}`;
    const result = failures[title] ?? { status: 'passed', errors: [], attachments: [] };
    return { title, ok: result.status === 'passed', tests: [{ projectName: 'chromium', results: [result] }] };
  });
  return {
    config: {},
    suites: [
      {
        title: 'blog-visual.spec.mjs',
        file: 'blog-visual.spec.mjs',
        specs: [],
        suites: [{ title: '[AC-16][F-018] blog visual comparison', file: 'blog-visual.spec.mjs', specs }],
      },
    ],
    errors: [],
    stats: {},
  };
}

/** The three evidence attachments the spec writes for screenshot `stem`. */
function evidence(stem, suffixes = ['expected', 'actual', 'diff']) {
  return suffixes.map((suffix) => ({
    name: `${stem}-${suffix}.png`,
    contentType: 'image/png',
    path: `/repo/tests/visual/test-results/case/attachments/${stem}-${suffix}-png-0123.png`,
  }));
}

/** The 5 × 5 opaque grey ramp of the anti-alias case: columns 0, 0, 128, 255, 255. */
function ramp(centre) {
  const columns = [0, 0, 128, 255, 255];
  return rgba(5, 5, (x, y) => {
    const value = x === 2 && y === 2 ? centre : columns[x];
    return [value, value, value, 255];
  });
}

/* ------------------------------------------------------------------------ */
/* Encoding and decoding                                                     */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] encodePng output round-trips through decodePng and Playwright\'s decoder', () => {
  const next = random(0x16a);
  const image = rgba(13, 7, () => [next(256), next(256), next(256), next(256)]);
  const file = encodePng(image);
  assert.deepEqual(file.subarray(0, 8), SIGNATURE);
  const decoded = decodePng(file);
  assert.deepEqual(decoded, { width: 13, height: 7, depth: 8, data: image.data });
  assert.deepEqual(decodePng(new Uint8Array(file)).data, image.data, 'a plain Uint8Array decodes too');

  // Playwright decodes it and finds it equal to itself, and unequal once an opaque pixel changes.
  assert.equal(playwrightCompare(file, file, SPEC_OPTIONS), null);
  const opaque = rgba(13, 7, (x, y) => [x * 19, y * 36, 90, 255]);
  const changed = rgba(13, 7, (x, y) => (x === 6 && y === 3 ? [255, 255, 255, 255] : [x * 19, y * 36, 90, 255]));
  assert.equal(playwrightCompare(encodePng(opaque), encodePng(opaque), SPEC_OPTIONS), null);
  assert.match(playwrightCompare(encodePng(changed), encodePng(opaque), SPEC_OPTIONS).errorMessage, /^1 pixels/);

  assert.throws(() => encodePng({ width: 0, height: 1, data: new Uint8Array(0) }), TypeError);
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(15) }), TypeError);
  assert.throws(() => encodePng({ width: 1, height: 1, data: new Uint16Array(4) }), TypeError);
  assert.throws(() => encodePng({ width: MAX_PIXELS, height: 2, data: new Uint8Array(4) }), RangeError);
});

test('[AC-16][F-018] decodes greyscale at bit depths 1, 2, 4, 8 and 16, with and without tRNS', () => {
  for (const [depth, scale] of [
    [1, 255],
    [2, 85],
    [4, 17],
  ]) {
    const levels = 2 ** depth;
    // Nine and ten columns: scanlines end inside a byte.
    for (const width of [9, 10]) {
      const pixels = grid(width, 3, (x, y) => [(x + 2 * y) % levels]);
      const plain = decodePng(makePng({ pixels, depth, colorType: 0 }));
      assert.equal(plain.depth, 8);
      assert.ok(plain.data instanceof Uint8Array);
      const keyed = decodePng(
        makePng({ pixels, depth, colorType: 0, before: [chunk('tRNS', Buffer.from([0, 1]))] }),
      );
      for (let y = 0; y < 3; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sample = pixels[y][x][0];
          const value = sample * scale;
          assert.deepEqual(at(plain, x, y), [value, value, value, 255], `depth ${depth} (${x}, ${y})`);
          assert.deepEqual(at(keyed, x, y), [value, value, value, sample === 1 ? 0 : 255]);
        }
      }
    }
  }

  const eight = decodePng(makePng({ pixels: [[[0], [1], [127], [128], [254], [255]]], depth: 8, colorType: 0 }));
  assert.deepEqual(Array.from(eight.data), [0, 0, 0, 255, 1, 1, 1, 255, 127, 127, 127, 255, 128, 128, 128, 255, 254, 254, 254, 255, 255, 255, 255, 255]);

  const sixteen = decodePng(
    makePng({
      pixels: [[[0], [1], [257], [65534], [65535]]],
      depth: 16,
      colorType: 0,
      before: [chunk('tRNS', Buffer.from([0x01, 0x01]))],
    }),
  );
  assert.equal(sixteen.depth, 16);
  assert.ok(sixteen.data instanceof Uint16Array);
  assert.deepEqual(Array.from(sixteen.data), [
    0, 0, 0, 65535, 1, 1, 1, 65535, 257, 257, 257, 0, 65534, 65534, 65534, 65535, 65535, 65535, 65535, 65535,
  ]);
});

test('[AC-16][F-018] decodes truecolour, greyscale with alpha and truecolour with alpha at 8 and 16 bits', () => {
  const rgb8 = decodePng(
    makePng({
      pixels: [[[10, 20, 30], [10, 20, 31], [255, 0, 0]]],
      depth: 8,
      colorType: 2,
      before: [chunk('tRNS', Buffer.from([0, 10, 0, 20, 0, 30]))],
    }),
  );
  assert.deepEqual(Array.from(rgb8.data), [10, 20, 30, 0, 10, 20, 31, 255, 255, 0, 0, 255]);

  const rgb16 = decodePng(
    makePng({
      pixels: [[[0x1234, 0x5678, 0x9abc], [1, 2, 3]]],
      depth: 16,
      colorType: 2,
      before: [chunk('tRNS', Buffer.from([0, 1, 0, 2, 0, 3]))],
    }),
  );
  assert.equal(rgb16.depth, 16);
  assert.deepEqual(Array.from(rgb16.data), [0x1234, 0x5678, 0x9abc, 65535, 1, 2, 3, 0]);

  const greyAlpha8 = decodePng(makePng({ pixels: [[[10, 0], [200, 128]]], depth: 8, colorType: 4 }));
  assert.deepEqual(Array.from(greyAlpha8.data), [10, 10, 10, 0, 200, 200, 200, 128]);
  const greyAlpha16 = decodePng(makePng({ pixels: [[[0x0102, 0xfffe]]], depth: 16, colorType: 4 }));
  assert.deepEqual(Array.from(greyAlpha16.data), [0x0102, 0x0102, 0x0102, 0xfffe]);

  const rgba8 = decodePng(makePng({ pixels: [[[1, 2, 3, 4], [250, 251, 252, 253]]], depth: 8, colorType: 6 }));
  assert.deepEqual(Array.from(rgba8.data), [1, 2, 3, 4, 250, 251, 252, 253]);
  const rgba16 = decodePng(makePng({ pixels: [[[1, 256, 65535, 4097]]], depth: 16, colorType: 6 }));
  assert.deepEqual(Array.from(rgba16.data), [1, 256, 65535, 4097]);

  // A suggested palette in a truecolour image does not change its samples.
  const suggested = decodePng(
    makePng({ pixels: [[[7, 8, 9]]], depth: 8, colorType: 2, before: [chunk('PLTE', Buffer.from([1, 2, 3]))] }),
  );
  assert.deepEqual(Array.from(suggested.data), [7, 8, 9, 255]);
});

test('[AC-16][F-018] decodes indexed colour at 1, 2, 4 and 8 bits with PLTE and tRNS', () => {
  for (const depth of [1, 2, 4, 8]) {
    const entries = Math.min(2 ** depth, 6);
    const palette = Buffer.from(Array.from({ length: entries * 3 }, (_, i) => (i * 37 + 5) % 256));
    // tRNS covers only the first entries; the rest stay opaque.
    const alpha = Buffer.from(Array.from({ length: Math.max(1, entries - 1) }, (_, i) => i * 40));
    const pixels = grid(11, 3, (x, y) => [(x * 3 + y) % entries]);
    const decoded = decodePng(
      makePng({ pixels, depth, colorType: 3, before: [chunk('PLTE', palette), chunk('tRNS', alpha)] }),
    );
    assert.equal(decoded.depth, 8);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 11; x += 1) {
        const index = pixels[y][x][0];
        const expected = [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], index < alpha.length ? alpha[index] : 255];
        assert.deepEqual(at(decoded, x, y), expected, `depth ${depth} (${x}, ${y})`);
      }
    }
  }

  const pixels = [[[0], [2]]];
  const twoEntries = chunk('PLTE', Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.throws(() => decodePng(makePng({ pixels, depth: 8, colorType: 3, before: [twoEntries] })), /palette index 2, but PLTE has 2 entries/);
  assert.throws(() => decodePng(makePng({ pixels: [[[0]]], depth: 8, colorType: 3 })), /indexed-colour image has no PLTE/);
  assert.throws(
    () => decodePng(makePng({ pixels: [[[0]]], depth: 1, colorType: 3, before: [chunk('PLTE', Buffer.alloc(9))] })),
    /PLTE has 3 entries, more than the 2/,
  );
  assert.throws(
    () => decodePng(makePng({ pixels: [[[0]]], depth: 8, colorType: 3, before: [chunk('PLTE', Buffer.alloc(4))] })),
    /PLTE is 4 bytes long/,
  );
  assert.throws(
    () => decodePng(makePng({ pixels: [[[0]]], depth: 8, colorType: 3, before: [twoEntries, chunk('tRNS', Buffer.alloc(3))] })),
    /tRNS has 3 entries, more than the 2 palette entries/,
  );
  assert.throws(
    () => decodePng(makePng({ pixels: [[[0]]], depth: 8, colorType: 3, before: [chunk('tRNS', Buffer.alloc(1)), twoEntries] })),
    /tRNS comes before PLTE/,
  );
});

test('[AC-16][F-018] reverses every filter type, 0 to 4, at every pixel width', () => {
  const next = random(0xf17);
  const configurations = [
    { depth: 1, colorType: 0 },
    { depth: 4, colorType: 0 },
    { depth: 8, colorType: 0 },
    { depth: 8, colorType: 2 },
    { depth: 8, colorType: 4 },
    { depth: 8, colorType: 6 },
    { depth: 16, colorType: 2 },
    { depth: 16, colorType: 6 },
  ];
  for (const { depth, colorType } of configurations) {
    const pixels = grid(11, 6, () => Array.from({ length: CHANNELS[colorType] }, () => next(2 ** depth)));
    const reference = decodePng(makePng({ pixels, depth, colorType }));
    const filters = [0, 1, 2, 3, 4].map((type) => [`filter ${type}`, () => type]);
    filters.push(['filters 0 to 4 by scanline', (n) => n % 5], ['filters 4 to 0 by scanline', (n) => 4 - (n % 5)]);
    for (const [label, filter] of filters) {
      const decoded = decodePng(makePng({ pixels, depth, colorType, filter }));
      assert.deepEqual(decoded, reference, `${label}, colour type ${colorType}, depth ${depth}`);
    }
  }

  // RGBA 8-bit samples are their own expected values, so the reference above is checked too.
  const pixels = grid(9, 5, () => [next(256), next(256), next(256), next(256)]);
  const decoded = decodePng(makePng({ pixels, depth: 8, colorType: 6, filter: (n) => (n + 3) % 5 }));
  assert.deepEqual(Array.from(decoded.data), pixels.flat(2));
});

test('[AC-16][F-018] decodes Adam7-interlaced images, empty passes included', () => {
  const next = random(0xada7);
  // 1 × 1 and 5 × 1 leave passes empty; 8 × 8 fills each pass exactly; 9 × 10 and 3 × 2 do neither.
  for (const [width, height] of [
    [1, 1],
    [5, 1],
    [1, 5],
    [3, 2],
    [8, 8],
    [9, 10],
  ]) {
    const pixels = grid(width, height, () => [next(256), next(256), next(256), next(256)]);
    const decoded = decodePng(makePng({ pixels, depth: 8, colorType: 6, interlace: 1, filter: (n) => n % 5 }));
    assert.deepEqual(decoded, { width, height, depth: 8, data: Uint8Array.from(pixels.flat(2)) }, `${width} × ${height}`);
  }

  // Low and high bit depths, interlaced, decode as their non-interlaced twins.
  for (const { depth, colorType, channels } of [
    { depth: 2, colorType: 0, channels: 1 },
    { depth: 4, colorType: 3, channels: 1 },
    { depth: 16, colorType: 2, channels: 3 },
  ]) {
    const levels = colorType === 3 ? 16 : 2 ** depth;
    const pixels = grid(9, 10, () => Array.from({ length: channels }, () => next(levels)));
    const before = colorType === 3 ? [chunk('PLTE', Buffer.from(Array.from({ length: 48 }, (_, i) => i * 5)))] : [];
    const flat = decodePng(makePng({ pixels, depth, colorType, before }));
    const interlaced = decodePng(makePng({ pixels, depth, colorType, before, interlace: 1, filter: (n) => (n * 3) % 5 }));
    assert.deepEqual(interlaced, flat, `colour type ${colorType}, depth ${depth}`);
  }
});

test('[AC-16][F-018] refuses malformed PNG files, naming the defect', () => {
  const file = validFile();
  const header = ihdr(2, 2, 8, 6);
  const pixels = grid(2, 2, () => [1, 2, 3, 4]);
  const idat = chunk('IDAT', zlib.deflateSync(imageData({ pixels, depth: 8, colorType: 6 })));
  const end = chunk('IEND');
  assert.equal(decodePng(png(header, idat, end)).width, 2, 'the parts below form a valid file');

  const corruptCrc = Buffer.from(file);
  corruptCrc[chunkOffset(file, 'IDAT') + 8] ^= 0x01;
  const corruptHeader = Buffer.from(file);
  corruptHeader[8 + 8 + 3] ^= 0x01;
  const badSignature = Buffer.from(file);
  badSignature[1] = 0x51;
  const raw = imageData({ pixels, depth: 8, colorType: 6 });
  const badFilter = Buffer.from(raw);
  badFilter[0] = 5;
  const tooLarge = ihdr(2 ** 14, 2 ** 13, 8, 6);
  const badType = chunk('IDAT', Buffer.alloc(0));
  badType[5] = 0x31;

  const cases = [
    ['an empty file', Buffer.alloc(0), /does not start with the PNG signature/],
    ['a bad signature', badSignature, /does not start with the PNG signature/],
    ['a corrupt IDAT CRC', corruptCrc, /the IDAT chunk at byte \d+ has a bad CRC/],
    ['a corrupt IHDR', corruptHeader, /the IHDR chunk at byte 8 has a bad CRC/],
    ['a file cut inside IDAT', file.subarray(0, chunkOffset(file, 'IDAT') + 12), /chunk at byte \d+ is truncated: it declares \d+ bytes/],
    ['a file cut inside a chunk header', file.subarray(0, chunkOffset(file, 'IEND') + 5), /chunk at byte \d+ is truncated/],
    ['a missing IEND', png(header, idat), /no IEND chunk/],
    ['the signature alone', SIGNATURE, /no IHDR chunk/],
    ['an unknown critical chunk', png(header, chunk('ZzZz', Buffer.from('x')), idat, end), /critical chunk ZzZz is not part of PNG/],
    ['a chunk type with a digit', png(header, badType, idat, end), /invalid type/],
    ['IHDR not first', png(chunk('gAMA', Buffer.alloc(4)), header, idat, end), /first chunk is gAMA, not IHDR/],
    ['two IHDR chunks', png(header, header, idat, end), /more than one IHDR/],
    ['a short IHDR', png(chunk('IHDR', Buffer.alloc(12)), idat, end), /IHDR is 12 bytes long, not 13/],
    ['a zero width', png(ihdr(0, 2, 8, 6), idat, end), /0 by 2 pixels; each side must be 1/],
    ['colour type 5', png(ihdr(2, 2, 8, 5), idat, end), /colour type 5 is not 0, 2, 3, 4 or 6/],
    ['bit depth 4 in truecolour', png(ihdr(2, 2, 4, 2), idat, end), /bit depth 4 is not allowed for colour type 2/],
    ['bit depth 16 in indexed colour', png(ihdr(2, 2, 16, 3), idat, end), /bit depth 16 is not allowed for colour type 3/],
    ['compression method 1', png(ihdr(2, 2, 8, 6, { compression: 1 }), idat, end), /compression method 1 is not 0/],
    ['filter method 1', png(ihdr(2, 2, 8, 6, { filter: 1 }), idat, end), /filter method 1 is not 0/],
    ['interlace method 2', png(ihdr(2, 2, 8, 6, { interlace: 2 }), idat, end), /interlace method 2 is not 0 or 1/],
    ['more pixels than the limit', png(tooLarge, idat, end), new RegExp(`more than the ${MAX_PIXELS}-pixel limit`)],
    ['no IDAT', png(header, end), /no IDAT chunk/],
    ['IDAT chunks apart', png(header, idat, chunk('tEXt', Buffer.from('a\0b')), idat, end), /IDAT chunks are not consecutive/],
    ['bytes after IEND', Buffer.concat([file, Buffer.from([0])]), /1 bytes follow the IEND chunk/],
    ['IEND with data', png(header, idat, chunk('IEND', Buffer.from([0]))), /IEND holds 1 bytes/],
    ['data that is not zlib', png(header, chunk('IDAT', Buffer.from('not deflate')), end), /cannot be inflated/],
    // Two scanlines of a filter byte and 2 × 4 samples: 18 bytes.
    ['too little image data', png(header, chunk('IDAT', zlib.deflateSync(raw.subarray(1))), end), /inflates to 17 bytes, not the 18 a 2 by 2 image holds/],
    ['too much image data', png(header, chunk('IDAT', zlib.deflateSync(Buffer.concat([raw, raw]))), end), /inflates to more than the 18 bytes/],
    ['filter type 5', png(header, chunk('IDAT', zlib.deflateSync(badFilter)), end), /scanline 0 has filter type 5, not 0 to 4/],
    ['tRNS with an alpha channel', png(header, chunk('tRNS', Buffer.alloc(2)), idat, end), /tRNS is not allowed in an image with an alpha channel/],
    ['tRNS of the wrong length', png(ihdr(2, 2, 8, 0), chunk('tRNS', Buffer.alloc(6)), idat, end), /tRNS of a greyscale image is 6 bytes long, not 2/],
    ['a tRNS value beyond the bit depth', png(ihdr(2, 2, 4, 0), chunk('tRNS', Buffer.from([0, 16])), idat, end), /tRNS sample 16 does not fit bit depth 4/],
    ['tRNS after the image data', png(ihdr(2, 2, 8, 2), idat, chunk('tRNS', Buffer.alloc(6)), end), /tRNS comes after the image data/],
    ['PLTE in a greyscale image', png(ihdr(2, 2, 8, 0), chunk('PLTE', Buffer.alloc(3)), idat, end), /greyscale image has a PLTE chunk/],
  ];
  for (const [label, bytes, message] of cases) {
    assert.throws(() => decodePng(bytes), (err) => err instanceof Error && /^Invalid PNG: /.test(err.message) && message.test(err.message), label);
  }
  assert.throws(() => decodePng('not bytes'), TypeError);

  // Ancillary chunks, known or not, are skipped.
  const ancillary = png(header, chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])), chunk('zzZz', Buffer.from('x')), idat, chunk('tEXt', Buffer.from('k\0v')), end);
  assert.deepEqual(decodePng(ancillary), decodePng(png(header, idat, end)));
});

/* ------------------------------------------------------------------------ */
/* Comparison                                                                */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] comparePixels finds a one-unit change in any channel and nothing in identical images', () => {
  const base = rgba(4, 3, (x, y) => [x * 60, y * 100, 255, 255]);
  const same = comparePixels(base, rgba(4, 3, (x, y) => [x * 60, y * 100, 255, 255]));
  assert.equal(same.equal, true);
  assert.equal(same.differentPixels, 0);
  assert.equal(same.totalPixels, 12);
  assert.deepEqual(same.expectedSize, { width: 4, height: 3 });
  assert.deepEqual(same.actualSize, { width: 4, height: 3 });
  assert.equal(same.diff.width, 4);
  assert.equal(same.diff.height, 3);
  // Unchanged pixels are the expected pixel's luma faded to 10 % towards white.
  const white = rgba(1, 1, () => [255, 255, 255, 255]);
  const black = rgba(1, 1, () => [0, 0, 0, 255]);
  const clear = rgba(1, 1, () => [0, 0, 0, 0]);
  assert.deepEqual(Array.from(comparePixels(white, white).diff.data), [255, 255, 255, 255]);
  assert.deepEqual(Array.from(comparePixels(black, black).diff.data), [230, 230, 230, 255]);
  assert.deepEqual(Array.from(comparePixels(clear, clear).diff.data), [255, 255, 255, 255]);

  for (let channel = 0; channel < 4; channel += 1) {
    const changed = rgba(4, 3, (x, y) => {
      const pixel = [x * 60, y * 100, 255, 255];
      if (x === 1 && y === 2) pixel[channel] += channel >= 2 ? -1 : 1;
      return pixel;
    });
    const result = comparePixels(base, changed);
    assert.equal(result.equal, false, `channel ${channel}`);
    assert.equal(result.differentPixels, 1, `channel ${channel}`);
    assert.deepEqual(at(result.diff, 1, 2), [255, 0, 0, 255]);
    assert.notDeepEqual(at(result.diff, 0, 0), [255, 0, 0, 255]);
  }
});

test('[AC-16][F-018] comparePixels counts the pixels only one image has when the sizes differ', () => {
  const wide = rgba(3, 2, () => [9, 9, 9, 255]);
  const tall = rgba(2, 3, () => [9, 9, 9, 255]);
  const result = comparePixels(wide, tall);
  assert.equal(result.equal, false);
  assert.equal(result.totalPixels, 9);
  // (2, 0) and (2, 1) only in the wide image, (0, 2) and (1, 2) only in the tall one.
  assert.equal(result.differentPixels, 4);
  assert.deepEqual(result.expectedSize, { width: 3, height: 2 });
  assert.deepEqual(result.actualSize, { width: 2, height: 3 });
  assert.deepEqual(at(result.diff, 2, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(result.diff, 0, 2), [255, 0, 0, 255]);
  assert.deepEqual(at(result.diff, 2, 2), [255, 255, 255, 255], 'neither image has (2, 2)');

  const taller = comparePixels(rgba(2, 2, () => [1, 1, 1, 255]), rgba(2, 3, () => [1, 1, 1, 255]));
  assert.equal(taller.differentPixels, 2);
  assert.equal(taller.totalPixels, 6);
});

test('[AC-16][F-018] comparePixels treats an 8-bit sample v as equal to a 16-bit sample v * 257 and nothing else', () => {
  const eight = rgba(2, 1, (x) => [10 + x, 20, 30, 255]);
  const sixteen = rgba(2, 1, (x) => [(10 + x) * 257, 20 * 257, 30 * 257, 65535], 16);
  assert.equal(comparePixels(eight, sixteen).equal, true);
  assert.equal(comparePixels(sixteen, eight).equal, true);
  assert.equal(comparePixels(sixteen, sixteen).equal, true);
  assert.deepEqual(Array.from(comparePixels(sixteen, sixteen).diff.data), Array.from(comparePixels(eight, eight).diff.data));

  const offByOne = rgba(2, 1, (x) => [(10 + x) * 257 + (x === 1 ? 1 : 0), 20 * 257, 30 * 257, 65535], 16);
  const result = comparePixels(eight, offByOne);
  assert.equal(result.equal, false);
  assert.equal(result.differentPixels, 1);
  assert.deepEqual(at(result.diff, 1, 0), [255, 0, 0, 255]);

  // Decoded files compare the same way.
  const file8 = makePng({ pixels: [[[10, 20, 30]]], depth: 8, colorType: 2 });
  const file16 = makePng({ pixels: [[[10 * 257, 20 * 257, 30 * 257]]], depth: 16, colorType: 2 });
  assert.equal(compareScreenshots(file8, file16).equal, true);
});

test('[AC-16][F-018] comparePixels and compareScreenshots refuse what they cannot compare', () => {
  const image = rgba(1, 1, () => [0, 0, 0, 255]);
  assert.throws(() => comparePixels(null, image), /expected image is not a decoded image/);
  assert.throws(() => comparePixels(image, { width: 1, height: 1, depth: 8, data: new Uint8Array(3) }), /actual image holds 3 samples, not 4/);
  assert.throws(() => comparePixels(image, { width: 1, height: 1, depth: 16, data: new Uint8Array(4) }), /depth 16 with a Uint16Array/);
  assert.throws(() => comparePixels({ width: 0, height: 1, depth: 8, data: new Uint8Array(0) }, image), /positive integer width and height/);
  const narrow = { width: 1, height: 2 ** 14, depth: 8, data: new Uint8Array(4 * 2 ** 14) };
  const flat = { width: 2 ** 13, height: 1, depth: 8, data: new Uint8Array(4 * 2 ** 13) };
  assert.throws(() => comparePixels(narrow, flat), /8192 by 16384 pixels is more than the/);

  const good = encodePng(image);
  const broken = Buffer.from(good);
  broken[broken.length - 1] ^= 0xff;
  assert.throws(() => compareScreenshots(broken, good), /^Error: the expected image cannot be decoded: Invalid PNG: the IEND chunk/);
  assert.throws(() => compareScreenshots(good, Buffer.from('GIF89a')), /the actual image cannot be decoded: Invalid PNG: the file does not start/);
  assert.equal(compareScreenshots(good, good).diffPng, undefined, 'no diff image when nothing differs');
});

test('[AC-16][F-018] rejects an anti-alias-only difference that Playwright\'s comparator accepts', () => {
  const expected = encodePng(ramp(128));
  const actual = encodePng(ramp(100));
  // The centre pixel sits on an edge between darker and lighter neighbours,
  // so pixelmatch classifies its change as anti-aliasing and does not count it.
  assert.equal(playwrightCompare(actual, expected, SPEC_OPTIONS), null);
  // The same change away from any edge is counted: the comparator is called as the matcher calls it.
  const flat = (centre) => encodePng(rgba(5, 5, (x, y) => (x === 2 && y === 2 ? [centre, centre, centre, 255] : [255, 255, 255, 255])));
  assert.match(playwrightCompare(flat(100), flat(255), SPEC_OPTIONS).errorMessage, /^1 pixels \(ratio 0\.04 of all image pixels\) are different\./);

  const result = compareScreenshots(expected, actual);
  assert.equal(result.equal, false);
  assert.equal(result.differentPixels, 1);
  assert.equal(result.totalPixels, 25);
  assert.ok(Buffer.isBuffer(result.diffPng));
  const diff = decodePng(result.diffPng);
  assert.equal(diff.width, 5);
  assert.equal(diff.height, 5);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      const red = at(diff, x, y)[0] === 255 && at(diff, x, y)[1] === 0;
      assert.equal(red, x === 2 && y === 2, `diff pixel (${x}, ${y})`);
    }
  }
  assert.equal(playwrightCompare(result.diffPng, result.diffPng, SPEC_OPTIONS), null, 'Playwright reads the diff image');
});

test('[AC-16][F-018] rejects a difference behind zero alpha that Playwright\'s comparator accepts', () => {
  const clear = encodePng(rgba(3, 3, () => [0, 0, 0, 0]));
  const tinted = encodePng(rgba(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 0, 0, 0] : [0, 0, 0, 0])));
  // pixelmatch blends both with white by their zero alpha: both become white.
  assert.equal(playwrightCompare(tinted, clear, SPEC_OPTIONS), null);
  const result = compareScreenshots(clear, tinted);
  assert.equal(result.equal, false);
  assert.equal(result.differentPixels, 1);
  assert.deepEqual(at(decodePng(result.diffPng), 1, 1), [255, 0, 0, 255]);
});

/* ------------------------------------------------------------------------ */
/* The failure message and its classification                                */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] strictMismatchMessage, as Playwright reports it, matches STRICT_MISMATCH and nothing else does', () => {
  const one = compareScreenshots(encodePng(ramp(128)), encodePng(ramp(100)));
  const message = strictMismatchMessage('listing-375-light.png', one);
  assert.equal(
    message,
    'Strict pixel comparison failed for listing-375-light.png: 1 pixel (ratio 0.04 of all image pixels) differs from the baseline at zero tolerance.',
  );
  const sized = comparePixels(rgba(3, 2, () => [9, 9, 9, 255]), rgba(2, 3, () => [9, 9, 9, 255]));
  const sizedMessage = strictMismatchMessage('article-1280-dark.png', sized);
  assert.equal(
    sizedMessage,
    'Strict pixel comparison failed for article-1280-dark.png: Expected an image 3px by 2px, received 2px by 3px. ' +
      '4 pixels (ratio 0.45 of all image pixels) differ from the baseline at zero tolerance.',
  );
  // Rounded up to hundredths, as Playwright rounds: 1 of 1000 pixels is 0.01.
  const sparse = comparePixels(rgba(1000, 1, () => [0, 0, 0, 255]), rgba(1000, 1, (x) => (x === 0 ? [1, 0, 0, 255] : [0, 0, 0, 255])));
  assert.match(strictMismatchMessage('x.png', sparse), /1 pixel \(ratio 0\.01 of all image pixels\)/);
  assert.doesNotMatch(strictMismatchMessage('a\nb.png', one), /\n/, 'one line, whatever the name');

  for (const text of [message, sizedMessage]) {
    assert.match(`Error: ${text}${SNIPPET}`, STRICT_MISMATCH, 'with the code snippet Playwright appends');
    assert.match(`Error: ${text}`, STRICT_MISMATCH, 'at the end of the report message');
    assert.doesNotMatch(text, STRICT_MISMATCH, 'without the Error: prefix');
  }

  const others = [
    'Error: expect(page).toHaveScreenshot(expected) failed\n\n  3 pixels (ratio 0.01 of all image pixels) are different.\n\n  Snapshot: listing-375-light.png',
    "Error: A snapshot doesn't exist at /tmp/blog-visual-x/baseline/listing-375-light.png.",
    'Error: Strict pixel comparison of listing-375-light.png could not run: the expected image cannot be decoded: Invalid PNG: the IDAT chunk at byte 33 has a bad CRC',
    `Error: page.goto: net::ERR_CONNECTION_REFUSED; ${message}`,
    `Error: ${message.replace('at zero tolerance.', 'at zero tolerance. And more.')}`,
    `TypeError: ${message}`,
    `Error: ${message.replace('1 pixel', 'one pixel')}`,
  ];
  for (const other of others) assert.doesNotMatch(other, STRICT_MISMATCH, other);

  assert.throws(() => strictMismatchMessage('x.png', comparePixels(rgba(1, 1, () => [0, 0, 0, 255]), rgba(1, 1, () => [0, 0, 0, 255]))), TypeError);
  assert.throws(() => strictMismatchMessage('x.png', null), TypeError);
});

test('[AC-16][F-018] classifyComparison counts a case failed only by the strict comparison as a screenshot difference', () => {
  const title = '[AC-16][F-018] listing 375px light';
  const message = strictMismatchMessage('listing-375-light.png', compareScreenshots(encodePng(ramp(128)), encodePng(ramp(100))));
  const failed = (errors, attachments) => ({ status: 'failed', errors: errors.map((text) => ({ message: text })), attachments });

  assert.deepEqual(
    classifyComparison(report({ [title]: failed([`Error: ${message}${SNIPPET}`], evidence('listing-375-light')) })),
    { mismatched: [title], problems: [] },
  );

  const withoutActual = classifyComparison(
    report({ [title]: failed([`Error: ${message}${SNIPPET}`], evidence('listing-375-light', ['expected', 'diff'])) }),
  );
  assert.deepEqual(withoutActual.mismatched, []);
  assert.deepEqual(withoutActual.problems, [`${title}: failed without an actual screenshot (*-actual.png)`]);

  const undecodable =
    'Error: Strict pixel comparison of listing-375-light.png could not run: the expected image cannot be decoded: Invalid PNG: the IDAT chunk at byte 33 has a bad CRC';
  const decodeFailure = classifyComparison(report({ [title]: failed([`${undecodable}${SNIPPET}`], evidence('listing-375-light')) }));
  assert.deepEqual(decodeFailure.mismatched, []);
  assert.deepEqual(decodeFailure.problems, [`${title}: ${undecodable}`]);

  const mixed = classifyComparison(
    report({ [title]: failed([`Error: ${message}${SNIPPET}`, 'Error: page.evaluate: Target crashed'], evidence('listing-375-light')) }),
  );
  assert.deepEqual(mixed.mismatched, []);
  assert.deepEqual(mixed.problems, [`${title}: Error: page.evaluate: Target crashed`]);

  // Alongside a Playwright matcher difference in another case, both are differences.
  const other = '[AC-16][F-018] article 800px dark';
  const matcher =
    'Error: expect(page).toHaveScreenshot(expected) failed\n\n  12 pixels (ratio 0.01 of all image pixels) are different.\n\n  Snapshot: article-800-dark.png';
  assert.deepEqual(
    classifyComparison(
      report({
        [title]: failed([`Error: ${message}${SNIPPET}`], evidence('listing-375-light')),
        [other]: failed([matcher], evidence('article-800-dark')),
      }),
    ),
    { mismatched: [title, other], problems: [] },
  );
});
