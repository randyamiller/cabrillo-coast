/* Cabrillo Coast LLC — draft privacy, publishing configuration and article schema (AC-01, AC-04, F-017) */
/**
 * Source checks over the repository. Nothing here reads build output (no
 * `SITE_DIR`), so the suite runs in the first `node --test
 * "tests/**\/*.test.mjs"` pass of `scripts/verify.mjs`, before any build.
 *
 * AC-01, draft privacy and publishing configuration:
 *   - nothing under `_drafts/` or `assets/drafts/` is tracked;
 *   - the working tree passes `checkTrackedContent`, the rules `guard`
 *     applies at commit and push time: no tracked drafts or draft images, no
 *     `published:` key, no future date, no orphan `assets/blog/<slug>/`, and
 *     every article valid and free of unsafe markup;
 *   - `.gitignore` lists every Jekyll, Bundler, npm, Playwright, draft and
 *     draft-image entry, and its own patterns ignore drafts and draft images;
 *   - `.githooks/pre-commit` and `.githooks/pre-push` run the two `guard`
 *     commands and are executable, with index mode `100755` once tracked;
 *   - `_config.yml` sets `theme: null` and `future: false`, never sets a base
 *     path, lists every `exclude` entry, and its `url` matches the
 *     deployment that `CNAME` selects;
 *   - `_config.preview.yml` restates that `exclude` list without
 *     `assets/drafts` and sets nothing else;
 *   - `Gemfile` and `Gemfile.lock` pin the GitHub Pages gem versions;
 *   - `.nojekyll` is absent.
 *
 * AC-04, article schema: every `_posts/**\/*.md` and fixture article has a
 * valid filename and slug and passes `parseArticle` and `validateArticle`,
 * with its images resolving to files on disk; slugs are unique across posts,
 * fixtures and the author's local drafts. Draft contents are never read:
 * drafts are private and may be incomplete.
 *
 * Every rule comes from `scripts/lib/articles.mjs`, the module `guard` uses,
 * so commit time and test time judge content identically.
 *
 * Paths resolve from this file's own location (`ROOT`), never from
 * `process.cwd()`, and git runs in `ROOT`, so the suite gives the same answer
 * from any directory, locally and in CI. It needs no network and writes
 * nothing.
 *
 * Run: node --test tests/static/blog-content.test.mjs (Node 22 or later).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  ARTICLE_PATH_RE,
  SLUG_MAX,
  SLUG_RE,
  checkTrackedContent,
  parseArticle,
  validateArticle,
} from '../../scripts/lib/articles.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Repository root: two levels above `tests/static/`. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Today as `YYYY-MM-DD` in UTC, the date the article rules compare against. */
const TODAY_UTC = new Date().toISOString().slice(0, 10);

/** Entries `.gitignore` must list (AAP 0.2.3 and 0.6.2). */
const GITIGNORE_ENTRIES = Object.freeze([
  '_drafts/',
  'assets/drafts/',
  '_site/',
  '.jekyll-cache/',
  '.jekyll-metadata',
  '.sass-cache/',
  'vendor/',
  '.bundle/',
  'node_modules/',
  'tests/visual/test-results/',
  'tests/visual/report/',
]);

/** Paths `git check-ignore` must report as ignored by `.gitignore` itself. */
const IGNORE_PROBES = Object.freeze(['_drafts/x.md', 'assets/drafts/x/y.png']);

/** Entries the `_config.yml` `exclude` list must contain (AAP 0.6.2). */
const CONFIG_EXCLUDES = Object.freeze([
  'README.md',
  'Gemfile',
  'Gemfile.lock',
  'package.json',
  'package-lock.json',
  'vendor',
  'node_modules',
  'tests',
  'scripts',
  'assets/drafts',
]);

/** The one entry `_config.preview.yml` leaves out, so draft images render in the preview. */
const PREVIEW_ONLY_INCLUDED = 'assets/drafts';

/** The hooks and the guard command each must run (AAP 0.6.2). */
const HOOKS = Object.freeze([
  Object.freeze({ file: '.githooks/pre-commit', command: 'node scripts/article.mjs guard --staged' }),
  Object.freeze({ file: '.githooks/pre-push', command: 'node scripts/article.mjs guard --pre-push' }),
]);

/** `url` of the project-path deployment, used once `CNAME` is removed (AAP 0.5.3). */
const PROJECT_URL = 'https://randyamiller.github.io';

