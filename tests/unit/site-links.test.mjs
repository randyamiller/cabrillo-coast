/* Cabrillo Coast LLC — unit proof that the built-site link checker reports failures (AC-07, F-018) */
/**
 * `checkSiteLinks` in `tests/static/lib/site-links.mjs` is what gives the
 * AC-07 link check in `tests/static/built-pages.test.mjs` its meaning: a
 * checker that quietly returned `[]` would let every broken link through.
 * This suite writes small synthetic sites into a temporary directory and
 * proves that the checker
 *   - reports nothing for a site whose every reference resolves,
 *   - reports a broken page-relative link, a broken absolute link on the
 *     site's own host (under both schemes), a missing fragment, a missing
 *     image, a `data-index` that names no file and a broken link on a page
 *     two directory levels deep,
 *   - ignores links to other hosts, and
 *   - reports a root-relative link that escapes the base path of a
 *     project-path deployment.
 * It also pins the parsing and resolution rules those results rest on:
 *   - values in double, single or no quotes are read, the first of two
 *     duplicate attributes wins, and attribute-looking text, escaped markup
 *     and commented-out tags are not references;
 *   - a comment ends where the HTML tokenizer ends it, `<!--` inside an
 *     attribute value opens none, and `parseStartTags` offsets point into
 *     the original HTML;
 *   - character references are decoded once, and percent-encoded paths and
 *     fragments are decoded, a malformed sequence being a missing file;
 *   - a query string is ignored, a directory path needs no trailing slash,
 *     and a missing or unnamed site directory throws;
 *   - pages named with `#`, `?`, `%` or a space resolve their own links at
 *     either base path, `listHtmlPages` percent-encoding their URLs; and
 *   - a symbolic link out of the site directory is a missing file, while one
 *     that stays inside resolves.
 *
 * Ordinary failure cases extend the same valid baseline (`validFiles`) with
 * only the files and references under test, so a finding can come from
 * nothing else. The base-path, reserved-name and symbolic-link cases need a
 * differently shaped site, so each writes an independent one holding its own
 * valid controls. The direct checks of `parseStartTags` and `decodeEntities`
 * and the missing-directory case write no site. Findings are compared
 * without their `page` field (`summarize`), and `page` is checked only for
 * naming the right page, so the suite pins the checker's contract rather
 * than its report format.
 *
 * Runs with `node --test tests/unit/site-links.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no Jekyll build and no
 * network, writes only under `os.tmpdir()`, and removes its temporary tree
 * once the file's tests have finished.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkSiteLinks, decodeEntities, listHtmlPages, parseStartTags } from '../static/lib/site-links.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Deployment URL of the custom-domain build (`url` in `_config.yml`). */
const SITE_URL = 'https://www.cabrillocoast.com';

/** Deployment URL of the project-path build (`CNAME` removed). */
const PROJECT_URL = 'https://randyamiller.github.io';

/** Base path the project-path build is served under. */
const BASEURL = '/cabrillo-coast';

/** Both deployment modes, as `checkSiteLinks` options without `siteDir`. */
const MODES = Object.freeze([
  Object.freeze({ baseurl: '', siteUrl: SITE_URL }),
  Object.freeze({ baseurl: BASEURL, siteUrl: PROJECT_URL }),
]);

/**
 * Contents of every image in the synthetic sites: the eight-byte PNG
 * signature. The checker only needs the file to exist.
 */
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------------ */
/* Temporary sites                                                           */
/* ------------------------------------------------------------------------ */

/**
 * One parent directory for the whole file; each case writes its own site
 * inside it, so cases never share files and one `rmSync` cleans up.
 */
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'site-links-'));

