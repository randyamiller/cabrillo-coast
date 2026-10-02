/* Cabrillo Coast LLC — built blog pages (AC-02, AC-05, AC-06, AC-07, AC-17; F-017, F-018) */
/**
 * Assertions over the HTML Jekyll built. `scripts/verify.mjs` runs this file
 * twice and every assertion holds in both runs: on the real build in
 * custom-domain mode (the defaults: `SITE_DIR=_site`, `SITE_BASEURL=""`,
 * `SITE_URL=https://www.cabrillocoast.com`), and on the fixture project
 * build (`SITE_DIR=<tmp>/project/cabrillo-coast`,
 * `SITE_BASEURL=/cabrillo-coast`, `SITE_URL=https://randyamiller.github.io`,
 * `FIXTURE_DIR=<tmp>`, the output of `tests/fixtures/build-fixture-site.mjs`).
 * The fixture-only cases run only when `FIXTURE_DIR` is set; the real
 * launch-state case runs only while `_posts/` holds no article.
 *
 *   - AC-06 [F-018] page contract: CSP, scripts, metadata, landmarks, list
 *     roles, the prose scan and the listing state the built articles call for.
 *   - AC-07 [F-018] links, canonical URLs and the published outputs.
 *   - AC-02 [F-017] drafts, draft images and future-dated posts stay out of
 *     normal builds.
 *   - AC-05 [F-018] the escaping fixture's title is escaped wherever it is
 *     printed and its raw-block code `{{ .Values.image }}` survives as text;
 *     Rouge classes and tables render.
 *   - AC-17 [F-018] the launch state.
 *
 * The prose region is bounded by markup the layouts own, never by markup an
 * article body can write, and it is scanned before the scripts are checked
 * so a script written in a body is reported against the article. Both
 * security checks fail closed: they read raw text and decode attribute
 * values as a browser does, and every forbidden `<name` written anywhere,
 * comments and attribute values included, counts, so markup the tokenizer
 * could read differently from a browser fails rather than passes. Escaped
 * values are asserted in their encoded form, and the privacy cases search
 * every output path and text file only after proving the fixture builder
 * wrote the synthetic draft and future-dated post.
 *
 * Paths resolve from this file's location, never `process.cwd()`. The suite
 * never builds or uses the network and reads the output without changing
 * it; its one write is a temporary folder for the post-inventory self-test.
 *
 * Run: bundle exec jekyll build && node --test tests/static/built-pages.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSiteLinks, decodeEntities, listHtmlPages, parseStartTags, tokenizeHtml } from './lib/site-links.mjs';
import {
  DRAFT_IMAGE,
  DRAFT_MARKER,
  DRAFT_SLUG,
  FUTURE_MARKER,
  FUTURE_SLUG,
} from '../fixtures/build-fixture-site.mjs';

/* Configuration                                                             */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Built site under test; a relative value resolves against `ROOT`. */
const SITE_DIR = path.resolve(ROOT, process.env.SITE_DIR || '_site');

/** Base path the site is served under: empty on the custom domain, `/cabrillo-coast` on the project path. */
const BASE = trimTrailingSlashes(process.env.SITE_BASEURL || '');

/** Deployment URL (scheme and host) that canonical and `og:url` start with. */
const SITE_URL = trimTrailingSlashes(process.env.SITE_URL || 'https://www.cabrillocoast.com');

/** Output folder of the fixture builder; empty when the fixture cases do not apply. */
const FIXTURE_DIR = process.env.FIXTURE_DIR ? path.resolve(ROOT, process.env.FIXTURE_DIR) : '';

/** `skip` option of every fixture-only case. */
const FIXTURE_ONLY = { skip: !FIXTURE_DIR && 'FIXTURE_DIR not set' };

/* Expected values                                                           */

/** The blog's Content-Security-Policy, character for character (AAP 0.5.6). */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'";

/** Suffix of every blog page title (U+2014 em dash). */
const TITLE_SUFFIX = ' — Cabrillo Coast';

const LISTING_TITLE = `Technical articles${TITLE_SUFFIX}`;

/** `og:site_name` on every blog page, matching the home page. */
const OG_SITE_NAME = 'Cabrillo Coast LLC';

/** Start tags the prose region of an article must never contain (AAP 0.5.3). */
const FORBIDDEN_PROSE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link', 'style']);

/** Start tag of the article's back links, exactly as `_layouts/post.html` writes it. */
const POST_BACK_TAG = '<p class="post-back">';

/**
 * What the layouts write from the article's closing back link on: the link
 * and the end of the container and the article (`_layouts/post.html`), then
 * the end of `main` (`_layouts/blog.html`).
 */
const LAYOUT_TAIL_RE = /^<p class="post-back"><a href="[^"<>]*">← All articles<\/a><\/p>\s*<\/div>\s*<\/article>\s*<\/main\s*>/;

const EVENT_HANDLER_RE = /^on/i;

/** A `javascript:` URL, tolerant of the whitespace browsers strip from URLs. */
const JAVASCRIPT_URL_RE = /j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i;

/**
 * The named references `securityDecode` replaces; a browser requires the `;`
 * for each. Of the 2,231 entries in the HTML named-reference table,
 * `&Tab;`, `&NewLine;`, `&colon;` and `&fjlig;` ("fj") are the only ones
 * whose replacement holds an ASCII letter of "javascript", a colon, a tab, a
 * line feed or a carriage return, so no reference left undecoded can spell a
 * `javascript:` scheme or hide one behind the tabs and newlines a URL parser
 * drops. The rest are the references kramdown and Liquid write.
 */
const SECURITY_NAMED_REFERENCES = Object.freeze({
  Tab: '\t',
  NewLine: '\n',
  colon: ':',
  fjlig: 'fj',
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: '\u00a0',
});

/**
 * The references `securityDecode` reads: hexadecimal and decimal numeric
 * references with every digit and an optional `;`, as a browser reads them,
 * and the names of `SECURITY_NAMED_REFERENCES` with their `;`.
 */
const SECURITY_REFERENCE_RE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|(Tab|NewLine|colon|fjlig|amp|quot|lt|gt|apos|nbsp);)/g;

