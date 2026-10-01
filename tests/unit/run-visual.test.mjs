/* Cabrillo Coast LLC — unit proof of the intended-change trailer scanner (AC-16, F-018) */
/**
 * `createTrailerScanner` in `tests/visual/run-visual.mjs` decides whether a
 * commit message in `<base>..HEAD` declares an intended visual change with a
 * `Visual-Change: intended` trailer (AC-16). The visual runner streams
 * `git log --format=%B <base>..HEAD` through it chunk by chunk, so a range of
 * any size is read without holding it in memory, and a declared change is
 * credited only when a whole line is that trailer. This suite proves that the
 * scanner
 *   - finds the trailer in one chunk and wherever a chunk boundary splits it,
 *   - accepts CRLF line ends, any ASCII letter case, spaces and tabs around
 *     the value, and a final line without a line end,
 *   - refuses near misses: extra text, a leading blank, another value, and
 *     non-ASCII lookalikes,
 *   - still finds a trailer after more than 2 MiB of other messages, past
 *     the 1 MiB that a captured `git log` was limited to, and
 *   - agrees with the regular expression it replaced,
 *     `/^Visual-Change:[ \t]*intended[ \t\r]*$/im`, on several hundred
 *     generated messages, invalid UTF-8 included.
 *
 * Runs with `node --test tests/unit/run-visual.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no Jekyll build, no git, no
 * browser and no network, and writes no files. Importing run-visual.mjs runs
 * nothing: its entry point only starts when it is the program Node runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTrailerScanner } from '../visual/run-visual.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** The trailer rule the scanner replaced; the cross-check holds it to this. */
const TRAILER_REGEX = /^Visual-Change:[ \t]*intended[ \t\r]*$/im;

/** A message that declares the change, with the trailer on its last line. */
const DECLARING = 'Restyle the blog listing\n\nWider cards on large screens.\n\nVisual-Change: intended\n';

/** More than twice Node's 1 MiB default capture limit. */
const LARGE_STREAM_BYTES = 2.5 * 1024 * 1024;

/** Number of generated messages in the regular-expression cross-check. */
const GENERATED_MESSAGES = 600;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** UTF-8 bytes of `text`. */
function bytes(text) {
  return Buffer.from(text, 'utf8');
}

/**
 * Feeds `chunks` to a new scanner, then marks the end of the stream.
 * @param {Uint8Array[]} chunks
 * @returns {boolean} whether a trailer line was found.
 */
function scan(chunks) {
  const scanner = createTrailerScanner();
  for (const chunk of chunks) {
    if (scanner.push(chunk)) return true;
  }
  return scanner.end();
}

/** `buffer` cut into one-byte chunks. */
function singleBytes(buffer) {
  return Array.from(buffer, (byte) => Uint8Array.of(byte));
}

/**
 * Deterministic pseudo-random numbers in [0, 1) (mulberry32), so a failing
 * generated case is the same on every run.
 */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One element of `items`, chosen with `next`. */
function pick(next, items) {
  return items[Math.floor(next() * items.length)];
}

/** `buffer` cut at up to three random points. */
function randomChunks(next, buffer) {
  const cuts = [0, buffer.length];
  for (let i = Math.floor(next() * 4); i > 0; i -= 1) cuts.push(Math.floor(next() * (buffer.length + 1)));
  cuts.sort((a, b) => a - b);
  const chunks = [];
  for (let i = 1; i < cuts.length; i += 1) chunks.push(buffer.subarray(cuts[i - 1], cuts[i]));
  return chunks;
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] finds the trailer in a single chunk', () => {
  const scanner = createTrailerScanner();
  assert.equal(scanner.push(bytes(DECLARING)), true);
  assert.equal(scanner.found, true);
  assert.equal(scanner.end(), true);
  assert.equal(scan([bytes('Fix a typo\n\nNo visual change.\n')]), false);
});

test('[AC-16][F-018] finds the trailer wherever a chunk boundary splits it', () => {
  const messages = [
    DECLARING,
    'Restyle\r\n\r\nVisual-Change: intended\r\n',
    'Restyle\n\nVisual-Change:\t intended \t',
    'Restyle\u2028Visual-Change: intended\u2029Signed-off-by: A <a@example.com>\n',
  ];
  for (const message of messages) {
    const buffer = bytes(message);
    for (let cut = 0; cut <= buffer.length; cut += 1) {
      assert.equal(
        scan([buffer.subarray(0, cut), buffer.subarray(cut)]),
        true,
        `${JSON.stringify(message)} split at byte ${cut}`,
      );
    }
    assert.equal(scan(singleBytes(buffer)), true, `${JSON.stringify(message)} one byte at a time`);
  }
});

test('[AC-16][F-018] accepts CRLF line ends', () => {
  assert.equal(scan([bytes('Restyle\r\n\r\nVisual-Change: intended\r\n')]), true);
  assert.equal(scan([bytes('Visual-Change: intended\r\nSigned-off-by: A <a@example.com>\r\n')]), true);
  // The CR alone ends the line, before any LF arrives.
  assert.equal(createTrailerScanner().push(bytes('Visual-Change: intended\r')), true);
});

test('[AC-16][F-018] accepts the key and value in any ASCII letter case', () => {
  for (const line of ['visual-change: intended', 'VISUAL-CHANGE: INTENDED', 'vIsUaL-cHaNgE: InTeNdEd']) {
    assert.equal(scan([bytes(`Restyle\n\n${line}\n`)]), true, line);
  }
});

test('[AC-16][F-018] accepts spaces and tabs before the value and after it', () => {
  for (const line of [
    'Visual-Change:intended',
    'Visual-Change: \t intended',
    'Visual-Change:\tintended \t ',
    'Visual-Change: intended \t\r',
  ]) {
    assert.equal(scan([bytes(`Restyle\n\n${line}\n`)]), true, JSON.stringify(line));
  }
});

