/* Cabrillo Coast LLC — built search index: validity, completeness, fidelity, order and size (AC-08, AC-02; F-019, F-017) */
/**
 * Checks the `blog/search.json` that Jekyll writes from the Liquid template
 * of the same name (AAP 0.5.5). `blog/search.js` parses it with `JSON.parse`
 * and joins each entry to its listing item on `url`.
 *
 * `scripts/verify.mjs` runs this suite twice:
 *   1. Real build: `SITE_DIR=_site`, empty base path. At launch there are no
 *      articles and the index is `[]`.
 *   2. Fixture project build: `SITE_DIR=<tmp>/project/cabrillo-coast`,
 *      `SITE_BASEURL=/cabrillo-coast`, `SITE_URL=https://randyamiller.github.io`
 *      and `FIXTURE_DIR=<tmp>`. The synthetic draft and future-dated post were
 *      staged but must not be built.
 *
 * Coverage (AC-08, and AC-02 for the index). Common cases run in both builds,
 * vacuously per entry on the empty one: entry shape, title, summary and tags
 * against the listing and the article page, one entry per built article, URL
 * resolution, newest-first and listing order, absence of private content,
 * distinct body tokens and the size budget. Fixture-only cases are skipped with
 * `FIXTURE_DIR not set` on the real build: body-only words and fenced code,
 * bodies against the built prose, leftover character references, and title,
 * summary and tags as raw text against the fixture sources, with dates from
 * the fixture filenames read in UTC.
 *
 * The body oracle is derived from the article page alone, independent of the
 * template. With the explicit checks for live tags, case, separators, repeats
 * and order, it covers every step of the body chain but `normalize_whitespace`
 * on its own, whose removal changes no byte because `split: " "` already
 * splits on runs of whitespace.
 *
 * Privacy checks search the raw text and every string value of the parsed
 * index, which catches text hidden behind JSON escapes such as
 * `assets\/drafts\/fixture-private-draft\/`, case-insensitively because
 * Liquid downcases bodies.
 *
 * Environment (same handling as `built-pages.test.mjs`):
 *   SITE_DIR      Built site, resolved against the repository root (`_site`).
 *   SITE_BASEURL  Base path the site was built with (empty).
 *   FIXTURE_DIR   Fixture output folder; fixture-only cases are skipped unless set.
 * `SITE_URL` plays no part here: the index holds base-path URLs, not absolute ones.
 *
 * Paths resolve from `ROOT`, never from `process.cwd()`. The suite needs no
 * network and writes nothing.
 *
 * Run: bundle exec jekyll build && node --test tests/static/built-search-index.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { parseArticle } from '../../scripts/lib/articles.mjs';
import {
  DRAFT_IMAGE,
  DRAFT_MARKER,
  DRAFT_SLUG,
  FIXTURE_POSTS,
  FUTURE_MARKER,
  FUTURE_SLUG,
} from '../fixtures/build-fixture-site.mjs';
import { decodeEntities, parseStartTags } from './lib/site-links.mjs';

/* Environment */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Built site under test; a relative value resolves against `ROOT`. */
const SITE_DIR = path.resolve(ROOT, process.env.SITE_DIR || '_site');

/** Base path the site was built with, without a trailing slash (`''` or `/cabrillo-coast`). */
const BASE = (process.env.SITE_BASEURL || '').replace(/\/+$/, '');

/** Fixture output folder from `build-fixture-site.mjs`, or `''` on the real build. */
const FIXTURE_DIR = process.env.FIXTURE_DIR ? path.resolve(ROOT, process.env.FIXTURE_DIR) : '';

/** Options for cases that need the fixture articles in `SITE_DIR`. */
const FIXTURE_ONLY = Object.freeze({ skip: !FIXTURE_DIR && 'FIXTURE_DIR not set' });

/* Constants */

const SEARCH_JSON = path.join(SITE_DIR, 'blog', 'search.json');
const BLOG_DIR = path.join(SITE_DIR, 'blog');
const LISTING_HTML = path.join(BLOG_DIR, 'index.html');

const BLOG_PREFIX = `${BASE}/blog/`;