/** What a browser substitutes for a numeric reference to 0x80–0x9F (windows-1252). */
const C1_REFERENCE_REPLACEMENTS = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020],
  [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
  [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022],
  [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
  [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

/** Markup inside raw text: SVG and MathML, where those elements hold no raw text, read it as tags. */
const RAW_TEXT_MARKUP_RE = /<[A-Za-z!/?]/;

/** A start-tag candidate's name: up to whitespace, `/`, `>` or `<`. */
const CANDIDATE_NAME_RUN_RE = /[^\t\n\f\r /><]*/y;

/**
 * Repository-internal paths that must never be published (AAP 0.5.7, AC-07).
 * `assets/css/style.css` is what the default primer theme would emit without
 * `theme: null`.
 */
const FORBIDDEN_OUTPUTS = Object.freeze([
  'README.md',
  'Gemfile',
  'Gemfile.lock',
  'package.json',
  'package-lock.json',
  'node_modules',
  'tests',
  'scripts',
  '_templates',
  'assets/drafts',
  'assets/css/style.css',
]);

/**
 * Extensions of output files whose text is searched for the private slugs,
 * markers and draft-image paths. Beyond the HTML, JSON, CSS, JS, XML and
 * plain-text files Jekyll emits, raw Markdown, SVG and YAML are included,
 * because a draft copied verbatim instead of rendered would arrive as one of
 * those.
 */
const TEXT_EXTENSIONS = new Set(['.html', '.json', '.css', '.js', '.xml', '.txt', '.md', '.svg', '.yml', '.yaml']);

/**
 * The synthetic draft's image folder (`assets/drafts/fixture-private-draft/`),
 * the AC-02 draft-image reference: no text file of the project build may hold
 * it, since a page or index entry that names a draft image leaks the draft it
 * belongs to. It is the only draft-image folder the fixture build's source
 * holds (staging leaves the author's own `assets/drafts/` out). The bare
 * `assets/drafts/` prefix is no needle: the project build also renders the
 * real `_posts/`, and a published article may name the path in prose or code
 * without leaking anything. An article image pointing into `assets/drafts/`
 * is refused by the article checks and, since that folder is never built,
 * fails the AC-07 link check. The folder holds `DRAFT_SLUG`, so the slug
 * needle matches it too; it is kept so that a failure names the draft-image
 * clause of AC-02.
 */
const DRAFT_IMAGE_FOLDER = `${path.posix.dirname(DRAFT_IMAGE)}/`;

/** The launch-state text of the listing (AAP 0.5.4). */
const EMPTY_LISTING_TEXT = 'No articles have been published yet.';

/**
 * Class name of every Rouge token type, from `lib/rouge/token.rb` of Rouge
 * 3.30.0, the version github-pages 232 pins. Plain text has no class and is
 * written without a span.
 */
const ROUGE_TOKEN_CLASSES = Object.freeze(
  new Set([
    'w', 'esc', 'err', 'x',
    'k', 'kc', 'kd', 'kn', 'kp', 'kr', 'kt', 'kv',
    'n', 'na', 'nb', 'bp', 'nc', 'no', 'nd', 'ni', 'ne', 'nf', 'fm', 'py', 'nl', 'nn', 'nx', 'nt', 'nv',
    'vc', 'vg', 'vi', 'vm',
    'l', 'ld',
    's', 'sa', 'sb', 'sc', 'dl', 'sd', 's2', 'se', 'sh', 'si', 'sx', 'sr', 's1', 'ss',
    'm', 'mb', 'mf', 'mh', 'mi', 'il', 'mo', 'mx',
    'o', 'ow',
    'p', 'pi',
    'c', 'ch', 'cd', 'cm', 'cp', 'cpf', 'c1', 'cs',
    'g', 'gd', 'ge', 'gr', 'gh', 'gi', 'go', 'gp', 'gs', 'gu', 'gt', 'gl',
  ]),
);

const ESCAPING_SLUG = 'fixture-escaping-and-liquid';
const CODE_SLUG = 'fixture-code-and-tables';
const ESCAPED_TITLE = 'Escaping &quot;quotes&quot; &amp; &lt;angle&gt; brackets';

/** An article page under a built site: `blog/<slug>/index.html`. */
const ARTICLE_REL_RE = /^blog\/([^/]+)\/index\.html$/;
const LISTING_REL = 'blog/index.html';

/* Helpers                                                                   */

/**
 * Every start tag of a page, in document order, with lowercase names and
 * entity-decoded attribute values (comments ignored).
 * @param {string} html
 */
function tags(html) {
  return parseStartTags(html);
}

/**
 * One-entry cache of the token views of the page read last: several checks
 * walk the same page, and the suite reads one page at a time.
 */
let tokenCache = { html: '', views: new Map() };

/**
 * `compute()` for `html`, kept under `key` until another page is read.
 * @template T
 * @param {string} html
 * @param {string} key
 * @param {() => T} compute
 * @returns {T}
 */
function cachedView(html, key, compute) {
  if (tokenCache.html !== html) tokenCache = { html, views: new Map() };
  if (!tokenCache.views.has(key)) tokenCache.views.set(key, compute());
  return tokenCache.views.get(key);
}

/** The tokens of a page read without raw text, as `tags()` reads it. */
function tokensOf(html) {
  return cachedView(html, 'tokens', () => tokenizeHtml(html));
}

/** The tokens of a page read with raw text, as a browser reads it. */
function rawTokensOf(html) {
  return cachedView(html, 'raw', () => tokenizeHtml(html, { rawText: true }));
}

/**
 * Offsets of the closed end tags named `name` in a page (`tokensOf`), ascending.
 * @param {string} html
 * @param {string} name
 * @returns {number[]}
 */
function endTagOffsets(html, name) {
  const byName = cachedView(html, 'end-tags', () => {
    const index = new Map();
    for (const token of tokensOf(html)) {
      if (token.type !== 'end-tag' || !token.terminated) continue;
      if (!index.has(token.name)) index.set(token.name, []);
      index.get(token.name).push(token.start);
    }
    return index;
  });
  return byName.get(name) ?? [];
}

/**
 * The `content` of the first `<meta>` whose `key` attribute (`name` or
 * `property`) equals `value`; `undefined` when there is none.
 * @param {string} html
 * @param {'name' | 'property'} key
 * @param {string} value
 * @returns {string | undefined}
 */
function meta(html, key, value) {
  const tag = tags(html).find((t) => t.name === 'meta' && t.attrs[key] === value);
  return tag === undefined ? undefined : tag.attrs.content;
}

/**
 * `value` without trailing slashes, by an index scan: an unanchored
 * /\/+$/ retries every suffix of a long slash run that a non-slash ends.
 * @param {string} value
 * @returns {string}
 */
function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** Removes comments and tags, leaving the text with its character references. */
function stripTags(s) {
  const html = String(s);
  let text = '';
  let at = 0;
  // The gaps between tokens are the text, less any `</>`, which a browser drops without a token.
  for (const token of tokenizeHtml(html)) {
    text += html.slice(at, token.start).replaceAll('</>', '');
    at = token.end;
  }
  return text + html.slice(at).replaceAll('</>', '');
}

/** Visible text of an HTML fragment: tags stripped, references decoded, whitespace collapsed. */
function textOf(fragment) {
  return decodeEntities(stripTags(fragment)).replace(/\s+/g, ' ').trim();
}

function classTokens(tag) {
  return (tag.attrs.class || '').split(/\s+/).filter(Boolean);
}

/**
 * Every file and folder under `dir`, as sorted POSIX paths relative to it.
 * Symbolic links are listed but not followed.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  const visit = (abs, prefix) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) visit(path.join(abs, entry.name), rel);
    }
  };
  visit(dir, '');
  return out.sort();
}

function textFiles(dir) {
  return walk(dir).filter((rel) => {
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) return false;
    return statSync(path.join(dir, ...rel.split('/'))).isFile();
  });
}

function readSiteFile(dir, rel) {
  return readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
}

/**
 * Offset of the first end tag `</name…>` at or after `from`, or -1. Only end
 * tags the tokenizer reads count, so one inside a comment does not; the
 * binary search keeps repeated lookups on malformed pages cheap.
 * @param {string} html
 * @param {string} name
 * @param {number} from
 */
function closingTagIndex(html, name, from) {
  const offsets = endTagOffsets(html, name);
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < offsets.length ? offsets[low] : -1;
}

/**
 * Every `<title>` of a page as a browser reads it: its offset, its raw text,
 * and whether its `</title>` was found (an unclosed title runs to the end of
 * the page).
 * @param {string} html
 * @returns {{ start: number, text: string, closed: boolean }[]}
 */
function pageTitles(html) {
  const tokens = rawTokensOf(html);
  const titles = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'start-tag' || token.name !== 'title') return;
    const content = tokens[index + 1];
    titles.push(
      content?.type === 'raw-text'
        ? { start: token.start, text: html.slice(content.start, content.end), closed: content.terminated }
        : { start: token.start, text: '', closed: false },
    );
  });
  return titles;
}

/**
 * The `<title>` elements of a page's head, the only ones that name the
 * document. A `<title>` in the body, such as an inline SVG's accessible name
 * in article prose, leaves `document.title` alone. The head runs from
 * `<head>` to `</head>` or the first `<body>`, whichever comes first; an
 * unclosed title keeps it open to the end of the page.
 * @param {string} html
 * @returns {{ start: number, text: string, closed: boolean }[] | null} `null` without a `<head>`
 */
function headTitles(html) {
  const tokens = rawTokensOf(html);
  const head = tokens.findIndex((token) => token.type === 'start-tag' && token.name === 'head');
  if (head === -1) return null;
  let end = html.length;
  for (let index = head + 1; index < tokens.length; index += 1) {
    const { type, name, start } = tokens[index];
    if ((type === 'end-tag' && name === 'head') || (type === 'start-tag' && name === 'body')) {
      end = start;
      break;
    }
  }
  const from = tokens[head].end;
  return pageTitles(html).filter((title) => title.start >= from && title.start < end);
}

/**
 * The title links of a listing: each `<h2>` holding one `<a>` and nothing
 * else but whitespace, with the link's start tag and its inner HTML. A link
 * that meets another `<a>` or `<h2>` tag before its `</a>` is not one, and
 * the walk resumes at that tag, so every token is visited a bounded number
 * of times however many openers are left unclosed.
 * @param {string} html
 * @returns {{ tag: import('./lib/site-links.mjs').StartTag, inner: string }[]}
 */
function titleLinks(html) {
  const tokens = tokensOf(html);
  const startTags = new Map(tags(html).map((tag) => [tag.start, tag]));
  const is = (token, type, name) => token?.type === type && token.name === name && token.terminated;
  const blankBetween = (before, after) => html.slice(before.end, after.start).trim() === '';
  const boundary = (token) =>
    (token.type === 'start-tag' || token.type === 'end-tag') && (token.name === 'a' || token.name === 'h2');
  const links = [];
  let i = 0;
  while (i < tokens.length) {
    const h2 = tokens[i];
    const a = tokens[i + 1];
    if (!is(h2, 'start-tag', 'h2') || !is(a, 'start-tag', 'a') || !blankBetween(h2, a)) {
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < tokens.length && !boundary(tokens[j])) j += 1;
    const close = tokens[j];
    const h2End = tokens[j + 1];
    if (is(close, 'end-tag', 'a') && is(h2End, 'end-tag', 'h2') && blankBetween(close, h2End)) {
      links.push({ tag: startTags.get(a.start), inner: html.slice(a.end, close.start) });
      i = j + 2;
    } else {
      i = j;
    }
  }
  return links;
}

/**
 * Whether a page holds a table with a header cell aligned the way kramdown
 * writes it (`<th style="text-align: …">`) before that table's `</table>`.
 * One pass over the tokens, counting open tables.
 * @param {string} html
 * @returns {boolean}
 */
function hasAlignedTable(html) {
  let open = 0;
  let aligned = false;
  for (const token of tokensOf(html)) {
    if (!token.terminated || (token.type !== 'start-tag' && token.type !== 'end-tag')) continue;
    if (token.name === 'table') {
      if (token.type === 'start-tag') {
        open += 1;
      } else if (open > 0) {
        if (aligned) return true;
        open -= 1;
      }
    } else if (open > 0 && token.type === 'start-tag' && token.name === 'th') {
      const style = token.attrs.find((attr) => attr.name === 'style');
      if (style !== undefined && style.value !== null && decodeEntities(style.value).startsWith('text-align:')) {
        aligned = true;
      }
    }
  }
  return false;
}

