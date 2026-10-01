/* Cabrillo Coast LLC — home page integrity, blog chrome parity and blog asset rules (AC-10, F-018, F-019) */
/**
 * Source checks over the files the blog shares with, or adds beside, the
 * hand-written home page. Nothing here reads build output, so the suite runs
 * in the first `node --test "tests/**\/*.test.mjs"` pass of
 * `scripts/verify.mjs`, before any Jekyll build.
 *
 * What it proves:
 *   - Home page navigation. `index.html` lists the seven header and
 *     mobile-menu destinations and the five footer destinations in the order
 *     the plan fixes, with Blog at `./blog/`, and its mobile menu is a
 *     `nav.mobile-menu#mobile-menu[aria-label="Primary"][hidden]` landmark.
 *   - Home page pass-through. `index.html` starts with `<!DOCTYPE html>`, so
 *     it has no front matter and Jekyll copies it byte-for-byte, and it loads
 *     exactly one script, `./main.js`.
 *   - Home page budgets. PT-4: five first-party requests including the
 *     document. PT-1: at most 237,954 first-party bytes. PT-2: `main.js` at
 *     most 3,609 bytes.
 *   - Chrome parity. The navigation in `_includes/site-header.html` and
 *     `_includes/site-footer.html` matches `index.html` label for label, with
 *     each home page href mapped to its site-root form, and the includes keep
 *     every hook `main.js` drives, so the blog's mobile menu, scroll shadow
 *     and footer year work with `main.js` unchanged.
 *   - Blog assets. `blog/search.js` is at most 5,000 bytes, ES5 strict-mode
 *     syntax, and free of HTML-writing and code-evaluating calls;
 *     `blog/blog.css` is at most 8,000 bytes.
 *
 * Paths resolve from this file's own location (`ROOT`), never from
 * `process.cwd()`, so the suite gives the same answer from any directory.
 *
 * Runs with `node --test tests/static/site-chrome.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no network and writes
 * nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { decodeEntities, parseStartTags } from './lib/site-links.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Repository root: two levels above `tests/static/`. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Header and mobile-menu labels on the home page, in order. */
const HOME_LABELS = Object.freeze([
  'Services',
  'Agentic AI',
  'Topology',
  'Approach',
  'About',
  'Blog',
  'Get in touch',
]);

/** Header and mobile-menu hrefs on the home page, paired with `HOME_LABELS`. */
const HOME_HREFS = Object.freeze([
  '#services',
  '#agentic',
  '#topology',
  '#approach',
  '#about',
  './blog/',
  '#contact',
]);

/** Footer labels on the home page, in order. */
const FOOT_LABELS = Object.freeze(['Services', 'Approach', 'About', 'Blog', 'Contact']);

/** Footer hrefs on the home page, paired with `FOOT_LABELS`. */
const FOOT_HREFS = Object.freeze(['#services', '#approach', '#about', './blog/', '#contact']);

/** PT-1: first-party bytes the home page may load, document included. */
const PT1_MAX_BYTES = 237_954;

/** PT-2: size limit of `main.js`. */
const PT2_MAX_BYTES = 3_609;

/** PT-4: first-party requests of the home page, document included. */
const PT4_REQUESTS = 5;

/** First-party resources `index.html` itself requests, sorted. */
const HOME_HTML_RESOURCES = Object.freeze(['./favicon.svg', './main.js', './styles.css']);

/** First-party resources the home page stylesheets request, sorted. */
const HOME_CSS_RESOURCES = Object.freeze(['./assets/hero-lighthouse.jpg']);

/** Size limit of `blog/search.js` (AAP 0.5.5). */
const SEARCH_JS_MAX_BYTES = 5_000;

/** Size limit of `blog/blog.css` (AAP 0.5.4). */
const BLOG_CSS_MAX_BYTES = 8_000;

/**
 * An absolute URL: a scheme (`https:`, `data:`, `mailto:`) or a
 * protocol-relative `//host`. Neither is a first-party request on a page
 * that loads its own files through `./` paths.
 */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/**
 * `<link rel>` tokens that make the browser fetch the `href` while loading
 * the page. `preconnect` and `dns-prefetch` open connections without
 * requesting a resource, so they are not counted.
 */
const REQUESTING_LINK_RELS = Object.freeze(['icon', 'stylesheet', 'preload', 'modulepreload']);

/**
 * Syntax ES5 does not have, matched on `blog/search.js` with comments,
 * string contents and regular-expression bodies blanked (`scanJs`). A
 * backtick that survives blanking opens a template literal.
 */