/** The keys `blog/search.json` writes for every entry (AAP 0.5.5). */
const ENTRY_KEYS = Object.freeze(['url', 'title', 'summary', 'tags', 'date', 'body']);

/** Keys whose values must be strings; `tags` is checked separately as a string array. */
const STRING_KEYS = Object.freeze(['url', 'title', 'summary', 'date', 'body']);

/** String keys the article schema requires to be non-empty (AAP 0.5.3: 1 or more characters). */
const NON_EMPTY_KEYS = Object.freeze(['title', 'summary']);

/** Number of tags every article carries (AAP 0.5.3: 1 to 5 items). */
const TAGS_MIN = 1;
const TAGS_MAX = 5;

const FIXTURE_POSTS_DIR = path.join(ROOT, 'tests', 'fixtures', 'posts');

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

const CODE_FIXTURE_SLUG = 'fixture-code-and-tables';
const ESCAPING_FIXTURE_SLUG = 'fixture-escaping-and-liquid';

const FIXTURE_URL_PART = '/blog/fixture-';

/**
 * Words that appear only in the code-and-tables fixture's body, as the index
 * stores them: lowercased by Liquid `downcase`, `&` decoded from kramdown's
 * `&amp;`, and `é` precomposed (U+00E9) exactly as written in the fixture.
 */
const BODY_ONLY_WORDS = Object.freeze(['r&d', 'caf\u00e9']);

/**
 * Text that each fixture holds only inside its ``` fenced code blocks, as the
 * index stores it (lowercased, distinct tokens still adjacent). A bare
 * `retry_delay` would not do: the prose names `retry_delay(3)` in inline
 * code, so it survives the loss of every fence. The Liquid probe keeps both
 * braces, which `{% raw %}` must carry through. The fixture sources are
 * re-checked on every run, so each probe keeps proving fenced code.
 */
const CODE_ONLY_PROBES = Object.freeze({
  [CODE_FIXTURE_SLUG]: Object.freeze(['def retry_delay(attempt,', 'base_seconds:']),
  [ESCAPING_FIXTURE_SLUG]: Object.freeze(['{{ .values.image }}']),
});

/**
 * The fixture title with characters `escape` would encode. `jsonify` keeps it
 * as raw text inside a valid JSON string.
 */
const ESCAPING_FIXTURE_TITLE = 'Escaping "quotes" & <angle> brackets';

/** Publication dates from fixture filenames, read in UTC (`timezone: Etc/UTC`). */
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
 * Bounds of an article's prose region in `_layouts/post.html`: from the end
 * of the single `div.prose` start tag to the `</div>` before the last back
 * link, which directly follows the prose.
 */
const PROSE_OPEN = '<div class="prose">';
const POST_BACK = '<p class="post-back">';

/**
 * Liquid 4.0.4 `strip_html`, reproduced for the body oracle: script, comment
 * and style blocks go first, then every remaining tag.
 */
const STRIP_HTML_BLOCKS_RE = /<script[\s\S]*?<\/script>|<!--[\s\S]*?-->|<style[\s\S]*?<\/style>/g;
const STRIP_HTML_TAGS_RE = /<[\s\S]*?>/g;

/**
 * The five references the index template decodes, and their text. Decoding
 * them in one pass gives what the template's `&amp;`-last order gives
 * (`&amp;lt;` becomes `&lt;`); any other reference stays literal (AAP 0.5.5).
 */
