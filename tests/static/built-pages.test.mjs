/* Cabrillo Coast LLC — built blog pages (AC-02, AC-05, AC-06, AC-07, AC-17; F-017, F-018) */
/**
 * Assertions over the HTML Jekyll built. The same file runs twice in
 * `scripts/verify.mjs`, and every assertion holds in both runs:
 *
 *   1. Real build, custom-domain mode (the defaults):
 *        SITE_DIR=_site  SITE_BASEURL=""  SITE_URL=https://www.cabrillocoast.com
 *      FIXTURE_DIR is unset, so the fixture-only cases are skipped. At launch
 *      `_posts/` is empty and the launch-state case (AC-17) runs on `_site`.
 *   2. Fixture project build, project-path mode:
 *        SITE_DIR=<tmp>/project/cabrillo-coast  SITE_BASEURL=/cabrillo-coast
 *        SITE_URL=https://randyamiller.github.io  FIXTURE_DIR=<tmp>
 *      `<tmp>` is the output of `tests/fixtures/build-fixture-site.mjs`, which
 *      also holds `preview/` (drafts built), `empty/` (no articles) and `src/`
 *      (the staged source with the synthetic draft and future-dated post).
 *
 * Coverage:
 *   - AC-06 [F-018] page contract of the listing and every article: doctype
 *     and language, the Content-Security-Policy directly after the charset,
 *     the allowed scripts, title and Open Graph metadata, skip link, mobile
 *     menu landmark, `aria-current` on Blog, the unsafe-markup scan of the
 *     prose region and the search form attributes.
 *   - AC-07 [F-018] every local link resolves (`checkSiteLinks`), canonical
 *     and `og:url` follow the deployment URL, repository-internal files are
 *     absent from the output, `CNAME` follows the deployment mode and the
 *     home page passes through byte for byte.
 *   - AC-02 [F-017] drafts, draft images and future-dated posts never reach a
 *     normal build; the preview build renders the draft and its image.
 *   - AC-05 [F-018] the escaping fixture's title is escaped everywhere it is
 *     printed, `{% raw %}` survives, Rouge highlighting and tables render.
 *   - AC-17 [F-018] the zero-article listing and an empty search index.
 *
 * Paths resolve from this file's location (`ROOT`), never `process.cwd()`;
 * relative `SITE_DIR` and `FIXTURE_DIR` values resolve against `ROOT`. The
 * suite reads files only: it never builds, writes or uses the network.
 *
 * Run: bundle exec jekyll build && node --test tests/static/built-pages.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSiteLinks, decodeEntities, listHtmlPages, parseStartTags } from './lib/site-links.mjs';
import {
  DRAFT_IMAGE,
  DRAFT_MARKER,
  DRAFT_SLUG,
  FUTURE_MARKER,
  FUTURE_SLUG,
} from '../fixtures/build-fixture-site.mjs';

/* ------------------------------------------------------------------------ */
/* Configuration                                                             */
/* ------------------------------------------------------------------------ */

/** Repository root: two levels above `tests/static/`. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Built site under test; a relative value resolves against `ROOT`. */
const SITE_DIR = path.resolve(ROOT, process.env.SITE_DIR || '_site');

/** Base path the site is served under: empty on the custom domain, `/cabrillo-coast` on the project path. */
const BASE = (process.env.SITE_BASEURL || '').replace(/\/+$/, '');

/** Deployment URL (scheme and host) that canonical and `og:url` start with. */
const SITE_URL = (process.env.SITE_URL || 'https://www.cabrillocoast.com').replace(/\/+$/, '');

/** Output folder of the fixture builder; empty when the fixture cases do not apply. */
const FIXTURE_DIR = process.env.FIXTURE_DIR ? path.resolve(ROOT, process.env.FIXTURE_DIR) : '';

/** `skip` option of every fixture-only case. */
const FIXTURE_ONLY = { skip: !FIXTURE_DIR && 'FIXTURE_DIR not set' };

/* ------------------------------------------------------------------------ */
/* Expected values                                                           */
/* ------------------------------------------------------------------------ */

/** The blog's Content-Security-Policy, character for character (AAP 0.5.6). */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'";

/** Suffix of every blog page title (U+2014 em dash). */
const TITLE_SUFFIX = ' — Cabrillo Coast';

/** Exact title of the listing page. */
const LISTING_TITLE = `Technical articles${TITLE_SUFFIX}`;

/** `og:site_name` on every blog page, matching the home page. */
const OG_SITE_NAME = 'Cabrillo Coast LLC';

/** Start tags the prose region of an article must never contain (AAP 0.5.3). */
const FORBIDDEN_PROSE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link', 'style']);

