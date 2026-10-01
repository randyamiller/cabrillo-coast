/* Cabrillo Coast LLC — built search index: validity, completeness, order, decoding and size (AC-08, AC-02, F-019) */
/**
 * Checks the `blog/search.json` that Jekyll writes from the Liquid template
 * of the same name (AAP 0.5.5). `blog/search.js` fetches this file, parses it
 * with `JSON.parse` and joins each entry to its listing item on `url`, so the
 * index must be valid JSON, complete, newest first, aligned with the listing
 * and free of private content.
 *
 * `scripts/verify.mjs` runs this suite twice, and every assertion holds in
 * both runs:
 *   1. Real build: `SITE_DIR=_site`, empty base path, custom-domain mode.
 *      At launch there are no articles and the index is `[]`.
 *   2. Fixture project build: `SITE_DIR=<tmp>/project/cabrillo-coast`,
 *      `SITE_BASEURL=/cabrillo-coast`, `SITE_URL=https://randyamiller.github.io`
 *      and `FIXTURE_DIR=<tmp>`. The fixture articles are present, and the
 *      synthetic draft and future-dated post were staged but must not be built.
 *
 * What it proves:
 *   - AC-08: the index is a JSON array of `{ url, title, summary, tags, date,
 *     body }` entries; there is exactly one entry per built article page and
 *     no duplicate; every URL resolves under the base path; entries are newest
 *     first and in the same order as the listing's `li[data-url]` items; the
 *     fixture bodies are indexed as decoded, lowercased text (`r&d`, `café`)
 *     with no leftover character references; front-matter values are raw text
 *     (`jsonify`, not `escape`); and the file stays inside its size budget,
 *     with raw and gzip sizes printed on every run.
 *   - AC-02 (index part): no entry belongs to the synthetic draft or the
 *     future-dated post, and no slug, no marker string and no
 *     `assets/drafts/` path appears anywhere in the file: not in its raw
 *     text and not in any string value of the parsed index (every field of
 *     every entry, nested ones included), which also catches text hidden
 *     behind JSON escapes such as `assets\/drafts\/`. Both comparisons are
 *     case-insensitive. On the real build these checks are vacuous but still
 *     run.
 *
 * Environment (same handling as `built-pages.test.mjs`):
 *   SITE_DIR      Built site, resolved against the repository root (`_site`).
 *   SITE_BASEURL  Base path the site was built with (empty).
 *   FIXTURE_DIR   Fixture output folder; fixture-only cases are skipped unless set.
 * `SITE_URL` plays no part here: the index holds base-path URLs, not absolute ones.
 *
 * Paths resolve from this file's own location (`ROOT`), never from
 * `process.cwd()`. The suite needs no network and writes nothing.
 *
 * Run: bundle exec jekyll build && node --test tests/static/built-search-index.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { DRAFT_MARKER, DRAFT_SLUG, FUTURE_MARKER, FUTURE_SLUG } from '../fixtures/build-fixture-site.mjs';
import { parseStartTags } from './lib/site-links.mjs';

/* ------------------------------------------------------------------------ */
/* Environment                                                               */
/* ------------------------------------------------------------------------ */

/** Repository root: two levels above `tests/static/`. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Built site under test; a relative value resolves against `ROOT`. */
const SITE_DIR = path.resolve(ROOT, process.env.SITE_DIR || '_site');

/** Base path the site was built with, without a trailing slash (`''` or `/cabrillo-coast`). */
const BASE = (process.env.SITE_BASEURL || '').replace(/\/+$/, '');

/** Fixture output folder from `build-fixture-site.mjs`, or `''` on the real build. */
const FIXTURE_DIR = process.env.FIXTURE_DIR ? path.resolve(ROOT, process.env.FIXTURE_DIR) : '';

/** Options for cases that need the fixture articles in `SITE_DIR`. */
const FIXTURE_ONLY = Object.freeze({ skip: !FIXTURE_DIR && 'FIXTURE_DIR not set' });

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** The built index and the listing that must agree with it. */
const SEARCH_JSON = path.join(SITE_DIR, 'blog', 'search.json');
const BLOG_DIR = path.join(SITE_DIR, 'blog');
const LISTING_HTML = path.join(BLOG_DIR, 'index.html');