after(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

/**
 * A complete HTML document whose body is the given lines. The head carries
 * no `href` or `src`, so every reference a page holds is one a case wrote.
 * @param {string[]} bodyLines
 * @returns {string}
 */
function page(bodyLines) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<title>Link checker fixture</title>',
    '</head>',
    '<body>',
    ...bodyLines,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Writes a site into a fresh directory under `parent`.
 * @param {Record<string, string | Buffer>} files
 *   Contents keyed by POSIX path relative to the site directory; parent
 *   directories are created as needed.
 * @returns {string} The site directory.
 */
function writeSite(files) {
  const siteDir = fs.mkdtempSync(path.join(parent, 'case-'));
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(siteDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return siteDir;
}

/**
 * The baseline site in custom-domain mode (empty base path). Every reference
 * resolves, and together they cover each kind the checker distinguishes:
 * root-relative, page-relative, fragment-only, directory URLs, a query
 * string, absolute URLs on the site's host under both schemes, `mailto:` and
 * `tel:`, an image and a `data-index` attribute.
 * @returns {Record<string, string | Buffer>} A fresh object on every call.
 */
function validFiles() {
  return {
    'index.html': page([
      '<header id="top">',
      '  <a href="/blog/">Blog</a>',
      '  <a href="./blog/">Blog, page-relative</a>',
      '  <a href="#top">Back to top</a>',
      '</header>',
      '<main>',
      '  <img src="/assets/fig.png" alt="x">',
      '  <a href="https://www.cabrillocoast.com/blog/">Blog, absolute https</a>',
      '  <a href="http://www.cabrillocoast.com/blog/">Blog, absolute http</a>',
      '  <a href="mailto:hello@cabrillocoast.com">Email</a>',
      '  <a href="tel:+15555550100">Phone</a>',
      '  <a href="/blog/?q=ai">Articles tagged ai</a>',
      '  <a href="/blog/post/#intro">Introduction of the post</a>',
      '</main>',
    ]),
    'blog/index.html': page([
      '<a href="../">Home</a>',
      '<a href="post/#intro">Read the post</a>',
      '<form id="blog-search" data-index="/blog/search.json"></form>',
    ]),
    'blog/search.json': '[]\n',
    'blog/post/index.html': page([
      '<a href="../">All articles</a>',
      '<h2 id="intro">Introduction</h2>',
      '<a href="#intro">Permalink</a>',
    ]),
    'other/index.html': page(['<h2 id="present">Present</h2>']),
    'assets/fig.png': IMAGE_BYTES,
  };
}

/**
 * Returns a copy of `files` with markup added at the end of the body of the
 * named pages. Throws when a page is not in `files`, so a mistyped path
 * fails the case instead of silently testing the baseline.
 * @param {Record<string, string | Buffer>} files
 * @param {Record<string, string[]>} additions Lines keyed by page path.
 * @returns {Record<string, string | Buffer>}
 */
function withMarkup(files, additions) {
  const result = { ...files };
  for (const [rel, lines] of Object.entries(additions)) {
    const html = result[rel];
    if (typeof html !== 'string' || !html.includes('</body>')) {
      throw new Error(`withMarkup: ${rel} is not an HTML page of the site`);
    }
    result[rel] = html.replace('</body>', `${lines.join('\n')}\n</body>`);
  }
  return result;
}

/* ------------------------------------------------------------------------ */
/* Assertion helpers                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Findings as readable JSON, used as the assertion message.
 * @param {unknown} problems
 * @returns {string}
 */
function formatProblems(problems) {
  return `checkSiteLinks returned:\n${JSON.stringify(problems, null, 2)}`;
}

/**
 * Findings without their `page` field, sorted by value, for exact
 * comparison independent of page and document order.
 * @param {{ attribute: string, value: string, reason: string }[]} problems
 * @returns {{ attribute: string, value: string, reason: string }[]}
 */
function summarize(problems) {
  return problems
    .map(({ attribute, value, reason }) => ({ attribute, value, reason }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/**
 * The single finding whose value is `value`.
 * @param {{ value: string }[]} problems
 * @param {string} value
 */
function findingFor(problems, value) {
  const matches = problems.filter((problem) => problem.value === value);
  assert.equal(matches.length, 1, `expected one finding for ${value}\n${formatProblems(problems)}`);
  return matches[0];
}

/* ------------------------------------------------------------------------ */
/* Cases                                                                     */
/* ------------------------------------------------------------------------ */

test('[AC-07][F-018] a valid site has no unresolved references', () => {
  const siteDir = writeSite(validFiles());
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(problems, [], formatProblems(problems));
});

test('[AC-07][F-018] reports a broken page-relative link', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), { 'blog/index.html': ['<a href="../missing/">Gone</a>'] }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'href', value: '../missing/', reason: 'missing file' }],
    formatProblems(problems),
  );
  assert.ok(String(problems[0].page).includes('blog'), formatProblems(problems));
});