/**
 * The prose region of an article, bounded by markup the layouts own and never
 * by markup the article body can write. It runs from the end of the
 * first `<div class="prose">` (only layout markup with escaped values comes
 * before it) to that div's own closing `</div>`, which the layout's closing
 * back link directly follows. That link is the last `<p class="post-back">`
 * in the page source; it must be a real tag, not text inside a comment opened
 * in the prose, and only the end of the container, the article and `main` may
 * follow it (`LAYOUT_TAIL_RE`). A back link written in the body therefore
 * stays inside the region, and a page that does not match this structure
 * fails the calling test instead of leaving part of its prose unscanned.
 * @param {string} html
 * @returns {string}
 */
function proseRegion(html) {
  const all = tags(html);
  const prose = all.find((t) => t.name === 'div' && classTokens(t).includes('prose'));
  assert.ok(prose, 'article has no <div class="prose"> (layout contract of _layouts/post.html)');

  const boundary = html.lastIndexOf(POST_BACK_TAG);
  assert.ok(boundary >= prose.end, `article has no ${POST_BACK_TAG} after its prose (layout contract of _layouts/post.html)`);
  assert.ok(
    all.some((t) => t.start === boundary && t.name === 'p'),
    `the closing ${POST_BACK_TAG} is not a tag: a comment opened in the prose hides it, so the prose has no bound`,
  );
  const close = /<\/div>\s*$/.exec(html.slice(prose.end, boundary));
  assert.ok(
    close,
    `the closing ${POST_BACK_TAG} must directly follow the </div> of the prose (layout contract of _layouts/post.html)`,
  );
  assert.ok(
    LAYOUT_TAIL_RE.test(html.slice(boundary)),
    `the closing ${POST_BACK_TAG} must be the "← All articles" link followed only by </div></article></main> ` +
      `(layout contract of _layouts/post.html and _layouts/blog.html), found: ${html.slice(boundary, boundary + 160)}`,
  );
  return html.slice(prose.end, prose.end + close.index);
}

/**
 * Decodes the character references of a raw attribute value exactly as a
 * browser does for every character that can make the value a `javascript:`
 * URL. Numeric references take every digit, need no `;`, and map 0, values
 * above U+10FFFF and surrogates to U+FFFD and 0x80–0x9F through
 * windows-1252; `&#` without digits stays literal. Named references are
 * those of `SECURITY_NAMED_REFERENCES`. One pass, so `&amp;#106;` stays
 * `&#106;`.
 * @param {string} raw
 * @returns {string}
 */
function securityDecode(raw) {
  return raw.replace(SECURITY_REFERENCE_RE, (reference, hex, decimal, name) => {
    if (name !== undefined) return SECURITY_NAMED_REFERENCES[name];
    // Past seven significant digits (six in hexadecimal) the value exceeds
    // U+10FFFF, so a long run is never parsed.
    const radix = hex === undefined ? 10 : 16;
    const digits = (hex ?? decimal).replace(/^0+/, '');
    const code = digits.length > (radix === 10 ? 7 : 6) ? Infinity : Number.parseInt(digits || '0', radix);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(C1_REFERENCE_REPLACEMENTS.get(code) ?? code);
  });
}

/**
 * Every place a browser could start an element: the offset and
 * ASCII-lowercased name of each `<` followed by an ASCII letter, wherever it
 * sits (text, a comment, raw text or an attribute value). A browser's tag
 * name runs on through `<`; stopping there keeps the pass linear and can
 * only shorten a name, never hide one.
 * @param {string} html
 * @returns {{ start: number, name: string }[]}
 */
function startTagCandidates(html) {
  const found = [];
  let open = html.indexOf('<');
  while (open !== -1) {
    let next = open + 1;
    if (/[A-Za-z]/.test(html[next] ?? '')) {
      CANDIDATE_NAME_RUN_RE.lastIndex = next;
      CANDIDATE_NAME_RUN_RE.test(html);
      next = CANDIDATE_NAME_RUN_RE.lastIndex;
      const name = html.slice(open + 1, next).replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
      found.push({ start: open, name });
    }
    open = html.indexOf('<', next);
  }
  return found;
}

/**
 * Lists the unsafe markup in an HTML fragment. The scan fails closed: what a
 * browser could read as an element, a handler or a script URL is reported
 * even where the tokenizer reads it differently.
 *   - A forbidden element anywhere `<name` is written (`startTagCandidates`),
 *     comments, raw text and attribute values included.
 *   - Any token left open at the end of the fragment, which would swallow
 *     the layout markup after it.
 *   - Raw text holding markup and a CDATA section that does not end at its
 *     first `>`: SVG and MathML read both as tags, where the tokenizer does
 *     not.
 *   - Event-handler attributes, and `javascript:` URLs in a value decoded as
 *     a browser decodes it (`securityDecode`) or in the tag source.
 * Escaped code samples (`&lt;script…`) contain no `<` and are text.
 * @param {string} fragment
 * @returns {string[]}
 */
function unsafeMarkup(fragment) {
  const problems = [];
  const tokens = tokenizeHtml(fragment, { rawText: true });
  const excerpt = (start, end) => fragment.slice(start, Math.min(end, start + 160));
  const startTags = new Map(tokens.filter((token) => token.type === 'start-tag').map((token) => [token.start, token]));
  for (const { start, name } of startTagCandidates(fragment)) {
    if (!FORBIDDEN_PROSE_TAGS.has(name)) continue;
    const tag = startTags.get(start);
    problems.push(`<${name}> element: ${excerpt(start, tag === undefined ? start + 80 : tag.end)}`);
  }
  for (const token of tokens) {
    const source = excerpt(token.start, token.end);
    const label = token.name === undefined ? token.type : `<${token.name}> ${token.type}`;
    if (!token.terminated) problems.push(`${label} left open at the end of the prose: ${source}`);
    if (token.type === 'raw-text' && RAW_TEXT_MARKUP_RE.test(fragment.slice(token.start, token.end))) {
      problems.push(`markup inside ${label}, which SVG and MathML read as tags: ${source}`);
    }
    if (
      token.type === 'bogus-comment' &&
      fragment.startsWith('<![CDATA[', token.start) &&
      !fragment.slice(token.start, token.end).endsWith(']]>')
    ) {
      problems.push(`CDATA section that SVG and MathML end after its first ">": ${source}`);
    }
    if (token.type !== 'start-tag') continue;
    for (const { name, value } of token.attrs) {
      if (EVENT_HANDLER_RE.test(name)) problems.push(`event handler attribute ${name}: ${source}`);
      if (value !== null && JAVASCRIPT_URL_RE.test(securityDecode(value))) {
        problems.push(`javascript: URL in ${name}: ${source}`);
      }
    }
    if (JAVASCRIPT_URL_RE.test(fragment.slice(token.start, token.end))) problems.push(`javascript: URL: ${source}`);
  }
  return [...new Set(problems)];
}

/**
 * The blog pages of a built site: the listing and every article, with the
 * URL path each is served at under `base`.
 * @param {string} dir
 * @param {string} base
 * @returns {{ file: string, rel: string, urlPath: string, kind: 'listing' | 'article', slug: string }[]}
 */
function blogPages(dir, base) {
  return listHtmlPages(dir, base).flatMap((page) => {
    if (page.rel === LISTING_REL) return [{ ...page, urlPath: `${base}/blog/`, kind: 'listing', slug: '' }];
    const match = ARTICLE_REL_RE.exec(page.rel);
    if (match === null) return [];
    return [{ ...page, urlPath: `${base}/blog/${match[1]}/`, kind: 'article', slug: match[1] }];
  });
}

/** The blog pages of `SITE_DIR`, failing the calling test when the listing is missing. */
function siteBlogPages() {
  const pages = blogPages(SITE_DIR, BASE);
  assert.ok(
    pages.some((page) => page.kind === 'listing'),
    `${path.join(SITE_DIR, LISTING_REL)} not found: the build produced no blog listing`,
  );
  return pages;
}

/**
 * Every regular `*.md` file under `dir`, recursively, as sorted POSIX paths
 * relative to it; empty when `dir` is missing or not a folder. Only real
 * folders are entered and only regular files count, so neither a folder named
 * `scratch.md` nor a symbolic link passes for an article (`Dirent` types come
 * from `lstat`, so links are never followed).
 * @param {string} dir
 * @returns {string[]}
 */
function postFiles(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  const out = [];
  const visit = (abs, prefix) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path.join(abs, entry.name), rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(rel);
    }
  };
  visit(dir, '');
  return out.sort();
}

/**
 * Every article file under `ROOT/_posts`, recursively (Jekyll reads `_posts/`
 * subfolders too); empty when the folder does not exist.
 * @returns {string[]}
 */
function realPostFiles() {
  return postFiles(path.join(ROOT, '_posts'));
}

/**
 * Launch-state assertions for one built site (AC-17): the listing shows the
 * empty-state text and neither the search form nor the list, no article page
 * was built and the search index is an empty array.
 * @param {string} dir
 */