/** Event-handler attribute names. */
const EVENT_HANDLER_RE = /^on/i;

/** A `javascript:` URL, tolerant of the whitespace browsers strip from URLs. */
const JAVASCRIPT_URL_RE = /j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i;

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
 * Extensions of output files whose text is searched for the private markers.
 * Beyond the HTML, JSON, CSS, JS, XML and plain-text files Jekyll emits, raw
 * Markdown, SVG and YAML are included, because a draft copied verbatim
 * instead of rendered would arrive as one of those.
 */
const TEXT_EXTENSIONS = new Set(['.html', '.json', '.css', '.js', '.xml', '.txt', '.md', '.svg', '.yml', '.yaml']);

/** The launch-state text of the listing (AAP 0.5.4). */
const EMPTY_LISTING_TEXT = 'No articles have been published yet.';

/** Fixture article slugs and the escaped title the escaping fixture must render as. */
const ESCAPING_SLUG = 'fixture-escaping-and-liquid';
const CODE_SLUG = 'fixture-code-and-tables';
const ESCAPED_TITLE = 'Escaping &quot;quotes&quot; &amp; &lt;angle&gt; brackets';

/** An article page under a built site: `blog/<slug>/index.html`. */
const ARTICLE_REL_RE = /^blog\/([^/]+)\/index\.html$/;
const LISTING_REL = 'blog/index.html';

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Every start tag of a page, in document order, with lowercase names and
 * entity-decoded attribute values (comments ignored).
 * @param {string} html
 */
function tags(html) {
  return parseStartTags(html);
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

/** Removes comments and tags, leaving the text with its character references. */
function stripTags(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
}

/** Visible text of an HTML fragment: tags stripped, references decoded, whitespace collapsed. */
function textOf(fragment) {
  return decodeEntities(stripTags(fragment)).replace(/\s+/g, ' ').trim();
}

/** Whitespace-separated tokens of a tag's `class` attribute. */
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

/** The text files under `dir` (see `TEXT_EXTENSIONS`), as relative POSIX paths. */
function textFiles(dir) {
  return walk(dir).filter((rel) => {
    if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) return false;
    return statSync(path.join(dir, ...rel.split('/'))).isFile();
  });
}

/** Reads a site file given as a POSIX path relative to `dir`. */
function readSiteFile(dir, rel) {
  return readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
}

/**
 * Offset of the first closing tag `</name` at or after `from`, or -1.
 * @param {string} html
 * @param {string} name
 * @param {number} from
 */
function closingTagIndex(html, name, from) {
  const re = new RegExp(`</${name}\\s*>`, 'gi');
  re.lastIndex = from;
  const match = re.exec(html);
  return match === null ? -1 : match.index;
}

/**
 * The prose region of an article: from the end of `<div class="prose">` to
 * the first `<p class="post-back">` after it, the layout contract of
 * `_layouts/post.html`. Fails the calling test when either is missing.
 * @param {string} html
 * @returns {string}
 */
function proseRegion(html) {
  const all = tags(html);
  const prose = all.find((t) => t.name === 'div' && classTokens(t).includes('prose'));
  assert.ok(prose, 'article has no <div class="prose"> (layout contract of _layouts/post.html)');
  const back = all.find((t) => t.start >= prose.end && t.name === 'p' && classTokens(t).includes('post-back'));
  assert.ok(back, 'article has no <p class="post-back"> after its prose (layout contract of _layouts/post.html)');
  return html.slice(prose.end, back.start);
}

/**
 * Lists the unsafe markup in an HTML fragment: forbidden elements, event
 * handler attributes and `javascript:` URLs, in the tag source or in a
 * decoded attribute value (which catches `&#106;avascript:`). Escaped code
 * samples (`&lt;script…`) contain no `<` and are text, not tags.
 * @param {string} fragment
 * @returns {string[]}
 */