test("[AC-07][F-018] reports a broken absolute link on the site's own host", () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<a href="https://www.cabrillocoast.com/nope/">Gone, https</a>',
        '<a href="http://www.cabrillocoast.com/nope-too/">Gone, http</a>',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  // Both schemes count as the site's own host, so both links are followed.
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: 'http://www.cabrillocoast.com/nope-too/', reason: 'missing file' },
      { attribute: 'href', value: 'https://www.cabrillocoast.com/nope/', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] reports a missing fragment', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<a href="/other/#no-such-id">Missing section</a>',
        '<a href="/other/#present">Present section</a>',
      ],
      'other/index.html': ['<a href="#nowhere">Missing local section</a>'],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: '#nowhere', reason: 'missing fragment' },
      { attribute: 'href', value: '/other/#no-such-id', reason: 'missing fragment' },
    ],
    formatProblems(problems),
  );
  // A fragment-only link is resolved against the page that holds it.
  assert.ok(String(findingFor(problems, '#nowhere').page).includes('other'), formatProblems(problems));
});

test('[AC-07][F-018] reports a missing image', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), { 'index.html': ['<img src="/assets/missing.png" alt="">'] }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'src', value: '/assets/missing.png', reason: 'missing file' }],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] reports a search form whose data-index names no file', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'blog/index.html': ['<form id="blog-search-stale" data-index="/blog/missing.json"></form>'],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'data-index', value: '/blog/missing.json', reason: 'missing file' }],
    formatProblems(problems),
  );
  const holder = String(problems[0].page);
  assert.ok(holder.includes('blog') && !holder.includes('post'), formatProblems(problems));
});

test('[AC-07][F-018] reports a broken link on a page two directory levels deep', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), { 'blog/post/index.html': ['<a href="../../missing/">Gone</a>'] }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'href', value: '../../missing/', reason: 'missing file' }],
    formatProblems(problems),
  );
  assert.ok(String(problems[0].page).includes('post'), formatProblems(problems));
});

test('[AC-07][F-018] ignores links to other hosts', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<a href="https://example.com/missing/">Elsewhere</a>',
        '<img src="https://example.com/x.png" alt="">',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(problems, [], formatProblems(problems));
});

test('[AC-07][F-018] enforces the base path', () => {
  // Project-path mode: files sit at the content root that BASEURL maps to,
  // and every URL that is not page-relative carries the prefix.
  const siteDir = writeSite({
    'index.html': page([
      '<a href="/cabrillo-coast/blog/">Blog, prefixed</a>',
      '<a href="./blog/">Blog, page-relative</a>',
      '<a href="https://randyamiller.github.io/cabrillo-coast/blog/">Blog, absolute</a>',
      '<a href="/blog/">Blog, missing the base path</a>',
    ]),
    'blog/index.html': page(['<h1>Technical articles</h1>']),
  });
  const problems = checkSiteLinks({ siteDir, baseurl: BASEURL, siteUrl: PROJECT_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'href', value: '/blog/', reason: 'outside base path' }],
    formatProblems(problems),
  );
});

/* ------------------------------------------------------------------------ */
/* Reference extraction                                                      */
/* ------------------------------------------------------------------------ */

test('[AC-07][F-018] "<!--" inside a quoted attribute value does not hide later references', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<a href="/missing/" title="<!--">Gone, with a comment opener in its title</a>',
        "<p data-note='<!-- not a comment either'>Opener in a single-quoted value</p>",
        '<img src="/missing.png" alt="">',
        '<form id="search-missing" data-index="/missing.json"></form>',
        '<!-- <a href="/commented-out/">A genuine comment stays ignored</a> -->',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'data-index', value: '/missing.json', reason: 'missing file' },
      { attribute: 'src', value: '/missing.png', reason: 'missing file' },
      { attribute: 'href', value: '/missing/', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] a comment ends where the HTML tokenizer ends it', () => {
  // `<!-->` and `<!--->` are complete empty comments and `--!>` closes one,
  // so the link after each is real; a comment never closed runs to the end.
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<!--><a href="/after-empty/">After an abrupt empty comment</a>',
        '<!---><a href="/after-dash/">After an abrupt comment with a dash</a>',
        '<!-- closed with a bang --!><a href="/after-bang/">After a bang-closed comment</a>',
        '<!-- <a href="/inside/">Inside a closed comment</a> -->',
        '<!-- never closed <a href="/unterminated/">Inside an unterminated comment</a>',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: '/after-bang/', reason: 'missing file' },
      { attribute: 'href', value: '/after-dash/', reason: 'missing file' },
      { attribute: 'href', value: '/after-empty/', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] reads single-quoted and unquoted attribute values', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        "<a href='/blog/'>Blog, single-quoted</a>",
        '<a href=/blog/post/ class=plain>Post, unquoted</a>',
        "<img src='/assets/fig.png' alt=''>",
        "<a href='/x/'>Gone, single-quoted</a>",
        '<img src=/y.png alt="">',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: '/x/', reason: 'missing file' },
      { attribute: 'src', value: '/y.png', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] ignores attribute-looking text, commented-out tags and escaped markup', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<p>href="/missing/" written in running text</p>',
        '<span title=\'href="/missing/"\'>A reference written inside another value</span>',
        '<a data-href="/missing/">An attribute that is not checked</a>',
        '<!-- <a href="/missing/">Commented out</a> -->',
        '<pre><code>&lt;a href="/missing/"&gt;Escaped&lt;/a&gt;</code></pre>',
        '<pre><code><span class="na">src</span>=<span class="s">"/missing.png"</span></code></pre>',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(problems, [], formatProblems(problems));
});