function assertEmpty(dir) {
  const listingFile = path.join(dir, ...LISTING_REL.split('/'));
  assert.ok(existsSync(listingFile), `${listingFile} not found`);
  const html = readFileSync(listingFile, 'utf8');
  assert.ok(html.includes(EMPTY_LISTING_TEXT), `${listingFile} lacks "${EMPTY_LISTING_TEXT}"`);
  const ids = new Set(tags(html).map((t) => t.attrs.id).filter((id) => id !== undefined));
  for (const id of ['blog-search', 'post-list']) {
    assert.ok(!html.includes(`id="${id}"`) && !ids.has(id), `${listingFile} must not contain #${id} without articles`);
  }

  const articles = blogPages(dir, '').filter((page) => page.kind === 'article').map((page) => page.rel);
  assert.deepEqual(articles, [], `${dir} must hold no article page in the launch state`);

  const indexFile = path.join(dir, 'blog', 'search.json');
  assert.ok(existsSync(indexFile), `${indexFile} not found`);
  let index;
  assert.doesNotThrow(() => {
    index = JSON.parse(readFileSync(indexFile, 'utf8'));
  }, `${indexFile} is not valid JSON`);
  assert.deepEqual(index, [], `${indexFile} must be [] without articles`);
}

/* AC-06 — page contract                                                     */

/**
 * The head of a page must open with the charset declaration and, directly
 * after it, the Content-Security-Policy meta tag: a meta policy governs only
 * the markup that follows it, so nothing (not even a comment) may come first.
 * @param {string} html
 */
function assertHeadOrder(html) {
  const head = tags(html).find((tag) => tag.name === 'head');
  assert.ok(head, 'page has no <head> start tag');
  const afterHead = html.slice(head.end);

  const charset = /^\s*<meta\s+charset\s*=\s*(["']?)utf-8\1\s*\/?>/i.exec(afterHead);
  assert.ok(charset, `the first tag after <head> must be <meta charset="UTF-8">, found: ${afterHead.trim().slice(0, 80)}`);
  const afterCharset = afterHead.slice(charset[0].length);

  const next = tags(afterCharset)[0];
  assert.ok(next, 'nothing follows <meta charset="UTF-8">');
  assert.equal(
    afterCharset.slice(0, next.start).trim(),
    '',
    'only whitespace may separate <meta charset> from the Content-Security-Policy meta tag',
  );
  assert.equal(next.name, 'meta', `the tag after <meta charset> must be the policy <meta>, found: ${next.source}`);
  assert.equal(
    (next.attrs['http-equiv'] || '').toLowerCase(),
    'content-security-policy',
    `the tag after <meta charset> must have http-equiv="Content-Security-Policy": ${next.source}`,
  );
  assert.equal(next.attrs.content, CSP, 'Content-Security-Policy content differs from the blog policy');
}

/**
 * Every script element loads a file and carries no inline code, and the
 * scripts are exactly the expected ones, in order. The page is read with raw
 * text, as a browser reads it, so a script after a `<textarea>` that holds
 * `<!--` is seen. The check fails closed: every `<script` written anywhere
 * (`startTagCandidates`), in a comment, raw text or attribute value
 * included, must be one of the script elements read.
 * @param {string} html
 * @param {string[]} expectedSrcs
 */
function assertScripts(html, expectedSrcs) {
  const tokens = rawTokensOf(html);
  const srcs = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'start-tag' || token.name !== 'script') return;
    const source = html.slice(token.start, Math.min(token.end, token.start + 160));
    assert.ok(token.terminated, `script start tag is never closed: ${source}`);
    const src = token.attrs.find((attr) => attr.name === 'src');
    assert.ok(src !== undefined, `inline script element without src: ${source}`);
    const content = tokens[index + 1];
    const close = tokens[index + 2];
    assert.ok(content?.type === 'raw-text' && content.terminated, `script element is never closed: ${source}`);
    assert.equal(html.slice(content.start, content.end).trim(), '', `script element has inline content: ${source}`);
    assert.ok(
      close?.type === 'end-tag' && close.name === 'script' && close.terminated,
      `script element is never closed: ${source}`,
    );
    srcs.push(src.value === null ? '' : decodeEntities(src.value));
  });
  const written = startTagCandidates(html).filter((candidate) => candidate.name === 'script').length;
  assert.equal(
    written,
    srcs.length,
    `${written} "<script" start tag(s) are written but ${srcs.length} read as script elements: ` +
      'one in a comment, raw text or an attribute value, or in markup read differently, could still run',
  );
  assert.deepEqual(srcs, expectedSrcs, 'blog pages load main.js everywhere and search.js on the listing only');
}

/**
 * Title and Open Graph metadata of one blog page.
 * @param {string} html
 * @param {'listing' | 'article'} kind
 */
function assertMetadata(html, kind) {
  const titles = headTitles(html);
  assert.ok(titles !== null, 'page has no <head> start tag');
  assert.equal(titles.length, 1, 'the <head> must hold exactly one <title>');
  assert.ok(titles[0].closed, 'the <title> is never closed');
  const title = decodeEntities(titles[0].text).trim();
  assert.ok(title.endsWith(TITLE_SUFFIX), `<title> "${title}" must end with "${TITLE_SUFFIX}"`);
  assert.ok(title.slice(0, -TITLE_SUFFIX.length).trim() !== '', `<title> "${title}" names no page`);
  if (kind === 'listing') assert.equal(title, LISTING_TITLE);

  const nonEmpty = (key, value) => {
    const content = meta(html, key, value);
    assert.ok(typeof content === 'string' && content.trim() !== '', `<meta ${key}="${value}"> missing or empty`);
    return content;
  };
  nonEmpty('name', 'description');
  assert.equal(meta(html, 'property', 'og:type'), kind === 'article' ? 'article' : 'website', 'og:type');
  nonEmpty('property', 'og:title');
  nonEmpty('property', 'og:description');
  assert.equal(meta(html, 'property', 'og:site_name'), OG_SITE_NAME, 'og:site_name');
  if (kind === 'article') {
    nonEmpty('property', 'article:published_time');
  } else {
    assert.equal(meta(html, 'property', 'article:published_time'), undefined, 'the listing is not an article');
  }

  const h1s = tags(html).filter((t) => t.name === 'h1');
  assert.equal(h1s.length, 1, 'page must have exactly one <h1>');
}

/**
 * Skip link, main landmark and the mobile menu element `main.js` drives.
 * @param {string} html
 */
function assertLandmarks(html) {
  const all = tags(html);
  assert.ok(all.some((t) => t.name === 'a' && t.attrs.href === '#main'), 'no skip link <a href="#main">');
  assert.ok(all.some((t) => t.name === 'main' && t.attrs.id === 'main'), 'no <main id="main">');

  const menu = all.find((t) => t.attrs.id === 'mobile-menu');
  assert.ok(menu, 'no #mobile-menu element');
  assert.equal(menu.name, 'nav', `the mobile menu must be a <nav>: ${menu.source}`);
  assert.ok(classTokens(menu).includes('mobile-menu'), `the mobile menu lacks class "mobile-menu": ${menu.source}`);
  assert.equal(menu.attrs['aria-label'], 'Primary', `the mobile menu must be labelled "Primary": ${menu.source}`);
  assert.ok(Object.hasOwn(menu.attrs, 'hidden'), `the mobile menu must start hidden: ${menu.source}`);
}

/**
 * Inside the site header, the desktop and mobile Blog links mark the current
 * section: `aria-current="page"` on the listing, `"true"` on articles. No
 * other header link carries `aria-current`.
 * @param {string} html
 * @param {'listing' | 'article'} kind
 */
function assertBlogCurrent(html, kind) {
  const all = tags(html);
  const header = all.find((t) => t.name === 'header' && classTokens(t).includes('site-header'));
  assert.ok(header, 'no <header class="site-header">');
  const close = closingTagIndex(html, 'header', header.end);
  assert.notEqual(close, -1, 'the site header is never closed');

  const expected = kind === 'listing' ? 'page' : 'true';
  const anchors = all
    .filter((t) => t.name === 'a' && t.start > header.end && t.start < close)
    .map((t) => {
      const end = closingTagIndex(html, 'a', t.end);
      return { tag: t, label: end === -1 ? '' : textOf(html.slice(t.end, end)) };
    });
  const blog = anchors.filter((a) => a.label === 'Blog');
  assert.ok(blog.length >= 2, `the site header must hold the desktop and mobile Blog links, found ${blog.length}`);
  for (const { tag } of blog) {
    assert.equal(tag.attrs['aria-current'], expected, `Blog link must carry aria-current="${expected}": ${tag.source}`);
  }
  for (const { tag, label } of anchors.filter((a) => a.label !== 'Blog')) {
    assert.ok(!Object.hasOwn(tag.attrs, 'aria-current'), `only Blog may carry aria-current, not "${label}": ${tag.source}`);
  }
}

/**
 * Every `.tag-list` among `candidates` carries `role="list"`: the blog
 * stylesheet sets `list-style: none` on tag lists, and WebKit drops the list
 * role from such a list unless the markup states it.
 * @param {import('./lib/site-links.mjs').StartTag[]} candidates
 */
function assertTagListRoles(candidates) {
  for (const tag of candidates.filter((t) => classTokens(t).includes('tag-list'))) {
    assert.equal(tag.attrs.role, 'list', `.tag-list must carry role="list" so WebKit keeps its list semantics: ${tag.source}`);
  }
}