/** URL prefix every article and index entry lives under. */
const BLOG_PREFIX = `${BASE}/blog/`;

/** The keys `blog/search.json` writes for every entry (AAP 0.5.5). */
const ENTRY_KEYS = Object.freeze(['url', 'title', 'summary', 'tags', 'date', 'body']);

/** Keys whose values must be strings; `tags` is checked separately as a string array. */
const STRING_KEYS = Object.freeze(['url', 'title', 'summary', 'date', 'body']);

/**
 * Size budget of the built index, following the warning-and-failure pattern of
 * the specification's thresholds (Tech Spec Table 6.6-21). A 2,000-word
 * article adds roughly 9,000 bytes, so the failure threshold sits near 45
 * articles. Raising `FAIL_BYTES` must happen in the same commit that grows the
 * index past it (AAP 0.5.5, Tech Spec §6.6.2.3), never afterwards; a sharded
 * or per-article index is a design change outside this release.
 */
const WARN_BYTES = 300000;
const FAIL_BYTES = 400000;

/** Slugs of the fixture articles (`tests/fixtures/posts/`). */
const CODE_FIXTURE_SLUG = 'fixture-code-and-tables';
const ESCAPING_FIXTURE_SLUG = 'fixture-escaping-and-liquid';

/** URL fragment shared by every fixture article. */
const FIXTURE_URL_PART = '/blog/fixture-';

/**
 * Words that appear only in the code-and-tables fixture's body, as the index
 * stores them: lowercased by Liquid `downcase`, `&` decoded from kramdown's
 * `&amp;`, and `é` precomposed (U+00E9) exactly as written in the fixture.
 */
const BODY_ONLY_WORDS = Object.freeze(['r&d', 'caf\u00e9']);

/**
 * The fixture title with characters `escape` would encode. `jsonify` keeps it
 * as raw text inside a valid JSON string.
 */
const ESCAPING_FIXTURE_TITLE = 'Escaping "quotes" & <angle> brackets';

/** Front-matter dates of the fixtures, read in UTC (`timezone: Etc/UTC`). */
const FIXTURE_DATES = Object.freeze({
  [CODE_FIXTURE_SLUG]: '2026-01-15',
  [ESCAPING_FIXTURE_SLUG]: '2026-02-01',
});

/**
 * Character references the index template decodes. The fixtures hold no
 * literal entity text, so any of these left in a fixture body means a step
 * of the decoding chain is missing or out of order.
 */
const UNDECODED_REFERENCES = Object.freeze(['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']);

/**
 * Path prefix of every draft image (`assets/drafts/<slug>/…`), the AC-02
 * draft-image reference: an index that names a draft image leaks its draft.
 */
const DRAFT_IMAGE_PREFIX = 'assets/drafts/';

/**
 * Text the index must never hold, in any field (AC-02): both synthetic slugs,
 * the draft-image prefix and both markers.
 */
const PRIVATE_TEXTS = Object.freeze([DRAFT_SLUG, FUTURE_SLUG, DRAFT_IMAGE_PREFIX, DRAFT_MARKER, FUTURE_MARKER]);

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Reads and parses the index once. Failures are recorded rather than thrown,
 * so the "valid JSON array" case reports the cause and every dependent case
 * fails with the same message instead of an unrelated TypeError.
 * @returns {{ bytes: Buffer | null, text: string | null, entries: unknown[] | null, error: string | null }}
 */
function loadIndex() {
  let bytes;
  try {
    bytes = readFileSync(SEARCH_JSON);
  } catch (err) {
    return { bytes: null, text: null, entries: null, error: `cannot read ${SEARCH_JSON}: ${err.message}` };
  }
  const text = bytes.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { bytes, text, entries: null, error: `${SEARCH_JSON} is not valid JSON: ${err.message}` };
  }
  if (!Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : typeof parsed;
    return { bytes, text, entries: null, error: `${SEARCH_JSON} holds a JSON ${kind}, not an array` };
  }
  return { bytes, text, entries: parsed, error: null };
}

/**
 * Directory names under `blog/` that hold an `index.html`: one per built
 * article (`permalink: /blog/:title/`). Sorted for stable reports.
 * @returns {string[]}
 */
