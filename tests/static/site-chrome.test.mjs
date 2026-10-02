/* Cabrillo Coast LLC — home page integrity, blog chrome parity and blog asset rules (AC-05, AC-10, F-018, F-019) */
/**
 * Source checks that the blog leaves the hand-written home page intact,
 * keeps its header and footer includes in step with the home page
 * navigation, and holds its own assets to their budgets and rules. The
 * blog templates must end every printed value in `escape`, except the
 * trusted `{{ content }}`, site-path URLs and `url_encode` values. The
 * suite runs in the first `node --test "tests/**\/*.test.mjs"` pass of
 * `scripts/verify.mjs`, after the real-site build, but reads no build
 * output, so it gives the same answer with or without `_site/`. Paths
 * resolve from this file's location (`ROOT`), never from `process.cwd()`.
 *
 * Standing choices behind the checks:
 *   - Home page integrity rests on the pre-blog page's size and SHA-256,
 *     frozen in this file (`PRE_BLOG_COMMIT`): with the blog's edits
 *     reversed, any other edit to `index.html` fails.
 *   - `styles.css` is read as a browser reads it, comments ignored and the
 *     cascade applied, so a commented-out or overridden rule cannot pass for
 *     a live one.
 *   - The request budgets count a static enumeration of the first-party
 *     URLs written in the HTML and CSS source, absolute URLs on the site's
 *     own host included. Requests a script makes when it runs are not seen,
 *     and linked stylesheets are read one level deep.
 *   - The `search.js` sink check is lexical: it finds the listed sinks in
 *     the static spellings `unsafeSinks` names (names with escapes resolved,
 *     `.`, `?.` and string-literal bracket keys, sink names in literal text)
 *     but resolves no alias or run-time value, such as
 *     `var d = document; d.write(s)` or `el[a + b]`. It guards how
 *     `search.js` is written and is no proof of XSS safety.
 *
 * It needs no network and writes nothing; only when the integrity check
 * fails does it ask `git`, if available, for the first differing line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { decodeEntities, parseStartTags } from './lib/site-links.mjs';

/* Constants                                                                 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const HOME_LABELS = Object.freeze([
  'Services',
  'Agentic AI',
  'Topology',
  'Approach',
  'About',
  'Blog',
  'Get in touch',
]);

const HOME_HREFS = Object.freeze([
  '#services',
  '#agentic',
  '#topology',
  '#approach',
  '#about',
  './blog/',
  '#contact',
]);

const FOOT_LABELS = Object.freeze(['Services', 'Approach', 'About', 'Blog', 'Contact']);

const FOOT_HREFS = Object.freeze(['#services', '#approach', '#about', './blog/', '#contact']);

/**
 * The home page before the blog: `index.html` at commit 4611c37, the commit
 * this work starts from (`git show 4611c37:index.html`). Its size and SHA-256
 * are frozen here, never read from git or derived from the current file, so
 * the integrity check cannot drift with the file it checks.
 */
const PRE_BLOG_COMMIT = '4611c37';

const PRE_BLOG_INDEX_BYTES = 23_676;

const PRE_BLOG_INDEX_SHA256 = '985588747b08aac84b6a305aeb62a8ed674aa5a0a4c0a1f052fcebac3622fa1e';

const BLOG_ANCHOR = '<a href="./blog/">Blog</a>';

const MOBILE_MENU_NAV_OPEN = '<nav class="mobile-menu" id="mobile-menu" aria-label="Primary" hidden>';

const PRE_BLOG_MOBILE_MENU_OPEN = '<div class="mobile-menu" id="mobile-menu" hidden>';

/**
 * The home page lists that gain a Blog link: the opening tag that starts each
 * one and the indentation of its links.
 */
const HOME_BLOG_LISTS = Object.freeze([
  Object.freeze({ what: 'header navigation', open: '<nav class="nav-links" aria-label="Primary">', indent: 8 }),
  Object.freeze({ what: 'mobile menu', open: MOBILE_MENU_NAV_OPEN, indent: 6 }),
  Object.freeze({ what: 'footer navigation', open: '<nav class="footer-links" aria-label="Footer">', indent: 8 }),
]);

/** PT-1: first-party bytes the home page may load, document included. */
const PT1_MAX_BYTES = 237_954;

/** PT-2: size limit of `main.js`. */
const PT2_MAX_BYTES = 3_609;

/** PT-4: first-party requests of the home page, document included. */
const PT4_REQUESTS = 5;

const HOME_HTML_RESOURCES = Object.freeze(['./favicon.svg', './main.js', './styles.css']);

const HOME_CSS_RESOURCES = Object.freeze(['./assets/hero-lighthouse.jpg']);

/**
 * Header and footer fit rules `styles.css` keeps at every width, as
 * `[selector, longhand, value]` (AAP 0.4.2): the logo never shrinks, the
 * navigation links never wrap, the footer links wrap in rows 10px apart
 * with 24px between links, and the mobile menu is hidden until opened.
 */
const FIT_RULES = Object.freeze([
  Object.freeze(['.brand', 'flex-shrink', '0']),
  Object.freeze(['.nav-links', 'white-space', 'nowrap']),
  Object.freeze(['.nav-links', 'text-wrap-mode', 'nowrap']),
  Object.freeze(['.footer-links', 'display', 'flex']),
  Object.freeze(['.footer-links', 'flex-wrap', 'wrap']),
  Object.freeze(['.footer-links', 'row-gap', '10px']),
  Object.freeze(['.footer-links', 'column-gap', '24px']),
  Object.freeze(['.mobile-menu', 'display', 'none']),
]);

/** Widest viewport, in px, that shows the hamburger instead of the desktop navigation. */
const NAV_SWITCH_WIDTH = 900;

/** The block that holds the navigation switch, as `normalizeAtRule` spells it. */
const NAV_SWITCH_MEDIA = '@media (max-width:900px)';

/** The block the navigation switch moved out of, which must no longer set it. */
const PRE_BLOG_SWITCH_MEDIA = '@media (max-width:720px)';

/**
 * The navigation above `NAV_SWITCH_WIDTH`: desktop links shown, no
 * hamburger, and no display rule for an open mobile menu.
 */
const NAV_WIDE = Object.freeze([
  Object.freeze(['.nav-links', 'display', 'flex']),
  Object.freeze(['.nav-toggle', 'display', 'none']),
  Object.freeze(['.mobile-menu[data-open="true"]', 'display', undefined]),
]);

const NAV_NARROW = Object.freeze([
  Object.freeze(['.nav-links', 'display', 'none']),
  Object.freeze(['.nav-toggle', 'display', 'flex']),
  Object.freeze(['.mobile-menu[data-open="true"]', 'display', 'flex']),
]);

/**
 * Viewports the fit rules are evaluated at: either side of both
 * breakpoints, the narrow phone widths the footer must fit, each in both
 * colour schemes and both motion preferences.
 */
const CSS_ENVIRONMENTS = Object.freeze(
  [1280, 1000, 901, 900, 800, 721, 720, 375, 360, 320].flatMap((width) =>
    ['light', 'dark'].flatMap((scheme) =>
      ['no-preference', 'reduce'].map((motion) => Object.freeze({ width, scheme, motion })))),
);

const SEARCH_JS_MAX_BYTES = 5_000;

const BLOG_CSS_MAX_BYTES = 8_000;

/**
 * `<link rel>` tokens that never make the browser fetch the `href` while
 * loading the page: `preconnect` and `dns-prefetch` open connections
 * without requesting a resource, and the rest only describe a relation. A
 * `<link>` with any other token, an unknown one included, or with no `rel`
 * at all, is counted as a request.
 */
const NON_FETCHING_LINK_RELS = new Set([
  'alternate',
  'author',
  'bookmark',
  'canonical',
  'dns-prefetch',
  'external',
  'help',
  'license',
  'me',
  'next',
  'nofollow',
  'noopener',
  'noreferrer',
  'opener',
  'pingback',
  'preconnect',
  'prev',
  'privacy-policy',
  'tag',
  'terms-of-service',
]);

/**
 * Attributes whose value is read as one requested URL (`<video poster>`,
 * `<object data>`). They count on every element, whatever its type, so one
 * that loads nothing where it is written (`<div data>`) counts as well.
 */
const RESOURCE_URL_ATTRIBUTES = new Set(['src', 'poster', 'data', 'background']);

/** Attributes holding a list of image candidates, each a URL and an optional descriptor. */
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);

/** Elements whose `href` is navigation, a `<link>` (classified by `rel`) or a `<base>` (refused). */
const NON_RESOURCE_HREF_ELEMENTS = new Set(['a', 'area', 'link', 'base']);

/* File helpers                                                              */

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

/* HTML helpers                                                              */

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

/** An HTML comment, or an unterminated one running to the end of the input. */
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

/** An `</a>` end tag, in any case, with whitespace or ignored attributes before its `>`. */
const ANCHOR_END_RE = /<\/a(?:[\s/][^>]*)?>/gi;

/**
 * The visible text of a fragment of markup: start tags removed at the
 * offsets `parseStartTags` reads (quote-aware, so `title="a > b"` stays
 * inside its tag), end tags removed, `&nbsp;` read as a space, other
 * character references decoded and whitespace collapsed.
 * @param {string} content
 * @returns {string}
 */