/** Gem versions `Gemfile.lock` must resolve, matching pages.github.com/versions.json. */
const LOCKED_GEMS = Object.freeze([
  ['github-pages', '232'],
  ['jekyll', '3.10.0'],
  ['kramdown', '2.4.0'],
  ['rouge', '3.30.0'],
]);

/** The nokogiri version Pages runs; every platform variant in the lock must carry it. */
const NOKOGIRI_VERSION = '1.16.7';

/** Maximum slug length in characters (AAP 0.5.3). */
const SLUG_LIMIT = 60;

/** A post filename: `YYYY-MM-DD-<slug>.md`. */
const POST_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

/** Folders holding articles that are validated as posts. */
const POSTS_DIR = '_posts';
const FIXTURE_POSTS_DIR = 'tests/fixtures/posts';

/** The fixture articles the AAP requires (AAP 0.6.2, "Fixtures"). */
const REQUIRED_FIXTURES = Object.freeze([
  'tests/fixtures/posts/2026-01-15-fixture-code-and-tables.md',
  'tests/fixtures/posts/2026-02-01-fixture-escaping-and-liquid.md',
]);

/** The author's local drafts folder; only its filenames are read, never its contents. */
const DRAFTS_DIR = '_drafts';

/**
 * Environment for git. Variables that point git at another repository, work
 * tree or index (a git hook exports several of them) are removed, so `ROOT`
 * alone decides which repository is inspected. `GIT_OPTIONAL_LOCKS=0` keeps
 * read-only commands from refreshing the index.
 */
const GIT_REDIRECT_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]);
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const name of GIT_REDIRECT_VARS) delete GIT_ENV[name];

/* ------------------------------------------------------------------------ */
/* File and git helpers                                                      */
/* ------------------------------------------------------------------------ */

/** Absolute path of a repository-relative POSIX path. */
function abs(rel) {
  return path.join(ROOT, ...rel.split('/'));
}

/** Reads a repository file as UTF-8. */
function read(rel) {
  return readFileSync(abs(rel), 'utf8');
}

/** Whether a repository path exists. */
function exists(rel) {
  return existsSync(abs(rel));
}

/** Whether a repository path is an existing regular file (symbolic links followed). */
function isFile(rel) {
  try {
    return statSync(abs(rel)).isFile();
  } catch {
    return false;
  }
}

/** Runs git in `ROOT` and returns its standard output; throws with git's message on failure. */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`git ${args.join(' ')} failed in ${ROOT}: ${stderr || error.message}`, { cause: error });
  }
}

/** Runs git in `ROOT` when the exit code matters; returns `{ status, stdout, stderr }`. */
function gitResult(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', env: GIT_ENV });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let repositoryChecked = false;

/**
 * Asserts that `ROOT` is the top level of a git work tree. Without this, a
 * copy of the site inside some other repository would answer "tracked"
 * questions about that repository and pass vacuously.
 */
function assertRepositoryRoot() {
  if (repositoryChecked) return;
  const top = git(['rev-parse', '--show-toplevel']).trim();
  assert.equal(
    path.resolve(realpathSync(top)),
    path.resolve(realpathSync(ROOT)),
    `${ROOT} must be the top level of its git work tree (git reports ${top})`,
  );
  repositoryChecked = true;
}

/**
 * Every path in the working tree that git does not ignore: tracked files plus
 * untracked, non-ignored ones, so a post is checked before its first commit.
 * Conflict stages are de-duplicated, and paths deleted from disk but still in
 * the index are left out. Ignored local drafts never appear.
 */
function workingTreePaths() {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0');
  const unique = [...new Set(listed.filter((p) => p !== ''))];
  return unique.filter((p) => exists(p));
}

/** Repository-relative POSIX paths of the `.md` files below `dir` (none when `dir` is absent). */
function markdownFilesUnder(dir) {
  if (!existsSync(abs(dir))) return [];
  return readdirSync(abs(dir), { recursive: true })
    .map((entry) => `${dir}/${String(entry).split(path.sep).join('/')}`)
    .filter((rel) => rel.endsWith('.md') && isFile(rel))
    .sort();
}

/**
 * Whether a root-relative public path such as `/assets/blog/foo/fig.png`
 * names an existing file in the repository. `validateArticle` has already
 * rejected external, `data:` and `..` sources before calling it.
 */
function imageExists(publicPath) {
  return isFile(publicPath.replace(/^\/+/, ''));
}

/* ------------------------------------------------------------------------ */
/* Top-level YAML reader for the Jekyll configuration files                  */
/* ------------------------------------------------------------------------ */

/** A top-level `key:` at column 0, followed by whitespace or the end of the line. */
const TOP_KEY_RE = /^([A-Za-z_][\w-]*):(?=\s|$)(.*)$/;

/** A block-sequence item `- value` (or a bare `-`) and its indentation. */
const BLOCK_ITEM_RE = /^([ \t]*)-(?:[ \t]+(.*))?$/;

/** YAML spellings of null and of false, as Ruby's Psych (YAML 1.1) reads them. */
const YAML_NULL_RE = /^(?:null|Null|NULL|~)$/;
const YAML_FALSE_RE = /^(?:false|False|FALSE|no|No|NO|off|Off|OFF)$/;

/**
 * One YAML scalar: a single- or double-quoted string is unquoted (a trailing
 * comment after the closing quote is dropped); a plain value loses any
 * trailing ` # comment`.
 */
function yamlScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m) return m[1].replace(/\\(.)/g, '$1');
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(text);
    if (m) return m[1].replace(/''/g, "'");
  }
  return text.replace(/\s+#.*$/, '').trim();
}

