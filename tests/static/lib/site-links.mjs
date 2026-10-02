/* Cabrillo Coast LLC — built-site HTML parsing and link checking (Node built-ins only) */
/**
 * Shared helper for the built-output tests (AC-07). It is not a test file: its
 * name does not match `*.test.mjs`, so `node --test "tests/**\/*.test.mjs"`
 * only reaches it through the suites that import it:
 *   - `tests/static/built-pages.test.mjs`        all five exports
 *   - `tests/static/built-search-index.test.mjs` `parseStartTags`, `decodeEntities`
 *   - `tests/static/site-chrome.test.mjs`        `parseStartTags`, `decodeEntities`
 *   - `tests/unit/site-links.test.mjs`           all five exports
 *
 * Everything is synchronous, so consumers can call it at module top level or
 * inside `test()`. Importing the module has no side effects and nothing here
 * writes to the console; findings are returned for the caller to assert on.
 *
 * Input: the site's own pages, written by hand (`index.html`) or emitted by
 * Jekyll. Layout and Liquid output is quoted and escaped, but an article body
 * is trusted author HTML that kramdown passes through unescaped, so a page
 * can hold any markup a browser accepts: boolean and unquoted attributes,
 * attributes with no space between them, `/` between attributes, malformed
 * comments and raw-text elements. Escaped markup (`&lt;a href="/nope"&gt;`
 * in a code sample) holds no `<`, and Rouge splits highlighted `src=` text
 * across `<span>` elements, so neither is ever read as a tag or an attribute.
 *
 * `tokenizeHtml` reads that input with the tag, comment and bogus-comment
 * states of the WHATWG HTML tokenizer, so every tag, attribute and comment
 * boundary falls where a browser puts it, and offsets point into the
 * original text. It only moves forward: each state reads one run with a
 * sticky regular expression or searches ahead once, so its work stays linear
 * in the input however malformed that is. It does not model tree
 * construction (implied end tags, misnested elements, foreign content such
 * as SVG and MathML) or the escaped states of script data, and it enters the
 * raw-text states only when asked (`rawText`). `parseStartTags` reads
 * without them, so `<script>` and `<style>` contents are scanned like any
 * other text: blog pages carry no inline scripts under their
 * Content-Security-Policy, and the home page's only script is external.
 *
 * Why no HTML library: the repository adds no runtime or test dependencies
 * beyond Playwright, and these checks need only token boundaries, not a
 * document tree.
 *
 * Link-checking model (`checkSiteLinks`): every `href`, `src` and
 * `data-index` value on every built HTML page is resolved the way a browser
 * would resolve it on the page's own URL, then mapped back to a file under
 * the site directory, so the same check covers the custom-domain build
 * (empty base path) and the project-path build (`/cabrillo-coast`).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} StartTag
 * @property {string} name   Tag name, ASCII-lowercased (`a`, `nav`, `use`).
 * @property {Record<string, string>} attrs
 *   Attributes keyed by ASCII-lowercased name; values entity-decoded, `""` for a
 *   boolean attribute, first occurrence of a duplicate name wins.
 * @property {number} start  Offset of the tag's `<` in the original HTML.
 * @property {number} end    Exclusive end offset (`start + length`).
 * @property {string} source The tag's original text, `html.slice(start, end)`.
 */

/**
 * @typedef {object} HtmlToken
 * @property {'start-tag' | 'end-tag' | 'comment' | 'bogus-comment' | 'raw-text'} type
 * @property {string} [name] Tags and raw text: the element name,
 *   ASCII-lowercased, NUL replaced by U+FFFD.
 * @property {{ name: string, value: string | null }[]} [attrs] Tags only:
 *   every attribute in source order, duplicates included. Names are
 *   ASCII-lowercased; values are raw (not entity-decoded) and `null` for a
 *   boolean attribute; NUL is replaced by U+FFFD in both.
 * @property {number} start Offset of the token's first character.
 * @property {number} end   Exclusive end offset.
 * @property {boolean} terminated `false` when the input ends inside the token.
 */

