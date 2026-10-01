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
 *     prose region (bounded by the layout's own markup) and the listing state
 *     the built article pages call for: every article in the list plus the
 *     search form attributes, or the launch state when none was built.
 *   - AC-07 [F-018] every local link resolves (`checkSiteLinks`), canonical
 *     and `og:url` follow the deployment URL, repository-internal files are
 *     absent from the output, `CNAME` follows the deployment mode and the
 *     home page passes through byte for byte.
 *   - AC-02 [F-017] drafts, draft images and future-dated posts never reach a
 *     normal build: no output path names either synthetic slug, and no page,
 *     `search.json` or other text file holds a slug, a marker or an
 *     `assets/drafts/` path. The preview build renders the draft and its
 *     image, and its paths and text hold no trace of the future-dated post.
 *   - AC-05 [F-018] the escaping fixture's title is escaped everywhere it is
 *     printed, `{% raw %}` survives, the Python and YAML blocks each hold
 *     Rouge token classes, and tables render.
 *   - AC-17 [F-018] the zero-article listing and an empty search index; the
 *     real case runs while `_posts/` holds no regular `.md` file.
 *   Self-tests on synthetic input prove that the prose scan, the listing
 *   check, the Rouge check and the post inventory reject what they must.
 *
 * Paths resolve from this file's location (`ROOT`), never `process.cwd()`;
 * relative `SITE_DIR` and `FIXTURE_DIR` values resolve against `ROOT`. The
 * suite never builds or uses the network, and it reads the built output
 * without changing it. Its one write is the post-inventory self-test, which
 * creates a folder under `os.tmpdir()` and removes it.
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

/** Start tag of the article's back links, exactly as `_layouts/post.html` writes it. */
const POST_BACK_TAG = '<p class="post-back">';

/**
 * What the layouts write from the article's closing back link on: the link
 * and the end of the container and the article (`_layouts/post.html`), then
 * the end of `main` (`_layouts/blog.html`).
 */
const LAYOUT_TAIL_RE = /^<p class="post-back"><a href="[^"<>]*">← All articles<\/a><\/p>\s*<\/div>\s*<\/article>\s*<\/main\s*>/;

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
 * Extensions of output files whose text is searched for the private slugs,
 * markers and draft-image paths. Beyond the HTML, JSON, CSS, JS, XML and
 * plain-text files Jekyll emits, raw Markdown, SVG and YAML are included,
 * because a draft copied verbatim instead of rendered would arrive as one of
 * those.
 */
const TEXT_EXTENSIONS = new Set(['.html', '.json', '.css', '.js', '.xml', '.txt', '.md', '.svg', '.yml', '.yaml']);

/**
 * Path prefix of every draft image (`assets/drafts/<slug>/…`), the AC-02
 * draft-image reference: no text file of a normal build may hold it, since a
 * page or index entry that names a draft image leaks the draft it belongs to.
 */
const DRAFT_IMAGE_PREFIX = 'assets/drafts/';

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
 * The listing's state, chosen by the built article inventory and never by the
 * listing's own markup, so a list or form that went missing cannot pass for
 * the launch state.
 *
 * With articles: `ol#post-list.post-list` holds one `li[data-url]` per built
 * article (the join `search.js` makes with the index); `form#blog-search` is
 * hidden until `search.js` runs, a GET to the listing, and names the index
 * under the base path in `data-index`; no `.post-empty` element is present.
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
  const close = closingTagIndex(html, 'ol', list.end);
  assert.notEqual(close, -1, 'ol#post-list is never closed');
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
    };
    for (const [why, html] of Object.entries(unbounded)) {
      assert.notEqual(html, wrap('<p>ok</p>'), `case not built: ${why}`);
      assert.throws(() => proseRegion(html), assert.AssertionError, `prose region accepted: ${why}`);
    }
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
      `<ul class="tag-list" aria-label="Tags"><li><a class="tag-link" href="${base}/blog/?q=tag">tag</a></li></ul>\n</li>`;
    const list = (items, words) =>
      `<ol class="post-list" id="post-list" aria-label="Articles">\n${items.map((url) => card(url, words)).join('\n')}\n</ol>`;
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
 * No path under `dir` names one of `slugs`, and no text file under it (every
 * page, `search.json` and the other `TEXT_EXTENSIONS` files) holds one of
 * `slugs` or `texts`: slugs are excluded from file text as well as paths.
 * @param {string} dir
 * @param {string[]} slugs matched against output paths and file text
 * @param {string[]} texts matched against file text only: markers, draft-image paths
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
    assertAbsent(SITE_DIR, [DRAFT_SLUG, FUTURE_SLUG], [DRAFT_MARKER, FUTURE_MARKER, DRAFT_IMAGE_PREFIX]);
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
    assertRougeBlock(html, 'python', {
      tokens: ['k', 'nf', 'c1', 's', 'mi', 'mf'],
      text: ['def retry_delay(attempt, base=0.5, limit=30):', 'unit = "seconds"'],
    });
    // The quoted YAML strategy is the fixture's settled choice: Rouge writes its opening quote as s2.
    assertRougeBlock(html, 'yaml', {
      tokens: ['na', 'pi', 's2', 'm'],
      text: ['strategy: "exponential"', 'max_attempts: 5'],
    });
    const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((m) => m[1]);
    assert.ok(
      tables.some((table) => table.includes('<th') && table.includes('style="text-align:')),
      'no rendered table with aligned header cells',
    );
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