const INDEX_REFERENCE_RE = /&(?:lt|gt|quot|#39|amp);/g;
const INDEX_REFERENCE_TEXT = Object.freeze({
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&',
});

/**
 * A run of whitespace as `normalize_whitespace` and `split: " "` see it.
 * Ruby's `\s` is ASCII only, so JavaScript's Unicode `\s` would collapse
 * characters, such as U+00A0, that the template keeps inside a token.
 */
const RUBY_WHITESPACE_RE = /[ \t\r\n\f\v]+/g;

/** A non-empty body of tokens joined by single spaces, as `split: " " | uniq | join: " "` writes it. */
const TOKEN_BODY_RE = /^[^\t\n\v\f\r ]+(?: [^\t\n\v\f\r ]+)*$/;

/**
 * The synthetic draft's image folder (`assets/drafts/fixture-private-draft/`),
 * the AC-02 draft-image reference. It is the only draft-image folder a fixture
 * build's source holds (staging leaves the author's own out), and the real
 * build renders no draft. The bare `assets/drafts/` prefix is no needle: index
 * bodies are `strip_html` text, so on either build it could match only a
 * published article that names the path, which leaks nothing. The folder holds
 * `DRAFT_SLUG`, so the slug needle matches it too; it is kept so that a failure
 * names the draft-image clause of AC-02.
 */
const DRAFT_IMAGE_FOLDER = `${path.posix.dirname(DRAFT_IMAGE)}/`;

/**
 * Text the index must never hold, in any field (AC-02): both synthetic slugs,
 * the synthetic draft's image folder and both markers.
 */
const PRIVATE_TEXTS = Object.freeze([DRAFT_SLUG, FUTURE_SLUG, DRAFT_IMAGE_FOLDER, DRAFT_MARKER, FUTURE_MARKER]);

/* Helpers */

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

/**
 * Built page of an index URL: `SITE_DIR` plus the URL without the base path,
 * plus `index.html` (`/cabrillo-coast/blog/x/` → `<SITE_DIR>/blog/x/index.html`).
 * @param {string} url
 * @returns {string}
 */
function articlePageFile(url) {
  return path.join(SITE_DIR, ...url.slice(BASE.length).split('/'), 'index.html');
}

/**
 * `true` when the tag's `class` attribute lists `token` among its
 * whitespace-separated class names (`card post-card` has `post-card`).
 * @param {import('./lib/site-links.mjs').StartTag} tag
 * @param {string} token
 * @returns {boolean}
 */
function hasClass(tag, token) {
  return Object.hasOwn(tag.attrs, 'class') && tag.attrs.class.split(/[\t\n\f\r ]+/).includes(token);
}

/**
 * Decoded text of the element that `tag` opens: the source from the end of
 * the start tag to the first `</name>` after it. That slice must hold no `<`,
 * so nested markup or a mis-sliced region fails with the slice shown, not as
 * a wrong value. Layouts print front matter through Liquid `escape`, so the
 * slice is decoded before it is compared with the index.
 * @param {string} html
 * @param {import('./lib/site-links.mjs').StartTag} tag
 * @param {string} where
 * @returns {string}
 */
function elementText(html, tag, where) {
  const close = html.indexOf(`</${tag.name}>`, tag.end);
  assert.notEqual(close, -1, `${where}: the <${tag.name}> at offset ${tag.start} is never closed`);
  const raw = html.slice(tag.end, close);
  assert.ok(
    !raw.includes('<'),
    `${where}: the <${tag.name}> at offset ${tag.start} holds markup, not text: ${JSON.stringify(raw)}`,
  );
  return decodeEntities(raw);
}

/**
 * Start tags of the listing item for `url`: from its `li[data-url]` to the
 * next `li[data-url]`, or to the `</ol>` after the last one. The item's own
 * `li` is left out.
 * @param {string} html
 * @param {import('./lib/site-links.mjs').StartTag[]} tags `parseStartTags(html)`
 * @param {string} url
 * @returns {import('./lib/site-links.mjs').StartTag[]}
 */
function listingItemTags(html, tags, url) {
  const items = tags.filter((tag) => tag.name === 'li' && Object.hasOwn(tag.attrs, 'data-url'));
  const at = items.findIndex((tag) => tag.attrs['data-url'] === url);
  assert.notEqual(at, -1, `the listing has no li[data-url="${url}"]`);
  const { start, end: itemOpenEnd } = items[at];
  const end = at + 1 < items.length ? items[at + 1].start : html.indexOf('</ol>', itemOpenEnd);
  assert.notEqual(end, -1, `the last listing item (${url}) is not followed by </ol>`);
  return tags.filter((tag) => tag.start > start && tag.start < end);
}

/**
 * Text of every `a.tag-link` among `tags`, in document order.
 * @param {string} html
 * @param {import('./lib/site-links.mjs').StartTag[]} tags
 * @param {string} where
 * @returns {string[]}
 */
function tagLinkTexts(html, tags, where) {
  return tags
    .filter((tag) => tag.name === 'a' && hasClass(tag, 'tag-link'))
    .map((tag) => elementText(html, tag, where));
}

/**
 * The fixture article's source, parsed with the same front-matter parser
 * `article.mjs` uses. Fails when it reports an error, so a comparison never
 * runs against partly parsed data.
 * @param {string} file Basename inside `tests/fixtures/posts/`.
 * @returns {{ data: Record<string, string | string[]>, body: string }}
 */
function fixtureSource(file) {
  const source = path.join(FIXTURE_POSTS_DIR, file);
  const { data, body, errors } = parseArticle(readFileSync(source, 'utf8'));
  assert.deepEqual(errors, [], `${source} does not parse`);
  return { data, body };
}

/**
 * Splits Markdown into the text inside ``` fenced blocks and the text outside
 * them. A line whose trimmed start is ``` toggles between the two and belongs
 * to neither, so a fence's language name is in neither part.
 * @param {string} markdown
 * @returns {{ fenced: string, prose: string }}
 */
function splitFences(markdown) {
  const fenced = [];
  const prose = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    else (inFence ? fenced : prose).push(line);
  }
  return { fenced: fenced.join('\n'), prose: prose.join('\n') };
}