/**
 * @typedef {object} HtmlPage
 * @property {string} file    Absolute path of the page.
 * @property {string} rel     POSIX path relative to the site directory.
 * @property {string} urlPath URL path a browser requests for the page: the
 *                            percent-encoded base path, then `rel` with each
 *                            segment percent-encoded (`blog/index.html` →
 *                            `<base>/blog/`, `notes#v1.html` →
 *                            `<base>/notes%23v1.html`).
 */

/**
 * @typedef {object} LinkFinding
 * @property {string} page      `rel` of the page holding the reference.
 * @property {'href' | 'src' | 'data-index'} attribute
 * @property {string} value     Decoded attribute value as parsed (untrimmed).
 * @property {'missing file' | 'missing fragment' | 'outside base path'} reason
 */

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The character references decoded by `decodeEntities`. One alternation, used
 * in a single pass, so `&amp;lt;` becomes `&lt;` and never `<`. The trailing
 * `;` is required, which leaves the raw `&family=` in the home page's Google
 * Fonts URL untouched.
 */
const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|quot|lt|gt|apos|nbsp));/g;

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: '\u00a0',
});

/**
 * The runs `tokenizeHtml` reads, one per tokenizer state. Each is sticky
 * (`y`): it matches at the offset it is given or not at all, and a `*` run
 * always matches, so every state reads its characters exactly once.
 * Whitespace is the tokenizer's: tab, LF, FF, CR and space.
 */