/** The items of a one-line flow list `[a, "b"]`, or `null` when `raw` is not one. */
function yamlFlowList(raw) {
  const text = raw.trim().replace(/\]\s+#.*$/, ']');
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  return text
    .slice(1, -1)
    .split(',')
    .map(yamlScalar)
    .filter((item) => item !== '');
}

/**
 * Reads the top level of a Jekyll configuration file without a YAML library.
 * Only what these checks need is understood: top-level keys at column 0,
 * their scalar values, and list values written as a flow list `[a, b]` or as
 * block items `- item` directly below the key. Blank lines and `#` comments
 * are skipped, and nested mappings are passed over.
 *
 * A key written twice is listed in `duplicates`; `get` and `list` return its
 * last occurrence, the value Ruby's YAML parser keeps.
 *
 * @param {string} text File contents.
 * @returns {{
 *   keys: string[],
 *   duplicates: string[],
 *   has(key: string): boolean,
 *   get(key: string): string | undefined,
 *   list(key: string): string[] | null | undefined,
 * }} `get` gives the unquoted scalar (`''` for a key whose value is a block);
 *   `list` gives the items, `null` when the value is not a list, and
 *   `undefined` when the key is absent.
 */
function readTopLevelYaml(text) {
  const entries = [];
  let current = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const key = TOP_KEY_RE.exec(line);
    if (key) {
      current = { key: key[1], value: key[2].trim(), items: [], itemIndent: null };
      entries.push(current);
      continue;
    }
    const item = BLOCK_ITEM_RE.exec(line);
    if (item && current && current.value === '') {
      const indent = item[1].length;
      if (current.itemIndent === null) current.itemIndent = indent;
      if (indent === current.itemIndent) current.items.push(yamlScalar(item[2] ?? ''));
      continue;
    }
    // Any other column-0 content (a document marker, for instance) ends the block.
    if (/^\S/.test(line)) current = null;
  }

  const keys = entries.map((entry) => entry.key);
  const duplicates = [...new Set(keys.filter((k, index) => keys.indexOf(k) !== index))];
  const last = (k) => entries.findLast((entry) => entry.key === k);
  return {
    keys,
    duplicates,
    has: (k) => last(k) !== undefined,
    get(k) {
      const entry = last(k);
      return entry === undefined ? undefined : yamlScalar(entry.value);
    },
    list(k) {
      const entry = last(k);
      if (entry === undefined) return undefined;
      if (entry.value === '') return entry.itemIndent === null ? null : [...entry.items];
      return yamlFlowList(entry.value);
    },
  };
}

/** Reads a configuration file and fails when it writes a top-level key twice. */
function readConfig(rel) {
  assert.ok(exists(rel), `${rel} is missing`);
  const config = readTopLevelYaml(read(rel));
  assert.deepEqual(config.duplicates, [], `${rel} writes these top-level keys more than once: ${config.duplicates.join(', ')}`);
  return config;
}

/* ------------------------------------------------------------------------ */
/* AC-01: draft privacy and publishing configuration                         */
/* ------------------------------------------------------------------------ */