function unsafeMarkup(fragment) {
  const problems = [];
  for (const tag of tags(fragment)) {
    if (FORBIDDEN_PROSE_TAGS.has(tag.name)) problems.push(`<${tag.name}> element: ${tag.source}`);
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (EVENT_HANDLER_RE.test(name)) problems.push(`event handler attribute ${name}: ${tag.source}`);
      if (JAVASCRIPT_URL_RE.test(value)) problems.push(`javascript: URL in ${name}: ${tag.source}`);
    }
    if (JAVASCRIPT_URL_RE.test(tag.source)) problems.push(`javascript: URL: ${tag.source}`);
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
 * Every `*.md` file under `ROOT/_posts`, recursively (Jekyll reads `_posts/`
 * subfolders too); empty when the folder does not exist.
 * @returns {string[]}
 */
function realPostFiles() {
  const dir = path.join(ROOT, '_posts');
  if (!existsSync(dir)) return [];
  return walk(dir).filter((rel) => rel.toLowerCase().endsWith('.md'));
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

/* ------------------------------------------------------------------------ */
/* AC-06 — page contract                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The head of a page must open with the charset declaration and, directly
 * after it, the Content-Security-Policy meta tag: a meta policy governs only
 * the markup that follows it, so nothing (not even a comment) may come first.
 * @param {string} html
 */
function assertHeadOrder(html) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  assert.ok(head, 'page has no <head> start tag');
  const afterHead = html.slice(head.index + head[0].length);

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
 * scripts are exactly the expected ones, in order.
 * @param {string} html
 * @param {string[]} expectedSrcs
 */
function assertScripts(html, expectedSrcs) {
  const scripts = tags(html).filter((t) => t.name === 'script');
  for (const script of scripts) {
    assert.ok(Object.hasOwn(script.attrs, 'src'), `inline script element without src: ${script.source}`);
    const close = closingTagIndex(html, 'script', script.end);
    assert.notEqual(close, -1, `script element is never closed: ${script.source}`);
    assert.equal(html.slice(script.end, close).trim(), '', `script element has inline content: ${script.source}`);
  }
  assert.deepEqual(
    scripts.map((script) => script.attrs.src),
    expectedSrcs,
    'blog pages load main.js everywhere and search.js on the listing only',
  );
}

/**
 * Title and Open Graph metadata of one blog page.
 * @param {string} html
 * @param {'listing' | 'article'} kind
 */
function assertMetadata(html, kind) {
  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)];
  assert.equal(titles.length, 1, 'page must have exactly one <title>');
  const title = decodeEntities(titles[0][1]).trim();
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
 * The listing's search form, present whenever the list is: hidden until
 * `search.js` runs, a GET to the listing, and the index URL under the base path.
 * @param {string} html
 * @param {import('node:test').TestContext} t
 */
function assertSearchForm(html, t) {
  const all = tags(html);
  if (!all.some((tag) => tag.attrs.id === 'post-list')) {
    t.diagnostic('the listing holds no #post-list (no articles); the launch-state case covers it');
    return;
  }
  const form = all.find((tag) => tag.attrs.id === 'blog-search');
  assert.ok(form, 'a listing with #post-list must hold form#blog-search');
  assert.equal(form.name, 'form', `#blog-search must be a <form>: ${form.source}`);
  assert.equal(form.attrs.role, 'search', 'form#blog-search role');
  assert.ok(Object.hasOwn(form.attrs, 'hidden'), 'form#blog-search must be hidden until search.js runs');
  assert.equal((form.attrs.method || '').toLowerCase(), 'get', 'form#blog-search method');
  assert.equal(form.attrs.action, `${BASE}/blog/`, 'form#blog-search action');
  assert.equal(form.attrs['data-index'], `${BASE}/blog/search.json`, 'form#blog-search data-index');
}

function definePageContractTests() {
  test('[AC-06][F-018] every blog page meets the page contract', async (t) => {
    const pages = siteBlogPages();
    t.diagnostic(`${pages.length} blog page(s) under ${SITE_DIR}: ${pages.map((p) => p.rel).join(', ')}`);
    for (const page of pages) {
      await t.test(`${page.rel} (${page.urlPath})`, (st) => {
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
        if (page.kind === 'listing') assertSearchForm(html, st);
      });
    }
  });

  test('[AC-06][F-018] the prose scan flags unsafe markup and passes escaped code samples', () => {
    const wrap = (inner) =>
      `<div class="prose">\n${inner}\n</div>\n<p class="post-back"><a href="/blog/">All articles</a></p>`;
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
    ];
    for (const inner of unsafe) assert.ok(flagged(inner), `not flagged: ${inner}`);

    const safe = [
      '<pre class="highlight"><code><span class="nt">&lt;script </span><span class="na">src=</span>' +
        '<span class="s">"/assets/app.js"</span><span class="nt">&gt;&lt;/script&gt;</span></code></pre>',
      '<p>Use <code>onclick</code> handlers sparingly; never write <code>javascript&#58;</code> URLs.</p>',
      '<table><tr><th style="text-align: left">A</th></tr></table>',
      '<!-- <script>commented out</script> -->',
      '<p><img src="/assets/blog/x/figure.png" alt="Figure"></p>',
    ];
    for (const inner of safe) assert.ok(!flagged(inner), `flagged: ${inner}`);

    // The region stops at the closing back link, so a script after it belongs to the layout scan.
    assert.equal(proseRegion(`${wrap('<p>ok</p>')}<script src="/main.js"></script>`).includes('<script'), false);
  });
}

