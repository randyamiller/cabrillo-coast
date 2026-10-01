/* Cabrillo Coast LLC — unit proof of the visual runner's trailer scanner and Playwright environment (AC-16, F-018) */
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
 * `playwrightEnv` builds the environment of each Playwright run. Playwright
 * prefers some inherited variables to the config's reporter settings, so
 * this suite also proves that a hostile environment cannot move the HTML
 * report away from the config's `tests/visual/report/` (the folder the
 * runner prints and the blog-checks workflow uploads), make it open, add a
 * reporter or redirect the JSON results, while the runner's own inputs are
 * set, unrelated variables pass through and the caller's object is left as
 * it was.
 *
 * Runs with `node --test tests/unit/run-visual.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no Jekyll build, no git, no
 * browser and no network, and writes no files; it imports the Playwright
 * config (and so `@playwright/test`, installed by `npm ci`) to read its
 * reporter options. Importing run-visual.mjs runs nothing: its entry point
 * only starts when it is the program Node runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTrailerScanner, playwrightEnv } from '../visual/run-visual.mjs';

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

/** The folder the Playwright config writes its HTML report to, from this file's location. */
const REPORT_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'visual', 'report');

/** The runner's own inputs to the config and the spec. */
const INPUTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:41234/cabrillo-coast',
  baselineDir: '/tmp/blog-visual-x/baseline',
  resultsFile: '/tmp/blog-visual-x/compare-results.json',
});

/** An inherited environment that tries every reporter override Playwright 1.63 honours. */
const HOSTILE_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/author',
  CI: 'true',
  PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright',
  VISUAL_CHANGE_INTENDED: '1',
  PLAYWRIGHT_HTML_OUTPUT_DIR: '/tmp/elsewhere/report',
  PLAYWRIGHT_HTML_REPORT: 'relative-report',
  PLAYWRIGHT_HTML_OPEN: 'always',
  PW_TEST_HTML_REPORT_OPEN: 'always',
  PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: 'https://example.com/attachments/',
  PW_TEST_REPORTER: 'html',
  PLAYWRIGHT_JSON_OUTPUT_FILE: '/tmp/elsewhere/results.json',
  JEKYLL_ENV: 'production',
  VISUAL_BASE_URL: 'http://example.com/',
  VISUAL_BASELINE_DIR: '/tmp/stale-baseline',
  VISUAL_RESULTS_FILE: '/tmp/stale-results.json',
});

/** Variables `playwrightEnv` must remove whatever their value. */
const REMOVED = Object.freeze([
  'PLAYWRIGHT_HTML_OUTPUT_DIR',
  'PLAYWRIGHT_HTML_REPORT',
  'PW_TEST_HTML_REPORT_OPEN',
  'PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL',
  'PW_TEST_REPORTER',
  'PLAYWRIGHT_JSON_OUTPUT_FILE',
  'JEKYLL_ENV',
]);

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

/**
 * Options of the html reporter in `tests/visual/playwright.config.mjs`,
 * the folder and open policy Playwright falls back to once no variable
 * overrides them. The config refuses to load without `VISUAL_BASELINE_DIR`,
 * so a placeholder is set for the import only (the config only resolves the
 * path; nothing is written) and the caller's value is restored afterwards.
 * @returns {Promise<{ outputFolder: string, open: string }>}
 */
async function configHtmlReporter() {
  const saved = process.env.VISUAL_BASELINE_DIR;
  process.env.VISUAL_BASELINE_DIR = path.join(path.sep, 'nonexistent', 'baseline');
  let config;
  try {
    ({ default: config } = await import('../visual/playwright.config.mjs'));
  } finally {
    if (saved === undefined) delete process.env.VISUAL_BASELINE_DIR;
    else process.env.VISUAL_BASELINE_DIR = saved;
  }
  const entry = config.reporter.find((reporter) => Array.isArray(reporter) && reporter[0] === 'html');
  assert.ok(entry, 'the config has an html reporter');
  return entry[1];
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

test('[AC-16][F-018] playwrightEnv neutralises every inherited HTML-report override', async () => {
  const base = { ...HOSTILE_ENV };
  const env = playwrightEnv(base, INPUTS);

  assert.equal(env.PLAYWRIGHT_HTML_OPEN, 'never');
  for (const key of REMOVED) assert.equal(Object.hasOwn(env, key), false, `${key} is removed`);

  // Read the way Playwright 1.63's HTML reporter reads them: the first set
  // variable of each pair wins over the config's `outputFolder` and `open`,
  // so with no folder variable left the config's folder is the one used.
  const html = await configHtmlReporter();
  const folder = env.PLAYWRIGHT_HTML_OUTPUT_DIR || env.PLAYWRIGHT_HTML_REPORT || html.outputFolder;
  const open = env.PLAYWRIGHT_HTML_OPEN || env.PW_TEST_HTML_REPORT_OPEN || html.open;
  assert.equal(path.resolve(folder), REPORT_FOLDER);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.equal(path.relative(repo, folder), path.join('tests', 'visual', 'report'));
  assert.equal(open, 'never');
  assert.equal(html.open, 'never', 'the config never opens the report either');
});

test('[AC-16][F-018] playwrightEnv sets the runner inputs and passes every unrelated variable through', () => {
  const base = { ...HOSTILE_ENV };
  const env = playwrightEnv(base, INPUTS);

  assert.equal(env.VISUAL_BASE_URL, INPUTS.baseUrl);
  assert.equal(env.VISUAL_BASELINE_DIR, INPUTS.baselineDir);
  assert.equal(env.VISUAL_RESULTS_FILE, INPUTS.resultsFile);
  for (const key of ['PATH', 'HOME', 'CI', 'PLAYWRIGHT_BROWSERS_PATH', 'VISUAL_CHANGE_INTENDED']) {
    assert.equal(env[key], HOSTILE_ENV[key], `${key} passes through`);
  }
  // Nothing else is added or removed.
  const expectedKeys = Object.keys(HOSTILE_ENV).filter((key) => !REMOVED.includes(key));
  assert.deepEqual(Object.keys(env).sort(), expectedKeys.sort());

  // The caller's object is a different one, left exactly as it was.
  assert.notEqual(env, base);
  assert.deepEqual(base, HOSTILE_ENV);

  // Without a results file the variable is empty, which the config reads as "no JSON report".
  const clean = { PATH: '/usr/bin' };
  const plain = playwrightEnv(clean, { baseUrl: INPUTS.baseUrl, baselineDir: INPUTS.baselineDir });
  assert.deepEqual(plain, {
    PATH: '/usr/bin',
    VISUAL_BASE_URL: INPUTS.baseUrl,
    VISUAL_BASELINE_DIR: INPUTS.baselineDir,
    VISUAL_RESULTS_FILE: '',
    PLAYWRIGHT_HTML_OPEN: 'never',
  });
  assert.deepEqual(clean, { PATH: '/usr/bin' });
});