test('[AC-01][F-017] nothing under _drafts/ or assets/drafts/ is tracked', () => {
  assertRepositoryRoot();
  const tracked = git(['ls-files', '--', '_drafts', 'assets/drafts']).trim();
  assert.equal(
    tracked,
    '',
    `drafts and draft images must never be tracked; remove them from the index with git rm --cached:\n${tracked}`,
  );
});

test('[AC-01][F-017] the working tree passes the tracked-content rules guard applies at commit and push', (t) => {
  assertRepositoryRoot();
  const paths = workingTreePaths();
  assert.ok(paths.includes('_config.yml'), 'git ls-files did not list _config.yml; the path listing is not this repository');

  const articles = paths
    .filter((p) => ARTICLE_PATH_RE.test(p) && isFile(p))
    .map((p) => ({ path: p, text: read(p) }));
  const checked = new Set(articles.map((article) => article.path));
  for (const fixture of REQUIRED_FIXTURES) {
    assert.ok(checked.has(fixture), `${fixture} must be present and not git-ignored, so its rules are checked`);
  }
  t.diagnostic(`checked ${paths.length} paths and ${articles.length} articles against ${TODAY_UTC} (UTC)`);

  const findings = checkTrackedContent({ paths, articles, todayUtc: TODAY_UTC });
  assert.deepEqual(findings, [], `tracked content breaks the publishing rules:\n${findings.join('\n')}`);
});