function visibleText(content) {
  let text = '';
  let at = 0;
  for (const tag of parseStartTags(content)) {
    text += content.slice(at, tag.start);
    at = tag.end;
  }
  text += content.slice(at);
  return decodeEntities(text.replace(/<\/[a-z][^>]*>/gi, '').replace(/&nbsp;/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every anchor in a fragment of markup, as its `href` and its visible label
 * (`visibleText`). Each `<a>` start tag is found by `parseStartTags`, so
 * attribute order, case (`<A HREF>`) and a quoted `>` in another attribute
 * do not matter, and its content runs to the next `</a>` (any case,
 * whitespace allowed: `</a >`) or to the next `<a>` start, whichever comes
 * first, as an HTML parser closes an unclosed anchor. HTML comments are
 * dropped first so a commented-out link is never counted.
 * @param {string} inner
 * @returns {{ label: string, href: string | undefined }[]}
 */
function anchors(inner) {
  const markup = inner.replace(HTML_COMMENT_RE, '');
  const starts = parseStartTags(markup).filter((tag) => tag.name === 'a');
  return starts.map((tag, index) => {
    const close = new RegExp(ANCHOR_END_RE.source, 'gi');
    close.lastIndex = tag.end;
    const match = close.exec(markup);
    const next = index + 1 < starts.length ? starts[index + 1].start : markup.length;
    const end = match === null ? next : Math.min(match.index, next);
    return { label: visibleText(markup.slice(tag.end, end)), href: tag.attrs.href };
  });
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

/** A Liquid tag `{% … %}` or output `{{ … }}`, with its whitespace-control dashes. */
const LIQUID_MARKUP_RE = /\{%(-?)([\s\S]*?)(-?)%\}|\{\{(-?)([\s\S]*?)(-?)\}\}/g;

const LIQUID_ENDRAW_RE = /\{%-?\s*endraw\s*-?%\}/g;

/**
 * Liquid blocks whose body is not unconditional markup: a condition or
 * loop decides whether, or how often, it is output (`if`, `unless`,
 * `case`, `for`, `tablerow`, `ifchanged`), `capture` stores it in a
 * variable, and `highlight` prints it as escaped code. Required chrome
 * inside one is not guaranteed on the page, so `liquidToStatic` drops these
 * bodies, every `elsif`, `else` and `when` branch included.
 */
const LIQUID_HIDDEN_BLOCKS = new Set(['if', 'unless', 'case', 'for', 'tablerow', 'capture', 'ifchanged', 'highlight']);

/** End tags of the blocks `liquidTokens` reads whole. */
const LIQUID_CONSUMED_ENDS = new Set(['endcomment', 'endraw']);

/** Branch tags, and the blocks each may appear in. */
const LIQUID_BRANCH_TAGS = Object.freeze({
  elsif: Object.freeze(['if', 'unless']),
  else: Object.freeze(['if', 'unless', 'case', 'for']),
  when: Object.freeze(['case']),
});

/** A Liquid output that passes a quoted site path through `relative_url`, as its markup reads. */
const RELATIVE_URL_MARKUP_RE = /^(['"])([^'"]*)\1\s*\|\s*relative_url$/;

/**
 * @typedef {object} LiquidToken
 * @property {'text' | 'tag' | 'output'} kind
 * @property {string} source    The token's text in the template.
 * @property {string} markup    For a tag or an output, what lies between its delimiters, trimmed.
 * @property {string} name      For a tag, its first word (`if`, `endif`, `assign`); `''` otherwise.
 * @property {boolean} trimLeft  Opened with `{%-` or `{{-`: strips the whitespace before it.
 * @property {boolean} trimRight Closed with `-%}` or `-}}`: strips the whitespace after it.
 */

/**
 * A Liquid template as text, tag and output tokens, as Liquid's lexer
 * reads it. A `{% comment %}` block, up to its matching `{% endcomment %}`
 * (nested comments counted), becomes one `comment` tag that renders
 * nothing. A `{% raw %}` block becomes its contents as plain text, between
 * two `raw` tags that render nothing. Either one left open throws.
 * @param {string} src
 * @returns {LiquidToken[]}
 */
function liquidTokens(src) {
  /** @type {LiquidToken[]} */
  const tokens = [];
  const re = new RegExp(LIQUID_MARKUP_RE.source, 'g');
  let at = 0;
  /** @returns {LiquidToken} */
  const tokenOf = (match) => {
    const isTag = match[2] !== undefined;
    const markup = (isTag ? match[2] : match[5]).trim();
    return {
      kind: isTag ? 'tag' : 'output',
      source: match[0],
      markup,
      name: isTag ? markup.split(/\s/, 1)[0] : '',
      trimLeft: (isTag ? match[1] : match[4]) === '-',
      trimRight: (isTag ? match[3] : match[6]) === '-',
    };
  };
  const text = (from, to) => {
    if (to > from) {
      const source = src.slice(from, to);
      tokens.push({ kind: 'text', source, markup: '', name: '', trimLeft: false, trimRight: false });
    }
  };
  let match;
  while ((match = re.exec(src)) !== null) {
    text(at, match.index);
    const token = tokenOf(match);
    if (token.name === 'comment') {
      let depth = 1;
      let inner = null;
      while (depth > 0 && (inner = re.exec(src)) !== null) {
        const { name } = tokenOf(inner);
        if (name === 'comment') depth += 1;
        if (name === 'endcomment') depth -= 1;
      }
      if (depth > 0) throw new Error(`liquidTokens: {% comment %} at offset ${match.index} is never closed`);
      tokens.push({ ...token, source: src.slice(match.index, re.lastIndex), trimRight: tokenOf(inner).trimRight });
    } else if (token.name === 'raw') {
      const close = new RegExp(LIQUID_ENDRAW_RE.source, 'g');
      close.lastIndex = re.lastIndex;
      const end = close.exec(src);
      if (end === null) throw new Error(`liquidTokens: {% raw %} at offset ${match.index} is never closed`);
      tokens.push(token);
      text(re.lastIndex, end.index);
      tokens.push({
        kind: 'tag',
        source: end[0],
        markup: 'endraw',
        name: 'raw',
        trimLeft: end[0].startsWith('{%-'),
        trimRight: end[0].endsWith('-%}'),
      });
      re.lastIndex = close.lastIndex;
    } else {
      tokens.push(token);
    }
    at = re.lastIndex;
  }
  text(at, src.length);
  return tokens;
}

/**
 * The site path a `{{ '/path' | relative_url }}` output names, or `null`
 * for any other token.
 * @param {LiquidToken} token
 * @returns {string | null}
 */
function relativeUrlPath(token) {
  if (token.kind !== 'output') return null;
  const match = RELATIVE_URL_MARKUP_RE.exec(token.markup);
  return match === null ? null : match[2];
}

/**
 * An include's markup as Jekyll would render it at an empty base path, as
 * far as this suite reads it, keeping only what is output on every page:
 *   - `{% comment %}` blocks are removed with their text, and `{% raw %}`
 *     contents are kept as written;
 *   - the bodies of `LIQUID_HIDDEN_BLOCKS` are removed with all their
 *     branches, so markup the chrome needs must sit outside every condition
 *     and loop. The header's `{% if %}` that only assigns
 *     `blog_nav_current` goes with them, harmlessly;
 *   - `{{ '/path' | relative_url }}` becomes `/path`; every other output and
 *     tag is removed, which drops the `{{ blog_nav_current }}` marker after
 *     the Blog link and the build-time year inside `span#year`;
 *   - `{%-`, `-%}`, `{{-` and `-}}` strip the whitespace beside them.
 * A block that is never closed, an end tag that closes no open block, and
 * a branch outside its block throw, as Liquid refuses them.
 * @param {string} src
 * @returns {string}
 */
function liquidToStatic(src) {
  const tokens = liquidTokens(src);
  /** Names of the hidden blocks open at the current token, innermost last. */
  const open = [];
  let out = '';
  tokens.forEach((token, index) => {
    const { name } = token;
    if (token.kind === 'text') {
      if (open.length > 0) return;
      let text = token.source;
      if (tokens[index - 1]?.trimRight) text = text.replace(/^\s+/, '');
      if (tokens[index + 1]?.trimLeft) text = text.replace(/\s+$/, '');
      out += text;
    } else if (token.kind === 'output') {
      if (open.length === 0) out += relativeUrlPath(token) ?? '';
    } else if (LIQUID_HIDDEN_BLOCKS.has(name)) {
      open.push(name);
    } else if (name.startsWith('end') && (LIQUID_HIDDEN_BLOCKS.has(name.slice(3)) || LIQUID_CONSUMED_ENDS.has(name))) {
      // `liquidTokens` consumes comment and raw blocks whole, so their end tags arrive here only unmatched.
      const block = open.pop();
      if (block !== name.slice(3)) {
        const inside = block === undefined ? '' : ` inside {% ${block} %}`;
        throw new Error(`liquidToStatic: {% ${name} %}${inside} has no matching {% ${name.slice(3)} %}`);
      }
    } else if (Object.hasOwn(LIQUID_BRANCH_TAGS, name) && !LIQUID_BRANCH_TAGS[name].includes(open.at(-1))) {
      const blocks = LIQUID_BRANCH_TAGS[name].map((block) => `{% ${block} %}`).join(' or ');
      throw new Error(`liquidToStatic: {% ${name} %} is outside ${blocks}`);
    }
  });
  if (open.length > 0) throw new Error(`liquidToStatic: {% ${open.at(-1)} %} is never closed`);
  return out;
}

/* Home page integrity helpers                                               */

/**
 * How many times `needle` occurs in `haystack`, without overlaps.
 * @param {string} haystack
 * @param {string} needle Non-empty.
 * @returns {number}
 */
function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Offset of `needle` in `haystack`, failing unless it occurs exactly once.
 * @param {string} haystack
 * @param {string} needle
 * @param {string} what Where the needle belongs, for the failure message.
 * @returns {number}
 */
function onlyIndexOf(haystack, needle, what) {
  const count = occurrences(haystack, needle);
  assert.equal(count, 1, `${what}: expected exactly one ${JSON.stringify(needle)}, found ${count}`);
  return haystack.indexOf(needle);
}

/**
 * `index.html` with the plan's edits reversed: the Blog link removed, as a
 * whole line, from the header navigation, the mobile menu and the footer
 * navigation, and the mobile menu's `<nav … aria-label="Primary" hidden>`
 * and its `</nav>` turned back into the `<div … hidden>` and `</div>` they
 * replaced. Each edit must sit exactly once where the plan puts it, so a
 * moved, doubled or missing edit fails with its own message rather than as a
 * digest mismatch. Whatever else changed survives the reversal, and the
 * digest comparison then rejects it.
 * @param {string} html `index.html` decoded as latin1, one character per byte.
 * @returns {string} The same encoding.
 */
function undoHomeEdits(html) {
  const blogLinks = occurrences(html, BLOG_ANCHOR);
  assert.equal(blogLinks, 3, `index.html must hold exactly three ${BLOG_ANCHOR} links, found ${blogLinks}`);
  /** `[from, to, replacement]` spans of the current text. */
  const edits = [];
  for (const { what, open, indent } of HOME_BLOG_LISTS) {
    const start = onlyIndexOf(html, open, `index.html ${what}`);
    const close = html.indexOf('</nav>', start);
    assert.notEqual(close, -1, `index.html ${what} has no </nav>`);
    const list = html.slice(start, close);
    const line = `${' '.repeat(indent)}${BLOG_ANCHOR}\n`;
    const lines = occurrences(list, `\n${line}`);
    assert.equal(
      lines,
      1,
      `index.html ${what} must hold the Blog link once, on its own line indented ${indent} spaces; found ${lines}`,
    );
    const at = start + list.indexOf(`\n${line}`) + 1;
    edits.push([at, at + line.length, '']);
    if (open === MOBILE_MENU_NAV_OPEN) {
      edits.push([start, start + open.length, PRE_BLOG_MOBILE_MENU_OPEN]);
      edits.push([close, close + '</nav>'.length, '</div>']);
    }
  }
  // Last span first, so earlier offsets stay valid.
  edits.sort((a, b) => b[0] - a[0]);
  let out = html;
  for (const [from, to, replacement] of edits) out = out.slice(0, from) + replacement + out.slice(to);
  return out;
}

/**
 * A pointer to the first line where `restored` departs from the pre-blog
 * page, read with `git show` when this checkout has the commit. Diagnostic
 * only: the verdict rests on the frozen digest, and a checkout without git
 * history gets a hint instead.
 * @param {Buffer} restored `index.html` with the plan's edits reversed.
 * @returns {string}
 */
function firstDifferenceFromPreBlog(restored) {
  const shown = spawnSync('git', ['show', `${PRE_BLOG_COMMIT}:index.html`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  });
  const hint = `compare with: git show ${PRE_BLOG_COMMIT}:index.html`;
  if (shown.error || shown.status !== 0) return `pre-blog index.html is not readable from git here; ${hint}`;
  if (createHash('sha256').update(shown.stdout).digest('hex') !== PRE_BLOG_INDEX_SHA256) {
    return `git's ${PRE_BLOG_COMMIT}:index.html does not match the frozen digest; ${hint}`;
  }
  const expected = shown.stdout.toString('latin1').split('\n');
  const actual = restored.toString('latin1').split('\n');
  const line = expected.findIndex((text, index) => text !== actual[index]);
  const at = line === -1 ? expected.length : line;
  const want = JSON.stringify(expected[at] ?? '<end of file>');
  const found = JSON.stringify(actual[at] ?? '<end of file>');
  return `first difference at line ${at + 1} (edits reversed): expected ${want}, found ${found}`;
}

/* Request helpers                                                           */

/** `url(…)` in CSS, with the value double-quoted, single-quoted or bare. */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

/** `@import "…"` in CSS; the `@import url(…)` form is caught by `CSS_URL_RE`. */
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/** `image-set(` and `-webkit-image-set(`, whose string arguments are URLs as well. */
const CSS_IMAGE_SET_RE = /(?:-webkit-)?image-set\(/gi;

/** The top-level `url:` of `_config.yml`, quoted or bare, with an optional trailing comment. */
const CONFIG_URL_RE = /^url:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#'"]+))[ \t]*(?:#.*)?$/m;

/**
 * The lowercased host name of an absolute URL, or `''` when the text does
 * not parse as one.
 * @param {string} text
 * @returns {string}
 */
function hostOfUrl(text) {
  try {
    return new URL(text).hostname;
  } catch {
    return '';
  }
}

/**
 * The site's own host: an absolute URL on it is a first-party request like
 * a `./` path. It is the first line of `CNAME` on the custom domain, and the
 * host of `_config.yml`'s `url` once `CNAME` is removed for the project-path
 * deployment, whose `url` names the github.io host. Without a host,
 * same-origin absolute URLs could not be told from external ones, so a
 * missing or malformed one fails the request checks.
 * @returns {string} Lowercased, such as `www.cabrillocoast.com`.
 */
function siteHost() {
  let host;
  let source;
  if (existsSync(abs('CNAME'))) {
    host = read('CNAME').split(/\r?\n/)[0].trim().toLowerCase();
    source = 'CNAME';
  } else {
    assert.ok(existsSync(abs('_config.yml')), 'neither CNAME nor _config.yml exists, so the site host is unknown');
    const match = CONFIG_URL_RE.exec(read('_config.yml'));
    assert.ok(match, '_config.yml has no top-level url, and there is no CNAME, so the site host is unknown');
    host = hostOfUrl(match[1] ?? match[2] ?? match[3]);
    source = "_config.yml's url";
  }
  assert.match(
    host,
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,
    `${source} must hold the site's host name, found ${JSON.stringify(host)}`,
  );
  return host;
}

/**
 * The path a URL found in markup or CSS requests from the site itself, or
 * `null` when it requests nothing from the site:
 *   - empty, or a bare fragment such as `#top` or SVG's `url(#gradient)`;
 *   - a scheme other than `http:`/`https:` (`data:`, `mailto:`);
 *   - an `http:`, `https:` or protocol-relative URL on another host or port.
 * A relative URL is returned as written; an absolute or protocol-relative
 * URL on `host` is first-party, and its path is returned root-relative.
 * @param {string} url
 * @param {string} host The site host (`siteHost`).
 * @returns {string | null}
 */
function firstPartyPath(url, host) {
  const text = url.trim();
  if (text === '' || text.startsWith('#')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme === null && !/^[\\/]{2}/.test(text)) return text;
  if (scheme !== null && !/^https?$/i.test(scheme[1])) return null;
  let parsed;
  try {
    // A page on the site is the base, so `https:path` resolves the way it would there.
    parsed = new URL(text, `https://${host}/index.html`);
  } catch {
    return null;
  }
  if (parsed.hostname !== host || parsed.port !== '') return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Whether a URL found in markup or CSS is a request to the site itself
 * (`firstPartyPath`).
 * @param {string} url
 * @param {string} host
 * @returns {boolean}
 */
function isFirstPartyRequest(url, host) {
  return firstPartyPath(url, host) !== null;
}

/**
 * Repository path of the file a first-party URL names, resolved against the
 * file that references it the way a browser resolves it against that file's
 * URL at an empty base path; a same-origin absolute URL names the file at
 * its path. Query and fragment are dropped.
 * @param {string} url
 * @param {string} fromRel POSIX path of the referencing file.
 * @param {string} host The site host (`siteHost`).
 * @returns {string}
 */
function fileOf(url, fromRel, host) {
  const target = firstPartyPath(url, host);
  if (target === null) throw new Error(`fileOf: ${JSON.stringify(url)} in ${fromRel} is not a request to the site`);
  const clean = target.replace(/[?#][\s\S]*$/, '');
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
 * The URLs of an image candidate list (`srcset`, `imagesrcset`): each
 * candidate is a URL, then an optional width or density descriptor, and
 * candidates are separated by commas. A URL may itself contain commas
 * except at its end, as HTML's parsing rules allow.
 * @param {string} value
 * @returns {string[]}
 */
function srcsetUrls(value) {
  const urls = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    let url = value.slice(start, index);
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      // Skip the descriptor up to the comma that ends the candidate.
      let depth = 0;
      while (index < value.length && !(value[index] === ',' && depth === 0)) {
        if (value[index] === '(') depth += 1;
        if (value[index] === ')' && depth > 0) depth -= 1;
        index += 1;
      }
    }
    if (url !== '') urls.push(url);
  }
  return urls;
}

/**
 * The first-party URLs a page's markup references for loading, read
 * statically from the HTML source in these forms:
 *   - the `href` of every `<link>` whose `rel` can fetch: anything but the
 *     relations in `NON_FETCHING_LINK_RELS`, unknown ones included;
 *   - `src`, `poster`, `data` and `background` on any element, and each
 *     candidate of a `srcset` or `imagesrcset`;
 *   - `href` and `xlink:href` on any element but `<a>`, `<area>` and
 *     `<link>`, such as SVG `<use>` and `<image>` (a bare fragment like
 *     `<use href="#gp">` stays inside the page);
 *   - the CSS of every `style` attribute and `<style>` element, and any
 *     attribute value holding `url(…)` (SVG `fill`, `filter`, `mask`), read
 *     with `cssRequests`.
 * No other attribute is read, and a request a script makes when it runs
 * (`fetch`, or an element or URL it creates) is not seen. Anchors are
 * navigation, never counted, so the home page's `./blog/` links add
 * nothing. A `<base>` element would change how every relative URL
 * resolves, so a page with one is refused.
 * @param {string} html
 * @param {string} host The site host (`siteHost`).
 * @returns {{ urls: string[], stylesheets: string[] }} As written, sorted, distinct.
 */
function htmlRequests(html, host) {
  const urls = new Set();
  const stylesheets = new Set();
  const add = (url) => {
    if (isFirstPartyRequest(url, host)) urls.add(url.trim());
  };
  const addCss = (css) => {
    for (const url of cssRequests(css, host)) urls.add(url);
  };
  const tags = parseStartTags(html);
  for (const tag of tags) {
    if (tag.name === 'base') {
      throw new Error(`htmlRequests: <base> at offset ${tag.start} changes how every relative URL resolves`);
    }
    if (tag.name === 'link' && Object.hasOwn(tag.attrs, 'href')) {
      const rels = (tag.attrs.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (rels.length === 0 || rels.some((rel) => !NON_FETCHING_LINK_RELS.has(rel))) {
        add(tag.attrs.href);
        if (rels.includes('stylesheet') && isFirstPartyRequest(tag.attrs.href, host)) {
          stylesheets.add(tag.attrs.href.trim());
        }
      }
    }
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (RESOURCE_URL_ATTRIBUTES.has(name)) add(value);
      if (SRCSET_ATTRIBUTES.has(name)) srcsetUrls(value).forEach(add);
      if ((name === 'href' || name === 'xlink:href') && !NON_RESOURCE_HREF_ELEMENTS.has(tag.name)) add(value);
      if (name === 'style' || /url\(/i.test(value)) addCss(value);
    }
    if (tag.name === 'style') {
      const close = /<\/style\s*>/gi;
      close.lastIndex = tag.end;
      const match = close.exec(html);
      addCss(html.slice(tag.end, match === null ? html.length : match.index));
    }
  }
  return { urls: [...urls].sort(), stylesheets: [...stylesheets].sort() };
}

/**
 * The first-party resources a stylesheet requests: `url(…)` values (quotes
 * optional, including multi-line `background:` lists), `@import` strings
 * and the string candidates of `image-set()`, with CSS comments ignored
 * (`stripCssComments`).
 * @param {string} css
 * @param {string} host The site host (`siteHost`).
 * @returns {string[]} As written, sorted, distinct.
 */
function cssRequests(css, host) {
  const text = stripCssComments(css);
  const urls = new Set();
  const add = (url) => {
    if (isFirstPartyRequest(url, host)) urls.add(url.trim());
  };
  for (const re of [CSS_URL_RE, CSS_IMPORT_RE]) {
    for (const match of text.matchAll(re)) add(match[1] ?? match[2] ?? match[3] ?? '');
  }
  for (const match of text.matchAll(CSS_IMAGE_SET_RE)) {
    const open = match.index + match[0].length;
    const close = cssStop(text, open, text.length, ')');
    for (const candidate of splitCssList(text.slice(open, close === -1 ? text.length : close))) {
      const string = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(candidate);
      if (string !== null) add(string[1] ?? string[2]);
    }
  }
  return [...urls].sort();
}

/**
 * The home page's first-party requests as its source shows them: the URLs
 * in `index.html` (`htmlRequests`), the URLs inside each first-party
 * stylesheet it links with a `rel` holding `stylesheet` (`cssRequests`),
 * and the distinct repository files they name, the document included.
 * Stylesheets are read one level deep: an `@import` target, in a linked
 * stylesheet or a `<style>` element, counts as a request, but its own
 * contents are not read. Requests `main.js` or any other script makes when
 * it runs are not counted.
 * @returns {{ htmlUrls: string[], cssUrls: string[], files: string[] }}
 */
function homeRequests() {
  const host = siteHost();
  const { urls: htmlUrls, stylesheets } = htmlRequests(read('index.html'), host);
  const cssUrls = new Set();
  const files = new Set(['index.html']);
  for (const url of htmlUrls) files.add(fileOf(url, 'index.html', host));
  for (const sheet of stylesheets) {
    const sheetRel = fileOf(sheet, 'index.html', host);
    for (const url of cssRequests(read(sheetRel), host)) {
      cssUrls.add(url);
      files.add(fileOf(url, sheetRel, host));
    }
  }
  return { htmlUrls, cssUrls: [...cssUrls].sort(), files: [...files].sort() };
}

/* Stylesheet helpers                                                        */

/** Values every CSS property accepts. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/** The longhands the fit rules read; `all` resets each of them. */
const CSS_FIT_LONGHANDS = Object.freeze([
  'display',
  'flex-shrink',
  'flex-wrap',
  'row-gap',
  'column-gap',
  'white-space',
  'text-wrap-mode',
]);

/**
 * @typedef {object} CssDeclaration
 * @property {string} property  Lowercased (custom properties as written).
 * @property {string} value     Lowercased outside strings, whitespace collapsed, `!important` removed.
 * @property {boolean} important
 * @property {number} order     Position in the whole stylesheet, for the cascade.
 */

/**
 * @typedef {object} CssRule
 * @property {string[]} selectors The rule's selector list, each normalised (`normalizeSelector`).
 * @property {string[]} context   The at-rules around it, outermost first, normalised (`@media (max-width:900px)`).
 * @property {CssDeclaration[]} declarations
 */

/**
 * Exclusive end of the CSS string whose opening quote is at `start`: just
 * past the closing quote, or, for an unterminated string, at the first LF
 * (`\n`) or the end of text. A backslash escapes the next character, an LF
 * included. CR and form feed do not end a string here, unlike in CSS's
 * tokenizer: the helper exists only so the stylesheet scanners
 * (`stripCssComments`, `cssStop`, `cssBlockEnd`, `normalizeCssText`) can
 * step over strings.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function cssStringEnd(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length && text[index] !== quote && text[index] !== '\n') {
    index += text[index] === '\\' ? 2 : 1;
  }
  return Math.min(index < text.length && text[index] === quote ? index + 1 : index, text.length);
}

/**
 * CSS text with every comment replaced by one space. Strings are kept as
 * written, so a comment marker inside one stays text and a commented-out
 * declaration is gone. A comment ends the token before it, as the CSS
 * tokenizer reads it, so the space keeps `flex-/**\/shrink` the two words a
 * browser sees, never the `flex-shrink` it does not apply.
 * @param {string} css
 * @returns {string}
 */
function stripCssComments(css) {
  let out = '';
  let index = 0;
  while (index < css.length) {
    const ch = css[index];
    if (ch === '"' || ch === "'") {
      const end = cssStringEnd(css, index);
      out += css.slice(index, end);
      index = end;
    } else if (ch === '\\') {
      out += css.slice(index, index + 2);
      index += 2;
    } else if (ch === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      index = close === -1 ? css.length : close + 2;
      out += ' ';
    } else {
      out += ch;
      index += 1;
    }
  }
  return out;
}

/**
 * Offset of the first character of `stops` in `text[from..to)` that lies
 * outside strings, escapes, parentheses and brackets; -1 when there is none.
 * @param {string} text
 * @param {number} from
 * @param {number} to
 * @param {string} stops
 * @returns {number}
 */
function cssStop(text, from, to, stops) {
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    const ch = text[index];
    if (ch === '\\') {
      index += 1;
    } else if (ch === '"' || ch === "'") {
      index = cssStringEnd(text, index) - 1;
    } else if (ch === '(' || ch === '[') {
      depth += 1;
    } else if ((ch === ')' || ch === ']') && depth > 0) {
      depth -= 1;
    } else if (depth === 0 && stops.includes(ch)) {
      return index;
    }
  }
  return -1;
}

/**
 * Offset of the `}` that closes the block opened by the `{` at `open`,
 * skipping strings and escapes and counting nested blocks.
 * @param {string} text
 * @param {number} open
 * @param {number} to
 * @returns {number}
 */
function cssBlockEnd(text, open, to) {
  let depth = 0;
  for (let index = open; index < to; index += 1) {
    const ch = text[index];
    if (ch === '\\') {
      index += 1;
    } else if (ch === '"' || ch === "'") {
      index = cssStringEnd(text, index) - 1;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`parseCss: the block opened at offset ${open} is never closed`);
}

/**
 * `text` split at each comma outside strings, parentheses and brackets.
 * @param {string} text
 * @returns {string[]}
 */
function splitCssList(text) {
  const parts = [];
  let from = 0;
  for (let comma = cssStop(text, 0, text.length, ','); comma !== -1; comma = cssStop(text, from, text.length, ',')) {
    parts.push(text.slice(from, comma));
    from = comma + 1;
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * `text` lowercased outside strings, with each run of whitespace outside
 * strings collapsed to one space and the ends trimmed.
 * @param {string} text
 * @returns {string}
 */
function normalizeCssText(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"' || ch === "'") {
      const end = cssStringEnd(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (/\s/.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
      index += 1;
    } else {
      out += ch.toLowerCase();
      index += 1;
    }
  }
  return out.trim();
}

/**
 * A selector in one spelling: whitespace collapsed, and attribute
 * selectors written `[name="value"]` whichever quotes, if any, the source
 * used. Class names stay case-sensitive, as HTML treats them.
 * @param {string} selector
 * @returns {string}
 */
function normalizeSelector(selector) {
  return selector
    .replace(
      /\[\s*([-\w]+)\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))\s*([is])?\s*\]/gi,
      (match, name, operator, double, single, bare, flag) =>
        `[${name.toLowerCase()}${operator}"${double ?? single ?? bare}"${flag ? ` ${flag.toLowerCase()}` : ''}]`,
    )
    .replace(/\[\s*([-\w]+)\s*\]/g, (match, name) => `[${name.toLowerCase()}]`)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An at-rule prelude in one spelling: lowercased, whitespace collapsed, and
 * no space inside the parentheses of a feature or around its colon, so
 * `@media ( max-width : 900px )` reads `@media (max-width:900px)`.
 * @param {string} prelude
 * @returns {string}
 */
function normalizeAtRule(prelude) {
  return normalizeCssText(prelude)
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*:\s*/g, ':');
}

/**
 * One declaration, `property: value [!important]`, or `null` for text that
 * is not one (an at-rule statement such as `@import`, or a stray token).
 * @param {string} piece
 * @returns {{ property: string, value: string, important: boolean } | null}
 */
function parseCssDeclaration(piece) {
  const colon = cssStop(piece, 0, piece.length, ':');
  if (piece.startsWith('@') || colon <= 0) return null;
  const name = piece.slice(0, colon).trim();
  let value = piece.slice(colon + 1);
  const important = /!\s*important\s*$/i.test(value);
  if (important) value = value.replace(/!\s*important\s*$/i, '');
  return {
    property: name.startsWith('--') ? name : name.toLowerCase(),
    value: normalizeCssText(value),
    important,
  };
}

/**
 * The style rules of a stylesheet with comments ignored and strings
 * honoured, so neither a commented-out declaration nor a `{`, `;` or `/*`
 * inside a string changes what is read. Each rule records the at-rules
 * around it (`@media`, `@supports`, at any depth) and its declarations in
 * source order. A selector list is split at its top-level commas, and a
 * nested style rule's selectors are resolved against its parent's (`&`
 * replaced, or a descendant otherwise).
 * @param {string} css
 * @returns {CssRule[]}
 */
function parseCss(css) {
  const text = stripCssComments(css);
  /** @type {CssRule[]} */
  const rules = [];
  let order = 0;
  /**
   * Reads `text[from..to)`, the body of a stylesheet, at-rule or style rule.
   * @param {number} from
   * @param {number} to
   * @param {string[]} context
   * @param {string[]} selectors Selectors of the enclosing style rule; empty outside one.
   */
  const parseBlock = (from, to, context, selectors) => {
    /** @type {CssDeclaration[]} */
    const declarations = [];
    let index = from;
    while (index < to) {
      const stop = cssStop(text, index, to, '{;}');
      if (stop !== -1 && text[stop] === '{') {
        const close = cssBlockEnd(text, stop, to);
        const prelude = text.slice(index, stop).trim();
        if (prelude.startsWith('@')) {
          parseBlock(stop + 1, close, [...context, normalizeAtRule(prelude)], selectors);
        } else {
          const own = splitCssList(prelude).map(normalizeSelector);
          const resolved = selectors.length === 0
            ? own
            : selectors.flatMap((parent) =>
              own.map((child) => (child.includes('&') ? child.replaceAll('&', parent) : `${parent} ${child}`)));
          parseBlock(stop + 1, close, context, resolved);
        }
        index = close + 1;
        continue;
      }
      const end = stop === -1 ? to : stop;
      const declaration = parseCssDeclaration(text.slice(index, end).trim());
      if (declaration !== null) {
        declarations.push({ ...declaration, order });
        order += 1;
      }
      index = end + 1;
    }
    if (selectors.length > 0 && declarations.length > 0) rules.push({ selectors, context, declarations });
  };
  parseBlock(0, text.length, [], []);
  return rules;
}

/**
 * The flex-shrink factor a `flex` shorthand sets: 0 for `none`, the second
 * of two adjacent unitless numbers (`flex: 0 0 auto`), and 1 otherwise.
 * @param {string[]} words
 * @returns {string}
 */
function flexShrinkOf(words) {
  if (words.length === 1 && words[0] === 'none') return '0';
  const isNumber = (word) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(word ?? '');
  const grow = words.findIndex(isNumber);
  return grow !== -1 && isNumber(words[grow + 1]) ? words[grow + 1] : '1';
}

/**
 * The fit-rule longhands a declaration sets, shorthands expanded:
 * `flex-flow` sets `flex-wrap` (to `nowrap` when it names none), `gap` and
 * `grid-gap` set `row-gap` and `column-gap`, `flex` sets `flex-shrink`,
 * `white-space` and `text-wrap` set `text-wrap-mode`, and `all` resets them
 * all.
 * @param {CssDeclaration} declaration
 * @returns {Record<string, string>}
 */
function cssLonghands({ property, value }) {
  const keyword = CSS_WIDE_KEYWORDS.has(value) ? value : null;
  const words = value.split(' ');
  switch (property) {
    case 'display':
    case 'flex-shrink':
    case 'flex-wrap':
    case 'row-gap':
    case 'column-gap':
    case 'text-wrap-mode':
      return { [property]: value };
    case 'grid-row-gap':
      return { 'row-gap': value };
    case 'grid-column-gap':
      return { 'column-gap': value };
    case 'gap':
    case 'grid-gap':
      return { 'row-gap': keyword ?? words[0], 'column-gap': keyword ?? words[1] ?? words[0] };
    case 'flex-flow': {
      const wrap = words.find((word) => ['nowrap', 'wrap', 'wrap-reverse'].includes(word));
      return { 'flex-wrap': keyword ?? wrap ?? 'nowrap' };
    }
    case 'flex':
      return { 'flex-shrink': keyword ?? flexShrinkOf(words) };
    case 'white-space':
      return {
        'white-space': value,
        'text-wrap-mode': keyword ?? (words.some((word) => word === 'nowrap' || word === 'pre') ? 'nowrap' : 'wrap'),
      };
    case 'text-wrap':
      return { 'text-wrap-mode': keyword ?? (words.includes('nowrap') ? 'nowrap' : 'wrap') };
    case 'all':
      return Object.fromEntries(CSS_FIT_LONGHANDS.map((name) => [name, value]));
    default:
      return {};
  }
}

/**
 * The value the cascade gives `longhand` on elements `selector` matches,
 * over the rules `include` admits: an `!important` declaration beats a
 * normal one, and among equals the later one wins. Only rules whose
 * selector list holds `selector` itself are read.
 * @param {CssRule[]} rules
 * @param {string} selector Normalised (`normalizeSelector`).
 * @param {string} longhand
 * @param {(rule: CssRule) => boolean} include
 * @returns {string | undefined} `undefined` when no admitted rule sets it.
 */
function cascadeCss(rules, selector, longhand, include) {
  let winner = null;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector) || !include(rule)) continue;
    for (const declaration of rule.declarations) {
      const longhands = cssLonghands(declaration);
      if (!Object.hasOwn(longhands, longhand)) continue;
      const { important, order } = declaration;
      if (winner === null || important > winner.important || (important === winner.important && order > winner.order)) {
        winner = { value: longhands[longhand], important, order };
      }
    }
  }
  return winner?.value;
}

/**
 * A CSS length in px for a media query: `px`, or `em`/`rem` at 16px.
 * @param {string} text
 * @returns {number | null} `null` when it is not such a length.
 */
function cssLengthPx(text) {
  const match = /^(\d+(?:\.\d+)?|\.\d+)(px|em|rem)$/.exec(text);
  if (match === null) return null;
  return Number(match[1]) * (match[2] === 'px' ? 1 : 16);
}

/**
 * Whether one media query term holds in `env`: a media type (`all`,
 * `screen` hold, `print` does not) or a feature in parentheses. Viewport
 * width (`min-width`, `max-width`, `width <=` and the other range forms),
 * `prefers-color-scheme` and `prefers-reduced-motion` are evaluated; any
 * other term is taken to hold, so rules behind it are still held to the
 * fit rules.
 * @param {string} term Normalised (`normalizeAtRule`).
 * @param {{ width: number, scheme: string, motion: string }} env
 * @returns {boolean}
 */
function mediaTermHolds(term, env) {
  if (term === 'print') return false;
  const feature = /^\(([a-z-]+):(.+)\)$/.exec(term);
  if (feature !== null) {
    const [, name, value] = feature;
    const px = cssLengthPx(value);
    if (name === 'min-width' && px !== null) return env.width >= px;
    if (name === 'max-width' && px !== null) return env.width <= px;
    if (name === 'prefers-color-scheme') return value === env.scheme;
    if (name === 'prefers-reduced-motion') return value === env.motion;
    return true;
  }
  const range = /^\(width ?(<=|<|>=|>) ?([^\s)]+)\)$/.exec(term);
  const px = range === null ? null : cssLengthPx(range[2]);
  if (px !== null) {
    switch (range[1]) {
      case '<=':
        return env.width <= px;
      case '<':
        return env.width < px;
      case '>=':
        return env.width >= px;
      default:
        return env.width > px;
    }
  }
  return true;
}

/**
 * Whether an at-rule around a rule applies in `env`. An `@media` query
 * list holds when any of its queries does; a query is its terms joined by
 * `and`, optionally led by `only` or by `not`, which negates it. Any other
 * at-rule (`@supports`, `@layer`) is taken to apply.
 * @param {string} atRule Normalised (`normalizeAtRule`).
 * @param {{ width: number, scheme: string, motion: string }} env
 * @returns {boolean}
 */
function atRuleApplies(atRule, env) {
  if (!atRule.startsWith('@media ')) return true;
  return splitCssList(atRule.slice('@media '.length)).some((query) => {
    let text = query.trim();
    const negated = text.startsWith('not ');
    if (negated) text = text.slice('not '.length);
    else if (text.startsWith('only ')) text = text.slice('only '.length);
    const holds = text.split(' and ').every((term) => mediaTermHolds(term.trim(), env));
    return negated ? !holds : holds;
  });
}

/* JavaScript source scanner                                                 */

/** Characters that end a `//` comment or an unterminated literal, and allow ASI. */
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;

/** Punctuators, longest first, so the scanner always takes the longest one. */
const JS_PUNCTUATORS = Object.freeze([
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '**',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.',
]);

/**
 * Punctuators after which an expression begins, so a `/` opens a regular
 * expression: `x = /re/`, `f(/re/)`, `a || /re/`, `{ /re/ }`. The closers,
 * `++`/`--` and the member accessors are decided by their role instead.
 */
const EXPRESSION_AFTER_PUNCTUATOR = new Set(
  JS_PUNCTUATORS.filter((punct) => ![')', ']', '}', '++', '--', '.', '?.'].includes(punct)),
);

/**
 * ES5 keywords and reserved words that never end an expression, so a `/`
 * after one cannot divide: `return /re/`, `else /re/`. `this`, `null`,
 * `true`, `false` and `super` are values, and contextual words such as
 * `let`, `yield` and `of` can be names, so a `/` after them divides.
 */
const JS_RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'return', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

/** Keywords whose parenthesised head is followed by a statement: `if (ok) /re/.test(s);`. */
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);

/** Keywords after which `{` opens a block. */
const BLOCK_AFTER_KEYWORD = new Set(['else', 'do', 'try', 'finally', 'catch']);

/** Keywords after which `{` opens an object literal. */
const OBJECT_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'extends',
]);

/** Keywords a line terminator ends the statement after (restricted productions). */
const RESTRICTED_KEYWORDS = new Set(['return', 'break', 'continue', 'throw']);

/** `{` roles whose contents are statements. */
const STATEMENT_LIST_BRACES = new Set(['block', 'function-decl', 'function-expr']);

/** `{` roles whose `}` ends a statement, so a `/` after it opens a regular expression. */
const STATEMENT_END_BRACES = new Set(['block', 'function-decl']);

const OPENER_OF = Object.freeze({ ')': '(', ']': '[', '}': '{' });

/** Escapes in a string literal: `\u{…}`, `\uXXXX`, `\xXX`, octal, line continuations, single characters. */
const JS_STRING_ESCAPE_RE = new RegExp(
  [
    String.raw`\\(?:u\{([0-9a-fA-F]+)\}`,
    String.raw`u([0-9a-fA-F]{4})`,
    String.raw`x([0-9a-fA-F]{2})`,
    String.raw`([0-3][0-7]{0,2}|[4-7][0-7]?)`,
    String.raw`(\r\n|[\n\r\u2028\u2029])`,
    String.raw`([\s\S]))`,
  ].join('|'),
  'g',
);

/** Unicode escapes in an identifier: `\u{…}` and `\uXXXX`. */
const JS_NAME_ESCAPE_RE = /\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g;

/** Values of the single-character escapes; any other escaped character stands for itself. */
const JS_SINGLE_ESCAPES = Object.freeze({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' });

/** A numeric literal, with any modern prefix, separator, BigInt suffix or trailing name characters. */
const JS_NUMBER_RE = /(?:0[xXoObB][0-9a-fA-F_]*|(?:[0-9][0-9_]*\.?[0-9_]*|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]*)?)[\w$]*/y;

/** Characters that may start a name, and that may continue one. */
const JS_NAME_START_RE = /[$_\p{ID_Start}]/u;
const JS_NAME_PART_RE = /[$\u200c\u200d\p{ID_Continue}]/u;

/** A unicode escape at the start of the text, as a name may contain. */
const JS_NAME_ESCAPE_AT_RE = /\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/y;

/**
 * @typedef {object} JsFrame An open bracket, or the script itself.
 * @property {'top' | '(' | '[' | '{'} kind
 * @property {string} role
 *   `top`: `block`. `(`: `control` (the head of `if`, `while`, `for`,
 *   `with`, `switch` or `catch`), `params` (a function's parameters) or
 *   `expr`. `[`: `array` (a literal) or `member` (`x[k]`). `{`: `block`,
 *   `function-decl` or `function-expr` (a function body), `object` (a
 *   literal) or `unknown`.
 * @property {number} open Index of the opening token; -1 for the script.
 * @property {number} ternary `?` directly inside not yet matched by a `:`.
 * @property {string} fn For `params`, the role of the body `{` after it.
 */

/**
 * @typedef {object} JsToken
 * @property {'name' | 'punct' | 'string' | 'number' | 'regex' | 'template' | 'private' | 'hashbang'} kind
 * @property {string} value Names and strings with every escape resolved;
 *   the source text otherwise.
 * @property {string} raw The source text, `src.slice(start, end)`.
 * @property {number} start Offset in the source.
 * @property {number} end Exclusive end offset.
 * @property {boolean} nl A line terminator separates it from the token before.
 * @property {boolean} codePointEscape The name or string uses a `\u{…}` escape.
 * @property {string} flags The flags of a regular-expression literal; `''` otherwise.
 * @property {boolean} property A name read after `.` or `?.`.
 * @property {boolean} propertyStart The first token of an object-literal property.
 * @property {boolean} key A name that is an object-literal key, shorthand included.
 * @property {string} role For a bracket, the role of the bracket pair;
 *   for `:` `ternary`, `property`, `label` or `expr`; for `++`/`--`
 *   `prefix` or `postfix`; `''` otherwise.
 * @property {string} fn For the `)` of a parameter list, the role of the body.
 * @property {number} match For a bracket, the index of its partner; -1 when unmatched.
 * @property {JsFrame} frame The innermost bracket the token sits in; for a
 *   bracket, the one around the pair.
 */

/**
 * The value of a string literal's body, between its quotes: every escape
 * resolved, a backslash before a line terminator dropped (a line
 * continuation) and legacy octal escapes read as octal.
 * @param {string} body
 * @returns {{ value: string, codePointEscape: boolean }}
 */
function decodeJsString(body) {
  let codePointEscape = false;
  const value = body.replace(JS_STRING_ESCAPE_RE, (escape, braced, u4, x2, octal, continuation, single) => {
    if (braced !== undefined) {
      codePointEscape = true;
      const codePoint = Number.parseInt(braced, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
    }
    if (u4 !== undefined) return String.fromCharCode(Number.parseInt(u4, 16));
    if (x2 !== undefined) return String.fromCharCode(Number.parseInt(x2, 16));
    if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8));
    if (continuation !== undefined) return '';
    return Object.hasOwn(JS_SINGLE_ESCAPES, single) ? JS_SINGLE_ESCAPES[single] : single;
  });
  return { value, codePointEscape };
}

/**
 * The name an identifier spells, its unicode escapes resolved, so
 * `inner\u0048TML` reads as `innerHTML`.
 * @param {string} raw
 * @returns {{ value: string, codePointEscape: boolean }}
 */
function decodeJsName(raw) {
  let codePointEscape = false;
  const value = raw.replace(JS_NAME_ESCAPE_RE, (escape, braced, u4) => {
    if (braced === undefined) return String.fromCharCode(Number.parseInt(u4, 16));
    codePointEscape = true;
    const codePoint = Number.parseInt(braced, 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
  });
  return { value, codePointEscape };
}

/**
 * Splits JavaScript source into tokens the way a parser's lexer does, for
 * the hand-written ES5 this suite checks. Comments, the `<!--` and
 * line-leading `-->` forms classic scripts allow included, yield no token,
 * so nothing written in one is ever read as code.
 *
 * Whether a `/` opens a regular-expression literal or divides depends on
 * the role of the token before it, which a bracket stack tracks:
 *   - it opens one after an operator, `(`, `[`, `{`, `,`, `;`, `:`, a
 *     keyword such as `return` or `else`, the `)` of an `if`, `while`,
 *     `for` or `with` head (`if (ok) /re/.test(s)`), and the `}` of a block
 *     or a function declaration;
 *   - it divides after a name, a literal, `]`, any other `)`, a postfix
 *     `++`/`--`, and the `}` of an object literal or a function expression
 *     (`{} / 2`, `function () {} / 2`).
 * A `{` is a block, a function body or an object literal by what precedes
 * it. One the scanner cannot place is `unknown`, and its `}` is read as
 * ending an expression, so an ambiguous `/` divides: misreading a regular
 * expression as division can only fail a check, while the opposite could
 * hide code inside a literal.
 *
 * This is a tokenizer for checking hand-written ES5, not a parser; the
 * source is also compiled with `node:vm` so a syntax error is caught
 * separately.
 * @param {string} src
 * @returns {JsToken[]}
 */
function scanJs(src) {
  const n = src.length;
  /** @type {JsToken[]} */
  const tokens = [];
  /** @type {JsFrame[]} */
  const frames = [{ kind: 'top', role: 'block', open: -1, ternary: 0, fn: '' }];
  /** The previous token, which decides what a `/`, `(`, `[` or `{` means. */
  let prev = null;
  /** Whether a line terminator has been passed since `prev`. */
  let nl = false;
  /** Body role of a `function` whose parameter list has not opened yet. */
  let pendingFunction = '';
  let i = 0;

  const current = () => frames[frames.length - 1];

  /** Whether `token` can be the last token of an expression. */
  const endsExpression = (token) => {
    switch (token.kind) {
      case 'name':
        return token.property || !JS_RESERVED_WORDS.has(token.value);
      case 'punct':
        if (token.value === ')') return token.role !== 'control';
        if (token.value === ']') return true;
        if (token.value === '}') return token.role === 'object' || token.role === 'function-expr';
        return (token.value === '++' || token.value === '--') && token.role === 'postfix';
      case 'hashbang':
        return false;
      default:
        return true;
    }
  };

  /** Whether the next token starts a statement. */
  const statementStart = () => {
    if (prev === null || prev.kind === 'hashbang') return true;
    if (prev.kind === 'punct') {
      if (prev.value === ';') return current().kind !== '(';
      if (prev.value === '{') return STATEMENT_LIST_BRACES.has(prev.role);
      if (prev.value === '}') return STATEMENT_END_BRACES.has(prev.role);
      if (prev.value === ':') return prev.role === 'label';
      if (prev.value === ')' && prev.role === 'control') return true;
    } else if (prev.kind === 'name' && !prev.property) {
      if (prev.value === 'else' || prev.value === 'do') return true;
      if (nl && RESTRICTED_KEYWORDS.has(prev.value)) return true;
    }
    // Automatic semicolon insertion before a token that cannot continue the line.
    return nl && endsExpression(prev);
  };

  /** Whether a `/` here opens a regular-expression literal. */
  const regexAllowed = () => {
    if (prev === null) return true;
    switch (prev.kind) {
      case 'hashbang':
        return true;
      case 'name':
        return !prev.property && JS_RESERVED_WORDS.has(prev.value);
      case 'punct':
        if (prev.value === ')') return prev.role === 'control';
        if (prev.value === '}') return STATEMENT_END_BRACES.has(prev.role);
        if (prev.value === '++' || prev.value === '--') return prev.role === 'prefix';
        return EXPRESSION_AFTER_PUNCTUATOR.has(prev.value);
      default:
        return false;
    }
  };

  /** The role of a `{` here. */
  const braceRole = () => {
    if (prev !== null && prev.kind === 'punct') {
      if (prev.value === ')' && prev.role === 'params') return prev.fn;
      if (prev.value === '=>') return 'function-expr';
    }
    if (statementStart()) return 'block';
    if (prev.kind === 'name' && !prev.property) {
      if (BLOCK_AFTER_KEYWORD.has(prev.value)) return 'block';
      if (OBJECT_AFTER_KEYWORD.has(prev.value)) return 'object';
      return 'unknown';
    }
    return prev.kind === 'punct' && EXPRESSION_AFTER_PUNCTUATOR.has(prev.value) ? 'object' : 'unknown';
  };

  /** The role of a `(` here. */
  const parenRole = () => {
    if (pendingFunction !== '') return 'params';
    if (prev !== null && prev.kind === 'name' && !prev.property && CONTROL_KEYWORDS.has(prev.value)) {
      return 'control';
    }
    return 'expr';
  };

  /** Offset just past a name starting at `from`; `from` itself when none starts there. */
  const nameEnd = (from) => {
    let end = from;
    while (end < n) {
      if (src[end] === '\\') {
        JS_NAME_ESCAPE_AT_RE.lastIndex = end;
        const escape = JS_NAME_ESCAPE_AT_RE.exec(src);
        if (escape === null) break;
        end += escape[0].length;
        continue;
      }
      const char = String.fromCodePoint(src.codePointAt(end));
      if (!(end === from ? JS_NAME_START_RE : JS_NAME_PART_RE).test(char)) break;
      end += char.length;
    }
    return end;
  };

  /** Offset of the line terminator that ends the line holding `from`, or the end of the source. */
  const lineEnd = (from) => {
    let end = from;
    while (end < n && !LINE_TERMINATOR_RE.test(src[end])) end += 1;
    return end;
  };

  /**
   * Records a token: assigns bracket, `:` and `++`/`--` roles, keeps the
   * bracket stack, and makes the token the one the next is read against.
   * @param {Pick<JsToken, 'kind' | 'value' | 'start' | 'end'> & Partial<JsToken>} fields
   */
  const push = (fields) => {
    const index = tokens.length;
    const afterAccessor = prev !== null && prev.kind === 'punct' && (prev.value === '.' || prev.value === '?.');
    /** @type {JsToken} */
    const token = {
      codePointEscape: false,
      flags: '',
      ...fields,
      raw: src.slice(fields.start, fields.end),
      nl,
      property: fields.kind === 'name' && afterAccessor,
      propertyStart: false,
      key: false,
      role: '',
      fn: '',
      match: -1,
      frame: current(),
    };
    const startsFunction = token.kind === 'name' && !token.property && token.value === 'function';
    const functionRole = startsFunction ? (statementStart() ? 'function-decl' : 'function-expr') : '';
    /** @type {JsFrame | null} */
    let opened = null;
    if (token.kind === 'punct') {
      const { value } = token;
      if (value === '(') {
        const role = parenRole();
        opened = { kind: '(', role, open: index, ternary: 0, fn: role === 'params' ? pendingFunction : '' };
      } else if (value === '[') {
        opened = { kind: '[', role: regexAllowed() ? 'array' : 'member', open: index, ternary: 0, fn: '' };
      } else if (value === '{') {
        opened = { kind: '{', role: braceRole(), open: index, ternary: 0, fn: '' };
      } else if (Object.hasOwn(OPENER_OF, value)) {
        const frame = current();
        if (frame.kind === OPENER_OF[value]) {
          frames.pop();
          token.role = frame.role;
          token.fn = frame.fn;
          token.match = frame.open;
          tokens[frame.open].match = index;
        } else {
          token.role = 'unknown';
        }
        token.frame = current();
      } else if (value === '?') {
        current().ternary += 1;
      } else if (value === ':') {
        const frame = current();
        if (frame.ternary > 0) {
          frame.ternary -= 1;
          token.role = 'ternary';
        } else if (frame.kind === '{' && frame.role === 'object') {
          token.role = 'property';
        } else if (frame.kind === 'top' || (frame.kind === '{' && STATEMENT_LIST_BRACES.has(frame.role))) {
          token.role = 'label';
        } else {
          token.role = 'expr';
        }
      } else if (value === '++' || value === '--') {
        token.role = !nl && prev !== null && endsExpression(prev) ? 'postfix' : 'prefix';
      }
    }
    if (opened !== null) {
      token.role = opened.role;
      frames.push(opened);
    }
    if (startsFunction) {
      pendingFunction = functionRole;
    } else if (!(token.kind === 'name' || (token.kind === 'punct' && token.value === '*'))) {
      // Only a name or `*` may sit between `function` and its parameter list.
      pendingFunction = '';
    }
    tokens.push(token);
    prev = token;
    nl = false;
  };

  while (i < n) {
    const ch = src[i];

    if (LINE_TERMINATOR_RE.test(ch)) {
      nl = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // Comments never begin a regular expression, and leave no token.
    if (
      (ch === '/' && src[i + 1] === '/') ||
      src.startsWith('<!--', i) ||
      (src.startsWith('-->', i) && (nl || prev === null))
    ) {
      i = lineEnd(i);
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      if (LINE_TERMINATOR_RE.test(src.slice(i, end))) nl = true;
      i = end;
      continue;
    }

    if (i === 0 && src.startsWith('#!')) {
      const end = lineEnd(0);
      push({ kind: 'hashbang', value: src.slice(0, end), start: 0, end });
      i = end;
      continue;
    }

    // Strings: a backslash escapes the next character; `\` + CRLF continues the line.
    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < n && src[end] !== ch && !LINE_TERMINATOR_RE.test(src[end])) {
        if (src[end] === '\\') {
          end += src[end + 1] === '\r' && src[end + 2] === '\n' ? 3 : 2;
        } else {
          end += 1;
        }
      }
      end = Math.min(end, n);
      const stop = end < n && src[end] === ch ? end + 1 : end;
      const { value, codePointEscape } = decodeJsString(src.slice(i + 1, end));
      push({ kind: 'string', value, start: i, end: stop, codePointEscape });
      i = stop;
      continue;
    }

    // Template literals: ES5 has none, so the whole literal is one token the rules reject.
    if (ch === '`') {
      let end = i + 1;
      while (end < n && src[end] !== '`') end += src[end] === '\\' ? 2 : 1;
      const stop = Math.min(end + 1, n);
      push({ kind: 'template', value: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }

    // Regular-expression literals run to the next unescaped `/` outside a `[…]` class.
    if (ch === '/' && regexAllowed()) {
      let end = i + 1;
      let inClass = false;
      while (end < n && !LINE_TERMINATOR_RE.test(src[end])) {
        const c = src[end];
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
      const flagsStart = end < n && src[end] === '/' ? end + 1 : end;
      let stop = flagsStart;
      while (stop < n && /[\w$]/.test(src[stop])) stop += 1;
      push({ kind: 'regex', value: src.slice(i, stop), start: i, end: stop, flags: src.slice(flagsStart, stop) });
      i = stop;
      continue;
    }

    // Names and keywords, unicode escapes included.
    const end = nameEnd(i);
    if (end > i) {
      const { value, codePointEscape } = decodeJsName(src.slice(i, end));
      push({ kind: 'name', value, start: i, end, codePointEscape });
      i = end;
      continue;
    }

    // Numbers, including `.5`, `1e3` and `0x1F`, and the modern forms the rules reject.
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      JS_NUMBER_RE.lastIndex = i;
      const stop = i + JS_NUMBER_RE.exec(src)[0].length;
      push({ kind: 'number', value: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }

    // `#name` is a private name; a lone `#` is a stray character.
    if (ch === '#' && nameEnd(i + 1) > i + 1) {
      const stop = nameEnd(i + 1);
      push({ kind: 'private', value: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }

    // Punctuators, longest first. `?.` before a digit is `?` and a number: `a?.5:b`.
    let punct = JS_PUNCTUATORS.find((candidate) => src.startsWith(candidate, i)) ?? ch;
    if (punct === '?.' && /[0-9]/.test(src[i + 2] ?? '')) punct = '?';
    push({ kind: 'punct', value: punct, start: i, end: i + punct.length });
    i += punct.length;
  }

  // Object-literal properties: the token that starts each one, and the key
  // that follows `get` or `set` in an accessor.
  tokens.forEach((token, index) => {
    const { frame } = token;
    if (frame.kind !== '{' || frame.role !== 'object') return;
    const before = tokens[index - 1];
    if (before !== tokens[frame.open] && !(isPunct(before, ',') && before.frame === frame)) return;
    token.propertyStart = true;
    if (token.kind === 'name') token.key = true;
    const next = tokens[index + 1];
    if (
      token.kind === 'name' &&
      (token.raw === 'get' || token.raw === 'set') &&
      next !== undefined &&
      ['name', 'string', 'number'].includes(next.kind)
    ) {
      next.key = true;
    }
  });
  return tokens;
}

/**
 * Whether `token` is the punctuator `value`.
 * @param {JsToken | undefined} token
 * @param {string} value
 * @returns {boolean}
 */
function isPunct(token, value) {
  return token !== undefined && token.kind === 'punct' && token.value === value;
}

/**
 * Whether `token` is the name `word` used as a keyword or a variable: not a
 * property after `.` and not an object-literal key, where ES5 allows any
 * name (`a.class`, `{ class: 1 }`).
 * @param {JsToken | undefined} token
 * @param {string} word
 * @returns {boolean}
 */
function isWord(token, word) {
  return token !== undefined && token.kind === 'name' && !token.property && !token.key && token.value === word;
}

/**
 * Whether `token` can be an object-literal key: a name, a string or a number.
 * @param {JsToken | undefined} token
 * @returns {boolean}
 */
function isKeyToken(token) {
  return token !== undefined && ['name', 'string', 'number'].includes(token.kind);
}

/**
 * Whether the token at `index` is the `of` of a `for (x of y)` loop.
 * @param {JsToken[]} tokens
 * @param {number} index
 * @returns {boolean}
 */
function isForOf(tokens, index) {
  const token = tokens[index];
  if (!isWord(token, 'of')) return false;
  const { frame } = token;
  if (frame.kind !== '(' || frame.role !== 'control' || !isWord(tokens[frame.open - 1], 'for')) return false;
  const before = tokens[index - 1];
  return (
    (before.kind === 'name' && !['var', 'let', 'const'].some((word) => isWord(before, word))) ||
    isPunct(before, ']') ||
    isPunct(before, '}')
  );
}

/**
 * Whether the `[` or `{` at `index` opens a destructuring pattern: after
 * `var`, `let` or `const`; as a parameter or `catch` binding; or an array or
 * object literal that is assigned to (`[a, b] = c`, `({ a } = o)`) or is
 * the target of a `for…in`/`for…of` head.
 * @param {JsToken[]} tokens
 * @param {number} index
 * @returns {boolean}
 */
function isDestructuring(tokens, index) {
  const token = tokens[index];
  if (!isPunct(token, '[') && !isPunct(token, '{')) return false;
  const before = tokens[index - 1];
  if (['var', 'let', 'const'].some((word) => isWord(before, word))) return true;
  const { frame } = token;
  const inFor = frame.kind === '(' && frame.role === 'control' && isWord(tokens[frame.open - 1], 'for');
  if (
    frame.kind === '(' &&
    (frame.role === 'params' || (frame.role === 'control' && isWord(tokens[frame.open - 1], 'catch')))
  ) {
    return true;
  }
  if ((token.role !== 'array' && token.role !== 'object') || token.match === -1) return false;
  const after = tokens[token.match + 1];
  if (isPunct(after, '=')) return true;
  return inFor && before === tokens[frame.open] && (isWord(after, 'in') || isWord(after, 'of'));
}

/**
 * Syntax ES5 does not have, found on the token stream of `blog/search.js`:
 * comments, string contents and regular-expression bodies never count, and
 * a keyword used as a property name (`a.class`, `{ class: 1 }`) is allowed
 * because ES5 allows it. `node:vm` compiles any syntax the running Node
 * supports, so these rules are what hold the file to ES5. Each rule is a
 * name and a test of the token at `index`.
 * @type {readonly (readonly [string, (tokens: JsToken[], index: number) => boolean])[]}
 */
const ES5_RULES = Object.freeze([
  ['`let` declaration', (t, i) => isWord(t[i], 'let')],
  ['`const` declaration', (t, i) => isWord(t[i], 'const')],
  ['arrow function', (t, i) => isPunct(t[i], '=>')],
  ['template literal', (t, i) => t[i].kind === 'template'],
  ['`class`', (t, i) => isWord(t[i], 'class')],
  ['`async`', (t, i) => isWord(t[i], 'async')],
  ['`await`', (t, i) => isWord(t[i], 'await')],
  ['spread or rest `...`', (t, i) => isPunct(t[i], '...')],
  ['`for…of` loop', isForOf],
  ['optional chaining `?.`', (t, i) => isPunct(t[i], '?.')],
  ['nullish coalescing `??`', (t, i) => isPunct(t[i], '??')],
  ['logical assignment `??=`, `||=` or `&&=`', (t, i) => ['??=', '||=', '&&='].some((op) => isPunct(t[i], op))],
  ['exponentiation `**`', (t, i) => isPunct(t[i], '**') || isPunct(t[i], '**=')],
  ['default parameter', (t, i) => isPunct(t[i], '=') && t[i].frame.kind === '(' && t[i].frame.role === 'params'],
  ['destructuring pattern', isDestructuring],
  [
    'shorthand property',
    (t, i) => t[i].propertyStart && isKeyToken(t[i]) && [',', '}', '='].some((punct) => isPunct(t[i + 1], punct)),
  ],
  ['method definition', (t, i) => t[i].propertyStart && isKeyToken(t[i]) && isPunct(t[i + 1], '(')],
  [
    'computed property name',
    (t, i) =>
      isPunct(t[i], '[') &&
      (t[i].propertyStart || (t[i - 1]?.propertyStart === true && (t[i - 1].raw === 'get' || t[i - 1].raw === 'set'))),
  ],
  ['generator `*`', (t, i) => isPunct(t[i], '*') && (isWord(t[i - 1], 'function') || t[i].propertyStart)],
  ['binary or octal literal `0b`/`0o`', (t, i) => t[i].kind === 'number' && /^0[bBoO]/.test(t[i].raw)],
  ['numeric separator `_`', (t, i) => t[i].kind === 'number' && t[i].raw.includes('_')],
  ['BigInt literal', (t, i) => t[i].kind === 'number' && /n$/.test(t[i].raw)],
  ['legacy octal or leading-zero number', (t, i) => t[i].kind === 'number' && /^0[0-9]/.test(t[i].raw)],
  ['regular-expression flag other than g, i, m', (t, i) => t[i].kind === 'regex' && /[^gim]/.test(t[i].flags)],
  ['code point escape `\\u{…}`', (t, i) => t[i].codePointEscape],
  ['`new.target`', (t, i) => isWord(t[i], 'new') && isPunct(t[i + 1], '.')],
  ['`import`', (t, i) => isWord(t[i], 'import')],
  ['optional `catch` binding', (t, i) => isWord(t[i], 'catch') && isPunct(t[i + 1], '{')],
  ['trailing comma before `)`', (t, i) => isPunct(t[i], ',') && isPunct(t[i + 1], ')')],
  ['private name or hashbang `#`', (t, i) => t[i].kind === 'private' || t[i].kind === 'hashbang' || isPunct(t[i], '#')],
]);

/**
 * The first token each ES5 rule rejects, in rule order.
 * @param {JsToken[]} tokens
 * @returns {{ what: string, token: JsToken }[]} Empty when the source is ES5.
 */
function es5Violations(tokens) {
  const found = [];
  for (const [what, breaks] of ES5_RULES) {
    const index = tokens.findIndex((token, at) => breaks(tokens, at));
    if (index !== -1) found.push({ what, token: tokens[index] });
  }
  return found;
}

/**
 * The static string an expression starting at `index` spells: one string
 * literal, or several joined by `+` (`'inner' + 'HTML'`).
 * @param {JsToken[]} tokens
 * @param {number} index
 * @returns {{ value: string, end: number } | null} `end` indexes the token after the last literal.
 */
function staticString(tokens, index) {
  if (tokens[index]?.kind !== 'string') return null;
  let { value } = tokens[index];
  let end = index + 1;
  while (isPunct(tokens[end], '+') && tokens[end + 1]?.kind === 'string') {
    value += tokens[end + 1].value;
    end += 2;
  }
  return { value, end };
}

/**
 * The name an access chain ends with at `index`: a name (`document`,
 * `window.document`) or a static bracket key (`self['document']`); `''`
 * for anything else.
 * @param {JsToken[]} tokens
 * @param {number} index
 * @returns {string}
 */
function accessedName(tokens, index) {
  const token = tokens[index];
  if (token === undefined) return '';
  if (token.kind === 'name') return token.value;
  if (isPunct(token, ']') && token.role === 'member') {
    const key = staticString(tokens, token.match + 1);
    if (key !== null && key.end === index) return key.value;
  }
  return '';
}

const SINK_KINDS = Object.freeze([
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval',
  'new Function',
]);

/** Names that are a sink wherever they appear, as a variable or a property. */
const SINK_NAMES = Object.freeze({
  innerHTML: 'innerHTML',
  outerHTML: 'outerHTML',
  insertAdjacentHTML: 'insertAdjacentHTML',
  eval: 'eval',
  Function: 'new Function',
});

/** Properties that are a sink when read from `document`, by dot or as a bracket key. */
const DOCUMENT_WRITE_NAMES = new Set(['write', 'writeln']);

/**
 * The name of the object a member access at `accessor` reads from: the
 * access chain (`accessedName`) just before its `.`, `?.` or `[`, stepping
 * over the `?.` of `x?.[k]`.
 * @param {JsToken[]} tokens
 * @param {number} accessor Index of the `.`, `?.` or `[` token.
 * @returns {string}
 */
function receiverName(tokens, accessor) {
  const at = isPunct(tokens[accessor], '[') && isPunct(tokens[accessor - 1], '?.') ? accessor - 2 : accessor - 1;
  return accessedName(tokens, at);
}

/**
 * The static key of a bracket member access whose key starts at the string
 * token at `index`, as in `el['inner' + 'HTML']`, with the index of its
 * `[`; `null` when the string is not such a key.
 * @param {JsToken[]} tokens
 * @param {number} index
 * @returns {{ key: string, open: number } | null}
 */
function bracketKey(tokens, index) {
  const open = index - 1;
  const bracket = tokens[open];
  if (!isPunct(bracket, '[') || bracket.role !== 'member' || bracket.match === -1) return null;
  const key = staticString(tokens, index);
  return key !== null && key.end === bracket.match ? { key: key.value, open } : null;
}

/** Sink names inside the text of a string, regular-expression or template literal. */
const SINK_TEXT_PATTERNS = Object.freeze([
  ['innerHTML', /\binnerHTML\b/],
  ['outerHTML', /\bouterHTML\b/],
  ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
  ['document.write', /\bdocument\s*\.\s*write/],
  ['eval', /\beval\b/],
  ['new Function', /\bnew\s+Function\b/],
]);

/**
 * Uses of the sinks that write markup or evaluate strings as code, found
 * lexically on the token stream, so comments never count. The plan names
 * `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and
 * `new Function`; `outerHTML` is checked as well because it is the same
 * kind of sink, and search output must be text only. These static
 * spellings count:
 *   - A sink name, its escapes resolved (`inner\u0048TML`), anywhere: as a
 *     variable, a property after `.` or `?.`, or an object key. The names
 *     are `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` (`eval(s)`,
 *     `window.eval`, `(0, eval)`) and `Function` (`Function(s)`,
 *     `new window.Function(s)`).
 *   - A bracket key that is one string literal, or string literals joined
 *     by `+`, read decoded: `el['innerHTML']`, `window['ev' + 'al']`,
 *     `self['Function']`.
 *   - `write` and `writeln` only as members of `document`, by `.`, `?.` or
 *     such a bracket key, with `document` reached by name, a dot chain or
 *     such a bracket key (`window.document.write`, `self['document'].write`,
 *     `document['wr' + 'ite']`); `stream.write`, `stream['write']` and the
 *     text `"write"` are not sinks.
 *   - A sink name in the decoded text of a string literal, alone or joined
 *     by `+`, or in the source text of a regular expression or template.
 * Nothing is followed through a variable, a call, parentheses or any other
 * value known only at run time, so aliases and computed keys pass:
 * `var d = document; d.write(s)`, `el[a + b]` with variable parts,
 * `window[['ev', 'al'].join('')](s)`, `(document).write(s)`. Other APIs
 * that parse markup or run strings, such as a string passed to
 * `setTimeout`, are not on the list. The check holds `search.js` to a way
 * of writing; it is no proof of XSS safety, and its input-to-sink paths
 * still need review by reading.
 * @param {JsToken[]} tokens
 * @returns {{ what: string, token: JsToken }[]} The first token of each sink, in `SINK_KINDS` order.
 */
function unsafeSinks(tokens) {
  /** @type {Map<string, JsToken>} */
  const first = new Map();
  const note = (what, token) => {
    if (!first.has(what)) first.set(what, token);
  };
  const inspectText = (text, token) => {
    for (const [what, re] of SINK_TEXT_PATTERNS) if (re.test(text)) note(what, token);
  };
  tokens.forEach((token, index) => {
    if (token.kind === 'name') {
      if (Object.hasOwn(SINK_NAMES, token.value)) note(SINK_NAMES[token.value], token);
      if (token.property && DOCUMENT_WRITE_NAMES.has(token.value) && receiverName(tokens, index - 1) === 'document') {
        note('document.write', token);
      }
    } else if (token.kind === 'string') {
      inspectText(token.value, token);
      const joined = staticString(tokens, index);
      if (joined.end > index + 1) inspectText(joined.value, token);
      const member = bracketKey(tokens, index);
      if (member !== null) {
        if (Object.hasOwn(SINK_NAMES, member.key)) note(SINK_NAMES[member.key], token);
        if (DOCUMENT_WRITE_NAMES.has(member.key) && receiverName(tokens, member.open) === 'document') {
          note('document.write', token);
        }
      }
    } else if (token.kind === 'regex' || token.kind === 'template') {
      inspectText(token.raw, token);
    }
  });
  return SINK_KINDS.filter((what) => first.has(what)).map((what) => ({ what, token: first.get(what) }));
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
 * Failure lines for findings, each located in the source.
 * @param {{ what: string, token: JsToken }[]} found
 * @param {string} src
 * @returns {string[]}
 */
function located(found, src) {
  return found.map(({ what, token }) => `${what} at ${locate(src, token.start)}`);
}

/**
 * Whether `token` would continue an expression that ends just before it on
 * the previous line, so no semicolon is inserted between them:
 * an operator, `(`, `[`, `.`, a template, or `in`/`instanceof`. `++`, `--`,
 * `!`, `~`, `{`, `}`, `;`, names and literals start a new statement.
 * @param {JsToken | undefined} token
 * @returns {boolean}
 */
function continuesExpression(token) {
  if (token === undefined) return false;
  if (token.kind === 'punct') return !['++', '--', '!', '~', '{', '}', ';'].includes(token.value);
  if (token.kind === 'name') return isWord(token, 'in') || isWord(token, 'instanceof');
  return token.kind === 'template';
}

/**
 * Whether the directive prologue of the function body between the tokens
 * at `from` and `to` (exclusive, the closing `}`) holds an exact
 * `"use strict"` or `'use strict'` directive, written without escapes. The
 * prologue is the run of statements at the start of the body that are a
 * string literal alone: one followed by `;`, by the end of the body, or by
 * a line break before a token that cannot continue it. `"use strict" + x`,
 * `"use strict".length`, `"use strict"(x)` and a `"use strict"` continued
 * on the next line are expressions, not directives, and end the prologue.
 * @param {JsToken[]} tokens
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
function hasStrictDirective(tokens, from, to) {
  let index = from;
  while (index < to && tokens[index].kind === 'string') {
    const next = tokens[index + 1];
    const standalone = index + 1 === to || isPunct(next, ';') || (next.nl && !continuesExpression(next));
    if (!standalone) return false;
    if (tokens[index].raw === '"use strict"' || tokens[index].raw === "'use strict'") return true;
    index += isPunct(next, ';') ? 2 : 1;
  }
  return false;
}

/**
 * Whether the source is one strict-mode IIFE and nothing else, so no helper
 * or state becomes a global: an optional leading `;`, then
 * `(function name? (params) { BODY })(args)` or
 * `(function name? (params) { BODY }(args))`, then an optional `;` and only
 * comments or whitespace. `BODY` must open with a `"use strict"` directive
 * (`hasStrictDirective`). A script-level `"use strict"` without the wrapper,
 * a wrapper that is never called, and a statement after the call all fail.
 * @param {JsToken[]} tokens
 * @returns {boolean}
 */
function isStrictScript(tokens) {
  const first = isPunct(tokens[0], ';') ? 1 : 0;
  const outer = tokens[first];
  if (!isPunct(outer, '(') || outer.match === -1 || !isWord(tokens[first + 1], 'function')) return false;
  let at = first + 2;
  if (tokens[at]?.kind === 'name') at += 1;
  const params = tokens[at];
  if (!isPunct(params, '(') || params.match === -1) return false;
  const bodyAt = params.match + 1;
  const body = tokens[bodyAt];
  if (!isPunct(body, '{') || body.match === -1) return false;
  let after;
  if (body.match + 1 === outer.match) {
    // `(function () { … })(args)`
    const args = tokens[outer.match + 1];
    if (!isPunct(args, '(') || args.match === -1) return false;
    after = args.match + 1;
  } else {
    // `(function () { … }(args))`
    const args = tokens[body.match + 1];
    if (!isPunct(args, '(') || args.match === -1 || args.match + 1 !== outer.match) return false;
    after = outer.match + 1;
  }
  if (isPunct(tokens[after], ';')) after += 1;
  return after === tokens.length && hasStrictDirective(tokens, bodyAt + 1, body.match);
}

/* Home page navigation (index.html)                                         */

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

test('[AC-10][F-018] index.html is the pre-blog page plus only the Blog links and the mobile-menu nav element', (t) => {
  // latin1 maps each byte to one character, so the reversal and the digest are byte-exact.
  const current = readFileSync(abs('index.html')).toString('latin1');
  const restored = Buffer.from(undoHomeEdits(current), 'latin1');
  const digest = createHash('sha256').update(restored).digest('hex');
  if (restored.length !== PRE_BLOG_INDEX_BYTES || digest !== PRE_BLOG_INDEX_SHA256) {
    t.diagnostic(firstDifferenceFromPreBlog(restored));
  }
  assert.equal(
    restored.length,
    PRE_BLOG_INDEX_BYTES,
    `with the Blog edits reversed, index.html must be the ${PRE_BLOG_INDEX_BYTES}-byte pre-blog page ` +
      `(${PRE_BLOG_COMMIT})`,
  );
  assert.equal(
    digest,
    PRE_BLOG_INDEX_SHA256,
    `with the Blog edits reversed, index.html must be byte-identical to the pre-blog page (${PRE_BLOG_COMMIT})`,
  );
});

/* Header and footer fit rules (styles.css)                                  */

test('[AC-10][F-018] styles.css keeps the header and footer fit rules, with the navigation switch at 900px', () => {
  const rules = parseCss(read('styles.css'));
  const problems = [];
  const show = (value) => (value === undefined ? 'unset' : JSON.stringify(value));
  /** Records a mismatch between what a set of rules gives and what the plan requires. */
  const check = (where, selector, longhand, actual, value) => {
    if (actual === value) return;
    problems.push(`${where}: ${selector} ${longhand} is ${show(actual)}, expected ${show(value)}`);
  };

  // Where the plan puts each rule: the base state at the top level, the
  // switch in the 900px block and none of it left in the 720px block.
  const topLevel = (rule) => rule.context.length === 0;
  const onlyIn = (atRule) => (rule) => rule.context.length === 1 && rule.context[0] === atRule;
  for (const [selector, longhand, value] of [...FIT_RULES, ...NAV_WIDE]) {
    check('top level', selector, longhand, cascadeCss(rules, selector, longhand, topLevel), value);
  }
  for (const [selector, longhand, value] of NAV_NARROW) {
    const inSwitch = cascadeCss(rules, selector, longhand, onlyIn(NAV_SWITCH_MEDIA));
    check(NAV_SWITCH_MEDIA, selector, longhand, inSwitch, value);
    const leftBehind = cascadeCss(rules, selector, longhand, onlyIn(PRE_BLOG_SWITCH_MEDIA));
    check(PRE_BLOG_SWITCH_MEDIA, selector, longhand, leftBehind, undefined);
  }

  // What every rule that applies gives, at each width, scheme and motion
  // preference, so no other block or later rule undoes the fit.
  /** Failing environments per requirement. */
  const failures = new Map();
  for (const env of CSS_ENVIRONMENTS) {
    const applies = (rule) => rule.context.every((atRule) => atRuleApplies(atRule, env));
    const nav = env.width > NAV_SWITCH_WIDTH ? NAV_WIDE : NAV_NARROW;
    for (const [selector, longhand, value] of [...FIT_RULES, ...nav]) {
      const actual = cascadeCss(rules, selector, longhand, applies);
      if (actual === value) continue;
      const requirement = `${selector} ${longhand} must be ${show(value)}`;
      const found = `${env.width}px ${env.scheme} ${env.motion}: ${show(actual)}`;
      failures.set(requirement, [...(failures.get(requirement) ?? []), found]);
    }
  }
  for (const [requirement, where] of failures) {
    const more = where.length > 3 ? ` and ${where.length - 3} more` : '';
    problems.push(`${requirement}; found ${where.slice(0, 3).join(', ')}${more}`);
  }
  assert.deepEqual(problems, [], 'styles.css must keep the header and footer fit rules (AAP 0.4.2)');
});

test('[AC-10][F-018] the styles.css reader ignores comments, honours strings and applies the cascade', () => {
  const all = () => true;
  /** The stylesheet's cascaded value for `longhand` on `selector` at the top level. */
  const value = (css, selector, longhand) => cascadeCss(parseCss(css), selector, longhand, all);

  // Comments never count, inside a value or around a declaration.
  assert.equal(value('.a { /* display: none; */ display: flex; } /* .a { display: none } */', '.a', 'display'), 'flex');
  assert.equal(value('.a { white-space: /* wrap */ nowrap; }', '.a', 'white-space'), 'nowrap');
  assert.equal(value('.a { display: flex; /* white-space: nowrap; */ }', '.a', 'white-space'), undefined);
  // A comment splits the token it sits in, so a property, value, selector or
  // query split by one is not the one the fit rules require, as a browser reads it.
  assert.equal(value('.b { flex-/**/shrink: 0; }', '.b', 'flex-shrink'), undefined);
  assert.equal(value('.n { white-/**/space: nowrap; }', '.n', 'white-space'), undefined);
  assert.equal(value('.n { white-/**/space: nowrap; }', '.n', 'text-wrap-mode'), undefined);
  assert.equal(value('.n { white-space: now/**/rap; }', '.n', 'text-wrap-mode'), 'wrap');
  assert.equal(value('.nav/**/-links { white-space: nowrap; }', '.nav-links', 'white-space'), undefined);
  assert.deepEqual(parseCss('@media (max-/**/width: 900px) { .a { display: none; } }')[0].context, [
    '@media (max- width:900px)',
  ]);
  // Strings keep braces, semicolons and comment markers as text.
  const quoted = parseCss('.a::before { content: "} ; /* {"; display: none; } .b { display: block; }');
  assert.equal(cascadeCss(quoted, '.a::before', 'display', all), 'none');
  assert.equal(cascadeCss(quoted, '.b', 'display', all), 'block');
  assert.equal(quoted[0].declarations[0].value, '"} ; /* {"');
  // Nested at-rules are recorded outermost first, normalised.
  const nested = parseCss('@media ( max-width : 900px ) { @supports (display: grid) { .a { display: grid; } } }');
  assert.deepEqual(nested.map(({ context }) => context), [['@media (max-width:900px)', '@supports (display:grid)']]);
  // Selector lists split at top-level commas only; attribute quotes are normalised.
  assert.deepEqual(parseCss('.a, .b:is(.c, .d), .e[data-x="1,2"] { color: red; }')[0].selectors, [
    '.a',
    '.b:is(.c, .d)',
    '.e[data-x="1,2"]',
  ]);
  assert.equal(value(".m[data-open='true'] { display: flex; }", '.m[data-open="true"]', 'display'), 'flex');
  assert.equal(value('.m[ data-open = true ] { display: flex; }', '.m[data-open="true"]', 'display'), 'flex');
  // The cascade: the last declaration wins, and `!important` beats a later normal one.
  assert.equal(value('.a { display: block; display: flex; } .a { display: none; }', '.a', 'display'), 'none');
  assert.equal(value('.a { display: flex !important; } .a { display: none; }', '.a', 'display'), 'flex');
  assert.equal(value('.a { DISPLAY: Flex; }', '.a', 'display'), 'flex');
  // Shorthands set the longhands they cover.
  assert.equal(value('.f { flex-wrap: wrap; flex-flow: column; }', '.f', 'flex-wrap'), 'nowrap');
  assert.equal(value('.f { flex-flow: row wrap; }', '.f', 'flex-wrap'), 'wrap');
  assert.equal(value('.f { gap: 10px 24px; column-gap: 0; }', '.f', 'column-gap'), '0');
  assert.equal(value('.f { gap: 24px; }', '.f', 'row-gap'), '24px');
  assert.equal(value('.b { flex-shrink: 0; flex: 1; }', '.b', 'flex-shrink'), '1');
  assert.equal(value('.b { flex: 0 0 auto; }', '.b', 'flex-shrink'), '0');
  assert.equal(value('.b { flex: none; }', '.b', 'flex-shrink'), '0');
  assert.equal(value('.n { white-space: nowrap; text-wrap-mode: wrap; }', '.n', 'text-wrap-mode'), 'wrap');
  assert.equal(value('.n { white-space: nowrap; all: unset; }', '.n', 'white-space'), 'unset');
  // Media queries are evaluated for width, colour scheme and motion.
  const env = { width: 900, scheme: 'light', motion: 'no-preference' };
  assert.equal(atRuleApplies('@media (max-width:900px)', env), true);
  assert.equal(atRuleApplies('@media (max-width:900px)', { ...env, width: 901 }), false);
  assert.equal(atRuleApplies('@media (min-width:901px)', env), false);
  assert.equal(atRuleApplies(normalizeAtRule('@media (width <= 56.25em)'), env), true);
  assert.equal(atRuleApplies('@media print', env), false);
  assert.equal(atRuleApplies('@media screen and (max-width:720px)', env), false);
  assert.equal(atRuleApplies('@media print, (max-width:900px)', env), true);
  assert.equal(atRuleApplies('@media not print', env), true);
  assert.equal(atRuleApplies('@media (prefers-color-scheme:dark)', env), false);
  assert.equal(atRuleApplies('@media (prefers-color-scheme:dark)', { ...env, scheme: 'dark' }), true);
  assert.equal(atRuleApplies('@supports (display:grid)', env), true);
});

/* Home page budgets                                                         */

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

test('[AC-10][F-018] home request discovery sees srcset, inline CSS, style elements and same-origin absolute URLs', () => {
  const host = 'www.example.test';
  /** First-party URLs the markup references, as the PT-1 and PT-4 checks enumerate them in `index.html`. */
  const urls = (html) => htmlRequests(html, host).urls;

  // Responsive images: every candidate of `srcset` and `imagesrcset`.
  assert.deepEqual(
    urls('<img srcset="./a.jpg 1x, ./b.jpg 2x" alt=""><picture><source srcset="./c.webp"></picture>' +
      '<link rel="preload" as="image" imagesrcset="./d.jpg 640w, ./e,1.jpg 1280w">'),
    ['./a.jpg', './b.jpg', './c.webp', './d.jpg', './e,1.jpg'],
  );
  // Inline CSS: style attributes, url() in presentation attributes, style elements and image-set().
  assert.deepEqual(
    urls('<div style="background:url(./f.jpg)"></div><svg><rect fill="url(./p.svg#g)"/></svg>' +
      '<style>.y { background: url("./g.png") } @import "./h.css"; ' +
      '.z { background-image: image-set("./i.png" 1x, url(./j.png) 2x) } /* url(./no.png) */</style>'),
    ['./f.jpg', './g.png', './h.css', './i.png', './j.png', './p.svg#g'],
  );
  // Other loading attributes, SVG references and stylesheets.
  assert.deepEqual(
    urls('<video poster="./k.jpg"></video><object data="./l.svg"></object><table background="./o.gif"></table>' +
      '<svg><use href="./sprite.svg#m"/><image xlink:href="./n.png"/></svg>' +
      '<link rel="stylesheet" href="./s.css"><link rel="alternate stylesheet" href="./t.css">'),
    ['./k.jpg', './l.svg', './n.png', './o.gif', './s.css', './sprite.svg#m', './t.css'],
  );
  // Absolute URLs on the site's own host are first-party, in any case or scheme form.
  assert.deepEqual(
    urls('<img src="https://WWW.EXAMPLE.TEST/q.jpg"><img src="//www.example.test/r.jpg">' +
      '<img src="http://www.example.test:80/s.jpg"><div style="background:url(https://www.example.test/u.jpg)"></div>'),
    [
      '//www.example.test/r.jpg',
      'http://www.example.test:80/s.jpg',
      'https://WWW.EXAMPLE.TEST/q.jpg',
      'https://www.example.test/u.jpg',
    ],
  );
  // Never first-party: other hosts and ports, data:, fragments, anchors, non-fetching links, form actions.
  assert.deepEqual(
    urls('<img src="https://cdn.example.org/x.jpg"><img src="data:image/png;base64,AAAA">' +
      '<img src="//other.example.test/y.jpg"><img src="https://www.example.test:8443/z.jpg">' +
      '<svg><use href="#gp"/><rect fill="url(#g)" style="color:#0a2734"/></svg><a href="./blog/">Blog</a>' +
      '<link rel="preconnect" href="https://www.example.test"><link rel="canonical" href="https://www.example.test/">' +
      '<form action="./send" method="POST"></form><!-- <img src="./commented.jpg"> -->'),
    [],
  );
  // An unknown relation, or none, counts; a <base> element is refused.
  assert.deepEqual(urls('<link rel="x-new" href="./t.json"><link href="./u.css">'), ['./t.json', './u.css']);
  assert.throws(() => urls('<base href="/sub/">'), /<base>/);

  // Stylesheets: comments hide nothing and add nothing; external and data: URLs are not first-party.
  assert.deepEqual(
    cssRequests('/* url(./no.png) */ .a { background: url(./yes.png), url( "https://www.example.test/abs.png" ), ' +
      'url(https://cdn.example.org/ext.png), url(data:image/gif;base64,R0), url(#frag) } ' +
      '.b { content: "/*"; background: url(./after-string.png) } @import url("./more.css");', host),
    ['./after-string.png', './more.css', './yes.png', 'https://www.example.test/abs.png'],
  );
  // Same-origin absolute URLs map to the file at their path.
  assert.equal(fileOf('https://www.example.test/assets/x.jpg?v=1', 'index.html', host), 'assets/x.jpg');
  assert.equal(fileOf('//www.example.test/a/b.css#top', 'index.html', host), 'a/b.css');
  assert.equal(fileOf('./assets/hero.jpg', 'styles.css', host), 'assets/hero.jpg');
  assert.throws(() => fileOf('https://cdn.example.org/x.jpg', 'index.html', host), /not a request to the site/);
});

test('[AC-10][F-018] main.js stays within 3,609 bytes (PT-2)', (t) => {
  const bytes = size('main.js');
  t.diagnostic(`PT-2 main.js: ${bytes} of ${PT2_MAX_BYTES} bytes`);
  assert.ok(bytes <= PT2_MAX_BYTES, `PT-2: main.js is ${bytes} bytes, limit ${PT2_MAX_BYTES}`);
});

/* Include parity (_includes/site-header.html, _includes/site-footer.html)  */

/** A placeholder for the Liquid token at an index, holding no space, quote, `=` or `>`. */
const LIQUID_PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;

/** A start tag, read quote-aware: its name, then plain text and quoted strings up to `>`. */
const START_TAG_SPAN_RE = /<[a-zA-Z][^\s/>]*(?:[^"'>]|"[^"]*"|'[^']*')*>/g;

/** `href=` or `xlink:href=` as written, in any case; `data-href=` is another attribute. */
const HREF_WRITTEN_RE = /(?<![\w:-])(?:xlink:)?href\s*=/gi;

/**
 * How many `href` and `xlink:href` attribute names are written in the start
 * tags of `html`, duplicates included. Tags are read quote-aware and their
 * quoted values are emptied first, so `href=` inside another attribute's
 * value (`title="see href=/x"`) or in text between tags is not an attribute
 * and is not counted.
 * @param {string} html
 * @returns {number}
 */
function writtenHrefAttributes(html) {
  let count = 0;
  for (const [tag] of html.matchAll(START_TAG_SPAN_RE)) {
    const names = tag.replace(/"[^"]*"|'[^']*'/g, '""');
    count += (names.match(HREF_WRITTEN_RE) ?? []).length;
  }
  return count;
}

/**
 * Markup with a space after every quoted attribute value that another
 * attribute follows directly, as in `href="…"{{ marker }}`. HTML and
 * `parseStartTags` both read that as two attributes, so the space changes
 * neither reading.
 * @param {string} html
 * @returns {string}
 */
function separateAttributes(html) {
  return html.replace(START_TAG_SPAN_RE, (tag) => tag.replace(/(=\s*(?:"[^"]*"|'[^']*'))(?=[^\s/>])/g, '$1 '));
}

/**
 * Every `href` and `xlink:href` written in an include's Liquid source that
 * is not exactly one `{{ '…' | relative_url }}` output. Each must be, so
 * blog pages link correctly at an empty base path and under a project path.
 *   - Liquid comments and HTML comments are inert, so links inside them are
 *     not read; a `{% raw %}` block is literal text, so a `relative_url`
 *     written inside one does not count.
 *   - Every other Liquid tag and output becomes a placeholder, and each
 *     start tag is read by `parseStartTags`, so double-quoted,
 *     single-quoted and unquoted values (`href=/#services`) are all seen,
 *     including inside conditional branches.
 *   - Every `href` attribute name written in a start tag
 *     (`writtenHrefAttributes`) must be read as an attribute; any left over,
 *     a duplicate included, is reported too, so no spelling escapes the
 *     check. `href=` inside another attribute's value or in text is neither.
 * @param {string} src Raw include source.
 * @returns {string[]} The offending values with their Liquid restored, and a
 *   line for any `href=` not read as an attribute; empty when every href passes.
 */
function hrefsWithoutRelativeUrl(src) {
  const tokens = liquidTokens(src).filter((token) => token.name !== 'comment');
  /** The Liquid tags and outputs, by placeholder index. */
  const liquid = [];
  let masked = '';
  for (const token of tokens) {
    if (token.kind === 'text') {
      masked += token.source;
    } else {
      masked += `\uE000${liquid.length}\uE001`;
      liquid.push(token);
    }
  }
  const html = separateAttributes(masked.replace(HTML_COMMENT_RE, ''));
  const restore = (value) =>
    value.replace(new RegExp(LIQUID_PLACEHOLDER_RE.source, 'g'), (placeholder, index) => liquid[Number(index)].source);
  const found = [];
  let parsed = 0;
  for (const tag of parseStartTags(html)) {
    for (const name of ['href', 'xlink:href']) {
      if (!Object.hasOwn(tag.attrs, name)) continue;
      parsed += 1;
      const value = tag.attrs[name].trim();
      const only = new RegExp(`^${LIQUID_PLACEHOLDER_RE.source}$`).exec(value);
      if (only === null || relativeUrlPath(liquid[Number(only[1])]) === null) found.push(restore(value));
    }
  }
  const written = writtenHrefAttributes(html);
  if (written !== parsed) found.push(`${written} href attributes are written but ${parsed} read as attributes`);
  return found;
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

test('[AC-10][F-018] the include readers drop conditional markup, see every href and read anchors as HTML does', () => {
  /** Anchors an include renders on every page, as the parity checks read it. */
  const rendered = (src) => anchors(liquidToStatic(src));

  // Markup inside a condition, loop or capture is not output on every page.
  assert.deepEqual(rendered('{% if false %}<a href="/x">X</a>{% endif %}<a href="/y">Y</a>'), [
    { label: 'Y', href: '/y' },
  ]);
  assert.deepEqual(rendered('{%- unless true -%}<a href="/x">X</a>{%- endunless -%}'), []);
  assert.deepEqual(
    rendered(
      '{% if a %}{% for i in list %}<a href="/x">X</a>{% endfor %}' +
        '{% elsif b %}<a href="/z">Z</a>{% else %}<a href="/w">W</a>{% endif %}',
    ),
    [],
  );
  assert.deepEqual(rendered('{% case x %}{% when 1 %}<a href="/1">1</a>{% else %}<a href="/2">2</a>{% endcase %}'), []);
  assert.deepEqual(rendered('{% capture c %}<a href="/c">C</a>{% endcapture %}{{ c }}'), []);
  // Whitespace control strips beside the dashes; comments vanish; raw text stays as written.
  assert.equal(
    liquidToStatic('<a href="/y">Y</a>\n  {%- if x -%}\n<a href="/x">X</a>\n{%- endif -%}\n<a href="/w">W</a>'),
    '<a href="/y">Y</a><a href="/w">W</a>',
  );
  assert.equal(
    liquidToStatic('a{% comment %} {% if x %} {% endcomment %}b{% raw %}{{ kept }}{% endraw %}'),
    'ab{{ kept }}',
  );
  assert.equal(
    liquidToStatic(
      "{%- assign v = '' -%}{%- if page.url == '/blog/' -%}" +
        "{%- assign v = ' aria-current=\"page\"' -%}{%- endif -%}\n<header>",
    ),
    '<header>',
  );
  assert.equal(
    liquidToStatic("<a href=\"{{ '/blog/' | relative_url }}\"{{ v }}>{{ site.time | date: '%Y' }}</a>"),
    '<a href="/blog/"></a>',
  );
  // Unbalanced blocks are refused.
  for (const src of [
    '{% if x %}<a>',
    '{% endif %}',
    '{% if x %}{% endfor %}',
    '{% else %}',
    '{% comment %}',
    '{% raw %}x',
    '{% endcomment %}',
  ]) {
    assert.throws(() => liquidToStatic(src), /never closed|no matching|is outside/, src);
  }

  // Every real href must be one relative_url output, quoted or not; comments are inert.
  const unbuilt = hrefsWithoutRelativeUrl;
  assert.deepEqual(unbuilt('<a href=/#services>Services</a>'), ['/#services']);
  assert.deepEqual(unbuilt('<a href="/z">z</a><svg><use xlink:href="/s.svg#i"/></svg>'), ['/z', '/s.svg#i']);
  assert.deepEqual(unbuilt('{% if x %}<a href="/c">c</a>{% endif %}'), ['/c']);
  assert.deepEqual(unbuilt('<a href="{{ page.url }}">p</a>'), ['{{ page.url }}']);
  assert.deepEqual(unbuilt("<a href=\"{{ '/a' | relative_url }}{{ '#b' }}\">a</a>"), [
    "{{ '/a' | relative_url }}{{ '#b' }}",
  ]);
  assert.deepEqual(unbuilt("{% raw %}<a href=\"{{ '/r' | relative_url }}\">r</a>{% endraw %}"), [
    "{{ '/r' | relative_url }}",
  ]);
  assert.deepEqual(
    unbuilt(
      "<a href=\"{{ '/#a' | relative_url }}\">A</a><a href='{{ \"/#b\" | relative_url }}'>B</a>" +
        "<a href=\"{{- '/#c'|relative_url -}}\">C</a><A HREF = \"{{ '/#d' | relative_url }}\">D</A>" +
        "<a href={{ '/#e' | relative_url }}>E</a><a href=\"{{ '/blog/' | relative_url }}\"{{ marker }}>Blog</a>" +
        '<!-- <a href="/x">x</a> -->{% comment %}<a href="/y">y</a>{% endcomment %}',
    ),
    [],
  );
  assert.deepEqual(unbuilt("<a href=\"{{ '/a' | relative_url }}\" href=\"/dup\">a</a>"), [
    '2 href attributes are written but 1 read as attributes',
  ]);
  // `href=` inside another attribute's value, or in text, is not an attribute.
  assert.deepEqual(
    unbuilt(
      "<nav title=\"example href=/x\" data-note='href=/y'><a href=\"{{ '/#a' | relative_url }}\">A</a></nav>" +
        '<p>Write href=/z in a link.</p>',
    ),
    [],
  );
  assert.deepEqual(unbuilt('<nav title="example href=/x"><a href=/b>B</a></nav>'), ['/b']);

  // Anchors read as HTML does: any attribute order, case, end-tag spacing or quoted `>`.
  const link = (label, href) => ({ label, href });
  assert.deepEqual(anchors('<a class="x" href="/a" id="y">A</a>'), [link('A', '/a')]);
  assert.deepEqual(anchors('<a\n  href="/b">\n  Multi\n  line\n</a>'), [link('Multi line', '/b')]);
  assert.deepEqual(anchors('<a href="/c">C</a ><a href="/d">D</a\n>'), [link('C', '/c'), link('D', '/d')]);
  assert.deepEqual(anchors('<A HREF="/e">E</A>'), [link('E', '/e')]);
  assert.deepEqual(anchors('<a title="a > b" href="/f">F</a>'), [link('F', '/f')]);
  assert.deepEqual(anchors('<a href="/g"><span class="x">G</span>&nbsp;<b title="1>0">g</b></a>'), [link('G g', '/g')]);
  assert.deepEqual(anchors('<a href="/h">H<a href="/i">I</a>'), [link('H', '/h'), link('I', '/i')]);
  assert.deepEqual(anchors('<!-- <a href="/j">J</a> --><abbr title="x">K</abbr>'), []);
});

/* Output encoding (_layouts/blog.html, _layouts/post.html, blog/index.html) */

/** The blog templates that print front-matter values. */
const ESCAPED_TEMPLATES = Object.freeze(['_layouts/blog.html', '_layouts/post.html', 'blog/index.html']);

/** Filters that may end an unescaped output when applied directly to a `URL_INPUT_RE` input. */
const URL_FILTERS = new Set(['relative_url', 'absolute_url']);

/** URL inputs written by the template or the permalink: a quoted string, `page.url` or `post.url`. */
const URL_INPUT_RE = /^(?:'[^']*'|"[^"]*"|page\.url|post\.url)$/;

/**
 * Liquid's and Jekyll's date filters. Each can return its input unchanged
 * (Liquid's `date` when it cannot read it, Jekyll's when it is empty), so
 * formatting a date is no encoding.
 */
const DATE_FILTERS = new Set(['date', 'date_to_xmlschema', 'date_to_rfc822', 'date_to_string', 'date_to_long_string']);

/**
 * A Liquid output's markup split on `|` outside quoted strings, as Liquid
 * reads its filter chain: the input expression, then each filter with its
 * arguments, all trimmed. Liquid strings have no escape sequences, so a
 * quote closes at the next quote of the same kind.
 * @param {string} markup
 * @returns {string[]}
 */
function liquidFilterChain(markup) {
  const parts = [''];
  let quote = '';
  for (const char of markup) {
    if (quote === '' && char === '|') {
      parts.push('');
      continue;
    }
    if (quote === '' && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = '';
    parts[parts.length - 1] += char;
  }
  return parts.map((part) => part.trim());
}

/**
 * Whether a Liquid output prints its value encoded for HTML: its last
 * filter is `escape`, or it is one of the outputs that need none:
 *   - `{{ content }}` alone, the rendered article body, which is trusted
 *     author Markdown printed as HTML by design;
 *   - one `relative_url` or `absolute_url` filter on a quoted string,
 *     `page.url` or `post.url`;
 *   - a last `url_encode` filter, whose output holds no character HTML
 *     reads as markup.
 * An output that uses a `DATE_FILTERS` filter must end in `escape`.
 * @param {string} markup The output's markup, trimmed, without delimiters.
 * @returns {boolean}
 */
function isEncodedOutput(markup) {
  if (markup === 'content') return true;
  const [input, ...filters] = liquidFilterChain(markup);
  const names = filters.map((filter) => /^\w*/.exec(filter)[0]);
  const last = names.at(-1);
  if (last === 'escape') return true;
  if (names.some((name) => DATE_FILTERS.has(name))) return false;
  if (last === 'url_encode') return true;
  return names.length === 1 && URL_FILTERS.has(last) && URL_INPUT_RE.test(input);
}

/**
 * Every Liquid output in a template that `isEncodedOutput` refuses, as
 * `line: {{ … }}` with its 1-based line. Outputs inside conditions and
 * loops are read; a `{% comment %}` block prints nothing and a
 * `{% raw %}` block prints its text as written, so outputs inside either
 * are not.
 * @param {string} src
 * @returns {string[]}
 */
function unescapedOutputs(src) {
  const found = [];
  let line = 1;
  for (const token of liquidTokens(src)) {
    if (token.kind === 'output' && !isEncodedOutput(token.markup)) found.push(`${line}: ${token.source}`);
    line += token.source.split('\n').length - 1;
  }
  return found;
}

test('[AC-05][F-018] _layouts/blog.html, _layouts/post.html and blog/index.html end every printed value in escape', () => {
  const found = ESCAPED_TEMPLATES.flatMap((rel) => unescapedOutputs(read(rel)).map((at) => `${rel}:${at}`));
  assert.deepEqual(
    found,
    [],
    'every printed value must end in | escape, except {{ content }}, one relative_url or absolute_url ' +
      'filter on a quoted path, page.url or post.url, and a url_encode value; a date always needs escape',
  );
});

test('[AC-05][F-018] the escape reader reads every output and exempts only the trusted body, site URLs and url_encode', () => {
  // Reported with its line: no escape, a date, escape before another filter, and output inside a condition.
  assert.deepEqual(
    unescapedOutputs(
      '<h1>{{ page.title }}</h1>\n' +
        "<time>{{ post.date | date: '%Y' }}</time>\n" +
        '<p>{{ page.summary | escape | strip }}</p>\n' +
        '{% if page.updated %}\n  <b>{{ page.updated }}</b>\n{% endif %}',
    ),
    [
      '1: {{ page.title }}',
      "2: {{ post.date | date: '%Y' }}",
      '3: {{ page.summary | escape | strip }}',
      '5: {{ page.updated }}',
    ],
  );
  for (const src of [
    '{{ page.title | relative_url }}',
    '{{ site.url | absolute_url }}',
    "{{ '/a/' | append: page.slug | relative_url }}",
    '{{ page.url | relative_url | strip }}',
    '{{ content | strip }}',
    '{{ post.date | date_to_xmlschema | url_encode }}',
    "{{ page.title | append: ' | escape' }}",
    "{{ post.date | date: '%Y|%m' }}",
    '{{ page.title | escape_once }}',
    '{% for tag in page.tags %}{{ tag }}{% endfor %}',
  ]) {
    assert.equal(unescapedOutputs(src).length, 1, src);
  }

  // Not reported: comments and raw blocks print no output; tags print nothing.
  assert.deepEqual(
    unescapedOutputs('{% comment %}{{ page.title }}{% endcomment %}{% raw %}{{ page.title }}{% endraw %}'),
    [],
  );
  assert.deepEqual(unescapedOutputs('{% assign t = page.title | strip %}{% include site-header.html %}'), []);
  // Line numbers count the lines inside comment and raw blocks.
  assert.deepEqual(unescapedOutputs('{% comment %}\n{{ a }}\n{% endcomment %}{% raw %}\n{% endraw %}\n{{ b }}'), [
    '5: {{ b }}',
  ]);
  for (const src of [
    '{{ content }}',
    '{{- content -}}',
    "{{ '/x' | relative_url }}",
    '{{ "/x" | relative_url }}',
    "{{ '/a|b' | relative_url }}",
    '{{ page.url | absolute_url }}',
    '{{ post.url | relative_url | escape }}',
    '{{ tag | url_encode }}',
    "{{ x | date: '%Y' | escape }}",
    '{{ page.updated | date_to_xmlschema | escape }}',
    '{{page.title|escape}}',
    '{{ page.title | default: site.title | escape }}',
  ]) {
    assert.deepEqual(unescapedOutputs(src), [], src);
  }
});

/* Blog asset budgets and search.js conformance                              */

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
  const tokens = scanJs(src);
  assert.ok(
    isStrictScript(tokens),
    'blog/search.js must be one invoked function expression, (function () { … })(…) or ' +
      '(function () { … }(…)), whose body opens with a standalone "use strict" directive',
  );
  assert.deepEqual(located(es5Violations(tokens), src), [], 'blog/search.js must use ES5 syntax only');
});

test('[AC-10][F-019] blog/search.js uses no HTML-writing or code-evaluating sinks', () => {
  const src = read('blog/search.js');
  assert.deepEqual(
    located(unsafeSinks(scanJs(src)), src),
    [],
    'blog/search.js must write text only (textContent) and evaluate no strings',
  );
});

test('[AC-10][F-019] the ES5 scanner sees through comments, strings and regular-expression literals', () => {
  const es5 = (src) => es5Violations(scanJs(src)).map(({ what }) => what);

  // Comment markers inside strings do not hide the code after them.
  assert.deepEqual(es5('var s = "// not a comment"; const x = 1;'), ['`const` declaration']);
  assert.deepEqual(es5("var s = '/* not a comment */'; let y = 2;"), ['`let` declaration']);
  // Comments and string contents are not code, escaped quotes included.
  assert.deepEqual(es5('// const a = 1;\n/* let b = 2; => */\nvar c = 3;'), []);
  assert.deepEqual(es5('var s = "const \\" let"; var t = \'a\\\'b => c\';'), []);
  assert.deepEqual(es5('var a = 1; <!-- const b = 2;\n--> let c = 3;\nvar d = 4;'), []);
  // Regular-expression bodies are not code, and a quote inside one opens no string.
  assert.deepEqual(es5('var r = /=>|`|const/g; var m = x.match(/\'/);'), []);
  assert.deepEqual(es5('function f(x) { return /"/.test(x); }\nconst z = 1;'), ['`const` declaration']);
  assert.deepEqual(es5('var r = /[/]let/; var ok = 1;'), []);
  // Division is not a regular expression, so the code between two slashes is read.
  assert.deepEqual(es5('var q = a / 2; const z = 1; var w = b / 3;'), ['`const` declaration']);
  assert.deepEqual(es5('var i = 0; i++ / 2; let k;'), ['`let` declaration']);
  // After `}` a `/` divides when the braces were an object literal or a
  // function expression, and opens a regular expression after a block or a
  // function declaration; after `)` it opens one only after a control head.
  assert.deepEqual(es5('var v = {} / (function () { const hidden = 1; return hidden; }()) / 2;'), [
    '`const` declaration',
  ]);
  assert.deepEqual(es5('var g = function () {} / 2; const z = 1; var w = g / 3;'), ['`const` declaration']);
  assert.deepEqual(es5('x = { a: 1 } / 2; let q; y = q / 2;'), ['`let` declaration']);
  assert.deepEqual(es5('if (ok) /const/.test(s);'), []);
  assert.deepEqual(es5('while (n--) /let/.exec(s);\nfor (;;) /=>/.test(s);'), []);
  assert.deepEqual(es5('function f() {}\n/const/.test(s);\n{}\n/let/.test(s);'), []);
  assert.deepEqual(es5('var t = f(a) / 2; const u = 1; var w = u / 3;'), ['`const` declaration']);
  // Each AAP-required ES5 restriction rejects its own construct.
  assert.deepEqual(es5('var t = `hi`;'), ['template literal']);
  assert.deepEqual(es5('var f = function (a) { return a; }; var g = (a) => a;'), ['arrow function']);
  assert.deepEqual(es5('for (var k of list) {}'), ['`for…of` loop']);
  assert.deepEqual(es5('var copy = [].concat(items); f(...args);'), ['spread or rest `...`']);
  assert.deepEqual(es5('async function f() { await g(); }'), ['`async`', '`await`']);
  assert.deepEqual(es5('class A {}'), ['`class`']);
  assert.deepEqual(es5('for (var k in o) { if (typeof o[k] === "number") n += o[k] / 2; }'), []);

  // Offsets index the source, so reported positions name the source line.
  const src = 'var a = "x";\n/* c */ const b = 1;';
  for (const token of scanJs(src)) assert.equal(src.slice(token.start, token.end), token.raw);
  assert.deepEqual(located(es5Violations(scanJs(src)), src), ['`const` declaration at 2:9 "/* c */ const b = 1;"']);
});

test('[AC-10][F-019] the ES5 rules reject syntax added after ES5 and accept ES5 syntax', () => {
  const es5 = (src) => es5Violations(scanJs(src)).map(({ what }) => what);

  const rejected = [
    ['if (q0?.trim()) go();', 'optional chaining `?.`'],
    ['var v = a ?? b;', 'nullish coalescing `??`'],
    ['a ??= b; c ||= d; e &&= f;', 'logical assignment `??=`, `||=` or `&&=`'],
    ['var p = 2 ** 7; p **= 2;', 'exponentiation `**`'],
    ['function hit(f, t, w = 1) { return w; }', 'default parameter'],
    ['var { length: n } = items;', 'destructuring pattern'],
    ['var [first, second] = pair;', 'destructuring pattern'],
    ['var a = 1, [b] = c;', 'destructuring pattern'],
    ['[a, b] = [b, a];', 'destructuring pattern'],
    ['({ x: a } = o);', 'destructuring pattern'],
    ['function f({ a: x }, [b]) { return x + b; }', 'destructuring pattern'],
    ['try { go(); } catch ([e]) { stop(e); }', 'destructuring pattern'],
    ['var o = { a, b: 1 };', 'shorthand property'],
    ['var o = { m() { return 1; } };', 'method definition'],
    ['var o = { get() { return 1; } };', 'method definition'],
    ['var o = { [k]: 1 };', 'computed property name'],
    ['var o = { get [k]() { return 1; } };', 'computed property name'],
    ['function* gen() {}', 'generator `*`'],
    ['var o = { *gen() {} };', 'generator `*`'],
    ['var b = 0b1010, c = 0o17;', 'binary or octal literal `0b`/`0o`'],
    ['var n = 1_000;', 'numeric separator `_`'],
    ['var n = 10n;', 'BigInt literal'],
    ['var n = 017;', 'legacy octal or leading-zero number'],
    ['var r = /a/u, s = /b/y, t = /c/s;', 'regular-expression flag other than g, i, m'],
    ['var s = "\\u{1F600}";', 'code point escape `\\u{…}`'],
    ['var \\u{61} = 1;', 'code point escape `\\u{…}`'],
    ['function F() { return new.target; }', '`new.target`'],
    ['import("./x.js").then(go);', '`import`'],
    ['try { go(); } catch { stop(); }', 'optional `catch` binding'],
    ['go(a, b,); function f(a,) { return a; }', 'trailing comma before `)`'],
    ['#!/usr/bin/env node\nvar a = 1;', 'private name or hashbang `#`'],
  ];
  for (const [src, what] of rejected) assert.deepEqual(es5(src), [what], src);
  assert.deepEqual(es5('class A { #x = 1; }'), ['`class`', 'private name or hashbang `#`']);

  const accepted = [
    'var o = { get x() { return 1; }, set x(v) { this.v = v; }, "a b": 1, 2: 3, class: 1, if: 2, };',
    'var c = a.class + a.let + a.const + a.import + a.of;',
    'var list = [1, 2, ];',
    'var n = .5 + 1e3 + 0x1F + 1.5e-3 + 5. + 0;',
    'var r = /a[/]b/gim; var q = a ? b : c;',
    'var get = 1, set = 2, of = 3; var o2 = { get: get, set: set, of: of };',
    'label: for (var i = 0; i < 3; i++) { if (i) continue label; else break label; }',
    'switch (x) { case 1: y = { a: 1 }; break; default: y = null; }',
    'var s = "\\\\u{1}" + \'it\\\'s\';',
    'var f = function named(a, b) { return a * b; };',
    'try { go(); } catch (err) { stop(err); } finally { done(); }',
  ];
  for (const src of accepted) {
    assert.doesNotThrow(() => new vm.Script(src), src);
    assert.deepEqual(es5(src), [], src);
  }
});

test('[AC-10][F-019] the strict-mode check requires one invoked IIFE whose body opens with "use strict"', () => {
  const strict = (src) => isStrictScript(scanJs(src));

  const accepted = [
    '/* x */\n(function (w) {\n  "use strict";\n})(window);',
    "(function(){ 'use strict'; }());",
    ';(function named(a, b) { "use strict"; return a + b; })(1, 2);',
    '(function () {\n  "use strict"\n  var a = 1;\n})();',
    '(function () { "a"; \'use strict\'; })();\n// a trailing comment',
  ];
  for (const src of accepted) {
    assert.doesNotThrow(() => new vm.Script(src), src);
    assert.equal(strict(src), true, src);
  }

  const rejected = [
    // Not a directive: the string is part of a larger expression.
    '(function () { "use strict" + ""; })();',
    '(function () { "use strict".toString(); })();',
    '(function () { "use strict"[0]; })();',
    '(function () { "use strict"(0); })();',
    '(function () {\n  "use strict"\n  + "";\n})();',
    // Not exactly "use strict", or not in the prologue.
    '(function () { "use\\u0020strict"; })();',
    '(function () { var a = 1; "use strict"; })();',
    // Not one invoked wrapper around the whole script.
    '"use strict";\nvar a = 1;',
    '(function () { "use strict"; });',
    '(function () { "use strict"; })();\nvar leak = 1;',
    'var leak = 1;\n(function () { "use strict"; })();',
  ];
  for (const src of rejected) assert.equal(strict(src), false, src);
});

test('[AC-10][F-019] the sink check sees dot, bracket, qualified, escaped and concatenated forms', () => {
  const sinks = (src) => unsafeSinks(scanJs(src)).map(({ what }) => what);

  const forms = [
    ['innerHTML', [
      'el.innerHTML = s;',
      'el["innerHTML"] = s;',
      "el['inner\\u0048TML'] = s;",
      "el['inner' + 'HTML'] = s;",
      'el.inner\\u0048TML = s;',
      'window.document.body.innerHTML = s;',
      'var how = "set innerHTML";',
    ]],
    ['outerHTML', ['el.outerHTML = s;', "el['outer' + 'HTML'] = s;", "el['\\x6FuterHTML'] = s;"]],
    ['insertAdjacentHTML', [
      'el.insertAdjacentHTML("beforeend", s);',
      "el['insertAdjacent' + 'HTML']('beforeend', s);",
      'el.insertAdjacent\\u{48}TML("beforeend", s);',
    ]],
    ['document.write', [
      'document.write(s);',
      "document['write'](s);",
      'window.document.write(s);',
      "self['document'].writeln(s);",
      'document["wr" + "ite"](s);',
      'docum\\u0065nt.write(s);',
      "document['\\u0077rite'](s);",
      'document?.write(s);',
      "document?.['writeln'](s);",
      "window['document']['write'](s);",
    ]],
    ['eval', [
      'eval(s);',
      'window.eval(s);',
      "window['eval'](s);",
      '(0, eval)(s);',
      "window['ev' + 'al'](s);",
      '\\u0065val(s);',
    ]],
    ['new Function', [
      'new Function(s);',
      'Function(s)();',
      'new window.Function(s);',
      "new self['Function'](s);",
      "new window['Func' + 'tion'](s);",
      'new \\u0046unction(s);',
    ]],
  ];
  for (const [what, snippets] of forms) {
    for (const src of snippets) assert.deepEqual(sinks(src), [what], src);
  }
  assert.deepEqual(sinks('document.write(s); eval(s); new Function(s);'), ['document.write', 'eval', 'new Function']);

  // Comments never count; text-only output and other objects' `write` pass,
  // and the words `write` and `Function` as text are not sinks.
  for (const src of [
    '// el.innerHTML = s;\nel.textContent = s;',
    '/* document.write(s); eval(s); */ list.appendChild(li);',
    'stream.write(s); log.writeln(s);',
    "stream['write'](s); log[\"writ\" + \"eln\"](s);",
    'var note = "write to us";',
    'el.textContent = "write"; status.textContent = \'writeln\';',
    'var kind = "Function"; el.title = kind;',
    "var m = { write: 1, 'writeln': 2 }; m.write += m['writeln'];",
  ]) {
    assert.deepEqual(sinks(src), [], src);
  }
});