test('[AC-07][F-018] parseStartTags skips commented tags and reports offsets into the original HTML', () => {
  const html = [
    '<!-- <a href="/commented/"> -->',
    '<p class="lead" title="<!-- text">Lead</p>',
    "<img src='/fig.png' alt=x>",
    '<!--><br>',
  ].join('\n');
  const tags = parseStartTags(html);
  assert.deepEqual(
    tags.map(({ name, start }) => ({ name, start })),
    [
      { name: 'p', start: html.indexOf('<p ') },
      { name: 'img', start: html.indexOf('<img ') },
      { name: 'br', start: html.indexOf('<br>') },
    ],
  );
  for (const tag of tags) {
    assert.equal(tag.source, html.slice(tag.start, tag.end), `source of <${tag.name}>`);
  }
  assert.deepEqual(tags[0].attrs, { class: 'lead', title: '<!-- text' });
  assert.deepEqual(tags[1].attrs, { src: '/fig.png', alt: 'x' });
});

test('[AC-07][F-018] the first of two duplicate attributes is the one checked', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<a href="/blog/" href="/missing-second/">First is valid</a>',
        '<a href="/missing-first/" HREF="/blog/">First is broken</a>',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'href', value: '/missing-first/', reason: 'missing file' }],
    formatProblems(problems),
  );
  assert.deepEqual(parseStartTags('<a href="/a/" HREF="/b/">')[0].attrs, { href: '/a/' });
});

/* ------------------------------------------------------------------------ */
/* Entity and percent decoding                                               */
/* ------------------------------------------------------------------------ */

test('[AC-07][F-018] decodes character references in a value once before resolving it', () => {
  const siteDir = writeSite(
    withMarkup(
      {
        ...validFiles(),
        'café/index.html': page(['<h2 id="menu">Menu</h2>']),
        'r&d/index.html': page(['<h2 id="lab">Lab</h2>']),
        'x&lt;y/index.html': page(['<h2 id="literal">Named literally</h2>']),
        'p<q/index.html': page(['<h2 id="decoded">Named with the decoded text</h2>']),
      },
      {
        'index.html': [
          '<a href="/caf&#233;/#menu">Decimal reference</a>',
          '<a href="/caf&#xE9;/">Hexadecimal reference</a>',
          '<a href="/r&amp;d/#lab">Ampersand reference</a>',
          '<a href="/x&amp;lt;y/#literal">Escaped reference, decoded once</a>',
          '<a href="/p&amp;lt;q/">Escaped reference, which must not decode twice</a>',
          '<a href="/caf&eacute;/">Named reference the decoder leaves literal</a>',
        ],
      },
    ),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  // A finding carries the value as decoded, so `&amp;lt;` reads `&lt;`.
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: '/caf&eacute;/', reason: 'missing file' },
      { attribute: 'href', value: '/p&lt;q/', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] decodeEntities decodes in one pass and leaves invalid code points as written', () => {
  assert.equal(decodeEntities('&amp;lt; R&amp;D &#39;x&#x27; &copy; &family='), "&lt; R&D 'x' &copy; &family=");
  assert.equal(decodeEntities('caf&#233; caf&#xE9; caf&#Xe9;'), 'café café café');
  assert.equal(decodeEntities('&quot;&apos;&gt;&lt;&nbsp;'), '"\'><\u00a0');
  for (const reference of ['&#0;', '&#xD800;', '&#xDFFF;', '&#1114112;', '&#x110000;', '&amp', '&#233']) {
    assert.equal(decodeEntities(reference), reference, reference);
  }
});