/* ------------------------------------------------------------------------ */
/* AC-07 — links, metadata and outputs                                       */
/* ------------------------------------------------------------------------ */

function defineLinkAndOutputTests() {
  test('[AC-07][F-018] every local href, src and data-index on every built page resolves', (t) => {
    const findings = checkSiteLinks({ siteDir: SITE_DIR, baseurl: BASE, siteUrl: SITE_URL });
    const lines = findings.map((f) => `${f.page}: ${f.attribute}="${f.value}" — ${f.reason}`);
    for (const line of lines) t.diagnostic(line);
    assert.deepEqual(findings, [], `${findings.length} unresolved reference(s) under ${SITE_DIR}:\n${lines.join('\n')}`);
  });

  test('[AC-07][F-018] canonical and og:url name the page on the deployment host', async (t) => {
    for (const page of siteBlogPages()) {
      await t.test(page.rel, () => {
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

/* ------------------------------------------------------------------------ */
/* AC-02 — drafts, draft images and future-dated posts                       */
/* ------------------------------------------------------------------------ */

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
 * No path under `dir` names one of `slugs`, and no text file holds one of `markers`.
 * @param {string} dir
 * @param {string[]} slugs
 * @param {string[]} markers
 */
function assertAbsent(dir, slugs, markers) {
  const paths = walk(dir).filter((rel) => slugs.some((slug) => rel.includes(slug)));
  assert.deepEqual(paths, [], `${dir} must not contain ${slugs.join(' or ')}`);
  const leaks = textFiles(dir).flatMap((rel) => {
    const text = readSiteFile(dir, rel);
    return markers.filter((marker) => text.includes(marker)).map((marker) => `${rel}: ${marker}`);
  });
  assert.deepEqual(leaks, [], `private markers found under ${dir}`);
}

function definePrivacyTests() {
  test('[AC-02][F-017] no draft image folder and no article template reach the build', () => {
    for (const rel of ['assets/drafts', '_templates']) {
      assert.ok(!existsSync(path.join(SITE_DIR, ...rel.split('/'))), `${rel} must not be published`);
    }
  });

  test('[AC-02][F-017] the project build holds no draft, draft image or future-dated post', FIXTURE_ONLY, () => {
    assertSyntheticSource();
    assertAbsent(SITE_DIR, [DRAFT_SLUG, FUTURE_SLUG], [DRAFT_MARKER, FUTURE_MARKER]);
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

/* ------------------------------------------------------------------------ */
/* AC-05 — rendering and escaping (fixture articles)                         */
/* ------------------------------------------------------------------------ */

/** Reads a built article of `SITE_DIR` by slug, failing when it was not built. */
function readArticle(slug) {
  const file = path.join(SITE_DIR, 'blog', slug, 'index.html');
  assert.ok(existsSync(file), `${file} not found: the fixture article was not built`);
  return readFileSync(file, 'utf8');
}

function defineRenderingTests() {
  test('[AC-05][F-018] the escaping fixture is escaped in <title>, <h1> and og:title and keeps {% raw %} text', FIXTURE_ONLY, () => {
    const html = readArticle(ESCAPING_SLUG);
    assert.ok(html.includes(`<title>${ESCAPED_TITLE}${TITLE_SUFFIX}</title>`), '<title> must hold the escaped title');

    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
    assert.ok(h1, 'no <h1>');
    assert.ok(h1[1].includes(ESCAPED_TITLE), `<h1> must hold the escaped title, found: ${h1[1]}`);

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
    const links = [...html.matchAll(/<h2\b[^>]*>\s*(<a\b[^>]*>)([\s\S]*?)<\/a\s*>\s*<\/h2\s*>/gi)];
    const match = links.find((m) => m[2].includes(ESCAPED_TITLE));
    assert.ok(match, 'no listing <h2> link holds the escaped title');
    assert.equal(tags(match[1])[0].attrs.href, `${BASE}/blog/${ESCAPING_SLUG}/`, 'listing link target');
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
    const blocks = [...html.matchAll(/<pre class="highlight">([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    assert.ok(
      blocks.some((block) => block.includes('<span class="')),
      'highlighted code blocks hold no Rouge token spans',
    );
    const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((m) => m[1]);
    assert.ok(
      tables.some((table) => table.includes('<th') && table.includes('style="text-align:')),
      'no rendered table with aligned header cells',
    );
    assert.equal(meta(html, 'property', 'article:modified_time'), undefined, 'the code fixture has no updated date');
  });
}

/* ------------------------------------------------------------------------ */
/* AC-17 — launch state                                                      */
/* ------------------------------------------------------------------------ */

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
}

/* ------------------------------------------------------------------------ */
/* Registration                                                              */
/* ------------------------------------------------------------------------ */

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