/**
 * Tokens that occur more than once, each named once, in first-repeat order.
 * @param {string[]} tokens
 * @returns {string[]}
 */
function duplicateTokens(tokens) {
  const seen = new Set();
  const repeated = new Set();
  for (const token of tokens) (seen.has(token) ? repeated : seen).add(token);
  return [...repeated];
}

/**
 * The body the index template must write for a built article, derived from
 * the article page alone rather than from the template: the prose region,
 * its markup removed as `strip_html` removes it, the five references decoded,
 * ASCII whitespace collapsed and trimmed, lowercased, then reduced to its
 * distinct tokens in first-occurrence order.
 * @param {string} html Built article page.
 * @param {string} where Page named in failure messages.
 * @returns {{ prose: string, stripped: string, text: string, tokens: string[], distinct: string[] }}
 *   `stripped` is the prose without markup, `text` the decoded, collapsed and
 *   lowercased text, `tokens` every token of it and `distinct` the expected body tokens.
 */
function expectedBody(html, where) {
  const open = html.indexOf(PROSE_OPEN);
  assert.notEqual(open, -1, `${where} has no ${PROSE_OPEN}`);
  assert.equal(html.indexOf(PROSE_OPEN, open + 1), -1, `${where} has more than one ${PROSE_OPEN}`);
  const start = open + PROSE_OPEN.length;
  const back = html.lastIndexOf(POST_BACK);
  assert.ok(back > start, `${where}: no ${POST_BACK} follows the prose`);
  const end = html.lastIndexOf('</div>', back);
  assert.ok(end >= start, `${where}: no </div> closes the prose before the last ${POST_BACK}`);
  const prose = html.slice(start, end);
  const stripped = prose.replace(STRIP_HTML_BLOCKS_RE, '').replace(STRIP_HTML_TAGS_RE, '');
  const text = stripped
    .replace(INDEX_REFERENCE_RE, (reference) => INDEX_REFERENCE_TEXT[reference])
    .replace(RUBY_WHITESPACE_RE, ' ')
    .replace(/^ | $/g, '')
    .toLowerCase();
  const tokens = text === '' ? [] : text.split(' ');
  return { prose, stripped, text, tokens, distinct: [...new Set(tokens)] };
}

/**
 * Where two token lists first differ, with a few tokens of context on each
 * side, so a failing body comparison names the step that went wrong.
 * @param {string[]} actual
 * @param {string[]} expected
 * @returns {string}
 */
function firstTokenDifference(actual, expected) {
  const show = (token) => (token === undefined ? 'the end of the body' : JSON.stringify(token));
  const around = (list, i) => JSON.stringify(list.slice(Math.max(0, i - 3), i + 4).join(' '));
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    if (actual[i] !== expected[i]) {
      return (
        `first difference at token ${i}: got ${show(actual[i])}, expected ${show(expected[i])} ` +
        `(got …${around(actual, i)}…, expected …${around(expected, i)}…)`
      );
    }
  }
  return 'the token lists are equal';
}

/* Suite */