test('[AC-16][F-018] counts a final line without a line end once the stream ends', () => {
  const scanner = createTrailerScanner();
  assert.equal(scanner.push(bytes('Restyle\n\nVisual-Change: intended')), false, 'the line has not ended yet');
  assert.equal(scanner.end(), true);
  assert.equal(scan([bytes('Restyle\n\nVisual-Change: intended \t')]), true);
  // An unfinished multi-byte character is not a line end.
  assert.equal(scan([Buffer.concat([bytes('Visual-Change: intended'), Uint8Array.of(0xe2, 0x80)])]), false);
  assert.throws(() => scanner.push(bytes('\n')), /after end/);
});

test('[AC-16][F-018] refuses lines that are not exactly the trailer', () => {
  const nearMisses = [
    'Visual-Change: intended later',
    'x Visual-Change: intended',
    ' Visual-Change: intended',
    'Visual-Change: unintended',
    'Visual-Change: intend',
    'Visual-Change intended',
    'Visual-Changes: intended',
    'Visual-Change: intended.',
    'Visual-Change:\nintended',
    'Visual-Change: intended\v',
    'Visual-Change:\u00a0intended',
    'Visual-Change: \u0131ntended',
    'Vi\u017fual-Change: intended',
    'Visual-Change\uff1a intended',
    'Visual-Change: intended\u200b',
    'Visual-Change: intended\u2026',
    'Visual-Change: intended\ufffd',
  ];
  for (const line of nearMisses) {
    for (const message of [line, `Restyle\n\n${line}\n`, `Restyle\r\n\r\n${line}\r\n`]) {
      assert.equal(TRAILER_REGEX.test(message), false, `the regular expression also refuses ${JSON.stringify(message)}`);
      assert.equal(scan([bytes(message)]), false, JSON.stringify(message));
      assert.equal(scan(singleBytes(bytes(message))), false, `${JSON.stringify(message)} one byte at a time`);
    }
  }
  const invalid = Buffer.concat([bytes('Visual-Change: intended'), Uint8Array.of(0xff), bytes('\n')]);
  assert.equal(scan([invalid]), false, 'an invalid UTF-8 byte after the value');
});

test('[AC-16][F-018] finds a trailer after more than 2 MiB of other commit messages', () => {
  const filler = bytes(
    'Refine the article layout spacing on narrow screens\n\n' +
      'Visual-Change: intended later\nx Visual-Change: intended\nVisual-Change: unintended\n' +
      'Signed-off-by: Author <author@example.com>\n\n',
  );
  const chunk = Buffer.concat(Array.from({ length: Math.ceil(65536 / filler.length) }, () => filler));
  const scanner = createTrailerScanner();
  let streamed = 0;
  while (streamed < LARGE_STREAM_BYTES) {
    assert.equal(scanner.push(chunk), false, `no trailer within the first ${streamed + chunk.length} bytes`);
    streamed += chunk.length;
  }
  assert.ok(streamed > 2 * 1024 * 1024);
  assert.equal(scanner.push(bytes('Visual-Change: intended\n')), true);
  assert.equal(scanner.end(), true);
});

test('[AC-16][F-018] agrees with the trailer regular expression on generated messages', () => {
  const next = random(0x16f018);
  const keys = ['Visual-Change:', 'visual-change:', 'VISUAL-CHANGE:', 'Visual-Change', 'Visual-Chang:', 'Vi\u017fual-Change:'];
  const values = ['intended', 'Intended', 'INTENDED', 'intend', 'intendedx', '\u0131ntended', 'unintended'];
  const blanks = ['', ' ', '\t', ' \t ', '\u00a0', '\v'];
  const tails = ['', ' ', '\t', '\r', ' \r', ' later', '.', '\u2026', '\u200b'];
  const prefixes = ['', '', '', ' ', 'x ', '\r', '\u2028'];
  const ends = ['\n', '\r\n', '\r', '\u2028', '\u2029', ''];
  const noise = [
    bytes('Fix the build'),
    bytes('Signed-off-by: A <a@example.com>'),
    bytes('\t'),
    bytes('\r'),
    Uint8Array.of(0xe2),
    Uint8Array.of(0xe2, 0x80),
    Uint8Array.of(0x80, 0xa8),
    Uint8Array.of(0xff),
    Uint8Array.of(0xc2),
  ];

  let matched = 0;
  for (let n = 0; n < GENERATED_MESSAGES; n += 1) {
    const parts = [];
    const lineCount = 1 + Math.floor(next() * 4);
    for (let line = 0; line < lineCount; line += 1) {
      if (next() < 0.7) {
        parts.push(bytes(pick(next, prefixes) + pick(next, keys) + pick(next, blanks)));
        parts.push(bytes(pick(next, values) + pick(next, tails)));
      } else {
        parts.push(pick(next, noise));
      }
      // The last line sometimes has no line end, or ends in a stray byte.
      if (line < lineCount - 1 || next() < 0.6) parts.push(bytes(pick(next, ends)));
      else if (next() < 0.3) parts.push(pick(next, noise));
    }
    const message = Buffer.concat(parts);
    const expected = TRAILER_REGEX.test(message.toString('utf8'));
    if (expected) matched += 1;
    assert.equal(scan(randomChunks(next, message)), expected, `message bytes ${message.toString('hex')}`);
  }
  // Both outcomes occur often enough for the agreement to mean something.
  assert.ok(matched >= GENERATED_MESSAGES / 10, `${matched} generated messages declare the change`);
  assert.ok(GENERATED_MESSAGES - matched >= GENERATED_MESSAGES / 10, `${GENERATED_MESSAGES - matched} do not`);
});
