/* Cabrillo Coast LLC — built-site HTML parsing and link checking (Node built-ins only) */
/**
 * Shared helper for the built-output tests (AC-07). It is not a test file: its
 * name does not match `*.test.mjs`, so `node --test "tests/**\/*.test.mjs"`
 * only reaches it through the suites that import it:
 *   - `tests/static/built-pages.test.mjs`        all four exports
 *   - `tests/static/built-search-index.test.mjs` `parseStartTags`
 *   - `tests/static/site-chrome.test.mjs`        `parseStartTags`, `decodeEntities`
 *   - `tests/unit/site-links.test.mjs`           `checkSiteLinks`
 *
 * Everything is synchronous, so consumers can call it at module top level or
 * inside `test()`. Importing the module has no side effects and nothing here
 * writes to the console; findings are returned for the caller to assert on.
 *
 * Why regular expressions instead of an HTML library: the repository adds no
 * runtime or test dependencies beyond Playwright, and the inputs are the
 * site's own pages, written by hand (`index.html`) or emitted by Jekyll,
 * kramdown and Liquid with every attribute value quoted and escaped. Two
 * properties make start tags reliable to find in that output:
 *   - Comments are blanked to equal-length whitespace before matching, so a
 *     URL inside a comment is never read as a link and offsets still point
 *     into the original text.
 *   - Escaped markup (`&lt;a href="/nope"&gt;` in a code sample) has no `<`,
 *     and Rouge splits highlighted `src=` text across `<span>` elements, so
 *     neither is ever read as a tag or an attribute.
 * `<script>` and `<style>` contents are not blanked: blog pages carry no
 * inline scripts under their Content-Security-Policy, and the home page's
 * only script is external.
 *
 * Link-checking model (`checkSiteLinks`): every `href`, `src` and
 * `data-index` value on every built HTML page is resolved the way a browser
 * would resolve it on the page's own URL, then mapped back to a file under
 * the site directory, so the same check covers the custom-domain build
 * (empty base path) and the project-path build (`/cabrillo-coast`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} StartTag
 * @property {string} name   Tag name, lowercased (`a`, `nav`, `use`).
 * @property {Record<string, string>} attrs
 *   Attributes keyed by lowercased name; values entity-decoded, `""` for a
 *   boolean attribute, first occurrence of a duplicate name wins.
 * @property {number} start  Offset of the tag's `<` in the original HTML.
 * @property {number} end    Exclusive end offset (`start + length`).
 * @property {string} source The tag's original text, `html.slice(start, end)`.
 */

/**
 * @typedef {object} HtmlPage
 * @property {string} file    Absolute path of the page.
 * @property {string} rel     POSIX path relative to the site directory.
 * @property {string} urlPath URL path of the page under the base path
 *                            (`blog/index.html` → `<base>/blog/`).
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

/** Replacement text for the named references in `ENTITY_RE`. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: '\u00a0',
});

/** An HTML comment, or an unterminated one running to the end of the input. */
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * A start tag with quote-aware attributes. `\s` crosses newlines, so tags
 * written over several lines match. `<!DOCTYPE …>`, closing tags and comments
 * never match because the name must start with a letter.
 */
const START_TAG_RE =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;

/** One attribute inside the attribute group captured by `START_TAG_RE`. */
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

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
  const trimmed = baseurl.trim().replace(/\/+$/, '').replace(/^\/+/, '');
  return trimmed === '' ? '' : `/${trimmed}`;
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
 * Parses the attribute group of one start tag.
 *
 * The result is an ordinary object rather than `Object.create(null)` so that
 * consumers can compare it with object literals under `node:assert/strict`,
 * which also compares prototypes. Keys are defined as own data properties, so
 * an attribute named `__proto__` or `constructor` is stored like any other,
 * and the duplicate check looks at own keys only.
 * @param {string} group
 * @returns {Record<string, string>}
 */
function parseAttributes(group) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const re = new RegExp(ATTR_RE.source, 'g');
  let match;
  while ((match = re.exec(group)) !== null) {
    const name = match[1].toLowerCase();
    if (Object.hasOwn(attrs, name)) continue;
    const raw = match[2] ?? match[3] ?? match[4];
    Object.defineProperty(attrs, name, {
      value: raw === undefined ? '' : decodeEntities(raw),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return attrs;
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
 * Never throws: a numeric reference to 0, a surrogate or a value above
 * U+10FFFF is left as written.
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
 * Lists every start tag of an HTML document in document order. Comments are
 * ignored; offsets and `source` refer to the original string.
 *
 * @example
 * const [nav] = parseStartTags('<nav class="mobile-menu" id="mobile-menu" aria-label="Primary" hidden>');
 * // nav.name === 'nav', nav.attrs.hidden === '', nav.attrs['aria-label'] === 'Primary'
 * @param {unknown} html
 * @returns {StartTag[]}
 */
export function parseStartTags(html) {
  const original = typeof html === 'string' ? html : String(html ?? '');
  // Every comment character except a newline becomes a space, so the blanked
  // text has the same length and every offset maps straight back.
  const blanked = original.replace(COMMENT_RE, (comment) => comment.replace(/[^\n]/g, ' '));
  /** @type {StartTag[]} */
  const tags = [];
  const re = new RegExp(START_TAG_RE.source, 'g');
  let match;
  while ((match = re.exec(blanked)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    tags.push({
      name: match[1].toLowerCase(),
      attrs: parseAttributes(match[2]),
      start,
      end,
      source: original.slice(start, end),
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
  const base = normalizeBase(baseurl);
  /** @type {HtmlPage[]} */
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        let urlPath;
        if (rel === INDEX_FILE) {
          urlPath = `${base}/`;
        } else if (rel.endsWith(`/${INDEX_FILE}`)) {
          urlPath = `${base}/${rel.slice(0, -INDEX_FILE.length)}`;
        } else {
          urlPath = `${base}/${rel}`;
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
 *   `index.html` is accepted), and any fragment on an HTML target must equal
 *   an `id` in that page.
 *
 * Findings are returned in page order, then document order; an empty array
 * means every reference resolves. A malformed reference is reported as
 * `missing file` rather than thrown.
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
  const root = resolveSiteDir(siteDir, 'checkSiteLinks');
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  const base = normalizeBase(baseurl);
  // The resolved pathname is percent-encoded, so compare it with the base
  // path in the same encoding. The pathname setter also encodes `?` and `#`.
  const baseUrl = new URL(RESOLVE_ORIGIN);
  baseUrl.pathname = `${base}/`;
  const encodedBase = base === '' ? '' : baseUrl.pathname.slice(0, -1);
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
   * Ids of a target page; a target outside the listed pages (reached through
   * a differently spelled path) is parsed once and cached.
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

    let target = path.join(root, remainder);
    if (target !== root && !target.startsWith(rootPrefix)) return REASON_MISSING_FILE;
    const stats = statOrNull(target);
    if (stats === null) return REASON_MISSING_FILE;
    if (stats.isDirectory()) {
      target = path.join(target, INDEX_FILE);
      const indexStats = statOrNull(target);
      if (indexStats === null || !indexStats.isFile()) return REASON_MISSING_FILE;
    } else if (!stats.isFile()) {
      return REASON_MISSING_FILE;
    }

    if (hash !== '' && target.endsWith('.html')) {
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