test('[AC-01][F-017] .gitignore lists every build, tooling, draft and draft-image entry and ignores drafts', () => {
  assert.ok(exists('.gitignore'), '.gitignore is missing');
  const lines = new Set(read('.gitignore').split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  assert.deepEqual(missing, [], `.gitignore must list: ${missing.join(', ')}`);

  assertRepositoryRoot();
  for (const probe of IGNORE_PROBES) {
    const quiet = gitResult(['check-ignore', '-q', '--no-index', '--', probe]);
    assert.equal(quiet.status, 0, `${probe} must be git-ignored (git check-ignore exited ${quiet.status}) ${quiet.stderr}`.trim());
    // The deciding pattern must come from the repository's own .gitignore, not from a
    // developer's .git/info/exclude or global excludes file, which other clones lack.
    const verbose = gitResult(['check-ignore', '-v', '--no-index', '--', probe]);
    const match = /^(.*?):(\d+):(.*)\t/.exec(verbose.stdout);
    assert.ok(match, `git check-ignore -v reported no pattern for ${probe}: ${verbose.stdout}${verbose.stderr}`);
    assert.equal(match[1], '.gitignore', `${probe} is ignored only by ${match[1]}:${match[2]}; .gitignore itself must ignore it`);
    assert.ok(!match[3].startsWith('!'), `${probe} is re-included by .gitignore:${match[2]} (${match[3]})`);
  }
});

test('[AC-01][F-017] .githooks/pre-commit and .githooks/pre-push run guard and are executable', async (t) => {
  assertRepositoryRoot();
  for (const hook of HOOKS) {
    await t.test(`[AC-01][F-017] ${hook.file} runs ${hook.command}`, (st) => {
      assert.ok(isFile(hook.file), `${hook.file} is missing`);
      const text = read(hook.file);
      assert.ok(text.startsWith('#!'), `${hook.file} must start with a #! line, or git cannot run it`);
      assert.ok(text.includes(hook.command), `${hook.file} must run ${hook.command}`);

      if (process.platform === 'win32') {
        st.diagnostic('exec bit not checkable on win32');
      } else {
        const mode = statSync(abs(hook.file)).mode;
        assert.notEqual(mode & 0o111, 0, `${hook.file} must be executable in the working tree (chmod +x)`);
      }

      const staged = git(['ls-files', '-s', '--', hook.file]).trim();
      if (staged === '') {
        assert.notEqual(process.env.CI, 'true', `${hook.file} is not tracked; hooks must be tracked in CI`);
        st.diagnostic(`${hook.file} not yet tracked; guard --staged enforces 100755 at commit`);
        return;
      }
      for (const entry of staged.split('\n')) {
        const mode = entry.split(/\s+/)[0];
        assert.equal(mode, '100755', `${hook.file} is tracked with mode ${mode}; run git update-index --chmod=+x ${hook.file}`);
      }
    });
  }
});

test('[AC-01][F-017] _config.yml disables the theme and future posts, sets no base path and excludes repository files', () => {
  const config = readConfig('_config.yml');

  const theme = config.get('theme');
  assert.ok(theme !== undefined && YAML_NULL_RE.test(theme), `_config.yml must set theme: null (got ${JSON.stringify(theme)})`);
  const future = config.get('future');
  assert.ok(future !== undefined && YAML_FALSE_RE.test(future), `_config.yml must set future: false (got ${JSON.stringify(future)})`);
  assert.equal(config.get('timezone'), 'Etc/UTC', '_config.yml must set timezone: Etc/UTC');
  assert.equal(config.get('permalink'), '/blog/:title/', '_config.yml must set permalink: /blog/:title/');
  assert.equal(config.get('title'), 'Cabrillo Coast', '_config.yml must set title: Cabrillo Coast');

  // Pages supplies the base path through jekyll-github-metadata; setting it here breaks one of the two deployment modes.
  assert.ok(!config.has('baseurl'), '_config.yml must not set baseurl');
  // gems is Jekyll 3's deprecated spelling of plugins; neither may switch on feed, sitemap or SEO plugins.
  for (const key of ['plugins', 'gems']) assert.ok(!config.has(key), `_config.yml must not set ${key}`);

  const exclude = config.list('exclude');
  assert.ok(Array.isArray(exclude), '_config.yml exclude must be a list');
  const missing = CONFIG_EXCLUDES.filter((entry) => !exclude.includes(entry));
  assert.deepEqual(missing, [], `_config.yml exclude must list: ${missing.join(', ')}`);

  const url = config.get('url');
  if (exists('CNAME')) {
    const host = read('CNAME').trim();
    assert.ok(host !== '', 'CNAME must name the custom-domain host');
    assert.equal(url, `https://${host}`, `with CNAME present, _config.yml url must be https://${host}`);
  } else {
    assert.equal(url, PROJECT_URL, `with CNAME absent, _config.yml url must be ${PROJECT_URL}`);
  }
});

test('[AC-01][F-017] _config.preview.yml only restates the exclude list without assets/drafts', () => {
  const base = readConfig('_config.yml');
  const preview = readConfig('_config.preview.yml');
  assert.deepEqual(preview.keys, ['exclude'], `_config.preview.yml must set exclude and nothing else (got ${preview.keys.join(', ')})`);

  const baseExclude = base.list('exclude');
  const previewExclude = preview.list('exclude');
  assert.ok(Array.isArray(baseExclude), '_config.yml exclude must be a list');
  assert.ok(Array.isArray(previewExclude), '_config.preview.yml exclude must be a list');
  assert.equal(
    baseExclude.filter((entry) => entry === PREVIEW_ONLY_INCLUDED).length,
    1,
    `_config.yml exclude must list ${PREVIEW_ONLY_INCLUDED} exactly once`,
  );
  assert.equal(previewExclude.length, baseExclude.length - 1, '_config.preview.yml exclude must hold exactly one entry fewer than _config.yml');
  assert.deepEqual(
    [...previewExclude].sort(),
    baseExclude.filter((entry) => entry !== PREVIEW_ONLY_INCLUDED).sort(),
    `_config.preview.yml exclude must equal the _config.yml list without ${PREVIEW_ONLY_INCLUDED}`,
  );
});

test('[AC-01][F-017] Gemfile and Gemfile.lock pin the GitHub Pages gem versions', () => {
  assert.ok(exists('Gemfile'), 'Gemfile is missing');
  const gemfile = read('Gemfile');
  assert.match(
    gemfile,
    /gem\s+["']github-pages["']\s*,\s*["']232["']\s*,\s*group:\s*:jekyll_plugins/,
    'Gemfile must pin gem "github-pages", "232", group: :jekyll_plugins',
  );
  assert.match(gemfile, /gem\s+["']nokogiri["']\s*,\s*["']1\.16\.7["']/, 'Gemfile must pin gem "nokogiri", "1.16.7"');

  assert.ok(exists('Gemfile.lock'), 'Gemfile.lock is missing; run bundle lock');
  const lock = read('Gemfile.lock');
  for (const [name, version] of LOCKED_GEMS) {
    assert.ok(lock.includes(`${name} (${version})`), `Gemfile.lock must record ${name} (${version})`);
  }
  assert.ok(lock.includes(`nokogiri (${NOKOGIRI_VERSION}`), `Gemfile.lock must record nokogiri (${NOKOGIRI_VERSION}`);
  // Resolved specs sit at four spaces; every platform variant must be the version Pages runs.
  const resolved = [...lock.matchAll(/^ {4}nokogiri \(([^)\s]+)\)/gm)].map((m) => m[1]);
  const stray = resolved.filter((v) => v !== NOKOGIRI_VERSION && !v.startsWith(`${NOKOGIRI_VERSION}-`));
  assert.deepEqual(stray, [], `Gemfile.lock resolves nokogiri versions other than ${NOKOGIRI_VERSION}: ${stray.join(', ')}`);
});

test('[AC-01][F-017] .nojekyll is absent, so GitHub Pages keeps running Jekyll for the blog', () => {
  assert.equal(existsSync(path.join(ROOT, '.nojekyll')), false, '.nojekyll would switch Jekyll off and stop the blog from rendering');
});

/* ------------------------------------------------------------------------ */
/* AC-04: article schema                                                     */
/* ------------------------------------------------------------------------ */

/** Real posts and fixture articles, each validated as a post. */
function articleFiles() {
  return { posts: markdownFilesUnder(POSTS_DIR), fixtures: markdownFilesUnder(FIXTURE_POSTS_DIR) };
}

/** The slug of a post filename, or `null` when the name is not `YYYY-MM-DD-<slug>.md`. */
function postSlug(rel) {
  const m = POST_FILENAME_RE.exec(path.posix.basename(rel));
  return m ? m[2] : null;
}

test('[AC-04][F-017] every article in _posts/ and tests/fixtures/posts/ passes the article schema', async (t) => {
  assert.equal(SLUG_MAX, SLUG_LIMIT, `scripts/lib/articles.mjs must limit slugs to ${SLUG_LIMIT} characters, as the schema does`);

  const { posts, fixtures } = articleFiles();
  for (const fixture of REQUIRED_FIXTURES) {
    assert.ok(fixtures.includes(fixture), `${fixture} is missing`);
  }
  if (posts.length === 0) t.diagnostic('no articles in _posts/ yet; validating fixtures only');

  for (const rel of [...posts, ...fixtures]) {
    await t.test(`[AC-04][F-017] ${rel} passes the article schema`, () => {
      const slug = postSlug(rel);
      assert.ok(slug !== null, `${rel}: filename must be YYYY-MM-DD-<slug>.md`);
      assert.match(slug, SLUG_RE, `${rel}: slug "${slug}" must be lowercase letters, digits and single hyphens`);
      assert.ok(slug.length <= SLUG_LIMIT, `${rel}: slug must be at most ${SLUG_LIMIT} characters (got ${slug.length})`);

      const text = read(rel);
      const { data, body, errors } = parseArticle(text);
      assert.deepEqual(errors, [], `${rel}: front matter does not parse:\n${errors.join('\n')}`);

      const bodyStartLine = text.slice(0, text.length - body.length).split('\n').length;
      const findings = validateArticle({ path: rel, data, body, kind: 'post', todayUtc: TODAY_UTC, imageExists, bodyStartLine });
      assert.deepEqual(findings, [], `${rel} breaks the article schema:\n${findings.join('\n')}`);
    });
  }
});

test('[AC-04][F-017] slugs are unique across _posts/, tests/fixtures/posts/ and local drafts', (t) => {
  const { posts, fixtures } = articleFiles();
  const owners = new Map();
  const clashes = [];
  const claim = (slug, rel) => {
    if (owners.has(slug)) clashes.push(`slug ${slug} is used by both ${owners.get(slug)} and ${rel}`);
    else owners.set(slug, rel);
  };

  for (const rel of [...posts, ...fixtures]) {
    const slug = postSlug(rel);
    // A misnamed file has no slug; the schema case above reports it.
    if (slug !== null) claim(slug, rel);
  }

  // Drafts are private and may be incomplete, so only their filenames are read.
  let drafts = 0;
  if (existsSync(abs(DRAFTS_DIR))) {
    for (const entry of readdirSync(abs(DRAFTS_DIR), { withFileTypes: true })) {
      if (!entry.name.endsWith('.md') || !isFile(`${DRAFTS_DIR}/${entry.name}`)) continue;
      drafts += 1;
      claim(entry.name.slice(0, -'.md'.length), `${DRAFTS_DIR}/${entry.name}`);
    }
  }
  t.diagnostic(`${posts.length} posts, ${fixtures.length} fixtures, ${drafts} local drafts`);

  assert.deepEqual(clashes, [], `every article needs its own slug, because the slug is its URL:\n${clashes.join('\n')}`);
});