/**
 * The tag list in an article's `header.post-header` carries `role="list"`
 * (`assertTagListRoles`). Only the layout-owned header is read: the prose
 * after it is author content and may hold any markup.
 * @param {string} html
 */
function assertArticleTagLists(html) {
  const all = tags(html);
  const header = all.find((t) => t.name === 'header' && classTokens(t).includes('post-header'));
  assert.ok(header, 'article has no <header class="post-header"> (layout contract of _layouts/post.html)');
  const close = closingTagIndex(html, 'header', header.end);
  assert.notEqual(close, -1, 'header.post-header is never closed');
  assertTagListRoles(all.filter((t) => t.start >= header.end && t.start < close));
}

/**
 * The listing's state, chosen by the built article inventory and never by the
 * listing's own markup, so a list or form that went missing cannot pass for
 * the launch state.
 *
 * With articles: `ol#post-list.post-list`, which carries `role="list"` as
 * each of its tag lists does (`assertTagListRoles`), holds one
 * `li[data-url]` per built article (the join `search.js` makes with the
 * index); `form#blog-search` is hidden until `search.js` runs, a GET to the
 * listing, and names the index under the base path in `data-index`; no
 * `.post-empty` element is present.
 * Without articles: one `p.post-empty` reading the empty-state text, and
 * neither the form nor the list.
 *
 * The empty state is recognised by its layout-owned element, never by its
 * wording: titles and summaries are escaped, so they cannot write a
 * `.post-empty` element, but they may contain any text, the empty-state
 * sentence included.
 * @param {string} html
 * @param {{ base: string, articleUrls: string[] }} expected `base`: the site's
 *   base path; `articleUrls`: the URL path of every built article page
 */
function assertListing(html, { base, articleUrls }) {
  const all = tags(html);
  const byId = (id) => all.find((tag) => tag.attrs.id === id);
  const emptyStates = all.filter((tag) => classTokens(tag).includes('post-empty'));

  if (articleUrls.length === 0) {
    assert.equal(emptyStates.length, 1, 'a listing without articles must hold exactly one .post-empty element');
    const [empty] = emptyStates;
    assert.equal(empty.name, 'p', `the empty state must be a <p>: ${empty.source}`);
    const end = closingTagIndex(html, 'p', empty.end);
    assert.notEqual(end, -1, 'p.post-empty is never closed');
    assert.equal(textOf(html.slice(empty.end, end)), EMPTY_LISTING_TEXT, 'p.post-empty must read the empty-state text');
    for (const id of ['blog-search', 'post-list']) {
      assert.ok(!html.includes(`id="${id}"`) && byId(id) === undefined, `a listing without articles must not contain #${id}`);
    }
    return;
  }

  const list = byId('post-list');
  assert.ok(list, `the listing must hold #post-list for its ${articleUrls.length} built article(s)`);
  assert.equal(list.name, 'ol', `#post-list must be an <ol>: ${list.source}`);
  assert.ok(classTokens(list).includes('post-list'), `#post-list lacks class "post-list": ${list.source}`);
  assert.equal(list.attrs.role, 'list', `#post-list must carry role="list" so WebKit keeps its list semantics: ${list.source}`);
  const close = closingTagIndex(html, 'ol', list.end);
  assert.notEqual(close, -1, 'ol#post-list is never closed');
  assertTagListRoles(all.filter((tag) => tag.start >= list.end && tag.start < close));
  const listed = all
    .filter((tag) => tag.name === 'li' && tag.start >= list.end && tag.start < close && Object.hasOwn(tag.attrs, 'data-url'))
    .map((tag) => tag.attrs['data-url']);
  assert.deepEqual(
    [...listed].sort(),
    [...articleUrls].sort(),
    'the li[data-url] items of ol#post-list must name every built article exactly once',
  );

  const form = byId('blog-search');
  assert.ok(form, `the listing must hold form#blog-search for its ${articleUrls.length} built article(s)`);
  assert.equal(form.name, 'form', `#blog-search must be a <form>: ${form.source}`);
  assert.equal(form.attrs.role, 'search', 'form#blog-search role');
  assert.ok(Object.hasOwn(form.attrs, 'hidden'), 'form#blog-search must be hidden until search.js runs');
  assert.equal((form.attrs.method || '').toLowerCase(), 'get', 'form#blog-search method');
  assert.equal(form.attrs.action, `${base}/blog/`, 'form#blog-search action');
  assert.equal(form.attrs['data-index'], `${base}/blog/search.json`, 'form#blog-search data-index');

  assert.deepEqual(
    emptyStates.map((tag) => tag.source),
    [],
    'a listing with articles must not show the empty state (.post-empty)',
  );
}