const WHITESPACE_RUN_RE = /[\t\n\f\r ]*/y;
const TAG_NAME_RUN_RE = /[^\t\n\f\r />]*/y;
const ATTRIBUTE_NAME_RUN_RE = /[^\t\n\f\r />=]*/y;
const DOUBLE_QUOTED_RUN_RE = /[^"]*/y;
const SINGLE_QUOTED_RUN_RE = /[^']*/y;
const UNQUOTED_RUN_RE = /[^\t\n\f\r >]*/y;

/** The end of a comment: `-->`, or `--!>`, which the tokenizer accepts too. */
const COMMENT_END_RE = /--!?>/g;

/**
 * Elements whose content the tokenizer reads as raw text once their start
 * tag is emitted: RCDATA (`textarea`, `title`), RAWTEXT (`style`, `xmp`,
 * `iframe`, `noembed`, `noframes`, and `noscript` as a browser with
 * scripting enabled reads it) and script data. Each maps to the search for
 * its closer, the first `</name` in any ASCII case followed by whitespace,
 * `/` or `>`.
 */
const RAW_TEXT_CLOSERS = new Map(
  ['textarea', 'title', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'script'].map((name) => [
    name,
    new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi'),
  ]),
);

/** The element whose content is raw text to the end of the input. */
const PLAINTEXT = 'plaintext';

/** Attributes whose values `checkSiteLinks` resolves. */
const CHECKED_ATTRIBUTES = new Set(['href', 'src', 'data-index']);

/** A URL scheme prefix such as `https:`, `mailto:` or `data:`. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/** Protocol-relative prefix, including the backslash forms URL parsers accept. */
const PROTOCOL_RELATIVE_RE = /^[\\/]{2}/;

/** Placeholder origin that site-relative references are resolved against. */
const RESOLVE_ORIGIN = 'http://site.invalid';
const RESOLVE_HOST = 'site.invalid';

/** Base used only to read the host of an absolute or protocol-relative URL. */
const ABSOLUTE_BASE = 'https://x.invalid';

const REASON_MISSING_FILE = 'missing file';
const REASON_MISSING_FRAGMENT = 'missing fragment';
const REASON_OUTSIDE_BASE = 'outside base path';

const INDEX_FILE = 'index.html';

/* ------------------------------------------------------------------------ */
/* Private helpers                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Normalises a Jekyll base path: trailing slashes removed (so `/` becomes
 * `""`) and exactly one leading slash on a non-empty value. Collapsing
 * repeated leading slashes keeps `//x` from reading as a protocol-relative
 * host. Anything that is not a string is treated as the empty base path.
 * @param {unknown} baseurl
 * @returns {string}
 */
function normalizeBase(baseurl) {
  if (typeof baseurl !== 'string') return '';
  const trimmed = baseurl.trim();
  // Index scans rather than slash-run expressions: an unanchored /\/+$/
  // retries every suffix of a long run of slashes that a non-slash ends.
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '/') end -= 1;
  let start = 0;
  while (start < end && trimmed[start] === '/') start += 1;
  return start === end ? '' : `/${trimmed.slice(start, end)}`;
}

/**
 * A normalised base path in the encoding of a parsed URL's pathname, which
 * is the form a resolved reference's pathname takes: the pathname setter
 * percent-encodes `?`, `#`, spaces and the other characters a URL path
 * cannot hold literally. The empty base path stays `""`.
 * @param {string} base Output of `normalizeBase`.
 * @returns {string}
 */
function encodeBase(base) {
  if (base === '') return '';
  const url = new URL(RESOLVE_ORIGIN);
  url.pathname = `${base}/`;
  return url.pathname.slice(0, -1);
}

/**
 * Resolves the site directory argument to an absolute path. A `file:` URL is
 * accepted so callers can pass `new URL('../../_site', import.meta.url)`.
 * @param {unknown} siteDir
 * @param {string} caller Function name used in the error message.
 * @returns {string}
 */
function resolveSiteDir(siteDir, caller) {
  if (siteDir instanceof URL) return path.resolve(fileURLToPath(siteDir));
  if (typeof siteDir !== 'string' || siteDir === '') {
    throw new TypeError(`${caller}: siteDir must be a non-empty path string or file: URL`);
  }
  return path.resolve(siteDir);
}

/**
 * Host (with any non-default port) of the deployment URL, or `null` when the
 * value is absent or cannot be parsed as an absolute URL with a host.
 * @param {unknown} siteUrl
 * @returns {string | null}
 */
function siteHostOf(siteUrl) {
  if (siteUrl === undefined || siteUrl === null) return null;
  const text = String(siteUrl).trim();
  if (text === '') return null;
  try {
    const { host } = new URL(text);
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * `statSync` that returns `null` instead of throwing for a missing entry, a
 * path through a regular file (`ENOTDIR`) or an invalid path (a NUL byte).
 * @param {string} file
 * @returns {import('node:fs').Stats | null}
 */
function statOrNull(file) {
  try {
    return statSync(file, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * `realpathSync` that returns `null` instead of throwing for a missing entry,
 * a dangling or looping symbolic link, a path through a regular file or an
 * invalid path (a NUL byte).
 * @param {string} file
 * @returns {string | null}
 */
function realpathOrNull(file) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The attributes of one start-tag token as a record: values entity-decoded,
 * `""` for a boolean attribute, the first of duplicate names kept.
 *
 * The result is an ordinary object rather than `Object.create(null)` so that
 * consumers can compare it with object literals under `node:assert/strict`,
 * which also compares prototypes. Keys are defined as own data properties, so
 * an attribute named `__proto__` or `constructor` is stored like any other,
 * and the duplicate check looks at own keys only.
 * @param {{ name: string, value: string | null }[]} list `HtmlToken.attrs`
 * @returns {Record<string, string>}
 */
function attributeRecord(list) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const { name, value } of list) {
    if (Object.hasOwn(attrs, name)) continue;
    Object.defineProperty(attrs, name, {
      value: value === null ? '' : decodeEntities(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return attrs;
}

/**
 * End offset of the run `re` (a sticky `*` expression) reads from `from`.
 * @param {RegExp} re
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function runEnd(re, text, from) {
  re.lastIndex = from;
  re.test(text);
  return re.lastIndex;
}

/**
 * A tag or attribute name as the tokenizer stores it: ASCII letters
 * lowercased (never other characters, as `toLowerCase` would) and NUL
 * replaced by U+FFFD.
 * @param {string} raw
 * @returns {string}
 */
function tokenName(raw) {
  return raw.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()).replaceAll('\0', '\uFFFD');
}

/**
 * Reads one start or end tag through the tag-name, attribute and
 * self-closing states of the WHATWG tokenizer.
 *   - The name runs to whitespace, `/` or `>`, so `<` is part of it.
 *   - A `/` not followed by `>` is skipped, so `<script/src=…>` has a `src`.
 *   - An attribute name runs to whitespace, `/`, `>` or `=`. It may hold
 *     `<`, `"` and `'`, and a leading `=` is part of it.
 *   - A quoted value runs to its closing quote. Any character after it other
 *     than whitespace, `/` or `>` starts a new attribute, so `"x"onerror=`
 *     is two attributes. An unquoted value runs to whitespace or `>`.
 * @param {string} text
 * @param {'start-tag' | 'end-tag'} type
 * @param {number} start Offset of the `<`.
 * @param {number} nameStart Offset of the name's first letter.
 * @returns {HtmlToken}
 */
function readTag(text, type, start, nameStart) {
  const { length } = text;
  /** @type {{ name: string, value: string | null }[]} */
  const attrs = [];
  let i = runEnd(TAG_NAME_RUN_RE, text, nameStart);
  const name = tokenName(text.slice(nameStart, i));
  const token = (end, terminated) => ({ type, name, attrs, start, end, terminated });

  for (;;) {
    // Before attribute name.
    i = runEnd(WHITESPACE_RUN_RE, text, i);
    if (i >= length) return token(length, false);
    if (text[i] === '>') return token(i + 1, true);
    if (text[i] === '/') {
      // Self-closing start tag: anything but `>` is read again as above.
      i += 1;
      if (i >= length) return token(length, false);
      if (text[i] === '>') return token(i + 1, true);
      continue;
    }

    const attrStart = i;
    i = runEnd(ATTRIBUTE_NAME_RUN_RE, text, text[i] === '=' ? i + 1 : i);
    const attrName = tokenName(text.slice(attrStart, i));

    // After attribute name: without `=`, the attribute is boolean and
    // whatever follows is read again as above.
    i = runEnd(WHITESPACE_RUN_RE, text, i);
    if (i >= length || text[i] !== '=') {
      attrs.push({ name: attrName, value: null });
      continue;
    }

    // Before attribute value.
    i = runEnd(WHITESPACE_RUN_RE, text, i + 1);
    if (i >= length) {
      attrs.push({ name: attrName, value: '' });
      return token(length, false);
    }
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const valueEnd = runEnd(quote === '"' ? DOUBLE_QUOTED_RUN_RE : SINGLE_QUOTED_RUN_RE, text, i + 1);
      attrs.push({ name: attrName, value: text.slice(i + 1, valueEnd).replaceAll('\0', '\uFFFD') });
      if (valueEnd >= length) return token(length, false);
      i = valueEnd + 1;
    } else {
      // Unquoted; an immediate `>` leaves the value empty and ends the tag.
      const valueEnd = runEnd(UNQUOTED_RUN_RE, text, i);
      attrs.push({ name: attrName, value: text.slice(i, valueEnd).replaceAll('\0', '\uFFFD') });
      i = valueEnd;
    }
  }
}

/**
 * Reads the raw text after the start tag of `name`, up to its closer or, with
 * none (and always for `plaintext`), to the end of the input.
 * @param {string} text
 * @param {string} name A key of `RAW_TEXT_CLOSERS`, or `plaintext`.
 * @param {number} from Offset just after the start tag.
 * @returns {HtmlToken}
 */
function readRawText(text, name, from) {
  const closer = RAW_TEXT_CLOSERS.get(name);
  let match = null;
  if (closer !== undefined) {
    closer.lastIndex = from;
    match = closer.exec(text);
  }
  return match === null
    ? { type: 'raw-text', name, start: from, end: text.length, terminated: false }
    : { type: 'raw-text', name, start: from, end: match.index, terminated: true };
}

/**
 * The set of `id` values declared anywhere in a page.
 * @param {StartTag[]} tags
 * @returns {Set<string>}
 */
function collectIds(tags) {
  const ids = new Set();
  for (const tag of tags) {
    if (Object.hasOwn(tag.attrs, 'id')) ids.add(tag.attrs.id);
  }
  return ids;
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Decodes the character references kramdown, Liquid `escape` and the home
 * page emit: `&amp;`, `&quot;`, `&lt;`, `&gt;`, `&apos;`, `&nbsp;` and
 * decimal or hexadecimal numeric references. One pass, so `&amp;lt;` becomes
 * `&lt;`. A reference must end in `;`; other named references stay literal.
 * For string input it never throws: a numeric reference to 0, a surrogate or
 * a value above U+10FFFF is left as written. Any other input is coerced with
 * `String()` (`null` and `undefined` become `""`), and that coercion throws
 * for a value with no string conversion, such as `Object.create(null)`.
 *
 * @example
 * decodeEntities('&amp;lt; R&amp;D &#39;x&#x27; &copy; &family=');
 * // → "&lt; R&D 'x' &copy; &family="
 * @param {unknown} text
 * @returns {string}
 */
export function decodeEntities(text) {
  const input = typeof text === 'string' ? text : String(text ?? '');
  return input.replace(ENTITY_RE, (reference, decimal, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name];
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
    if (
      !Number.isSafeInteger(codePoint) ||
      codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return reference;
    }
    return String.fromCodePoint(codePoint);
  });
}

/**
 * Splits HTML into the tokens a browser's tokenizer reads, in document
 * order. Text is not emitted: it is the gaps between tokens, except that
 * `</>`, which a browser drops, is consumed without a token.
 *   - `<` plus an ASCII letter opens a start tag, `</` plus one an end tag;
 *     both are read like a browser reads them (`readTag`), attributes and
 *     quotes included.
 *   - A comment (`<!--`) ends at `-->` or `--!>`, at once for `<!-->` and
 *     `<!--->`, or at the end of the input.
 *   - `<!` followed by anything else (`<!DOCTYPE`, `<![CDATA[`), `<?`, and
 *     `</` followed by a character other than a letter or `>` are each a
 *     bogus comment, ending at the first `>`.
 *   - Any other `<`, and `</` at the end of the input, is text.
 *   - A token the input ends inside has `terminated: false`.
 * With `rawText`, the content after a `textarea`, `title`, `style`, `xmp`,
 * `iframe`, `noembed`, `noframes`, `noscript` or `script` start tag (a
 * self-closing `/>` included) is one `raw-text` token, ending at the first
 * `</name` in any ASCII case followed by whitespace, `/` or `>`, or
 * unterminated at the end of the input; that end tag is then read as usual.
 * `plaintext` content always runs to the end, unterminated. A script whose
 * content holds `<!--` can end later in a browser (its escaped states), and
 * inside SVG or MathML these elements are not raw text at all.
 *
 * Linear in the input: no character is read twice, whatever is left open.
 * A non-string is coerced with `String()` (`null` and `undefined` become
 * `""`), which throws for a value with no string conversion.
 *
 * @example
 * tokenizeHtml('<p class=x>a</p><!-- b --><textarea><b></textarea>', { rawText: true }).map((t) => t.type);
 * // → ['start-tag', 'end-tag', 'comment', 'start-tag', 'raw-text', 'end-tag']
 * @param {unknown} html
 * @param {{ rawText?: boolean }} [options]
 * @returns {HtmlToken[]}
 */
export function tokenizeHtml(html, { rawText = false } = {}) {
  const text = typeof html === 'string' ? html : String(html ?? '');
  const { length } = text;
  /** @type {HtmlToken[]} */
  const tokens = [];
  /** A bogus comment from `start` to the first `>` at or after `from`. */
  const bogus = (start, from) => {
    const close = text.indexOf('>', from);
    return close === -1
      ? { type: 'bogus-comment', start, end: length, terminated: false }
      : { type: 'bogus-comment', start, end: close + 1, terminated: true };
  };
  const isLetter = (offset) => /[A-Za-z]/.test(text[offset] ?? '');

  let i = 0;
  while (i < length) {
    const open = text.indexOf('<', i);
    if (open === -1) break;
    const next = text[open + 1];
    /** @type {HtmlToken | null} */
    let token = null;
    if (isLetter(open + 1)) {
      token = readTag(text, 'start-tag', open, open + 1);
    } else if (next === '!') {
      if (text.startsWith('--', open + 2)) {
        let end;
        if (text[open + 4] === '>') end = open + 5;
        else if (text.startsWith('->', open + 4)) end = open + 6;
        else {
          COMMENT_END_RE.lastIndex = open + 4;
          const close = COMMENT_END_RE.exec(text);
          end = close === null ? -1 : close.index + close[0].length;
        }
        token = end === -1
          ? { type: 'comment', start: open, end: length, terminated: false }
          : { type: 'comment', start: open, end, terminated: true };
      } else {
        token = bogus(open, open + 2);
      }
    } else if (next === '?') {
      token = bogus(open, open + 2);
    } else if (next === '/') {
      if (isLetter(open + 2)) token = readTag(text, 'end-tag', open, open + 2);
      else if (text[open + 2] === '>') {
        i = open + 3;
        continue;
      } else if (open + 2 >= length) break;
      else token = bogus(open, open + 2);
    }
    if (token === null) {
      i = open + 1;
      continue;
    }
    tokens.push(token);
    i = token.end;
    if (rawText && token.type === 'start-tag' && token.terminated) {
      if (token.name === PLAINTEXT || RAW_TEXT_CLOSERS.has(token.name)) {
        const content = readRawText(text, token.name, i);
        tokens.push(content);
        i = content.end;
      }
    }
  }
  return tokens;
}

/**
 * Lists every start tag of an HTML document in document order, read by
 * `tokenizeHtml` without raw text: a tag inside a comment, a bogus comment
 * or an end tag's attribute value is not returned, `<!--` inside a quoted
 * value is text, and a tag the input ends inside is dropped, as a browser
 * drops it. Offsets and `source` refer to the original string.
 *
 * @example
 * const [nav] = parseStartTags('<nav class="mobile-menu" id="mobile-menu" aria-label="Primary" hidden>');
 * // nav.name === 'nav', nav.attrs.hidden === '', nav.attrs['aria-label'] === 'Primary'
 * @param {unknown} html
 * @returns {StartTag[]}
 */
export function parseStartTags(html) {
  const original = typeof html === 'string' ? html : String(html ?? '');
  /** @type {StartTag[]} */
  const tags = [];
  for (const token of tokenizeHtml(original)) {
    if (token.type !== 'start-tag' || !token.terminated) continue;
    tags.push({
      name: token.name,
      attrs: attributeRecord(token.attrs),
      start: token.start,
      end: token.end,
      source: original.slice(token.start, token.end),
    });
  }
  return tags;
}

/**
 * Lists every `.html` file under a built site, sorted by `rel` so reports are
 * deterministic. Symbolic links are not followed. A missing `siteDir` throws
 * the file-system error; callers check it exists first.
 *
 * @example
 * listHtmlPages('_site', '/cabrillo-coast');
 * // [{ file: '/…/_site/blog/index.html', rel: 'blog/index.html', urlPath: '/cabrillo-coast/blog/' }, …]
 * @param {string | URL} siteDir Directory holding the built site.
 * @param {string} [baseurl=''] Base path the site is served under.
 * @returns {HtmlPage[]}
 */
export function listHtmlPages(siteDir, baseurl = '') {
  const root = resolveSiteDir(siteDir, 'listHtmlPages');
  const base = encodeBase(normalizeBase(baseurl));
  /** @type {HtmlPage[]} */
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        // Every segment is percent-encoded, so a `#`, `?`, `%` or space in a
        // name stays part of the path when references are resolved on it.
        const encoded = rel
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/');
        let urlPath;
        if (rel === INDEX_FILE) {
          urlPath = `${base}/`;
        } else if (rel.endsWith(`/${INDEX_FILE}`)) {
          urlPath = `${base}/${encoded.slice(0, -INDEX_FILE.length)}`;
        } else {
          urlPath = `${base}/${encoded}`;
        }
        pages.push({ file, rel, urlPath });
      }
    }
  };
  walk(root);
  pages.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return pages;
}

/**
 * Checks every `href`, `src` and `data-index` value on every built HTML page.
 *
 * - Skipped: empty values, a bare `#`, non-HTTP schemes (`mailto:`, `tel:`,
 *   `data:`, `javascript:`), and absolute or protocol-relative URLs on any
 *   host other than the `siteUrl` host (all absolute URLs when `siteUrl` is
 *   absent or unparsable).
 * - Checked: fragment-only, root-relative and page-relative values, resolved
 *   on the page's own URL, plus absolute URLs on the `siteUrl` host under
 *   either scheme. The query string is ignored (`/blog/?q=tag` checks
 *   `/blog/`).
 * - Each resolved path must lie under the base path, name an existing file
 *   (a path ending in `/` names its `index.html`; a directory holding
 *   `index.html` is accepted) that is still inside the site directory once
 *   every symbolic link is resolved, and any fragment on an HTML target must
 *   equal an `id` in that page. A symbolic link inside the site to a file or
 *   directory outside it is `missing file`, so it never lends its ids.
 *
 * Findings are returned in page order, then document order; an empty array
 * means every reference resolves. A malformed reference is reported as
 * `missing file` rather than thrown. A missing `siteDir` throws the
 * file-system error (`ENOENT`); an empty or non-path `siteDir` throws a
 * `TypeError`.
 *
 * @example
 * checkSiteLinks({ siteDir: '_site', baseurl: '', siteUrl: 'https://www.cabrillocoast.com' });
 * // [] or [{ page: 'blog/x/index.html', attribute: 'href', value: '../gone/', reason: 'missing file' }]
 * @param {object} options
 * @param {string | URL} options.siteDir Directory holding the built site.
 * @param {string} [options.baseurl=''] Base path the site is served under.
 * @param {string} [options.siteUrl] Deployment URL; its host marks absolute
 *   links that belong to this site.
 * @returns {LinkFinding[]}
 */
export function checkSiteLinks({ siteDir, baseurl = '', siteUrl } = {}) {
  // Canonical, so containment compares canonical paths and the ids cached
  // per listed page share their keys with canonical targets.
  const root = realpathSync(resolveSiteDir(siteDir, 'checkSiteLinks'));
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  const base = normalizeBase(baseurl);
  // The resolved pathname is percent-encoded, so compare it with the base
  // path in the same encoding.
  const encodedBase = encodeBase(base);
  const siteHost = siteHostOf(siteUrl);

  // First pass: parse every page once, keeping its references and its ids.
  /** @type {Map<string, Set<string>>} */
  const idCache = new Map();
  const parsed = listHtmlPages(root, base).map((page) => {
    const tags = parseStartTags(readFileSync(page.file, 'utf8'));
    idCache.set(page.file, collectIds(tags));
    const references = [];
    for (const tag of tags) {
      for (const [attribute, value] of Object.entries(tag.attrs)) {
        if (CHECKED_ATTRIBUTES.has(attribute)) references.push({ attribute, value });
      }
    }
    return { page, references };
  });

  /**
   * Ids of a target page, by canonical path. A target the walk did not list
   * (an in-site symbolic link named `.html` whose file is not) is parsed
   * once and cached.
   * @param {string} file
   * @returns {Set<string>}
   */
  const idsOf = (file) => {
    let ids = idCache.get(file);
    if (ids === undefined) {
      try {
        ids = collectIds(parseStartTags(readFileSync(file, 'utf8')));
      } catch {
        ids = new Set();
      }
      idCache.set(file, ids);
    }
    return ids;
  };

  /**
   * `file` with every symbolic link resolved, or `null` when it does not
   * resolve or its canonical path lies outside the site directory. The
   * lexical check alone would let an in-site link to an outside file pass.
   * @param {string} file
   * @returns {string | null}
   */
  const canonicalInside = (file) => {
    const canonical = realpathOrNull(file);
    if (canonical === null) return null;
    return canonical === root || canonical.startsWith(rootPrefix) ? canonical : null;
  };

  /**
   * Resolves one reference. Returns the reason it fails, or `null` when it
   * resolves or is not checked.
   * @param {string} value
   * @param {HtmlPage} page
   * @returns {LinkFinding['reason'] | null}
   */
  const checkReference = (value, page) => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '#') return null;

    const scheme = SCHEME_RE.exec(trimmed);
    const schemeName = scheme === null ? null : scheme[1].toLowerCase();
    if (schemeName !== null && schemeName !== 'http' && schemeName !== 'https') return null;
    const absolute = schemeName !== null || PROTOCOL_RELATIVE_RE.test(trimmed);
    if (absolute && siteHost === null) return null;

    let url;
    try {
      url = absolute ? new URL(trimmed, ABSOLUTE_BASE) : new URL(trimmed, RESOLVE_ORIGIN + page.urlPath);
    } catch {
      return REASON_MISSING_FILE;
    }
    // A relative-looking value can still name another host once the URL
    // parser drops tabs and newlines (`/\t/host`), so the host decides.
    const onSite = absolute ? url.host === siteHost : url.host === RESOLVE_HOST || url.host === siteHost;
    if (!onSite) return null;

    const { pathname, hash } = url;
    if (encodedBase !== '' && pathname !== encodedBase && !pathname.startsWith(`${encodedBase}/`)) {
      return REASON_OUTSIDE_BASE;
    }

    let remainder;
    try {
      remainder = decodeURIComponent(pathname.slice(encodedBase.length));
    } catch {
      return REASON_MISSING_FILE;
    }
    if (remainder === '' || remainder.endsWith('/')) remainder += INDEX_FILE;

    // `served` is the name the URL asks for, a directory mapped to its
    // `index.html`; it decides whether the fragment is checked. `target` is
    // the file actually read, every symbolic link resolved.
    let served = path.join(root, remainder);
    if (served !== root && !served.startsWith(rootPrefix)) return REASON_MISSING_FILE;
    let target = canonicalInside(served);
    if (target === null) return REASON_MISSING_FILE;
    const stats = statOrNull(target);
    if (stats === null) return REASON_MISSING_FILE;
    if (stats.isDirectory()) {
      served = path.join(served, INDEX_FILE);
      target = canonicalInside(path.join(target, INDEX_FILE));
      if (target === null) return REASON_MISSING_FILE;
      const indexStats = statOrNull(target);
      if (indexStats === null || !indexStats.isFile()) return REASON_MISSING_FILE;
    } else if (!stats.isFile()) {
      return REASON_MISSING_FILE;
    }

    if (hash !== '' && served.endsWith('.html')) {
      let fragment;
      try {
        fragment = decodeURIComponent(hash.slice(1));
      } catch {
        return REASON_MISSING_FILE;
      }
      if (!idsOf(target).has(fragment)) return REASON_MISSING_FRAGMENT;
    }
    return null;
  };

  /** @type {LinkFinding[]} */
  const findings = [];
  for (const { page, references } of parsed) {
    for (const { attribute, value } of references) {
      const reason = checkReference(value, page);
      if (reason !== null) findings.push({ page: page.rel, attribute, value, reason });
    }
  }
  return findings;
}
