/* Cabrillo Coast LLC — built-site HTML parsing and link checking (Node built-ins only) */
/**
 * Shared helper for the built-output tests (AC-07). It is not a test file: its
 * name does not match `*.test.mjs`, so `node --test "tests/**\/*.test.mjs"`
 * only reaches it through the suites that import it:
 *   - `tests/static/built-pages.test.mjs`        all four exports
 *   - `tests/static/built-search-index.test.mjs` `parseStartTags`, `decodeEntities`
 *   - `tests/static/site-chrome.test.mjs`        `parseStartTags`, `decodeEntities`
 *   - `tests/unit/site-links.test.mjs`           all four exports
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
 *   - Comments and start tags are read in one left-to-right scan, each
 *     consumed whole. A URL inside a comment is never read as a link, and
 *     `<!--` inside a quoted attribute value never opens a comment. A
 *     comment ends where the HTML tokenizer ends one (`-->`, `--!>`, the
 *     abrupt `<!-->` or `<!--->`, or the end of the input), and offsets
 *     point into the original text.
 *   - Escaped markup (`&lt;a href="/nope"&gt;` in a code sample) has no `<`,
 *     and Rouge splits highlighted `src=` text across `<span>` elements, so
 *     neither is ever read as a tag or an attribute.
 * `<script>` and `<style>` contents are scanned like any other text: blog
 * pages carry no inline scripts under their Content-Security-Policy, and the
 * home page's only script is external.
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

/** Replacement text for the named references in `ENTITY_RE`. */
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  quot: '"',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: '\u00a0',
});

/**
 * An HTML comment, ended where the HTML tokenizer ends one: at `-->` or
 * `--!>`, at once for the abrupt empty comments `<!-->` and `<!--->`, or at
 * the end of the input when it is never closed. No capture groups.
 */
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g;

/**
 * A start tag with quote-aware attributes. `\s` crosses newlines, so tags
 * written over several lines match. `<!DOCTYPE …>`, closing tags and comments
 * never match because the name must start with a letter.
 */
const START_TAG_RE =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;

/**
 * A comment or a start tag, whichever begins first. Scanning with one
 * alternation consumes each construct whole, so `<!--` inside a quoted
 * attribute value never opens a comment and a tag inside a comment is never
 * read. The two alternatives cannot both match at one offset (`<!` against
 * `<` plus a letter), and the tag's groups are 1 (name) and 2 (attributes).
 */
const MARKUP_RE = new RegExp(`${COMMENT_RE.source}|${START_TAG_RE.source}`, 'g');

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
 * Lists every start tag of an HTML document in document order. One
 * left-to-right scan reads comments and start tags whole: a tag inside a
 * comment is not returned, and `<!--` inside a quoted attribute value is
 * text, not the start of a comment. Offsets and `source` refer to the
 * original string.
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
  const re = new RegExp(MARKUP_RE.source, 'g');
  let match;
  while ((match = re.exec(original)) !== null) {
    // A comment has no tag-name group; it is consumed and skipped.
    if (match[1] === undefined) continue;
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