function defineSuite() {
  const index = loadIndex();

  /** The parsed entries, or the load failure as the case's error. */
  const requireEntries = () => {
    if (index.error) throw new Error(index.error);
    return /** @type {Array<Record<string, unknown>>} */ (index.entries);
  };

  /* Phase 1: load, entry shape and metadata fidelity */

  test('[AC-08][F-019] search.json is a valid JSON array', (t) => {
    assert.equal(index.error, null, index.error ?? '');
    t.diagnostic(`search.json: ${index.entries.length} entries`);
  });

  test('[AC-08][F-019] every entry has url, title, summary, tags, date and body of the right types, with non-empty title, summary and tags', () => {
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
      // Required article fields: an empty value would silently drop every
      // title- or summary-only match.
      for (const key of NON_EMPTY_KEYS) {
        assert.notEqual(entry[key], '', `${where}: ${key} must not be empty`);
      }
      assert.ok(!Number.isNaN(Date.parse(entry.date)), `${where}: date ${JSON.stringify(entry.date)} does not parse`);
      assert.ok(Array.isArray(entry.tags), `${where}: tags must be an array, got ${JSON.stringify(entry.tags)}`);
      assert.ok(
        entry.tags.length >= TAGS_MIN && entry.tags.length <= TAGS_MAX,
        `${where}: tags must hold ${TAGS_MIN} to ${TAGS_MAX} items, got ${JSON.stringify(entry.tags)}`,
      );
      entry.tags.forEach((tag, j) => {
        assert.equal(typeof tag, 'string', `${where}: tags[${j}] must be a string, got ${JSON.stringify(tag)}`);
        assert.notEqual(tag, '', `${where}: tags[${j}] must not be empty`);
      });
    });
  });

  test('[AC-08][F-019] entry title, summary and tags equal the listing item and the article page', () => {
    const entries = requireEntries();
    assert.ok(existsSync(LISTING_HTML), `${LISTING_HTML} not found: the build produced no listing`);
    const listing = readFileSync(LISTING_HTML, 'utf8');
    const listingTags = parseStartTags(listing);
    for (const entry of entries) {
      // Listing item: h2 > a holds the title, p.post-summary the summary,
      // a.tag-link the tags in front-matter order.
      const inListing = `listing item ${entry.url}`;
      const item = listingItemTags(listing, listingTags, entry.url);
      const heading = item.find((tag) => tag.name === 'h2');
      assert.ok(heading, `${inListing} has no h2`);
      const titleLink = item.find((tag) => tag.name === 'a' && tag.start > heading.start);
      assert.ok(titleLink, `${inListing} has no link after its h2`);
      assert.equal(elementText(listing, titleLink, inListing), entry.title, `${inListing}: title`);
      const summaries = item.filter((tag) => tag.name === 'p' && hasClass(tag, 'post-summary'));
      assert.equal(summaries.length, 1, `${inListing} must have exactly one p.post-summary`);
      assert.equal(elementText(listing, summaries[0], inListing), entry.summary, `${inListing}: summary`);
      assert.deepEqual(tagLinkTexts(listing, item, inListing), entry.tags, `${inListing}: tag links`);

      // Article page: the single h1, the meta description and the tag links
      // inside header.post-header.
      const file = articlePageFile(entry.url);
      assert.ok(isSiteFile(file), `${entry.url} does not resolve: ${file} is not a built file`);
      const html = readFileSync(file, 'utf8');
      const tags = parseStartTags(html);
      const onPage = `article page ${entry.url}`;
      const h1s = tags.filter((tag) => tag.name === 'h1');
      assert.equal(h1s.length, 1, `${onPage} must have exactly one h1`);
      assert.equal(elementText(html, h1s[0], onPage), entry.title, `${onPage}: h1`);
      const descriptions = tags.filter((tag) => tag.name === 'meta' && tag.attrs.name === 'description');
      assert.equal(descriptions.length, 1, `${onPage} must have exactly one meta[name="description"]`);
      // parseStartTags has already decoded the attribute value.
      assert.equal(descriptions[0].attrs.content, entry.summary, `${onPage}: meta description`);
      const headers = tags.filter((tag) => tag.name === 'header' && hasClass(tag, 'post-header'));
      assert.equal(headers.length, 1, `${onPage} must have exactly one header.post-header`);
      const headerEnd = html.indexOf('</header>', headers[0].end);
      assert.notEqual(headerEnd, -1, `${onPage}: header.post-header is never closed`);
      const inHeader = tags.filter((tag) => tag.start > headers[0].start && tag.start < headerEnd);
      assert.deepEqual(tagLinkTexts(html, inHeader, onPage), entry.tags, `${onPage}: header tag links`);
    }
  });

  /* Phase 2: completeness and order */

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

  /* Phase 3: AC-02, private content never reaches the index */

  test('[AC-02][F-017] no draft or future-dated post reaches the index', () => {
    const entries = requireEntries();
    for (const { url } of entries) {
      assert.ok(!url.includes(DRAFT_SLUG), `the synthetic draft is indexed: ${url}`);
      assert.ok(!url.includes(FUTURE_SLUG), `the future-dated post is indexed: ${url}`);
    }
    // Every decoded string of every entry, whatever its field: JSON escapes
    // (`assets\/drafts\/fixture-private-draft\/`, `\u0066ixture-…`) can hide a
    // needle from the raw text.
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
    for (const needle of [DRAFT_SLUG, FUTURE_SLUG, DRAFT_IMAGE_FOLDER]) {
      assert.ok(!text.includes(needle.toLowerCase()), `search.json text contains ${needle}`);
    }
  });

  /* Phase 4: body tokens and decoding, raw front-matter values */

  test('[AC-08][F-019] every body is single-space-separated distinct tokens', () => {
    const entries = requireEntries();
    for (const entry of entries) {
      assert.equal(typeof entry.body, 'string', `${entry.url}: body must be a string`);
      if (entry.body === '') continue;
      assert.match(
        entry.body,
        TOKEN_BODY_RE,
        `${entry.url} body must be tokens joined by single spaces, with no other whitespace and none at either end`,
      );
      const repeated = duplicateTokens(entry.body.split(' '));
      assert.deepEqual(
        repeated,
        [],
        `${entry.url} body repeats ${repeated.length} token(s): ${JSON.stringify(repeated.slice(0, 20))}`,
      );
    }
  });

  test('[AC-08][F-019] body-only words and fenced code samples are indexed decoded and lowercased', FIXTURE_ONLY, () => {
    const entries = requireEntries();
    const entry = fixtureEntry(entries, CODE_FIXTURE_SLUG);
    const elsewhere = [entry.title, entry.summary, entry.tags.join(' ')].join(' ').toLowerCase();
    for (const word of BODY_ONLY_WORDS) {
      assert.ok(entry.body.includes(word), `${entry.url} body lacks ${JSON.stringify(word)}`);
      assert.ok(
        !elsewhere.includes(word),
        `${JSON.stringify(word)} occurs in the title, summary or tags of ${entry.url}, so it no longer proves body search`,
      );
    }
    // Code samples are part of the indexed body (AAP 0.5.5), the raw Liquid
    // sample with its braces included.
    for (const [slug, probes] of Object.entries(CODE_ONLY_PROBES)) {
      const post = FIXTURE_POSTS.find((candidate) => candidate.slug === slug);
      assert.ok(post, `CODE_ONLY_PROBES names ${slug}, which is not in FIXTURE_POSTS`);
      const { fenced, prose } = splitFences(fixtureSource(post.file).body);
      const fixture = fixtureEntry(entries, slug);
      for (const probe of probes) {
        assert.ok(
          fenced.toLowerCase().includes(probe),
          `${post.file}: ${JSON.stringify(probe)} is not inside a fenced code block, so it no longer proves code indexing`,
        );
        assert.ok(
          !prose.toLowerCase().includes(probe),
          `${post.file}: ${JSON.stringify(probe)} also occurs outside fenced code, so it no longer proves code indexing`,
        );
        assert.ok(
          fixture.body.includes(probe),
          `${fixture.url} body lacks its fenced code sample ${JSON.stringify(probe)}`,
        );
      }
    }
  });

  test('[AC-08][F-019] fixture bodies equal the distinct tokens of the decoded built article prose', FIXTURE_ONLY, (t) => {
    const entries = requireEntries();
    for (const { slug } of FIXTURE_POSTS) {
      const entry = fixtureEntry(entries, slug);
      const file = articlePageFile(entry.url);
      assert.ok(isSiteFile(file), `${entry.url} does not resolve: ${file} is not a built file`);
      const where = `article page ${entry.url}`;
      const expected = expectedBody(readFileSync(file, 'utf8'), where);
      const live = parseStartTags(expected.prose);
      // The fixture must give every step something to do.
      assert.ok(live.length > 0, `${where}: the prose holds no markup, so HTML removal goes unchecked`);
      assert.match(
        expected.stripped,
        /[\t\n\v\f\r]| {2}/,
        `${where}: the prose holds no whitespace run, so collapsing goes unchecked`,
      );
      assert.ok(
        expected.tokens.length > expected.distinct.length,
        `${where}: the prose repeats no word, so distinct-token reduction goes unchecked`,
      );
      // HTML removal: no live tag of the prose survives into the body. A tag
      // name the decoded text itself shows, such as the escaping fixture's
      // `<script src=…>` code sample, is content and stays.
      for (const name of new Set(live.map((tag) => tag.name))) {
        // Tag names hold only word characters, ':' and '-', so none needs escaping.
        const markup = new RegExp(`<${name}[\\s>/]`, 'i');
        if (markup.test(expected.text)) continue;
        const at = entry.body.search(markup);
        assert.equal(
          at,
          -1,
          `${entry.url} body still holds <${name}> markup: …${entry.body.slice(Math.max(0, at - 40), at + 40)}…`,
        );
      }
      assert.equal(entry.body, entry.body.toLowerCase(), `${entry.url} body is not lowercased`);
      assert.match(entry.body, TOKEN_BODY_RE, `${entry.url} body must be tokens joined by single spaces`);
      const tokens = entry.body.split(' ');
      const repeated = duplicateTokens(tokens);
      assert.deepEqual(repeated, [], `${entry.url} body repeats tokens: ${JSON.stringify(repeated.slice(0, 20))}`);
      const difference = firstTokenDifference(tokens, expected.distinct);
      assert.deepEqual(
        tokens,
        expected.distinct,
        `${entry.url} body must hold the prose's distinct tokens in first-occurrence order; ${difference}`,
      );
      assert.equal(
        entry.body,
        expected.distinct.join(' '),
        `${entry.url} body must equal the decoded prose's distinct tokens; ${difference}`,
      );
      t.diagnostic(`${entry.url}: ${expected.tokens.length} prose tokens, ${expected.distinct.length} distinct`);
    }
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

  test('[AC-08][F-019] front-matter values are indexed as written: raw text, not HTML-escaped, dates in UTC', FIXTURE_ONLY, () => {
    const entries = requireEntries();
    // Every fixture's title, summary and tags, compared with its source front
    // matter: an empty, escaped, reordered or truncated value fails.
    for (const { file, slug } of FIXTURE_POSTS) {
      const { data } = fixtureSource(file);
      for (const key of NON_EMPTY_KEYS) {
        assert.ok(
          typeof data[key] === 'string' && data[key] !== '',
          `${file}: ${key} must be a non-empty string, got ${JSON.stringify(data[key])}`,
        );
      }
      assert.ok(
        Array.isArray(data.tags) && data.tags.length > 0,
        `${file}: tags must be a non-empty list, got ${JSON.stringify(data.tags)}`,
      );
      const entry = fixtureEntry(entries, slug);
      assert.equal(entry.title, data.title, `${entry.url}: title must equal the front matter of ${file}`);
      assert.equal(entry.summary, data.summary, `${entry.url}: summary must equal the front matter of ${file}`);
      assert.deepEqual(entry.tags, data.tags, `${entry.url}: tags must equal the front matter of ${file}`);
    }
    const escaping = fixtureEntry(entries, ESCAPING_FIXTURE_SLUG);
    assert.equal(escaping.title, ESCAPING_FIXTURE_TITLE);
    for (const [slug, day] of Object.entries(FIXTURE_DATES)) {
      const entry = fixtureEntry(entries, slug);
      assert.ok(entry.date.startsWith(day), `${entry.url} date ${entry.date} does not start with ${day} (UTC)`);
    }
  });

  /* Phase 5: size budget */

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