const ES5_FORBIDDEN = Object.freeze([
  ['`let` declaration', /\blet\b/],
  ['`const` declaration', /\bconst\b/],
  ['arrow function', /=>/],
  ['template literal', /`/],
  ['`class`', /\bclass\b/],
  ['`async`', /\basync\b/],
  ['`await`', /\bawait\b/],
  ['spread or rest `...`', /\.\.\./],
  ['`for…of` loop', /\bfor\s*\([^)]*\bof\b/],
]);

/**
 * Calls that write markup or evaluate strings as code, matched on
 * `blog/search.js` with comments blanked and strings kept, so
 * `el['innerHTML']` is caught too. The plan names `innerHTML`,
 * `insertAdjacentHTML`, `document.write`, `eval` and `new Function`;
 * `outerHTML` is checked as well because it is the same kind of sink, and
 * search output must be text only.
 */
const UNSAFE_SINKS = Object.freeze([
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\s*\.\s*write/],
  ['eval', /\beval\b/],
  ['new Function', /\bnew\s+Function\b/],
]);

/* ------------------------------------------------------------------------ */
/* File helpers                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Absolute path of a repository file given its POSIX path from the root.
 * @param {string} rel
 * @returns {string}
 */
function abs(rel) {
  return path.join(ROOT, ...rel.split('/'));
}

/**
 * Contents of a repository file as UTF-8 text.
 * @param {string} rel
 * @returns {string}
 */
function read(rel) {
  return readFileSync(abs(rel), 'utf8');
}

/**
 * Size of a repository file in bytes. The budgets count uncompressed bytes.
 * @param {string} rel
 * @returns {number}
 */
function size(rel) {
  return statSync(abs(rel)).size;
}

/* ------------------------------------------------------------------------ */
/* HTML helpers                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Whether a parsed start tag's `class` attribute holds `token`.
 * @param {{ attrs: Record<string, string> }} tag
 * @param {string} token
 * @returns {boolean}
 */
function hasClass(tag, token) {
  return (tag.attrs.class ?? '').split(/\s+/).includes(token);
}

/**
 * The first element whose start tag satisfies `predicate`, with the markup
 * between its start tag and the next closing tag of the same name. That is
 * the element's whole content for the elements this suite reads (`nav`,
 * `header`, `footer`), none of which nests inside an element of its own
 * name.
 * @param {string} html
 * @param {(tag: import('./lib/site-links.mjs').StartTag) => boolean} predicate
 * @returns {{ tag: import('./lib/site-links.mjs').StartTag, inner: string } | null}
 */
function element(html, predicate) {
  const tag = parseStartTags(html).find(predicate);
  if (tag === undefined) return null;
  const close = new RegExp(`</${tag.name}\\s*>`, 'gi');
  close.lastIndex = tag.end;
  const match = close.exec(html);
  if (match === null) {
    throw new Error(`element: <${tag.name}> at offset ${tag.start} has no closing tag`);
  }
  return { tag, inner: html.slice(tag.end, match.index) };
}

/**
 * Every anchor in a fragment of markup, as its `href` and its visible label:
 * the anchor's content with tags removed, `&nbsp;` read as a space, other
 * character references decoded and whitespace collapsed. HTML comments are
 * dropped first so a commented-out link is never counted.
 * @param {string} inner
 * @returns {{ label: string, href: string | undefined }[]}
 */
function anchors(inner) {
  const markup = inner.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const found = [];
  for (const match of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const [startTag] = parseStartTags(`<a${match[1]}>`);
    const label = decodeEntities(match[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    found.push({ label, href: startTag?.attrs.href });
  }
  return found;
}

/**
 * Pairs labels with hrefs in the shape `anchors` returns, so one
 * `deepEqual` shows a label and its link side by side in a failure diff.
 * @param {readonly string[]} labels
 * @param {readonly string[]} hrefs
 * @returns {{ label: string, href: string }[]}
 */
function links(labels, hrefs) {
  assert.equal(labels.length, hrefs.length, 'links: labels and hrefs must pair up');
  return labels.map((label, index) => ({ label, href: hrefs[index] }));
}

/**
 * The site-root form of a home page href, which is what an include renders
 * at an empty base path: `#services` → `/#services`, `./blog/` → `/blog/`.
 * @param {string} href
 * @returns {string}
 */
function siteRootHref(href) {
  if (href.startsWith('#')) return `/${href}`;
  if (href.startsWith('./')) return `/${href.slice(2)}`;
  throw new Error(`siteRootHref: unexpected home page href ${JSON.stringify(href)}`);
}

/** A `{% comment %}…{% endcomment %}` block, whitespace-control dashes allowed. */
const LIQUID_COMMENT_RE = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g;

/**
 * An include's markup as Jekyll would render it at an empty base path, as
 * far as this suite reads it:
 *   - `{% comment %}` blocks are removed with their text;
 *   - `{{ '/path' | relative_url }}` becomes `/path`;
 *   - every other Liquid tag and output is removed, which drops the
 *     `{{ blog_nav_current }}` marker after the Blog link and the build-time
 *     year inside `span#year`. `aria-current` values assigned inside
 *     `{% if %}` branches disappear with their tags.
 * @param {string} src
 * @returns {string}
 */
function liquidToStatic(src) {
  return src
    .replace(LIQUID_COMMENT_RE, '')
    .replace(/\{\{-?\s*(['"])(.*?)\1\s*\|\s*relative_url\s*-?\}\}/g, '$2')
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '');
}

/* ------------------------------------------------------------------------ */
/* Request helpers                                                           */
/* ------------------------------------------------------------------------ */

/** `url(…)` in CSS, with the value double-quoted, single-quoted or bare. */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

/** `@import "…"` in CSS; the `@import url(…)` form is caught by `CSS_URL_RE`. */
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Whether a URL found in markup or CSS is a request to the site itself:
 * not empty, not absolute (which also excludes `data:`), and not a bare
 * fragment such as SVG's `url(#gradient)`.
 * @param {string} url
 * @returns {boolean}
 */
function isFirstPartyRequest(url) {
  return url !== '' && !url.startsWith('#') && !ABSOLUTE_URL_RE.test(url);
}

/**
 * Repository path of the file a first-party URL names, resolved against the
 * file that references it the way a browser resolves it against that file's
 * URL at an empty base path. Query and fragment are dropped.
 * @param {string} url
 * @param {string} fromRel POSIX path of the referencing file.
 * @returns {string}
 */
function fileOf(url, fromRel) {
  const clean = url.replace(/[?#][\s\S]*$/, '');
  const joined = clean.startsWith('/')
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(fromRel), clean);
  const rel = path.posix.normalize(joined);
  if (rel === '..' || rel.startsWith('../') || rel === '.' || rel === '') {
    throw new Error(`fileOf: ${JSON.stringify(url)} in ${fromRel} does not name a file in the site`);
  }
  return rel;
}

/**
 * The first-party resources a page requests while it loads: the `href` of
 * every `<link>` whose `rel` fetches (`REQUESTING_LINK_RELS`) and the `src`
 * of every element that has one (`<script>`, `<img>` and any other element
 * that loads a source). Anchors are navigation, never counted, so the
 * home page's `./blog/` links add nothing.
 * @param {string} html
 * @returns {{ urls: string[], stylesheets: string[] }} Sorted, distinct.
 */
function htmlRequests(html) {
  const urls = new Set();
  const stylesheets = new Set();
  for (const tag of parseStartTags(html)) {
    if (tag.name === 'link') {
      const rels = (tag.attrs.rel ?? '').toLowerCase().split(/\s+/);
      const href = (tag.attrs.href ?? '').trim();
      if (REQUESTING_LINK_RELS.some((rel) => rels.includes(rel)) && isFirstPartyRequest(href)) {
        urls.add(href);
        if (rels.includes('stylesheet')) stylesheets.add(href);
      }
    }
    if (Object.hasOwn(tag.attrs, 'src')) {
      const src = tag.attrs.src.trim();
      if (isFirstPartyRequest(src)) urls.add(src);
    }
  }
  return { urls: [...urls].sort(), stylesheets: [...stylesheets].sort() };
}

/**
 * The first-party resources a stylesheet requests: `url(…)` values (quotes
 * optional, including multi-line `background:` lists) and `@import`
 * strings, with CSS comments ignored.
 * @param {string} css
 * @returns {string[]} Sorted, distinct.
 */
function cssRequests(css) {
  const text = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
  const urls = new Set();
  for (const re of [CSS_URL_RE, CSS_IMPORT_RE]) {
    for (const match of text.matchAll(re)) {
      const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (isFirstPartyRequest(url)) urls.add(url);
    }
  }
  return [...urls].sort();
}

/**
 * Everything the home page loads from the site itself: the URLs in
 * `index.html`, the URLs inside each first-party stylesheet it links, and
 * the distinct repository files they name, the document included.
 * @returns {{ htmlUrls: string[], cssUrls: string[], files: string[] }}
 */
function homeRequests() {
  const { urls: htmlUrls, stylesheets } = htmlRequests(read('index.html'));
  const cssUrls = new Set();
  const files = new Set(['index.html']);
  for (const url of htmlUrls) files.add(fileOf(url, 'index.html'));
  for (const sheet of stylesheets) {
    const sheetRel = fileOf(sheet, 'index.html');
    for (const url of cssRequests(read(sheetRel))) {
      cssUrls.add(url);
      files.add(fileOf(url, sheetRel));
    }
  }
  return { htmlUrls, cssUrls: [...cssUrls].sort(), files: [...files].sort() };
}

/* ------------------------------------------------------------------------ */
/* JavaScript source scanner                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Punctuators after which a `/` begins a regular-expression literal rather
 * than a division: `x = /re/`, `f(/re/)`, `a || /re/`, `{ /re/ }`. After `)`,
 * `]`, a name, a number, a string or another literal it divides.
 */
const REGEX_AFTER_PUNCTUATOR = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '~', '^',
]);

/** Keywords after which a `/` begins a regular-expression literal. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
]);

/** Characters that end a `//` comment or an unterminated literal. */
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;

/**
 * Overwrites `out[from..to)` with spaces, keeping line terminators, so the
 * scanned text keeps the source's length and every offset still names the
 * same line and column.
 * @param {string[]} out
 * @param {number} from
 * @param {number} to
 */
function blank(out, from, to) {
  for (let index = from; index < to; index += 1) {
    if (!LINE_TERMINATOR_RE.test(out[index])) out[index] = ' ';
  }
}

/**
 * Whether a `/` that follows the token `last` opens a regular expression.
 * `last.pair` holds the last two punctuator characters when they are
 * adjacent, so the `/` in the postfix `i++ / 2` still reads as division.
 * @param {{ kind: string, value: string, pair: string }} last
 * @returns {boolean}
 */
function regexAllowedAfter(last) {
  switch (last.kind) {
    case 'start':
      return true;
    case 'word':
      return REGEX_AFTER_KEYWORD.has(last.value);
    case 'punctuator':
      return REGEX_AFTER_PUNCTUATOR.has(last.value) && last.pair !== '++' && last.pair !== '--';
    default:
      return false;
  }
}


/**
 * One pass over JavaScript source that blanks what syntax checks must not
 * read, keeping every offset in place:
 *   - `withStrings`: `//` and `/* *\/` comments blanked; strings and
 *     regular-expression literals kept. Used for the sink check, so
 *     `el['innerHTML']` still counts.
 *   - `code`: comments blanked and the contents of `'…'` and `"…"` strings
 *     (backslash escapes honoured) and of regular-expression literals
 *     blanked, so neither `"const"` nor `/=>/` reads as syntax. A string
 *     such as `"// not a comment"` is a string, so the code after it is
 *     still scanned.
 *
 * A `/` opens a regular expression when the preceding token allows one
 * (`regexAllowedAfter`), and the literal runs to the next unescaped `/`
 * outside a `[…]` class. Backticks are left as code: ES5 has no template
 * literals, so one that survives is itself a violation.
 *
 * This is a tokenizer for checking hand-written ES5, not a parser; the
 * source is also compiled with `node:vm` so a syntax error is caught
 * separately.
 * @param {string} src
 * @returns {{ code: string, withStrings: string }}
 */
function scanJs(src) {
  // UTF-16 units, so blanking keeps `code.join('')` exactly as long as `src`.
  const code = src.split('');
  const withStrings = src.split('');
  const n = code.length;
  /** The previous significant token, which decides what a `/` means. */
  let last = { kind: 'start', value: '', pair: '', end: 0 };
  let i = 0;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Comments: `//` and `/*` never begin a regular expression.
    if (ch === '/' && next === '/') {
      let end = i + 2;
      while (end < n && !LINE_TERMINATOR_RE.test(code[end])) end += 1;
      blank(code, i, end);
      blank(withStrings, i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      let end = i + 2;
      while (end < n && !(code[end] === '*' && code[end + 1] === '/')) end += 1;
      end = Math.min(end + 2, n);
      blank(code, i, end);
      blank(withStrings, i, end);
      i = end;
      continue;
    }

    // Strings: blank the contents, keep the quotes.
    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < n && code[end] !== ch && !LINE_TERMINATOR_RE.test(code[end])) {
        if (code[end] === '\\') {
          // An escape covers the next character; `\` + CRLF continues the line.
          end += code[end + 1] === '\r' && code[end + 2] === '\n' ? 3 : 2;
        } else {
          end += 1;
        }
      }
      end = Math.min(end, n);
      blank(code, i + 1, end);
      i = end < n && code[end] === ch ? end + 1 : end;
      last = { kind: 'literal', value: ch, pair: '', end: i };
      continue;
    }

    // Regular-expression literals: blank the body, keep the slashes and flags.
    if (ch === '/' && regexAllowedAfter(last)) {
      let end = i + 1;
      let inClass = false;
      while (end < n && !LINE_TERMINATOR_RE.test(code[end])) {
        const c = code[end];
        if (c === '\\') {
          end += 2;
          continue;
        }
        if (inClass) {
          if (c === ']') inClass = false;
        } else if (c === '[') {
          inClass = true;
        } else if (c === '/') {
          break;
        }
        end += 1;
      }
      end = Math.min(end, n);
      blank(code, i + 1, end);
      i = end < n && code[end] === '/' ? end + 1 : end;
      while (i < n && /[\w$]/.test(code[i])) i += 1;
      last = { kind: 'literal', value: '/', pair: '', end: i };
      continue;
    }

    // Names and keywords. A name after `.` is a property, never a keyword.
    if (/[A-Za-z_$\\\u0080-\uffff]/.test(ch)) {
      let end = i + 1;
      while (end < n && /[\w$\\\u0080-\uffff]/.test(code[end])) end += 1;
      const word = code.slice(i, end).join('');
      const isProperty = last.kind === 'punctuator' && last.value === '.';
      last = { kind: isProperty ? 'property' : 'word', value: word, pair: '', end };
      i = end;
      continue;
    }

    // Numbers, including `.5`, `1e3` and `0x1F`.
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next ?? ''))) {
      let end = i + 1;
      while (end < n && /[\w$.]/.test(code[end])) end += 1;
      last = { kind: 'literal', value: '0', pair: '', end };
      i = end;
      continue;
    }

    // Any other character is a one-character punctuator; backticks included.
    const pair = last.kind === 'punctuator' && last.end === i ? last.value + ch : '';
    last = { kind: 'punctuator', value: ch, pair, end: i + 1 };
    i += 1;
  }
  return { code: code.join(''), withStrings: withStrings.join('') };
}

/**
 * `line:column` (both 1-based) of an offset in `src`, and the trimmed text of
 * that source line, for failure messages.
 * @param {string} src
 * @param {number} offset
 * @returns {string}
 */
function locate(src, offset) {
  const before = src.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  const text = src.split('\n')[line - 1].trim();
  return `${line}:${column} ${JSON.stringify(text)}`;
}

/**
 * The first match of each pattern in scanned text, located in the original
 * source. Patterns are non-global, so `exec` always starts at offset 0.
 * @param {string} scanned Output of `scanJs`, the same length as `src`.
 * @param {readonly (readonly [string, RegExp])[]} patterns
 * @param {string} src
 * @returns {string[]} One line per pattern that matched; empty when none.
 */
function firstMatches(scanned, patterns, src) {
  const found = [];
  for (const [what, re] of patterns) {
    const match = re.exec(scanned);
    if (match !== null) found.push(`${what} at ${locate(src, match.index)}`);
  }
  return found;
}

/**
 * Whether the source runs in strict mode as a whole: either the script's own
 * directive prologue, or that of the IIFE it consists of, starts with
 * `"use strict"`. A `"use strict"` anywhere later is an ordinary string
 * expression, not a directive.
 * @param {string} withStrings `scanJs(src).withStrings`
 * @returns {boolean}
 */
function isStrictScript(withStrings) {
  const head = withStrings.trimStart();
  return (
    /^(['"])use strict\1/.test(head) ||
    /^;?\s*\(\s*function\b[^(]*\([^)]*\)\s*\{\s*(['"])use strict\1/.test(head)
  );
}

/* ------------------------------------------------------------------------ */
/* Home page navigation (index.html)                                         */
/* ------------------------------------------------------------------------ */

test('[AC-10][F-018] index.html header navigation lists the seven destinations in order, Blog included', () => {
  const nav = element(
    read('index.html'),
    (tag) => tag.name === 'nav' && hasClass(tag, 'nav-links') && tag.attrs['aria-label'] === 'Primary',
  );
  assert.ok(nav, 'index.html has no nav.nav-links[aria-label="Primary"]');
  assert.deepEqual(anchors(nav.inner), links(HOME_LABELS, HOME_HREFS));
});

test('[AC-10][F-018] index.html mobile menu is nav.mobile-menu#mobile-menu[aria-label="Primary"][hidden] with the same seven links', () => {
  const html = read('index.html');
  const withId = parseStartTags(html).filter((tag) => tag.attrs.id === 'mobile-menu');
  assert.equal(withId.length, 1, 'index.html must have exactly one element with id="mobile-menu"');
  const [menu] = withId;
  assert.equal(menu.name, 'nav', `#mobile-menu must be a <nav> landmark, found <${menu.name}>`);
  assert.ok(hasClass(menu, 'mobile-menu'), '#mobile-menu must carry class "mobile-menu"');
  assert.equal(menu.attrs['aria-label'], 'Primary', '#mobile-menu must be labelled "Primary"');
  assert.ok(Object.hasOwn(menu.attrs, 'hidden'), '#mobile-menu must start hidden');

  const { inner } = element(html, (tag) => tag.start === menu.start);
  assert.deepEqual(anchors(inner), links(HOME_LABELS, HOME_HREFS));
});

test('[AC-10][F-018] index.html footer navigation lists the five destinations in order, Blog included', () => {
  const nav = element(
    read('index.html'),
    (tag) => tag.name === 'nav' && hasClass(tag, 'footer-links') && tag.attrs['aria-label'] === 'Footer',
  );
  assert.ok(nav, 'index.html has no nav.footer-links[aria-label="Footer"]');
  assert.deepEqual(anchors(nav.inner), links(FOOT_LABELS, FOOT_HREFS));
});

test('[AC-10][F-018] index.html has no front matter and loads only ./main.js', () => {
  const html = read('index.html');
  // Jekyll copies a file byte-for-byte unless it starts with a `---` front
  // matter block, so the doctype as the very first bytes proves pass-through.
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'index.html must start with <!DOCTYPE html>');

  const scriptOpenings = html.match(/<script/gi) ?? [];
  assert.equal(scriptOpenings.length, 1, 'index.html must contain exactly one <script');
  const scripts = parseStartTags(html).filter((tag) => tag.name === 'script');
  assert.equal(scripts.length, 1, 'the one <script must be a parseable start tag');
  assert.equal(scripts[0].attrs.src, './main.js');
});

test('[AC-10][F-018] index.html keeps the hooks main.js drives', () => {
  const tags = parseStartTags(read('index.html'));
  const header = tags.find((tag) => tag.attrs.id === 'top');
  assert.ok(header && header.name === 'header' && hasClass(header, 'site-header'), 'header.site-header#top is missing');
  const toggle = tags.find((tag) => tag.name === 'button' && hasClass(tag, 'nav-toggle'));
  assert.ok(toggle, 'button.nav-toggle is missing');
  assert.equal(toggle.attrs['aria-controls'], 'mobile-menu');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  const year = tags.find((tag) => tag.attrs.id === 'year');
  assert.ok(year && year.name === 'span', 'span#year is missing');
  const form = tags.find((tag) => tag.attrs.id === 'contact-form');
  assert.ok(form && form.name === 'form', 'form#contact-form is missing');
});

/* ------------------------------------------------------------------------ */
/* Home page budgets                                                         */
/* ------------------------------------------------------------------------ */

test('[AC-10][F-018] home page makes exactly 5 first-party requests (PT-4)', (t) => {
  const { htmlUrls, cssUrls, files } = homeRequests();
  t.diagnostic(`index.html requests: ${htmlUrls.join(', ')}`);
  t.diagnostic(`stylesheet requests: ${cssUrls.join(', ')}`);
  assert.deepEqual(htmlUrls, [...HOME_HTML_RESOURCES]);
  assert.deepEqual(cssUrls, [...HOME_CSS_RESOURCES]);
  t.diagnostic(`PT-4 first-party requests: ${files.length} (document included)`);
  assert.equal(files.length, PT4_REQUESTS, `first-party requests: ${files.join(', ')}`);
});

test('[AC-10][F-018] home page first-party bytes stay within 237,954 (PT-1)', (t) => {
  const { files } = homeRequests();
  let total = 0;
  for (const file of files) {
    assert.ok(existsSync(abs(file)), `${file} is requested by the home page but does not exist`);
    const bytes = size(file);
    t.diagnostic(`${file}: ${bytes} bytes`);
    total += bytes;
  }
  t.diagnostic(`PT-1 first-party bytes: ${total} of ${PT1_MAX_BYTES}`);
  assert.ok(total <= PT1_MAX_BYTES, `PT-1: ${total} bytes exceeds ${PT1_MAX_BYTES}`);
});

test('[AC-10][F-018] main.js stays within 3,609 bytes (PT-2)', (t) => {
  const bytes = size('main.js');
  t.diagnostic(`PT-2 main.js: ${bytes} of ${PT2_MAX_BYTES} bytes`);
  assert.ok(bytes <= PT2_MAX_BYTES, `PT-2: main.js is ${bytes} bytes, limit ${PT2_MAX_BYTES}`);
});

/* ------------------------------------------------------------------------ */
/* Include parity (_includes/site-header.html, _includes/site-footer.html)  */
/* ------------------------------------------------------------------------ */

/** A Liquid output that passes a quoted site path through `relative_url`. */
const RELATIVE_URL_OUTPUT_RE = /^\{\{-?\s*(['"])[^'"]*\1\s*\|\s*relative_url\s*-?\}\}$/;

/**
 * Every `href` value written in an include's Liquid source, comments
 * excluded, that is not built with `relative_url`. Each must be, so blog
 * pages link correctly at an empty base path and under a project path.
 * @param {string} src Raw include source.
 * @returns {string[]}
 */
function hrefsWithoutRelativeUrl(src) {
  const text = src.replace(LIQUID_COMMENT_RE, '');
  return [...text.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => match[1] ?? match[2])
    .filter((value) => !RELATIVE_URL_OUTPUT_RE.test(value.trim()));
}

test('[AC-10][F-018] _includes/site-header.html copies the home page header and mobile menu', () => {
  const src = read('_includes/site-header.html');
  const html = liquidToStatic(src);
  const tags = parseStartTags(html);
  const expected = links(HOME_LABELS, HOME_HREFS.map(siteRootHref));

  const header = tags.find((tag) => tag.attrs.id === 'top');
  assert.ok(header && header.name === 'header' && hasClass(header, 'site-header'), 'header.site-header#top is missing');

  const brand = tags.find((tag) => tag.name === 'a' && hasClass(tag, 'brand'));
  assert.ok(brand, 'a.brand is missing');
  assert.equal(brand.attrs.href, '/', 'a.brand must link to the home page');

  const desktop = element(
    html,
    (tag) => tag.name === 'nav' && hasClass(tag, 'nav-links') && tag.attrs['aria-label'] === 'Primary',
  );
  assert.ok(desktop, 'nav.nav-links[aria-label="Primary"] is missing');
  assert.deepEqual(anchors(desktop.inner), expected, 'desktop navigation must match index.html');

  const toggle = tags.find((tag) => tag.name === 'button' && hasClass(tag, 'nav-toggle'));
  assert.ok(toggle, 'button.nav-toggle is missing');
  assert.equal(toggle.attrs['aria-controls'], 'mobile-menu');
  assert.equal(toggle.attrs['aria-expanded'], 'false');

  const menus = tags.filter((tag) => tag.attrs.id === 'mobile-menu');
  assert.equal(menus.length, 1, 'exactly one element must have id="mobile-menu"');
  const [menu] = menus;
  assert.equal(menu.name, 'nav', `#mobile-menu must be a <nav> landmark, found <${menu.name}>`);
  assert.ok(hasClass(menu, 'mobile-menu'), '#mobile-menu must carry class "mobile-menu"');
  assert.equal(menu.attrs['aria-label'], 'Primary', '#mobile-menu must be labelled "Primary"');
  assert.ok(Object.hasOwn(menu.attrs, 'hidden'), '#mobile-menu must start hidden');
  const mobile = element(html, (tag) => tag.start === menu.start);
  assert.deepEqual(anchors(mobile.inner), expected, 'mobile menu must match index.html');

  assert.deepEqual(hrefsWithoutRelativeUrl(src), [], 'every href must be built with relative_url');
});

test('[AC-10][F-018] _includes/site-footer.html copies the home page footer', () => {
  const src = read('_includes/site-footer.html');
  const html = liquidToStatic(src);

  const nav = element(
    html,
    (tag) => tag.name === 'nav' && hasClass(tag, 'footer-links') && tag.attrs['aria-label'] === 'Footer',
  );
  assert.ok(nav, 'nav.footer-links[aria-label="Footer"] is missing');
  assert.deepEqual(anchors(nav.inner), links(FOOT_LABELS, FOOT_HREFS.map(siteRootHref)));

  const year = parseStartTags(html).find((tag) => tag.attrs.id === 'year');
  assert.ok(year, 'the footer has no element with id="year"');
  assert.equal(year.name, 'span', `#year must be a <span>, found <${year.name}>`);

  assert.deepEqual(hrefsWithoutRelativeUrl(src), [], 'every href must be built with relative_url');
});

/* ------------------------------------------------------------------------ */
/* Blog asset budgets and search.js conformance                              */
/* ------------------------------------------------------------------------ */

test('[AC-10][F-019] blog/search.js stays within 5,000 bytes', (t) => {
  const bytes = size('blog/search.js');
  t.diagnostic(`blog/search.js: ${bytes} of ${SEARCH_JS_MAX_BYTES} bytes`);
  assert.ok(bytes <= SEARCH_JS_MAX_BYTES, `blog/search.js is ${bytes} bytes, limit ${SEARCH_JS_MAX_BYTES}`);
});

test('[AC-10][F-018] blog/blog.css stays within 8,000 bytes', (t) => {
  const bytes = size('blog/blog.css');
  t.diagnostic(`blog/blog.css: ${bytes} of ${BLOG_CSS_MAX_BYTES} bytes`);
  assert.ok(bytes <= BLOG_CSS_MAX_BYTES, `blog/blog.css is ${bytes} bytes, limit ${BLOG_CSS_MAX_BYTES}`);
});

test('[AC-10][F-019] blog/search.js is ES5 strict-mode syntax', () => {
  const src = read('blog/search.js');
  assert.doesNotThrow(
    () => new vm.Script(src, { filename: 'blog/search.js' }),
    'blog/search.js must compile as a classic script',
  );
  const { code, withStrings } = scanJs(src);
  assert.ok(/(['"])use strict\1/.test(withStrings), 'blog/search.js must contain a "use strict" directive');
  assert.ok(isStrictScript(withStrings), '"use strict" must open the script or the body of its IIFE');
  assert.deepEqual(firstMatches(code, ES5_FORBIDDEN, src), [], 'blog/search.js must use ES5 syntax only');
});

test('[AC-10][F-019] blog/search.js uses no HTML-writing or code-evaluating sinks', () => {
  const src = read('blog/search.js');
  assert.deepEqual(
    firstMatches(scanJs(src).withStrings, UNSAFE_SINKS, src),
    [],
    'blog/search.js must write text only (textContent) and evaluate no strings',
  );
});

test('[AC-10][F-019] the ES5 scanner sees through comments, strings and regular-expression literals', () => {
  /** Names of the ES5 rules a snippet breaks, as the search.js check reads it. */
  const es5 = (src) => ES5_FORBIDDEN.filter(([, re]) => re.test(scanJs(src).code)).map(([what]) => what);
  /** Names of the sinks a snippet uses, as the search.js check reads it. */
  const sinks = (src) => UNSAFE_SINKS.filter(([, re]) => re.test(scanJs(src).withStrings)).map(([what]) => what);

  // Comment markers inside strings do not hide the code after them.
  assert.deepEqual(es5('var s = "// not a comment"; const x = 1;'), ['`const` declaration']);
  assert.deepEqual(es5("var s = '/* not a comment */'; let y = 2;"), ['`let` declaration']);
  // Comments and string contents are not code, escaped quotes included.
  assert.deepEqual(es5('// const a = 1;\n/* let b = 2; => */\nvar c = 3;'), []);
  assert.deepEqual(es5('var s = "const \\" let"; var t = \'a\\\'b => c\';'), []);
  // Regular-expression bodies are not code, and a quote inside one opens no string.
  assert.deepEqual(es5('var r = /=>|`|const/g; var m = x.match(/\'/);'), []);
  assert.deepEqual(es5('function f(x) { return /"/.test(x); }\nconst z = 1;'), ['`const` declaration']);
  assert.deepEqual(es5('var r = /[/]let/; var ok = 1;'), []);
  // Division is not a regular expression, so the code between two slashes is read.
  assert.deepEqual(es5('var q = a / 2; const z = 1; var w = b / 3;'), ['`const` declaration']);
  assert.deepEqual(es5('var i = 0; i++ / 2; let k;'), ['`let` declaration']);
  // Each rule fires on its own syntax.
  assert.deepEqual(es5('var t = `hi`;'), ['template literal']);
  assert.deepEqual(es5('var f = function (a) { return a; }; var g = (a) => a;'), ['arrow function']);
  assert.deepEqual(es5('for (var k of list) {}'), ['`for…of` loop']);
  assert.deepEqual(es5('var copy = [].concat(items); f(...args);'), ['spread or rest `...`']);
  assert.deepEqual(es5('async function f() { await g(); }'), ['`async`', '`await`']);
  assert.deepEqual(es5('class A {}'), ['`class`']);
  assert.deepEqual(es5('for (var k in o) { if (typeof o[k] === "number") n += o[k] / 2; }'), []);

  // Sinks are found in code and in strings, never in comments.
  assert.deepEqual(sinks('el.innerHTML = s;'), ['innerHTML']);
  assert.deepEqual(sinks('el["innerHTML"] = s;'), ['innerHTML']);
  assert.deepEqual(sinks('// el.innerHTML = s;\nel.textContent = s;'), []);
  assert.deepEqual(sinks('document.write(s); eval(s); new Function(s);'), ['document.write', 'eval', 'new Function']);

  // Blanking keeps every offset, so reported positions name the source line.
  const src = 'var a = "x";\n/* c */ const b = 1;';
  assert.equal(scanJs(src).code.length, src.length);
  assert.deepEqual(firstMatches(scanJs(src).code, ES5_FORBIDDEN, src), [
    '`const` declaration at 2:9 "/* c */ const b = 1;"',
  ]);
  assert.ok(isStrictScript(scanJs('/* x */\n(function (w) {\n  "use strict";\n})(window);').withStrings));
  assert.ok(!isStrictScript(scanJs('(function () { var a = 1; "use strict"; })();').withStrings));
});