function builtArticleSlugs() {
  return readdirSync(BLOG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(BLOG_DIR, entry.name, 'index.html')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * `true` when `file` is a regular file inside `SITE_DIR`. The containment
 * check keeps a URL such as `/blog/../../x/` from resolving outside the site.
 * @param {string} file
 * @returns {boolean}
 */
function isSiteFile(file) {
  const rel = path.relative(SITE_DIR, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    const stats = statSync(file, { throwIfNoEntry: false });
    return stats !== undefined && stats.isFile();
  } catch {
    // A path through a regular file (ENOTDIR) or an invalid path names no file.
    return false;
  }
}

/**
 * Finds the fixture entry whose URL ends with `/blog/<slug>/`, failing with
 * the list of URLs present when it is missing.
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} slug
 * @returns {Record<string, unknown>}
 */
function fixtureEntry(entries, slug) {
  const suffix = `/blog/${slug}/`;
  const entry = entries.find((candidate) => typeof candidate.url === 'string' && candidate.url.endsWith(suffix));
  assert.ok(
    entry,
    `no index entry ends with ${suffix}; entries: ${JSON.stringify(entries.map((e) => e.url))}`,
  );
  return entry;
}

/**
 * Every string inside a parsed JSON value, depth first, as `[where, string]`
 * pairs. `where` names `value` itself; nested values extend it with `.key`
 * or `[i]` (`entry 0 (/blog/x/).tags[1]`). Numbers, booleans and `null` hold
 * no text and yield nothing; parsed JSON has no cycles.
 * @param {unknown} value
 * @param {string} where
 * @returns {Generator<[string, string]>}
 */
function* stringValues(value, where) {
  if (typeof value === 'string') {
    yield [where, value];
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) yield* stringValues(value[i], `${where}[${i}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) yield* stringValues(child, `${where}.${key}`);
  }
}

/* ------------------------------------------------------------------------ */
/* Suite                                                                     */
/* ------------------------------------------------------------------------ */

/** Registers every case; called only when `SITE_DIR` exists. */
function defineSuite() {
  const index = loadIndex();

  /** The parsed entries, or the load failure as the case's error. */
  const requireEntries = () => {
    if (index.error) throw new Error(index.error);
    return /** @type {Array<Record<string, unknown>>} */ (index.entries);
  };

  /* ---------------------------------------------------------------------- */
  /* Phase 1: load and entry shape                                          */
  /* ---------------------------------------------------------------------- */

  test('[AC-08][F-019] search.json is a valid JSON array', (t) => {
    assert.equal(index.error, null, index.error ?? '');
    t.diagnostic(`search.json: ${index.entries.length} entries`);
  });

  test('[AC-08][F-019] every entry has url, title, summary, tags, date and body of the right types', () => {
    const entries = requireEntries();
    entries.forEach((entry, i) => {
      const where = `entry ${i}${entry && typeof entry.url === 'string' ? ` (${entry.url})` : ''}`;
      assert.ok(
        entry !== null && typeof entry === 'object' && !Array.isArray(entry),
        `${where} is not a JSON object: ${JSON.stringify(entry)}`,
      );
      assert.deepEqual(Object.keys(entry).sort(), [...ENTRY_KEYS].sort(), `${where} keys`);
      for (const key of STRING_KEYS) {
        assert.equal(typeof entry[key], 'string', `${where}: ${key} must be a string, got ${JSON.stringify(entry[key])}`);
      }
      assert.ok(!Number.isNaN(Date.parse(entry.date)), `${where}: date ${JSON.stringify(entry.date)} does not parse`);
      assert.ok(Array.isArray(entry.tags), `${where}: tags must be an array, got ${JSON.stringify(entry.tags)}`);
      entry.tags.forEach((tag, j) => {
        assert.equal(typeof tag, 'string', `${where}: tags[${j}] must be a string, got ${JSON.stringify(tag)}`);
      });
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Phase 2: completeness and order                                        */
  /* ---------------------------------------------------------------------- */

  test('[AC-08][F-019] the index holds exactly one entry per built article', (t) => {
    const entries = requireEntries();
    assert.ok(existsSync(BLOG_DIR), `${BLOG_DIR} not found: the build produced no blog`);
    const expected = builtArticleSlugs().map((slug) => `${BLOG_PREFIX}${slug}/`);
    const urls = entries.map((entry) => entry.url);
    const duplicates = urls.filter((url, i) => urls.indexOf(url) !== i);
    assert.deepEqual(duplicates, [], `duplicate index entries: ${JSON.stringify(duplicates)}`);
    assert.deepEqual(
      [...urls].sort(),
      expected,
      'index entry URLs must equal the built article pages (blog/<slug>/index.html)',
    );
    t.diagnostic(`${expected.length} built articles, ${urls.length} index entries`);
  });

  test('[AC-08][F-019] every entry URL resolves to a built page under the base path', () => {
    const entries = requireEntries();
    for (const { url } of entries) {
      assert.ok(url.startsWith(BLOG_PREFIX), `${url} does not start with ${BLOG_PREFIX}`);
      assert.ok(url.endsWith('/'), `${url} does not end with "/" (permalink /blog/:title/)`);
      const file = path.join(SITE_DIR, ...url.slice(BASE.length).split('/'), 'index.html');
      assert.ok(isSiteFile(file), `${url} does not resolve: ${file} is not a built file`);
    }
  });

  test('[AC-08][F-019] entries are ordered newest first', () => {
    const entries = requireEntries();
    for (let i = 1; i < entries.length; i += 1) {
      const newer = entries[i - 1];
      const older = entries[i];
      assert.ok(
        Date.parse(newer.date) >= Date.parse(older.date),
        `entry ${i - 1} (${newer.url}, ${newer.date}) is older than entry ${i} (${older.url}, ${older.date})`,
      );
    }
  });

  test('[AC-08][F-019] listing items appear in index order', () => {
    const entries = requireEntries();
    assert.ok(existsSync(LISTING_HTML), `${LISTING_HTML} not found: the build produced no listing`);
    // search.js joins each listing item to its entry on data-url and re-appends
    // matches in rank order, with index order as the tie-break, so the two
    // orders must agree. Tag-list items carry no data-url and are skipped.
    const listed = parseStartTags(readFileSync(LISTING_HTML, 'utf8'))
      .filter((tag) => tag.name === 'li' && Object.hasOwn(tag.attrs, 'data-url'))
      .map((tag) => tag.attrs['data-url']);
    assert.deepEqual(
      listed,
      entries.map((entry) => entry.url),
      'listing li[data-url] values must equal the index URLs, in the same order',
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Phase 3: AC-02, private content never reaches the index                */
  /* ---------------------------------------------------------------------- */

  test('[AC-02][F-019] no draft or future-dated post reaches the index', () => {
    const entries = requireEntries();
    for (const { url } of entries) {
      assert.ok(!url.includes(DRAFT_SLUG), `the synthetic draft is indexed: ${url}`);
      assert.ok(!url.includes(FUTURE_SLUG), `the future-dated post is indexed: ${url}`);
    }
    // Every decoded string of every entry, whatever its field: JSON escapes
    // (`assets\/drafts\/`, `\u0066ixture-…`) can hide a needle from the raw text.
    const leaks = entries.flatMap((entry, i) => {
      const where = `entry ${i}${entry && typeof entry.url === 'string' ? ` (${entry.url})` : ''}`;
      return [...stringValues(entry, where)].flatMap(([field, value]) => {
        const lower = value.toLowerCase();
        return PRIVATE_TEXTS.filter((needle) => lower.includes(needle.toLowerCase())).map(
          (needle) => `${field}: ${needle}`,
        );
      });
    });
    assert.deepEqual(leaks, [], `private slugs, markers or draft-image paths in ${SEARCH_JSON}:\n${leaks.join('\n')}`);
    // The template lowercases every body (Liquid downcase), so a leaked marker
    // would appear in lower case: compare case-insensitively.
    const text = index.text.toLowerCase();
    for (const marker of [DRAFT_MARKER, FUTURE_MARKER]) {
      assert.ok(!text.includes(marker.toLowerCase()), `search.json contains the private marker ${marker}`);
    }
    // The raw text also covers what no string value holds, such as an object key.
    for (const needle of [DRAFT_SLUG, FUTURE_SLUG, DRAFT_IMAGE_PREFIX]) {
      assert.ok(!text.includes(needle.toLowerCase()), `search.json text contains ${needle}`);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Phase 4: body decoding and raw front-matter values (fixture build)     */
  /* ---------------------------------------------------------------------- */

  test('[AC-08][F-019] body-only words are indexed decoded and lowercased', FIXTURE_ONLY, () => {
    const entry = fixtureEntry(requireEntries(), CODE_FIXTURE_SLUG);
    const elsewhere = [entry.title, entry.summary, entry.tags.join(' ')].join(' ').toLowerCase();
    for (const word of BODY_ONLY_WORDS) {
      assert.ok(entry.body.includes(word), `${entry.url} body lacks ${JSON.stringify(word)}`);
      assert.ok(
        !elsewhere.includes(word),
        `${JSON.stringify(word)} occurs in the title, summary or tags of ${entry.url}, so it no longer proves body search`,
      );
    }
    // Code samples are part of the indexed body (AAP 0.5.5).
    assert.ok(entry.body.includes('retry_delay'), `${entry.url} body lacks its python sample`);
  });

  test('[AC-08][F-019] fixture bodies carry no undecoded character references', FIXTURE_ONLY, () => {
    const entries = requireEntries().filter((entry) => entry.url.includes(FIXTURE_URL_PART));
    assert.ok(entries.length >= 2, `expected both fixture entries, found ${JSON.stringify(entries.map((e) => e.url))}`);
    for (const entry of entries) {
      for (const reference of UNDECODED_REFERENCES) {
        const at = entry.body.indexOf(reference);
        assert.equal(
          at,
          -1,
          `${entry.url} body still holds ${reference}: …${entry.body.slice(Math.max(0, at - 40), at + 40)}…`,
        );
      }
    }
    // Positive counterpart: the escaped html sample comes back as the markup it shows.
    const escaping = fixtureEntry(entries, ESCAPING_FIXTURE_SLUG);
    assert.ok(
      escaping.body.includes('<script src="/assets/app.js"></script>'),
      `${escaping.url} body lacks the decoded html code sample`,
    );
  });

  test('[AC-08][F-019] front-matter values are raw text, not HTML-escaped', FIXTURE_ONLY, () => {
    const entries = requireEntries();
    const escaping = fixtureEntry(entries, ESCAPING_FIXTURE_SLUG);
    assert.equal(escaping.title, ESCAPING_FIXTURE_TITLE);
    // Liquid inside {% raw %} survives into the index as literal text.
    assert.ok(escaping.body.includes('.values.image'), `${escaping.url} body lacks its raw Liquid sample`);
    for (const [slug, day] of Object.entries(FIXTURE_DATES)) {
      const entry = fixtureEntry(entries, slug);
      assert.ok(entry.date.startsWith(day), `${entry.url} date ${entry.date} does not start with ${day} (UTC)`);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Phase 5: size budget                                                   */
  /* ---------------------------------------------------------------------- */

  test('[AC-08][F-019] search.json stays within its size budget', (t) => {
    if (index.bytes === null) throw new Error(index.error);
    const raw = index.bytes.length;
    const gzip = gzipSync(index.bytes).length;
    const report = `search.json: ${raw} bytes raw, ${gzip} bytes gzip (warning above ${WARN_BYTES}, failure above ${FAIL_BYTES})`;
    t.diagnostic(report);
    console.log(report);
    if (raw > WARN_BYTES) {
      const warning = `WARNING: search.json is ${raw} bytes, above the ${WARN_BYTES}-byte warning threshold`;
      t.diagnostic(warning);
      console.log(warning);
    }
    assert.ok(
      raw <= FAIL_BYTES,
      `search.json is ${raw} bytes, above the ${FAIL_BYTES}-byte limit: raise FAIL_BYTES in the commit that grows the index`,
    );
  });
}

if (!existsSync(SITE_DIR)) {
  // Without a build there is nothing to check: one failing case says why, and
  // no other case is registered (top-level return is not allowed in ESM).
  test('[AC-08][F-019] built site present', () => {
    assert.fail(`SITE_DIR ${SITE_DIR} not found — run bundle exec jekyll build first`);
  });
} else {
  defineSuite();
}