test('[AC-07][F-018] decodes percent-encoded paths and fragments, and reports malformed ones', () => {
  const siteDir = writeSite(
    withMarkup(
      {
        ...validFiles(),
        'café/index.html': page(['<h2 id="résumé">Résumé</h2>']),
        'a b.html': page(['<h2 id="top">Top</h2>']),
      },
      {
        'index.html': [
          '<a href="/caf%C3%A9/">Encoded path</a>',
          '<a href="/caf%c3%a9/#r%C3%A9sum%C3%A9">Encoded path and fragment</a>',
          '<a href="/café/#résumé">Path and fragment written unencoded</a>',
          '<a href="/a%20b.html#top">Encoded space</a>',
          '<a href="/bad%E0%A4%A/">Malformed sequence in the path</a>',
          '<a href="/100%/">Lone percent sign in the path</a>',
          '<a href="/caf%C3%A9/#r%C3%A9sum%C3%A">Malformed sequence in the fragment</a>',
          '<a href="/caf%C3%A9/#r%C3%A9sum%C3%A9-not">Encoded fragment that names no id</a>',
        ],
      },
    ),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: '/100%/', reason: 'missing file' },
      { attribute: 'href', value: '/bad%E0%A4%A/', reason: 'missing file' },
      { attribute: 'href', value: '/caf%C3%A9/#r%C3%A9sum%C3%A', reason: 'missing file' },
      { attribute: 'href', value: '/caf%C3%A9/#r%C3%A9sum%C3%A9-not', reason: 'missing fragment' },
    ],
    formatProblems(problems),
  );
});

/* ------------------------------------------------------------------------ */
/* Target lookup                                                             */
/* ------------------------------------------------------------------------ */

test('[AC-07][F-018] ignores a query string and still checks the fragment after it', () => {
  const siteDir = writeSite(
    withMarkup(validFiles(), {
      'index.html': [
        '<a href="/blog/post/?q=x#intro">Query and fragment</a>',
        '<a href="blog/post/?q=x&amp;page=2#intro">Page-relative, two parameters</a>',
        '<a href="/blog/post/?q=x#nope">Query and a missing fragment</a>',
      ],
    }),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [{ attribute: 'href', value: '/blog/post/?q=x#nope', reason: 'missing fragment' }],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] a directory path without a trailing slash names its index.html', () => {
  const siteDir = writeSite(
    withMarkup(
      { ...validFiles(), 'data/feed.json': '[]\n' },
      {
        'index.html': [
          '<a href="/blog/post">Directory without a slash</a>',
          '<a href="/blog/post#intro">Directory without a slash, with a fragment</a>',
          '<a href="/blog/post#nope">Directory without a slash, missing fragment</a>',
          '<a href="/data">Directory without an index.html</a>',
          '<a href="/data/">Directory without an index.html, with a slash</a>',
        ],
      },
    ),
  );
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: '/blog/post#nope', reason: 'missing fragment' },
      { attribute: 'href', value: '/data', reason: 'missing file' },
      { attribute: 'href', value: '/data/', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] a missing or unnamed site directory throws instead of passing', () => {
  const missing = path.join(parent, 'no-such-site');
  assert.throws(() => checkSiteLinks({ siteDir: missing, baseurl: '', siteUrl: SITE_URL }), {
    code: 'ENOENT',
  });
  assert.throws(() => listHtmlPages(missing), { code: 'ENOENT' });
  for (const siteDir of ['', undefined, null, 42]) {
    assert.throws(() => checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL }), TypeError, String(siteDir));
  }
  assert.throws(() => checkSiteLinks(), TypeError);
});

/* ------------------------------------------------------------------------ */
/* Page URLs from file names                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A site whose page and directory names hold `#`, `?`, `%` and a space, the
 * characters that change a URL's meaning unless they are percent-encoded.
 * Every reference is page-relative or fragment-only and resolves, so the
 * site is valid at either base path.
 * @returns {Record<string, string | Buffer>} A fresh object on every call.
 */
