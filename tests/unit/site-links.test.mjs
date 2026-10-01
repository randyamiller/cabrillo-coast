/* Cabrillo Coast LLC — unit proof that the built-site link checker reports failures (AC-07, F-018) */
/**
 * `checkSiteLinks` in `tests/static/lib/site-links.mjs` is what gives the
 * AC-07 link check in `tests/static/built-pages.test.mjs` its meaning: a
 * checker that quietly returned `[]` would let every broken link through.
 * This suite writes small synthetic sites into a temporary directory and
 * proves that the checker
 *   - reports nothing for a site whose every reference resolves,
 *   - reports a broken page-relative link, a broken absolute link on the
 *     site's own host (under both schemes), a missing fragment and a missing
 *     image,
 *   - ignores links to other hosts, and
 *   - reports a root-relative link that escapes the base path of a
 *     project-path deployment.
 *
 * Every failure case starts from the same valid baseline (`validFiles`) and
 * adds only the references under test, so a finding can come from nothing
 * else. Findings are compared without their `page` field (`summarize`), and
 * `page` is checked only for naming the right page, so the suite pins the
 * checker's contract rather than its report format.
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

import { checkSiteLinks } from '../static/lib/site-links.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Deployment URL of the custom-domain build (`url` in `_config.yml`). */
const SITE_URL = 'https://www.cabrillocoast.com';

/** Deployment URL of the project-path build (`CNAME` removed). */
const PROJECT_URL = 'https://randyamiller.github.io';

/** Base path the project-path build is served under. */
const BASEURL = '/cabrillo-coast';

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