function definePageContractTests() {
  test('[AC-06][F-018] every blog page meets the page contract', async (t) => {
    const pages = siteBlogPages();
    t.diagnostic(`${pages.length} blog page(s) under ${SITE_DIR}: ${pages.map((p) => p.rel).join(', ')}`);
    // Article pages built, independent of the listing markup they are checked against.
    const articleUrls = pages.filter((p) => p.kind === 'article').map((p) => p.urlPath);
    t.diagnostic(
      `${articleUrls.length} built article page(s): the listing must ` +
        (articleUrls.length > 0 ? 'list each one and hold the search form' : 'show the launch state'),
    );
    for (const page of pages) {
      await t.test(`[AC-06][F-018] ${page.rel} (${page.urlPath})`, () => {
        const html = readFileSync(page.file, 'utf8');
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'page must start with <!DOCTYPE html>');
        const root = tags(html).find((tag) => tag.name === 'html');
        assert.ok(root, 'no <html> start tag');
        assert.equal(root.attrs.lang, 'en', `<html> must declare lang="en": ${root.source}`);

        assertHeadOrder(html);
        // The prose scan runs before the script check so that a script written in an
        // article body is reported against the article content, where it must be fixed.
        if (page.kind === 'article') {
          const problems = unsafeMarkup(proseRegion(html));
          assert.deepEqual(problems, [], `unsafe markup in the prose of ${page.rel}:\n${problems.join('\n')}`);
        }
        assertScripts(
          html,
          page.kind === 'listing' ? [`${BASE}/main.js`, `${BASE}/blog/search.js`] : [`${BASE}/main.js`],
        );
        assertMetadata(html, page.kind);
        assertLandmarks(html);
        assertBlogCurrent(html, page.kind);
        if (page.kind === 'article') assertArticleTagLists(html);
        if (page.kind === 'listing') assertListing(html, { base: BASE, articleUrls });
      });
    }
  });

  test('[AC-06][F-018] the prose scan flags unsafe markup and passes escaped code samples', () => {
    // The structure _layouts/post.html and _layouts/blog.html build around the rendered body.
    const back = '<p class="post-back"><a href="/blog/">← All articles</a></p>';
    const wrap = (inner) =>
      `<main id="main">\n<article class="section post">\n<div class="container">\n${back}\n` +
      `<header class="post-header"><h1>T</h1></header>\n<div class="prose">\n${inner}\n</div>\n${back}\n` +
      '</div>\n</article>\n</main>';
    const flagged = (inner) => unsafeMarkup(proseRegion(wrap(inner))).length > 0;
    const unsafe = [
      '<script>alert(1)</script>',
      '<script src="/main.js"></script>',
      '<SCRIPT SRC="/x.js"></SCRIPT>',
      '<iframe src="/"></iframe>',
      '<object data="/x"></object>',
      '<embed src="/x">',
      '<form action="/"><input></form>',
      '<base href="/">',
      '<meta http-equiv="refresh" content="0">',
      '<link rel="stylesheet" href="/x.css">',
      '<style>p { color: red }</style>',
      '<img src="/x.png" alt="x" onerror="alert(1)">',
      '<p OnClick="x()">tap</p>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<svg><script>alert(1)</script></svg>',
      // Recovery syntax and raw text a browser reads differently from plain tags.
      '<script/src="/assets/blog/x/evil.js"></script>',
      '<img src="x"onerror="alert(1)">',
      '<textarea><!--</textarea><script src="/assets/blog/x/evil.js"></script>--><p>ok</p>',
      '<svg><xmp><p><textarea><!--</textarea><img src="/x.png" alt="x" onerror="alert(1)"></xmp>--></svg>',
      '<svg><![CDATA[ > <!-- ]]><img src=x onerror=alert(1)> -->',
      '<textarea>',
      '<plaintext>',
      '<noscript><img src=x onerror=alert(1)></noscript>',
      // References a browser decodes: no `;`, named tab and colon, the "fj" ligature.
      '<a href="&#106avascript:alert(1)">x</a>',
      '<a href="java&Tab;script&colon;alert(1)">x</a>',
      '<a href="java&#x09script:alert(1)">x</a>',
      '<a href="&fjlig;avascript:alert(1)">x</a>',
      // A `<script` counts wherever it is written, as in the source scan.
      '<!-- <script>commented out</script> -->',
    ];
    for (const inner of unsafe) assert.ok(flagged(inner), `not flagged: ${inner}`);
    assert.ok(unsafeMarkup('<p>ok</p><a href="x').length > 0, 'not flagged: an attribute value left open');

    const safe = [
      '<pre class="highlight"><code><span class="nt">&lt;script </span><span class="na">src=</span>' +
        '<span class="s">"/assets/app.js"</span><span class="nt">&gt;&lt;/script&gt;</span></code></pre>',
      '<p>Use <code>onclick</code> handlers sparingly; never write <code>javascript&#58;</code> URLs.</p>',
      '<table><tr><th style="text-align: left">A</th></tr></table>',
      '<p><img src="/assets/blog/x/figure.png" alt="Figure"></p>',
      '<svg><title>Diagram</title></svg>',
      '<p>a &lt; b and &amp;#106;avascript: as text</p>',
      '<textarea>plain</textarea>',
    ];
    for (const inner of safe) assert.ok(!flagged(inner), `flagged: ${inner}`);

    // The region stops at the closing back link, so a script after it belongs to the layout scan.
    assert.equal(proseRegion(`${wrap('<p>ok</p>')}<script src="/main.js"></script>`).includes('<script'), false);

    // A back link, or a whole fake layout tail, written in the body does not end the region.
    const spoofed = [
      '<p class="post-back">x</p><iframe src="/"></iframe>',
      `${back}</div></article></main><iframe src="/"></iframe>`,
      "<p class='post-back'>x</p><form action=\"/\"></form>",
    ];
    for (const inner of spoofed) assert.ok(flagged(inner), `not flagged behind a spoofed back link: ${inner}`);

    // A page whose prose cannot be bounded by the layout's own markup fails instead of passing unscanned.
    const unbounded = {
      'a comment opened in the prose hides the closing back link': wrap(
        '<p class="post-back">x</p><iframe src="/"></iframe>\n<!--',
      ),
      'markup between the closing back link and </article>': wrap('<p>ok</p>').replace(
        `${back}\n</div>\n</article>`,
        `${back}\n<iframe src="/"></iframe>\n</div>\n</article>`,
      ),
      'markup between the prose and the closing back link': wrap('<p>ok</p>').replace(
        `</div>\n${back}\n</div>`,
        `</div>\n<iframe src="/"></iframe>\n${back}\n</div>`,
      ),
      'no closing back link after the prose': wrap('<p>ok</p>').replace(`${back}\n</div>\n</article>`, '</div>\n</article>'),
      'an attribute value left open in the prose swallows the closing back link': wrap('<a href="x'),
    };
    for (const [why, html] of Object.entries(unbounded)) {
      assert.notEqual(html, wrap('<p>ok</p>'), `case not built: ${why}`);
      assert.throws(() => proseRegion(html), assert.AssertionError, `prose region accepted: ${why}`);
    }
  });

  test('[AC-06][F-018] the script check finds every script a browser could run', () => {
    const main = '<script src="/main.js" defer></script>';
    const page = (body, scripts = main) =>
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>T &amp; U</title>\n' +
      `${scripts}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
    const check = (html, expected = ['/main.js']) => () => assertScripts(html, expected);

    assert.doesNotThrow(check(page('<p>ok</p>')), 'the expected script must pass');
    assert.doesNotThrow(
      check(page('<textarea>plain</textarea>', `${main}\n<script src="/blog/search.js" defer></script>`), [
        '/main.js',
        '/blog/search.js',
      ]),
      'the expected listing scripts must pass',
    );
    const rejected = {
      'an extra <script/src>': page('<script/src="/assets/blog/x/evil.js"></script>'),
      'a script hidden from plain tags by a textarea and a comment': page(
        '<textarea><!--</textarea><script src="/assets/blog/x/evil.js"></script>-->',
      ),
      'a script written in a comment': page('<!-- <script src=x> -->'),
      'inline content': page('<p>ok</p>', '<script src="/main.js" defer>alert(1)</script>'),
      'an unclosed script': page('<p>ok</p>', '<script src="/main.js" defer>'),
    };
    for (const [why, html] of Object.entries(rejected)) {
      assert.throws(check(html), assert.AssertionError, `passed: ${why}`);
    }
  });

  test('[AC-06][F-018] the title check counts the head only, so an inline SVG title in the prose passes', () => {
    const page = (head, body) =>
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
    const texts = (html) => headTitles(html).map((title) => title.text);

    assert.deepEqual(texts(page('<title>A</title>', '<svg><title>Diagram</title></svg>')), ['A']);
    assert.deepEqual(texts(page('<title>A</title><title>B</title>', '<p>x</p>')), ['A', 'B']);
    assert.deepEqual(texts(page('', '<title>A</title>')), []);
    // A `</head>` inside the title's raw text does not end the head.
    assert.deepEqual(texts(page('<title>A</head>B</title><title>C</title>', '<p>x</p>')), ['A</head>B', 'C']);
    // Without `</head>`, the first `<body>` ends it.
    assert.deepEqual(texts('<html><head><title>A</title><body><svg><title>D</title></svg>'), ['A']);
    assert.equal(headTitles('<html><body><title>A</title>'), null);
  });

  test('[AC-06][F-018] the page checks stay linear on a hundred thousand unclosed openers', () => {
    const count = 100000;
    // Each check here takes well under a second; a pass that rescans the rest
    // of the input per opener takes about twenty seconds at this count.
    const boundMs = 5000;
    const timed = (why, run) => {
      const started = performance.now();
      const result = run();
      const elapsed = performance.now() - started;
      assert.ok(elapsed < boundMs, `${why} took ${elapsed.toFixed(0)} ms on ${count} unclosed openers`);
      return result;
    };
    const tables = '<table>'.repeat(count);
    const titles = '<title>'.repeat(count);
    const links = '<h2><a>x'.repeat(count);
    const angles = '< '.repeat(count);

    assert.equal(timed('the table check', () => hasAlignedTable(tables)), false);
    const aligned = '<table><tr><th style="text-align: left">A</th></tr></table>';
    assert.equal(timed('the table check', () => hasAlignedTable(`${tables}${aligned}`)), true);
    assert.deepEqual(
      timed('the title read', () => pageTitles(`<title>T</title>${titles}`)).map((title) => title.closed),
      [true, false],
    );
    const found = timed('the listing link read', () => titleLinks(`${links}<h2><a href="/blog/x/">X</a></h2>`));
    assert.deepEqual(
      found.map(({ tag, inner }) => ({ href: tag.attrs.href, inner })),
      [{ href: '/blog/x/', inner: 'X' }],
    );
    assert.equal(timed('the text read', () => textOf(angles)), angles.trim());
    assert.deepEqual(timed('the prose scan', () => unsafeMarkup(tables)), []);
    assert.ok(timed('the prose scan', () => unsafeMarkup(titles)).length > 0, 'an unclosed <title> must be flagged');
    assert.deepEqual(timed('the prose scan', () => unsafeMarkup(links)), []);
    assert.deepEqual(timed('the prose scan', () => unsafeMarkup(angles)), []);
  });

  test('[AC-06][F-018] the listing check follows the built article inventory, not the listing markup', () => {
    const base = '/cabrillo-coast';
    const urls = [`${base}/blog/second-article/`, `${base}/blog/first-article/`];
    const index = `data-index="${base}/blog/search.json"`;
    const form =
      `<form class="blog-search" id="blog-search" role="search" action="${base}/blog/" method="get" ${index} hidden>\n` +
      '<label for="blog-search-input">Search articles</label>\n' +
      '<input id="blog-search-input" type="search" name="q">\n</form>';
    const card = (url, words = 'Title') =>
      `<li class="card post-card" data-url="${url}">\n<h2><a href="${url}">${words}</a></h2>\n` +
      `<p class="post-summary">${words}</p>\n` +
      `<ul class="tag-list" role="list" aria-label="Tags"><li><a class="tag-link" href="${base}/blog/?q=tag">tag</a></li></ul>\n</li>`;
    const list = (items, words) =>
      `<ol class="post-list" id="post-list" role="list" aria-label="Articles">\n${items.map((url) => card(url, words)).join('\n')}\n</ol>`;
    const page = (inner) =>
      '<!DOCTYPE html>\n<html lang="en">\n<body>\n<main id="main">\n<section class="section blog-index">\n' +
      `<div class="container">\n<div class="section-head"><h1>Technical articles</h1></div>\n${inner}\n</div>\n` +
      '</section>\n</main>\n</body>\n</html>';
    const populated = page(`${form}\n${list(urls)}`);
    const launch = page(`<p class="post-empty">${EMPTY_LISTING_TEXT}</p>`);
    const check = (html, articleUrls) => () => assertListing(html, { base, articleUrls });
    const fails = (html, articleUrls, why) => assert.throws(check(html, articleUrls), assert.AssertionError, `passed: ${why}`);

    assert.doesNotThrow(check(populated, urls), 'a valid populated listing must pass');
    fails(populated.replace('id="post-list"', 'id="posts"'), urls, 'list id renamed');
    fails(populated.replace(' role="list" aria-label="Articles"', ' aria-label="Articles"'), urls, 'list without role="list"');
    fails(populated.replace(' role="list" aria-label="Tags"', ' aria-label="Tags"'), urls, 'tag list without role="list"');
    fails(page(form), urls, 'list removed');
    fails(page(list(urls)), urls, 'form removed');
    fails(populated.replace(` ${index}`, ''), urls, 'form without data-index');
    fails(populated.replace(index, 'data-index="/blog/search.json"'), urls, 'data-index without the base path');
    fails(page(`${form}\n${list(urls.slice(1))}`), urls, 'list missing an article');
    fails(populated, [], 'populated listing with no built article');
    fails(page(`<p class="post-empty">${EMPTY_LISTING_TEXT}</p>\n${form}\n${list(urls)}`), urls, 'empty state beside the list');
    assert.doesNotThrow(
      check(page(`${form}\n${list(urls, `Why ${EMPTY_LISTING_TEXT} matters`)}`), urls),
      'the empty-state sentence in an article title or summary is article content, not the empty state',
    );
    assert.doesNotThrow(check(launch, []), 'the launch state with no built article must pass');
    fails(launch, urls, 'launch state with built articles');
    fails(page('<p class="post-empty">Nothing here.</p>'), [], 'launch state with the wrong empty-state text');
    fails(page(''), [], 'no built article and no empty state');
  });
}

/* AC-07 — links, metadata and outputs                                       */

function defineLinkAndOutputTests() {
  test('[AC-07][F-018] every local href, src and data-index on every built page resolves', (t) => {
    const findings = checkSiteLinks({ siteDir: SITE_DIR, baseurl: BASE, siteUrl: SITE_URL });
    const lines = findings.map((f) => `${f.page}: ${f.attribute}="${f.value}" — ${f.reason}`);
    for (const line of lines) t.diagnostic(line);
    assert.deepEqual(findings, [], `${findings.length} unresolved reference(s) under ${SITE_DIR}:\n${lines.join('\n')}`);
  });

  test('[AC-07][F-018] canonical and og:url name the page on the deployment host', async (t) => {
    for (const page of siteBlogPages()) {
      await t.test(`[AC-07][F-018] ${page.rel}`, () => {
        const html = readFileSync(page.file, 'utf8');
        const expected = `${SITE_URL}${page.urlPath}`;
        const canonical = tags(html).filter(
          (tag) => tag.name === 'link' && (tag.attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical'),
        );
        assert.equal(canonical.length, 1, 'page must have exactly one <link rel="canonical">');
        assert.equal(canonical[0].attrs.href, expected, 'canonical href');
        assert.equal(meta(html, 'property', 'og:url'), expected, 'og:url');
      });
    }
  });

  test('[AC-07][F-018] repository-internal files are absent from the output', () => {
    const present = FORBIDDEN_OUTPUTS.filter((rel) => existsSync(path.join(SITE_DIR, ...rel.split('/'))));
    assert.deepEqual(present, [], `published although _config.yml must exclude them: ${present.join(', ')}`);
  });

  test('[AC-07][F-018] CNAME follows the deployment mode', () => {
    const host = new URL(SITE_URL).host;
    const cname = path.join(SITE_DIR, 'CNAME');
    if (host.endsWith('.github.io')) {
      assert.ok(!existsSync(cname), `${cname} must be absent on the project path (${host})`);
    } else {
      assert.ok(existsSync(cname), `${cname} must be published for the custom domain ${host}`);
      assert.equal(readFileSync(cname, 'utf8').trim(), host, 'CNAME must hold the SITE_URL host');
    }
  });

  test('[AC-07][F-018] the home page is copied byte for byte', () => {
    const built = path.join(SITE_DIR, 'index.html');
    assert.ok(existsSync(built), `${built} not found`);
    assert.ok(
      readFileSync(built).equals(readFileSync(path.join(ROOT, 'index.html'))),
      'the built index.html differs from the source: it must carry no front matter and pass through unchanged',
    );
  });
}

/* AC-02 — drafts, draft images and future-dated posts                       */

/**
 * Confirms the fixture builder wrote the synthetic draft, its image and the
 * future-dated post into its staged source, so their absence from a build
 * proves exclusion rather than a missing input.
 */
function assertSyntheticSource() {
  const src = path.join(FIXTURE_DIR, 'src');
  assert.ok(existsSync(path.join(src, '_drafts', `${DRAFT_SLUG}.md`)), `${src} holds no synthetic draft`);
  assert.ok(existsSync(path.join(src, ...DRAFT_IMAGE.split('/'))), `${src} holds no synthetic draft image`);
  const postsDir = path.join(src, '_posts');
  const future = existsSync(postsDir) ? readdirSync(postsDir).filter((name) => name.endsWith(`-${FUTURE_SLUG}.md`)) : [];
  assert.equal(future.length, 1, `${postsDir} holds no future-dated synthetic post`);
}

/**
 * No path under `dir` names one of `slugs`, and no text file under it (every
 * page, `search.json` and the other `TEXT_EXTENSIONS` files) holds one of
 * `slugs` or `texts`: slugs are excluded from file text as well as paths.
 * @param {string} dir
 * @param {string[]} slugs matched against output paths and file text
 * @param {string[]} texts matched against file text only: markers, the draft-image folder
 */
function assertAbsent(dir, slugs, texts) {
  const paths = walk(dir).filter((rel) => slugs.some((slug) => rel.includes(slug)));
  assert.deepEqual(paths, [], `${dir} must not contain ${slugs.join(' or ')}`);
  const needles = [...slugs, ...texts];
  const leaks = textFiles(dir).flatMap((rel) => {
    const text = readSiteFile(dir, rel);
    return needles.filter((needle) => text.includes(needle)).map((needle) => `${rel}: ${needle}`);
  });
  assert.deepEqual(leaks, [], `private slugs, markers or draft-image paths found in the text under ${dir}`);
}

function definePrivacyTests() {
  test('[AC-02][F-017] no draft image folder and no article template reach the build', () => {
    for (const rel of ['assets/drafts', '_templates']) {
      assert.ok(!existsSync(path.join(SITE_DIR, ...rel.split('/'))), `${rel} must not be published`);
    }
  });

  test('[AC-02][F-017] the project build holds no draft, draft image or future-dated post', FIXTURE_ONLY, () => {
    assertSyntheticSource();
    assertAbsent(SITE_DIR, [DRAFT_SLUG, FUTURE_SLUG], [DRAFT_MARKER, FUTURE_MARKER, DRAFT_IMAGE_FOLDER]);
  });

  test('[AC-02][F-017] the preview build renders the draft and its image but no future-dated post', FIXTURE_ONLY, () => {
    assertSyntheticSource();
    const preview = path.join(FIXTURE_DIR, 'preview');
    const draftFile = path.join(preview, 'blog', DRAFT_SLUG, 'index.html');
    assert.ok(existsSync(draftFile), `${draftFile} not found: the preview build must render drafts`);
    const html = readFileSync(draftFile, 'utf8');
    assert.ok(html.includes(DRAFT_MARKER), 'the preview draft page lacks its marker text');
    const imageSrc = `/${DRAFT_IMAGE}`;
    assert.ok(
      tags(html).some((t) => t.name === 'img' && t.attrs.src === imageSrc),
      `the preview draft page has no <img src="${imageSrc}">`,
    );
    assert.ok(existsSync(path.join(preview, ...DRAFT_IMAGE.split('/'))), `${DRAFT_IMAGE} missing from the preview build`);
    // future: false holds in the preview too.
    assertAbsent(preview, [FUTURE_SLUG], [FUTURE_MARKER]);
  });
}

/* AC-05 — rendering and escaping (fixture articles)                         */

/** Reads a built article of `SITE_DIR` by slug, failing when it was not built. */
function readArticle(slug) {
  const file = path.join(SITE_DIR, 'blog', slug, 'index.html');
  assert.ok(existsSync(file), `${file} not found: the fixture article was not built`);
  return readFileSync(file, 'utf8');
}

/**
 * The code HTML of the one fenced block for `lang` in a page: the content of
 * `<code>` in `div.language-<lang>.highlighter-rouge > div.highlight >
 * pre.highlight`, the structure kramdown writes with Rouge. Fails the calling
 * test unless exactly one such block exists and holds that structure.
 * @param {string} html
 * @param {string} lang
 * @returns {string}
 */
function rougeCode(html, lang) {
  const blocks = tags(html).filter((t) => {
    const classes = classTokens(t);
    return t.name === 'div' && classes.includes(`language-${lang}`) && classes.includes('highlighter-rouge');
  });
  assert.equal(blocks.length, 1, `the page must hold exactly one div.language-${lang}.highlighter-rouge block`);
  const opening = '<div class="highlight"><pre class="highlight"><code>';
  const after = blocks[0].end;
  assert.ok(
    html.startsWith(opening, after),
    `div.language-${lang}.highlighter-rouge must directly hold ${opening}, found: ${html.slice(after, after + 80)}`,
  );
  const close = closingTagIndex(html, 'code', after + opening.length);
  assert.notEqual(close, -1, `the ${lang} code block is never closed`);
  return html.slice(after + opening.length, close);
}

/**
 * The fenced `lang` block was highlighted by Rouge: its code holds token
 * spans, every span carries exactly one class from `ROUGE_TOKEN_CLASSES`,
 * every class in `tokens` occurs, and its text holds every string in `text`.
 * @param {string} html
 * @param {string} lang
 * @param {{ tokens: string[], text: string[] }} expected
 */
function assertRougeBlock(html, lang, { tokens, text }) {
  const code = rougeCode(html, lang);
  const spans = tags(code).filter((t) => t.name === 'span');
  assert.ok(spans.length > 0, `the ${lang} block holds no Rouge token spans`);
  const found = new Set();
  for (const span of spans) {
    const classes = classTokens(span);
    assert.ok(
      classes.length === 1 && ROUGE_TOKEN_CLASSES.has(classes[0]),
      `every span of the ${lang} block must carry one Rouge token class: ${span.source}`,
    );
    found.add(classes[0]);
  }
  const missing = tokens.filter((token) => !found.has(token));
  assert.deepEqual(missing, [], `the ${lang} block lacks Rouge token class(es); it holds ${[...found].sort().join(' ')}`);
  const plain = textOf(code);
  for (const expected of text) {
    assert.ok(plain.includes(expected), `the ${lang} block lacks the text "${expected}", found: ${plain.slice(0, 160)}`);
  }
}

function defineRenderingTests() {
  test('[AC-05][F-018] the escaping fixture is escaped in <title>, <h1> and og:title and keeps its raw-block code as text', FIXTURE_ONLY, () => {
    const html = readArticle(ESCAPING_SLUG);
    assert.ok(html.includes(`<title>${ESCAPED_TITLE}${TITLE_SUFFIX}</title>`), '<title> must hold the escaped title');

    const h1 = tags(html).find((t) => t.name === 'h1');
    assert.ok(h1, 'no <h1>');
    const h1End = closingTagIndex(html, 'h1', h1.end);
    assert.notEqual(h1End, -1, 'the <h1> is never closed');
    const h1Html = html.slice(h1.end, h1End);
    assert.ok(h1Html.includes(ESCAPED_TITLE), `<h1> must hold the escaped title, found: ${h1Html}`);

    const ogTitle = tags(html).find((t) => t.name === 'meta' && t.attrs.property === 'og:title');
    assert.ok(ogTitle, 'no og:title');
    assert.ok(ogTitle.source.includes(ESCAPED_TITLE), `og:title must be escaped in the source: ${ogTitle.source}`);
    assert.ok(!html.includes('<angle>'), 'the unescaped title reached the page');

    assert.ok(textOf(proseRegion(html)).includes('{{ .Values.image }}'), 'the {% raw %} sample lost its Liquid text');

    const modified = meta(html, 'property', 'article:modified_time');
    assert.ok(
      typeof modified === 'string' && modified.startsWith('2026-02-10'),
      `article:modified_time must follow the fixture's updated date, found: ${modified}`,
    );
  });

  test('[AC-05][F-018] the listing prints the escaped fixture title in its <h2> link', FIXTURE_ONLY, () => {
    const html = readSiteFile(SITE_DIR, LISTING_REL);
    const match = titleLinks(html).find((link) => link.inner.includes(ESCAPED_TITLE));
    assert.ok(match, 'no listing <h2> link holds the escaped title');
    assert.equal(match.tag.attrs.href, `${BASE}/blog/${ESCAPING_SLUG}/`, 'listing link target');
  });

  test('[AC-05][F-018] the code fixture renders Rouge highlighting, inline code and an aligned table', FIXTURE_ONLY, () => {
    const html = readArticle(CODE_SLUG);
    for (const expected of [
      'class="language-python highlighter-rouge"',
      'class="language-yaml highlighter-rouge"',
      '<pre class="highlight">',
      '<code class="language-plaintext highlighter-rouge">',
    ]) {
      assert.ok(html.includes(expected), `missing ${expected}`);
    }
    assertRougeBlock(html, 'python', {
      tokens: ['k', 'nf', 'c1', 's', 'mi', 'mf'],
      text: ['def retry_delay(attempt, base=0.5, limit=30):', 'unit = "seconds"'],
    });
    // The quoted YAML strategy is the fixture's settled choice: Rouge writes its opening quote as s2.
    assertRougeBlock(html, 'yaml', {
      tokens: ['na', 'pi', 's2', 'm'],
      text: ['strategy: "exponential"', 'max_attempts: 5'],
    });
    assert.ok(hasAlignedTable(html), 'no rendered table with aligned header cells');
    assert.equal(meta(html, 'property', 'article:modified_time'), undefined, 'the code fixture has no updated date');
  });

  test('[AC-05][F-018] the Rouge check requires recognized tokens in each language block', () => {
    const block = (lang, code) =>
      `<div class="language-${lang} highlighter-rouge"><div class="highlight"><pre class="highlight"><code>${code}` +
      '</code></pre></div></div>';
    const python =
      '<span class="k">def</span> <span class="nf">delay</span><span class="p">(</span><span class="n">attempt</span>' +
      '<span class="p">):</span>\n    <span class="c1"># Capped.\n</span>    <span class="n">unit</span> ' +
      '<span class="o">=</span> <span class="s">"seconds"</span>\n    <span class="k">return</span> ' +
      '<span class="mf">0.5</span> <span class="o">*</span> <span class="mi">2</span>\n';
    const yaml =
      '<span class="na">strategy</span><span class="pi">:</span> <span class="s2">"</span>' +
      '<span class="s">exponential"</span>\n<span class="na">max_attempts</span><span class="pi">:</span> ' +
      '<span class="m">5</span>\n';
    const page = (...blocks) => `<div class="prose">\n${blocks.join('\n')}\n</div>`;
    const check = (html) => () => {
      assertRougeBlock(html, 'python', {
        tokens: ['k', 'nf', 'c1', 's', 'mi', 'mf'],
        text: ['def delay(attempt):', 'unit = "seconds"'],
      });
      assertRougeBlock(html, 'yaml', { tokens: ['na', 'pi', 's2', 'm'], text: ['strategy: "exponential"', 'max_attempts: 5'] });
    };
    const fails = (html, why) => assert.throws(check(html), assert.AssertionError, `passed: ${why}`);
    const unspanned = (code) => code.replace(/<\/?span\b[^>]*>/g, '');
    const nonRouge = (code) => code.replace(/<span class="[^"]*">/g, '<span class="token">');

    assert.doesNotThrow(check(page(block('python', python), block('yaml', yaml))), 'valid Python and YAML blocks must pass');
    fails(page(block('python', python), block('yaml', unspanned(yaml))), 'YAML block without token spans');
    fails(page(block('python', unspanned(python)), block('yaml', yaml)), 'Python block without token spans');
    fails(page(block('python', nonRouge(python)), block('yaml', nonRouge(yaml))), 'non-Rouge class on every span');
    fails(page(block('python', python), block('yaml', yaml.replace('<span class="s2">"</span>', '"'))), 'YAML s2 token missing');
    fails(page(block('python', python), block('yaml', yaml.replace('>5</span>', '>7</span>'))), 'expected YAML text missing');
    fails(page(block('python', python)), 'YAML block missing');
    fails(page(block('python', python), block('yaml', yaml), block('yaml', yaml)), 'YAML block written twice');
    fails(
      page(block('python', python), `<div class="language-yaml highlighter-rouge"><pre><code>${yaml}</code></pre></div>`),
      'YAML block outside div.highlight > pre.highlight',
    );
  });
}