function reservedNameFiles() {
  return {
    'index.html': page([
      '<a href="notes%23v1.html#ok">Notes</a>',
      '<a href="what%3F.html#q">Question</a>',
      '<a href="100%25.html#t">Percent</a>',
      '<a href="a%20b.html#s">Space</a>',
      '<a href="odd%20dir%23%3F%25/#d">Odd directory</a>',
    ]),
    'notes#v1.html': page([
      '<h2 id="ok">Notes</h2>',
      '<a href="#ok">This section</a>',
      '<a href="./">Home</a>',
      '<a href="what%3F.html#q">A page beside this one</a>',
    ]),
    'what?.html': page([
      '<h2 id="q">Question</h2>',
      '<a href="#q">This section</a>',
      '<a href="?x=1#q">This section, with a query</a>',
    ]),
    '100%.html': page(['<h2 id="t">Percent</h2>', '<a href="#t">This section</a>']),
    'a b.html': page(['<h2 id="s">Space</h2>', '<a href="#s">This section</a>']),
    'odd dir#?%/index.html': page([
      '<h2 id="d">Odd directory</h2>',
      '<a href="#d">This section</a>',
      '<a href="page%231.html#p">A page beside this one</a>',
      '<a href="../a%20b.html#s">Up a level</a>',
    ]),
    'odd dir#?%/page#1.html': page([
      '<h2 id="p">Page</h2>',
      '<a href="#p">This section</a>',
      '<a href="./#d">The directory index</a>',
      '<a href="../notes%23v1.html#ok">Up a level</a>',
    ]),
  };
}

test('[AC-07][F-018] pages named with #, ?, % or a space resolve their own links in both modes', () => {
  const siteDir = writeSite(reservedNameFiles());
  for (const mode of MODES) {
    const problems = checkSiteLinks({ siteDir, ...mode });
    assert.deepEqual(problems, [], `baseurl ${JSON.stringify(mode.baseurl)}: ${formatProblems(problems)}`);
  }
});

test('[AC-07][F-018] reports a missing fragment on a page named with reserved characters', () => {
  const siteDir = writeSite(
    withMarkup(reservedNameFiles(), {
      'notes#v1.html': ['<a href="#absent">Missing section</a>'],
      'odd dir#?%/page#1.html': ['<a href="../what%3F.html#absent">Missing section of another page</a>'],
    }),
  );
  for (const mode of MODES) {
    const problems = checkSiteLinks({ siteDir, ...mode });
    const message = `baseurl ${JSON.stringify(mode.baseurl)}: ${formatProblems(problems)}`;
    assert.deepEqual(
      summarize(problems),
      [
        { attribute: 'href', value: '#absent', reason: 'missing fragment' },
        { attribute: 'href', value: '../what%3F.html#absent', reason: 'missing fragment' },
      ],
      message,
    );
    assert.ok(String(findingFor(problems, '#absent').page).includes('notes#v1'), message);
    assert.ok(String(findingFor(problems, '../what%3F.html#absent').page).includes('page#1'), message);
  }
});

test('[AC-07][F-018] listHtmlPages percent-encodes each URL segment and keeps rel and file raw', () => {
  const siteDir = writeSite(reservedNameFiles());
  for (const base of ['', BASEURL]) {
    const pages = listHtmlPages(siteDir, base);
    assert.deepEqual(
      pages.map(({ rel, urlPath }) => ({ rel, urlPath })),
      [
        { rel: '100%.html', urlPath: `${base}/100%25.html` },
        { rel: 'a b.html', urlPath: `${base}/a%20b.html` },
        { rel: 'index.html', urlPath: `${base}/` },
        { rel: 'notes#v1.html', urlPath: `${base}/notes%23v1.html` },
        { rel: 'odd dir#?%/index.html', urlPath: `${base}/odd%20dir%23%3F%25/` },
        { rel: 'odd dir#?%/page#1.html', urlPath: `${base}/odd%20dir%23%3F%25/page%231.html` },
        { rel: 'what?.html', urlPath: `${base}/what%3F.html` },
      ],
      `baseurl ${JSON.stringify(base)}`,
    );
    for (const { file, rel } of pages) {
      assert.equal(file, path.join(siteDir, ...rel.split('/')), `file of ${rel}`);
    }
  }
});