/* AC-17 — launch state                                                      */

function defineLaunchStateTests() {
  test('[AC-17][F-018] the empty fixture build shows the launch state', FIXTURE_ONLY, () => {
    assertEmpty(path.join(FIXTURE_DIR, 'empty'));
  });

  const posts = realPostFiles();
  let realSkip = false;
  if (FIXTURE_DIR) {
    realSkip = 'FIXTURE_DIR is set: SITE_DIR is the fixture build, which holds articles';
  } else if (posts.length > 0) {
    realSkip = `_posts/ holds ${posts.length} article(s), so the real build is past its launch state`;
  }
  test('[AC-17][F-018] the real build shows the launch state while _posts/ holds no article', { skip: realSkip }, () => {
    assertEmpty(SITE_DIR);
  });

  test('[AC-17][F-018] the post inventory counts regular .md files only', (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'built-pages-posts-'));
    try {
      assert.deepEqual(postFiles(path.join(dir, 'missing')), [], 'a missing folder holds no article');
      mkdirSync(path.join(dir, 'scratch.md'));
      assert.deepEqual(postFiles(dir), [], 'an empty folder named scratch.md is not an article');

      mkdirSync(path.join(dir, 'sub'));
      writeFileSync(path.join(dir, 'sub', '2026-01-01-a.md'), '---\ntitle: "A"\n---\nBody.\n');
      writeFileSync(path.join(dir, 'notes.txt'), 'Not an article.\n');
      assert.deepEqual(postFiles(dir), ['sub/2026-01-01-a.md'], 'a nested regular .md file counts, a .txt file does not');

      let linked = false;
      try {
        symlinkSync(path.join(dir, 'sub', '2026-01-01-a.md'), path.join(dir, 'link.md'));
        symlinkSync(path.join(dir, 'sub'), path.join(dir, 'linked-folder'), 'dir');
        linked = true;
      } catch (error) {
        t.diagnostic(`symbolic links are unsupported here (${error.code}); the link sub-case is skipped`);
      }
      if (linked) {
        assert.deepEqual(postFiles(dir), ['sub/2026-01-01-a.md'], 'symbolic links are neither counted nor followed');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/* Registration                                                              */

if (!existsSync(SITE_DIR)) {
  // Without a build there is nothing to check: one failing case says what to do,
  // and nothing else is registered (top-level return is not allowed in a module).
  test('[AC-06][F-018] built site present', () => {
    assert.fail(`SITE_DIR ${SITE_DIR} not found — run bundle exec jekyll build first`);
  });
} else {
  definePageContractTests();
  defineLinkAndOutputTests();
  definePrivacyTests();
  defineRenderingTests();
  defineLaunchStateTests();
}