/* ------------------------------------------------------------------------ */
/* Symbolic links                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Creates a symbolic link at `rel` inside `siteDir`, written relative to the
 * link's own directory. Parent directories are created as needed.
 * @param {string} siteDir
 * @param {string} rel POSIX path of the link relative to `siteDir`.
 * @param {string} target Absolute path the link points at.
 */
function symlinkIn(siteDir, rel, target) {
  const link = path.join(siteDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), target), link);
}

test('[AC-07][F-018] a symbolic link from inside the site to outside it is a missing file', () => {
  // The outside tree is its own directory under `parent`, beside the site.
  const outside = writeSite({
    'secret.html': page(['<h2 id="external-id">Outside the site</h2>']),
    'outside-dir/index.html': page(['<h2 id="external-id">Outside the site</h2>']),
  });
  const siteDir = writeSite({
    'index.html': page([
      '<a href="alias.html#external-id">File link, with a fragment</a>',
      '<a href="alias.html">File link</a>',
      '<a href="aliasdir/#external-id">Directory link, with a fragment</a>',
      '<a href="aliasdir">Directory link, without a slash</a>',
      '<a href="trap/#external-id">Directory whose index.html is a link, with a fragment</a>',
      '<a href="trap/">Directory whose index.html is a link</a>',
      '<a href="trap#external-id">The same directory without a slash, with a fragment</a>',
      '<a href="trap">The same directory without a slash</a>',
    ]),
  });
  symlinkIn(siteDir, 'alias.html', path.join(outside, 'secret.html'));
  symlinkIn(siteDir, 'aliasdir', path.join(outside, 'outside-dir'));
  symlinkIn(siteDir, 'trap/index.html', path.join(outside, 'secret.html'));
  const problems = checkSiteLinks({ siteDir, baseurl: '', siteUrl: SITE_URL });
  assert.deepEqual(
    summarize(problems),
    [
      { attribute: 'href', value: 'alias.html', reason: 'missing file' },
      { attribute: 'href', value: 'alias.html#external-id', reason: 'missing file' },
      { attribute: 'href', value: 'aliasdir', reason: 'missing file' },
      { attribute: 'href', value: 'aliasdir/#external-id', reason: 'missing file' },
      { attribute: 'href', value: 'trap', reason: 'missing file' },
      { attribute: 'href', value: 'trap#external-id', reason: 'missing file' },
      { attribute: 'href', value: 'trap/', reason: 'missing file' },
      { attribute: 'href', value: 'trap/#external-id', reason: 'missing file' },
    ],
    formatProblems(problems),
  );
});

test('[AC-07][F-018] a symbolic link that stays inside the site resolves, as does a linked site directory', () => {
  const siteDir = writeSite({
    'index.html': page([
      '<a href="alias.html#inside">File link to a page in the site</a>',
      '<a href="docs/#guide">Directory link to a directory in the site</a>',
      '<a href="docs#guide">Directory link, without a slash</a>',
      '<a href="alias.html#absent">File link, missing fragment</a>',
      '<a href="notes.html#plain">Link served as HTML to a file not named .html</a>',
      '<a href="notes.html#gone">The same link, missing fragment</a>',
    ]),
    'real.html': page(['<h2 id="inside">Inside the site</h2>']),
    'manual/index.html': page(['<h2 id="guide">Guide</h2>']),
    'notes.txt': page(['<h2 id="plain">Plain</h2>']),
  });
  symlinkIn(siteDir, 'alias.html', path.join(siteDir, 'real.html'));
  symlinkIn(siteDir, 'docs', path.join(siteDir, 'manual'));
  // The name served decides whether a fragment is checked, not the name of
  // the file the link resolves to.
  symlinkIn(siteDir, 'notes.html', path.join(siteDir, 'notes.txt'));
  // The same site reached through a link to its directory gives the same
  // result, so containment compares canonical paths on both sides.
  const linkedDir = `${siteDir}-link`;
  fs.symlinkSync(siteDir, linkedDir);
  for (const dir of [siteDir, linkedDir]) {
    const problems = checkSiteLinks({ siteDir: dir, baseurl: '', siteUrl: SITE_URL });
    assert.deepEqual(
      summarize(problems),
      [
        { attribute: 'href', value: 'alias.html#absent', reason: 'missing fragment' },
        { attribute: 'href', value: 'notes.html#gone', reason: 'missing fragment' },
      ],
      `${dir}: ${formatProblems(problems)}`,
    );
  }
});

