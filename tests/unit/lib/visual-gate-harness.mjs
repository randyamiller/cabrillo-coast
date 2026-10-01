/* Cabrillo Coast LLC — shared harness of the visual-gate and fixture-staging suites (Node built-ins only) */
/**
 * Test infrastructure for `tests/unit/visual-gate.test.mjs` and
 * `tests/unit/fixture-staging.test.mjs`, which prove the visual comparison
 * gate (AC-16) without Jekyll, a browser or the network:
 *
 *   - Report shapes: builders of Playwright Test 1.63.0 JSON reports for the
 *     12 cases of `tests/visual/blog-visual.spec.mjs`, with the messages,
 *     colour sequences and attachments real runs produce, used directly by
 *     the classifier cases and by the stand-in Playwright below.
 *   - Sandbox: a parent folder in `os.tmpdir()` and a git environment that
 *     reads no system or personal configuration and cannot be redirected to
 *     another repository (the isolation of `tests/unit/article-cli.test.mjs`).
 *   - Site repositories: temporary git repositories holding copies of the
 *     real runner, fixture builder, transport and pixel modules, the fixture
 *     articles and a minimal site source. The runner and the builder derive
 *     their repository from their own location, so each copy runs against its
 *     temporary repository and never against this one.
 *   - Stand-ins: `bundle` (a POSIX shell wrapper first on PATH that runs a
 *     Node script) writes small pages from the staged source and logs what it
 *     was given; `node_modules/@playwright/test/cli.js` fetches the served
 *     pages, writes or compares a baseline and writes a real-shaped report.
 *
 * Every path these helpers write lies below the sandbox's parent folder.
 * Importing this module writes nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------------ */
/* Repository files the temporary repositories copy                          */
/* ------------------------------------------------------------------------ */

/** Root of the repository holding this file. */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The gate's modules, copied into every site repository from `ROOT` at test time. */
export const GATE_FILES = Object.freeze([
  'tests/visual/run-visual.mjs',
  'tests/visual/lib/pixels.mjs',
  'tests/visual/playwright.config.mjs',
  'tests/fixtures/build-fixture-site.mjs',
  'scripts/lib/subprocess.mjs',
]);

/** Basenames in `tests/fixtures/posts/`, as `FIXTURE_POSTS` in build-fixture-site.mjs lists them. */
export const FIXTURE_POST_FILES = Object.freeze([
  '2026-01-15-fixture-code-and-tables.md',
  '2026-02-01-fixture-escaping-and-liquid.md',
]);

/* ------------------------------------------------------------------------ */
/* The 12 cases of blog-visual.spec.mjs                                      */
/* ------------------------------------------------------------------------ */

/** Pages, widths and schemes in the order the spec's loops generate them. */
export const PAGES = Object.freeze([
  Object.freeze({ name: 'listing', path: '/blog/' }),
  Object.freeze({ name: 'article', path: '/blog/fixture-code-and-tables/' }),
]);
export const WIDTHS = Object.freeze([375, 800, 1280]);
export const SCHEMES = Object.freeze(['light', 'dark']);

/** Viewport height of every case. */
const HEIGHT = 900;

/**
 * Every case: its spec title, screenshot file name and stem, and the page it
 * opens.
 * @type {ReadonlyArray<Readonly<{ title: string, file: string, stem: string, page: string, path: string, width: number, scheme: string }>>}
 */
export const CASES = Object.freeze(
  PAGES.flatMap(({ name, path: pagePath }) =>
    WIDTHS.flatMap((width) =>
      SCHEMES.map((scheme) =>
        Object.freeze({
          title: `[AC-16][F-018] ${name} ${width}px ${scheme}`,
          file: `${name}-${width}-${scheme}.png`,
          stem: `${name}-${width}-${scheme}`,
          page: name,
          path: pagePath,
          width,
          scheme,
        }),
      ),
    ),
  ),
);

/** Title of the spec's `test.describe` block. */
export const DESCRIBE_TITLE = '[AC-16][F-018] blog visual comparison';

/* ------------------------------------------------------------------------ */
/* Playwright 1.63.0 messages, as its JSON reporter serialises them          */
/* ------------------------------------------------------------------------ */

const ESC = '\u001b';
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`;
const red = (text) => `${ESC}[31m${text}${ESC}[39m`;
const green = (text) => `${ESC}[32m${text}${ESC}[39m`;

/** The `toHaveScreenshot` failure header, colour sequences included. */
const MATCHER_HEADER =
  `Error: ${dim('expect(')}${red('page')}${dim(').')}toHaveScreenshot${dim('(')}${green('expected')}${dim(')')} failed\n\n`;

/** The code frame and stack Playwright appends to a test's error message. */
function codeFrame(line, column) {
  return [
    `  ${line - 2} |           const file = \`\${name}-\${width}-\${scheme}.png\`;`,
    `  ${line - 1} |           const capture = captureOptions(page);`,
    `> ${line} |           await expect(page).toHaveScreenshot(file, {`,
    `      |${' '.repeat(column)}^`,
    `  ${line + 1} |             ...capture,`,
    `    at /work/tests/visual/blog-visual.spec.mjs:${line}:${column}`,
  ].join('\n');
}

/** The matcher's call log, one dimmed line per step, ending with the comparison's summary. */
function callLog(file, summary) {
  const steps = [
    `  - Expect "toHaveScreenshot(${file})" with timeout 5000ms`,
    '    - verifying given screenshot expectation',
    '  - taking page screenshot',
    '    - disabled all CSS animations',
    '  - waiting for fonts to load...',
    '  - fonts loaded',
    `  - ${summary}`,
    '  - waiting 100ms before taking screenshot',
    '  - taking page screenshot',
    '    - disabled all CSS animations',
    '  - waiting for fonts to load...',
    '  - fonts loaded',
    '  - captured a stable screenshot',
    `  - ${summary}`,
  ];
  return `Call log:\n${steps.map(dim).join('\n')}\n`;
}

/** A `toHaveScreenshot` failure with `summary` as its diff line, optionally after a `Timeout:` line. */
function matcherFailure(file, summary, { timeout = false } = {}) {
  return (
    `${MATCHER_HEADER}${timeout ? 'Timeout: 5000ms\n' : ''}  ${summary}\n\n  Snapshot: ${file}\n\n` +
    `${callLog(file, summary)}\n\n${codeFrame(188, 30)}`
  );
}

/** Playwright's pixel-count summary. */
function pixelSummary(pixels, ratio) {
  return `${pixels} pixels (ratio ${ratio} of all image pixels) are different.`;
}

export const messages = Object.freeze({
  /** `toHaveScreenshot` found differing pixels in images of one size. */
  pixelMismatch: (file, pixels = 10000, ratio = '0.01') => matcherFailure(file, pixelSummary(pixels, ratio)),
  /** `toHaveScreenshot` found images of different sizes. */
  sizeMismatch: (file, width = 1280) =>
    matcherFailure(
      file,
      `Expected an image ${width}px by 2400px, received ${width}px by 2448px. ${pixelSummary(width * 48, '0.02')}`,
    ),
  /** A matcher that timed out while the screenshots still differed: a `Timeout:` line before the diff. */
  timedOutMismatch: (file) => matcherFailure(file, pixelSummary(10000, '0.01'), { timeout: true }),
  /** A page that never rendered the same twice. */
  unstable: (file) => matcherFailure(file, 'Failed to take two consecutive stable screenshots.'),
  /** A comparison run without the baseline file (`--update-snapshots=none`). */
  missingSnapshot: (absolutePath) => `Error: A snapshot doesn't exist at ${absolutePath}.\n\n${codeFrame(188, 30)}`,
  /** A page that could not be loaded. */
  navigation: (url) =>
    `Error: page.goto: net::ERR_CONNECTION_REFUSED at ${url}\nCall log:\n` +
    `${dim(`  - navigating to "${url}", waiting until "load"`)}\n\n\n${codeFrame(175, 37)}`,
  /** Any `Error` the spec throws, the strict comparison's own message included. */
  thrown: (message) => `Error: ${message}\n\n${codeFrame(162, 9)}`,
  /** The test's own timeout. */
  testTimeout: (ms = 30000) => red(`Test timeout of ${ms}ms exceeded.`),
});

/* ------------------------------------------------------------------------ */
/* Playwright 1.63.0 JSON report builders                                    */
/* ------------------------------------------------------------------------ */

const START_TIME = '2026-10-01T19:12:48.385Z';

/**
 * Attachments of a failed screenshot case: `<stem>-<kind>.png` for each of
 * `kinds` under `dir`, then Playwright's `error-context`.
 * @param {string} stem
 * @param {string} dir Folder the files are said to lie in.
 * @param {string[]} [kinds]
 */
export function evidence(stem, dir, kinds = ['expected', 'actual', 'diff']) {
  return [
    ...kinds.map((kind) => ({ name: `${stem}-${kind}.png`, contentType: 'image/png', path: path.join(dir, `${stem}-${kind}.png`) })),
    { name: 'error-context', contentType: 'text/markdown', path: path.join(dir, 'error-context.md') },
  ];
}

/** One passed attempt. */
export function passed({ retry = 0 } = {}) {
  return {
    workerIndex: retry,
    parallelIndex: 0,
    status: 'passed',
    duration: 812,
    errors: [],
    stdout: [],
    stderr: [],
    retry,
    startTime: START_TIME,
    annotations: [],
    attachments: [],
  };
}

/**
 * One attempt that ended with `status` and the given error messages; an
 * `errorLocation` and located errors unless it timed out, as Playwright
 * reports them.
 * @param {string[]} errorMessages
 * @param {{ name: string, contentType: string, path: string }[]} [attachments]
 * @param {{ status?: string, retry?: number }} [options]
 */
export function failed(errorMessages, attachments = [], { status = 'failed', retry = 0 } = {}) {
  const located = status === 'failed';
  const location = { file: '/work/tests/visual/blog-visual.spec.mjs', column: 30, line: 188 };
  const errors = errorMessages.map((message) => (located ? { location, message } : { message }));
  const result = {
    workerIndex: retry,
    parallelIndex: 0,
    status,
    duration: 1543,
    errors,
    stdout: [],
    stderr: [],
    retry,
    startTime: START_TIME,
    annotations: [],
    attachments,
  };
  if (errors.length > 0) {
    const first = errors[0].message.split('\n\n')[0];
    result.error = located ? { message: first, stack: first, location, snippet: '' } : { message: first, stack: first };
  }
  if (located && errors.length > 0) result.errorLocation = location;
  return result;
}

/**
 * A complete report of the spec's run.
 * @param {Record<string, object[]>} [resultsByTitle] Results of each case by
 *   its title; a case not named here passed once.
 * @param {{ cases?: ReadonlyArray<{ title: string }>, errors?: object[], updateSnapshots?: string }} [options]
 *   `cases` limits the report to those cases (an incomplete run), `errors`
 *   are run-level errors.
 */
export function buildReport(resultsByTitle = {}, { cases = CASES, errors = [], updateSnapshots = 'none' } = {}) {
  const stats = { startTime: START_TIME, duration: 10943.964, expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  const specs = cases.map(({ title }, index) => {
    const results = resultsByTitle[title] ?? [passed()];
    const statuses = results.map((result) => result.status);
    let status;
    if (statuses.length > 0 && statuses.every((s) => s === 'skipped')) status = 'skipped';
    else if (statuses.length > 0 && statuses.at(-1) === 'passed') status = statuses.length === 1 ? 'expected' : 'flaky';
    else status = 'unexpected';
    stats[status === 'flaky' ? 'flaky' : status] += 1;
    return {
      title,
      ok: status === 'expected' || status === 'flaky' || status === 'skipped',
      tags: [],
      tests: [
        {
          timeout: 30000,
          annotations: [],
          expectedStatus: 'passed',
          projectId: 'chromium',
          projectName: 'chromium',
          results,
          status,
        },
      ],
      id: `b2ff05121c1fe9747ff9-${String(index).padStart(20, '0')}`,
      file: 'blog-visual.spec.mjs',
      line: 169,
      column: 9,
    };
  });
  return {
    config: {
      configFile: '/work/tests/visual/playwright.config.mjs',
      rootDir: '/work/tests/visual',
      forbidOnly: true,
      fullyParallel: false,
      globalTimeout: 0,
      maxFailures: 0,
      metadata: { actualWorkers: 1 },
      projects: [{ id: 'chromium', name: 'chromium', retries: 0, testDir: '/work/tests/visual', testMatch: ['*.spec.mjs'], timeout: 30000 }],
      updateSnapshots,
      version: '1.63.0',
      workers: 1,
    },
    suites: [
      {
        title: 'blog-visual.spec.mjs',
        file: 'blog-visual.spec.mjs',
        column: 0,
        line: 0,
        specs: [],
        suites: [{ title: DESCRIBE_TITLE, file: 'blog-visual.spec.mjs', line: 165, column: 6, specs }],
      },
    ],
    errors,
    stats,
  };
}

/* ------------------------------------------------------------------------ */
/* Sandbox and git isolation                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Variables that point git at another repository, index or object store, or
 * inject configuration (`git -c` exports `GIT_CONFIG_PARAMETERS`). A git hook
 * that runs these tests exports several of them.
 */
const GIT_REDIRECT_VARS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_SYSTEM',
]);

/**
 * Inputs of the gate, its builds and Playwright that an outer run may carry
 * (`scripts/verify.mjs` passes `VISUAL_CHANGE_INTENDED` on): each case sets
 * the ones it means.
 */
function isGateInput(name) {
  return (
    name.startsWith('VISUAL_') ||
    name === 'JEKYLL_ENV' ||
    name.startsWith('PLAYWRIGHT_') ||
    name.startsWith('PW_TEST_') ||
    name.startsWith('FAKE_') ||
    name === 'NODE_TEST_CONTEXT'
  );
}

/**
 * A parent folder under `os.tmpdir()` (its real path, so
 * `GIT_CEILING_DIRECTORIES` matches where the temp folder is a symbolic
 * link) and the environment every git command and every child gets.
 * @param {string} prefix Folder name prefix.
 * @returns {{ parent: string, env: NodeJS.ProcessEnv, folder: (name: string) => string, cleanup: () => void }}
 */
export function createSandbox(prefix) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const gitConfig = path.join(parent, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const home = path.join(parent, 'home');
  fs.mkdirSync(home);

  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (GIT_REDIRECT_VARS.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name) || isGateInput(name)) delete env[name];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_AUTHOR_NAME: 'Visual Gate Test',
    GIT_COMMITTER_NAME: 'Visual Gate Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    // A temporary folder that is not a repository never discovers an enclosing one.
    GIT_CEILING_DIRECTORIES: parent,
    CI: 'true',
  });

  return {
    parent,
    env,
    folder(name) {
      const dir = path.join(parent, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    cleanup() {
      fs.rmSync(parent, { recursive: true, force: true });
    },
  };
}

/**
 * Runs git with `env`; throws with git's stderr on failure and returns the
 * trimmed stdout.
 */
export function git(env, cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}) in ${cwd}:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/* ------------------------------------------------------------------------ */
/* Site repositories                                                         */
/* ------------------------------------------------------------------------ */

/** Writes `text` (or bytes) at `rel` below `root`, creating its folders. */
export function write(root, rel, content) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Reads the UTF-8 file at `rel` below `root`. */
export function read(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

/** Site source of a blog-era commit, by repository-relative path. */
export const SITE_SOURCE = Object.freeze({
  '_config.yml': 'title: Visual gate fixture\nfuture: false\n',
  '_config.preview.yml': 'title: Visual gate fixture\nfuture: false\n',
  '_layouts/post.html': '<article>{{ content }}</article>\n',
  '_includes/footer.html': '<footer>Visual gate fixture</footer>\n',
  'index.html': '<!DOCTYPE html>\n<title>Visual gate fixture</title>\n',
  'blog/index.html': '---\nlayout: null\n---\n<h1>Blog</h1>\n',
  'blog/base-only.html': '<p>Committed in the base, deleted in the working tree.</p>\n',
  '_posts/2026-03-01-real-article.md': '---\ntitle: "Real article"\n---\nREAL-POST-MARKER\n',
});

/** Paths of the site source that build-fixture-site.mjs must never stage. */
export const DRAFT_IMAGE_REL = 'assets/drafts/real-draft/x.png';
export const REAL_DRAFT_REL = '_drafts/real-draft.md';
export const REAL_POST_REL = '_posts/2026-03-01-real-article.md';

/** Base and working-tree variants of `styles.css`, each with its provenance marker. */
export const BASE_STYLES = '/* BASE-MARKER */\nbody { color: #102030; }\n';
export const WORK_STYLES = '/* WORK-MARKER */\nbody { color: #405060; }\n';

/** What `changeWorkingTree` adds, removes and edits. */
export const UNTRACKED_REL = '_includes/work-only.html';
export const DELETED_REL = 'blog/base-only.html';
export const FIXTURE_EDIT = '\nEdited in the working tree after the base commit: FIXTURE-WORK-EDIT.\n';

/**
 * Creates a git repository at `repo` holding copies of the gate's modules
 * and fixture articles from `ROOT`, a `.gitignore` like the real one and,
 * unless `preBlog` is set, the blog-era site source with `styles`, plus a
 * draft image force-added to the commit (a revision that carries one must
 * still never stage it) and an ignored real draft in the working tree.
 * Everything is committed with `message`.
 * @param {NodeJS.ProcessEnv} env Sandbox environment.
 * @param {string} repo Folder to create the repository in.
 * @param {{ styles?: string, message?: string, preBlog?: boolean }} [options]
 *   `preBlog` commits only the home page and stylesheet: a base without
 *   `_layouts/post.html`.
 * @returns {string} the commit id.
 */
export function createSiteRepo(env, repo, { styles = BASE_STYLES, message = 'Base commit', preBlog = false } = {}) {
  fs.mkdirSync(repo, { recursive: true });
  git(env, repo, 'init', '-q');
  for (const rel of GATE_FILES) fs.copyFileSync(path.join(ROOT, rel), mkdirFor(repo, rel));
  for (const file of FIXTURE_POST_FILES) {
    const rel = `tests/fixtures/posts/${file}`;
    fs.copyFileSync(path.join(ROOT, rel), mkdirFor(repo, rel));
  }
  write(repo, '.gitignore', '_drafts/\nassets/drafts/\nnode_modules/\ntests/visual/test-results/\ntests/visual/report/\n');
  write(repo, 'styles.css', styles);
  if (preBlog) {
    write(repo, 'index.html', SITE_SOURCE['index.html']);
    return commitAll(env, repo, message);
  }
  return commitBlogSource(env, repo, message);
}

/**
 * Writes the blog-era site source, a draft image and an ignored real draft
 * into `repo`, force-adds the draft image (a revision that carries one must
 * still never stage it) and commits everything with `message`.
 * @returns {string} the commit id.
 */
export function commitBlogSource(env, repo, message) {
  for (const [rel, text] of Object.entries(SITE_SOURCE)) write(repo, rel, text);
  write(repo, DRAFT_IMAGE_REL, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  write(repo, REAL_DRAFT_REL, '---\ntitle: "Real draft"\n---\nREAL-DRAFT-MARKER\n');
  git(env, repo, 'add', '-f', DRAFT_IMAGE_REL);
  return commitAll(env, repo, message);
}

/** Creates the folders of `rel` below `root` and returns its absolute path. */
function mkdirFor(root, rel) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/**
 * Stages everything that is not ignored and commits it with `message`;
 * hooks never run.
 * @returns {string} the commit id.
 */
export function commitAll(env, repo, message) {
  git(env, repo, 'add', '-A');
  git(env, repo, 'commit', '-q', '--no-verify', '--allow-empty', '-m', message);
  return git(env, repo, 'rev-parse', 'HEAD');
}

/**
 * Turns a committed site into a changed working tree, left uncommitted:
 * `styles.css` becomes `styles`, an untracked allow-listed file appears,
 * a committed allow-listed file is deleted and the first fixture article
 * gains a line.
 */
export function changeWorkingTree(repo, { styles = WORK_STYLES } = {}) {
  write(repo, 'styles.css', styles);
  write(repo, UNTRACKED_REL, '<aside>Untracked, working tree only.</aside>\n');
  fs.rmSync(path.join(repo, ...DELETED_REL.split('/')));
  fs.appendFileSync(path.join(repo, 'tests', 'fixtures', 'posts', FIXTURE_POST_FILES[0]), FIXTURE_EDIT);
}

/** The JSON lines of a log file, or none when it was never written. */
export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/* ------------------------------------------------------------------------ */
/* Stand-in bundle                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The stand-in for `bundle exec jekyll build --source S --destination D
 * --config … [--baseurl B] [--drafts]`. It appends one JSON line to the file
 * in `FAKE_BUNDLE_LOG`: the arguments, `JEKYLL_ENV` and `BUNDLE_GEMFILE` as
 * received, `S/styles.css`, each `S/_posts/*.md` with its SHA-256 and every
 * file under S. It then writes `D/index.html`, `D/blog/index.html` and
 * `D/blog/<slug>/index.html` for every post dated today or earlier (as
 * `future: false` builds), each page holding `styles.css` and the posts it
 * shows with their hashes, so equal sources give equal pages and nothing
 * names the side that built them. Hooks read from the staged source:
 * `FAKE-BUILD-FAIL` in `styles.css` exits 1 and `FAKE-NO-ARTICLE` leaves out
 * `blog/fixture-code-and-tables/`.
 */
const FAKE_BUNDLE_SOURCE = `import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const logFile = process.env.FAKE_BUNDLE_LOG;
if (!logFile) {
  console.error('fake bundle: FAKE_BUNDLE_LOG is not set');
  process.exit(70);
}
const source = option('--source');
const destination = option('--destination');
if (args.slice(0, 3).join(' ') !== 'exec jekyll build' || !source || !destination) {
  console.error('fake bundle: unexpected arguments ' + args.join(' '));
  process.exit(64);
}
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const listFiles = (dir) => {
  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return files.sort();
};
const stylesFile = path.join(source, 'styles.css');
const styles = fs.existsSync(stylesFile) ? fs.readFileSync(stylesFile, 'utf8') : null;
const postsDir = path.join(source, '_posts');
const posts = fs.existsSync(postsDir)
  ? fs.readdirSync(postsDir).filter((name) => name.endsWith('.md')).sort()
      .map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(postsDir, file))) }))
  : [];
const failed = styles !== null && styles.includes('FAKE-BUILD-FAIL');
fs.appendFileSync(logFile, JSON.stringify({
  source,
  destination,
  cwd: process.cwd(),
  args,
  jekyllEnv: process.env.JEKYLL_ENV ?? null,
  bundleGemfile: process.env.BUNDLE_GEMFILE ?? null,
  styles,
  posts,
  files: listFiles(source),
  failed,
}) + '\\n');
if (failed) {
  console.error('fake bundle: FAKE-BUILD-FAIL in styles.css');
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
const built = posts.filter(({ file }) => file.slice(0, 10) <= today);
const page = (heading, list) =>
  '<!DOCTYPE html>\\n<html lang="en">\\n<head><style>\\n' + (styles ?? '') + '</style></head>\\n<body>\\n<h1>' + heading +
  '</h1>\\n<ul>\\n' + list.map(({ file, sha256: hash }) => '<li>' + file + ' ' + hash + '</li>\\n').join('') + '</ul>\\n</body>\\n</html>\\n';
const emit = (rel, text) => {
  const file = path.join(destination, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
emit('index.html', page('home', []));
emit('blog/index.html', page('blog', built));
for (const post of built) {
  const slug = /^\\d{4}-\\d{2}-\\d{2}-(.+)\\.md$/.exec(post.file)[1];
  if (slug === 'fixture-code-and-tables' && styles !== null && styles.includes('FAKE-NO-ARTICLE')) continue;
  emit('blog/' + slug + '/index.html', page(slug, [post]));
}
`;

/** Quotes text as one POSIX shell word. */
function shQuote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Writes the stand-in bundle into `<dir>/bin/bundle` (a POSIX shell wrapper
 * running this Node binary on `<dir>/fake-bundle.mjs`).
 * @returns {string} the folder to put first on PATH.
 */
export function installFakeBundle(dir) {
  const script = path.join(dir, 'fake-bundle.mjs');
  fs.writeFileSync(script, FAKE_BUNDLE_SOURCE);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'bundle'),
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

/* ------------------------------------------------------------------------ */
/* Stand-in Playwright Test                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The stand-in for `node node_modules/@playwright/test/cli.js test --config C
 * --update-snapshots=<mode>`, as run-visual.mjs runs it. Like Playwright it
 * first removes `<repo>/tests/visual/test-results`. It fetches the listing
 * and the article from `VISUAL_BASE_URL` and appends one JSON line to
 * `FAKE_PW_LOG`: its arguments, working folder, mode, fault, the
 * environment it was given and the two page bodies.
 *
 * Mode `all` writes the 12 baseline files `<name>-<width>-<scheme>.png`,
 * each holding its page's body, into `VISUAL_BASELINE_DIR`. Mode `none`
 * compares each case's page body with its baseline file: equal passes;
 * different fails with Playwright's pixel (listing) or size (article)
 * message, writes `<stem>-expected/-actual/-diff.png` into the case's folder
 * under test-results and attaches them; an absent baseline fails with the
 * missing-snapshot message and no actual image. A JSON report goes to
 * `VISUAL_RESULTS_FILE` when it is set, and the exit code is 0 when every
 * case passed, 1 otherwise.
 *
 * `FAKE_PW_FAULT` adds one fault: `strict` (differences fail with
 * `strictMismatchMessage` from the repository's own lib/pixels.mjs, as the
 * spec's zero-tolerance layer does), `mixed` (the last case fails with a
 * navigation error instead), `incomplete` (10 cases reported), `no-actual`
 * (no actual image written or attached), `interrupted` (exit 130 after the
 * report), `killed` (SIGKILL itself after the actual images), `no-results`
 * (no JSON report), `run-error` (a run-level error), `timedout` (the second
 * case timed out), `baseline-short` (11 baseline files), `baseline-exit`
 * (exit 1 after the baseline), `baseline-misnamed` (12 wrongly named
 * baseline files) and `baseline-one-misnamed` (the first file wrongly named).
 */
function fakePlaywrightSource() {
  // The stand-in imports the report builders from this module, wherever the repository lies.
  const harness = import.meta.url;
  return `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, buildReport, evidence, failed, messages, passed } from ${JSON.stringify(harness)};
import { strictMismatchMessage } from '../../../tests/visual/lib/pixels.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEST_RESULTS = path.join(REPO, 'tests', 'visual', 'test-results');
const REPORTED_ENV = [
  'VISUAL_BASE_URL', 'VISUAL_BASELINE_DIR', 'VISUAL_RESULTS_FILE', 'VISUAL_CHANGE_INTENDED',
  'PLAYWRIGHT_HTML_OUTPUT_DIR', 'PLAYWRIGHT_HTML_REPORT', 'PLAYWRIGHT_HTML_OPEN', 'PW_TEST_HTML_REPORT_OPEN',
  'PW_TEST_REPORTER', 'PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'JEKYLL_ENV',
];

const argv = process.argv.slice(2);
const modeArg = argv.find((arg) => arg.startsWith('--update-snapshots='));
const mode = modeArg === undefined ? null : modeArg.slice('--update-snapshots='.length);
const fault = process.env.FAKE_PW_FAULT ?? '';
const base = process.env.VISUAL_BASE_URL ?? '';
const baselineDir = process.env.VISUAL_BASELINE_DIR ?? '';
const resultsFile = process.env.VISUAL_RESULTS_FILE ?? '';

fs.rmSync(TEST_RESULTS, { recursive: true, force: true });

const bodies = {};
for (const [name, page] of [['listing', '/blog/'], ['article', '/blog/fixture-code-and-tables/']]) {
  try {
    const response = await fetch(base + page);
    bodies[name] = { status: response.status, text: await response.text() };
  } catch (err) {
    bodies[name] = { status: null, text: String(err && err.message ? err.message : err) };
  }
}
const env = Object.fromEntries(REPORTED_ENV.map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] : null]));
fs.appendFileSync(process.env.FAKE_PW_LOG, JSON.stringify({ argv, cwd: process.cwd(), mode, fault, env, bodies }) + '\\n');

const writeReport = (results, options) => {
  if (resultsFile.trim() !== '') fs.writeFileSync(resultsFile, JSON.stringify(buildReport(results, { updateSnapshots: mode, ...options })));
};

if (mode === 'all') {
  fs.mkdirSync(baselineDir, { recursive: true });
  CASES.forEach((entry, index) => {
    if (fault === 'baseline-short' && index === CASES.length - 1) return;
    const misnamed = fault === 'baseline-misnamed' || (fault === 'baseline-one-misnamed' && index === 0);
    fs.writeFileSync(path.join(baselineDir, misnamed ? entry.stem + '-misnamed.png' : entry.file), bodies[entry.page].text);
  });
  writeReport({});
  process.exit(fault === 'baseline-exit' ? 1 : 0);
}

const results = {};
CASES.forEach((entry, index) => {
  const caseDir = path.join(TEST_RESULTS, 'blog-visual-' + entry.stem + '-chromium');
  if (fault === 'mixed' && index === CASES.length - 1) {
    results[entry.title] = [failed([messages.navigation(base + entry.path)], evidence(entry.stem, caseDir, []))];
    return;
  }
  if (fault === 'timedout' && index === 1) {
    results[entry.title] = [failed([messages.testTimeout()], evidence(entry.stem, caseDir, []), { status: 'timedOut' })];
    return;
  }
  const baselineFile = path.join(baselineDir, entry.file);
  if (!fs.existsSync(baselineFile)) {
    results[entry.title] = [failed([messages.missingSnapshot(baselineFile)], evidence(entry.stem, caseDir, []))];
    return;
  }
  const expected = fs.readFileSync(baselineFile, 'utf8');
  const actual = bodies[entry.page].text;
  if (expected === actual) {
    results[entry.title] = [passed()];
    return;
  }
  const kinds = fault === 'no-actual' ? ['expected', 'diff'] : ['expected', 'actual', 'diff'];
  fs.mkdirSync(caseDir, { recursive: true });
  for (const kind of kinds) fs.writeFileSync(path.join(caseDir, entry.stem + '-' + kind + '.png'), kind === 'expected' ? expected : actual);
  let message;
  if (fault === 'strict') {
    const size = { width: entry.width, height: 900 };
    message = messages.thrown(strictMismatchMessage(entry.file, {
      equal: false, differentPixels: 3, totalPixels: entry.width * 900, expectedSize: size, actualSize: size,
    }));
  } else {
    message = entry.page === 'listing' ? messages.pixelMismatch(entry.file) : messages.sizeMismatch(entry.file, entry.width);
  }
  results[entry.title] = [failed([message], evidence(entry.stem, caseDir, kinds))];
});

if (fault === 'killed') process.kill(process.pid, 'SIGKILL');
if (fault !== 'no-results') {
  const runError = 'Error: Timed out waiting 900s for the test suite to run';
  const errors = fault === 'run-error' ? [{ message: runError, stack: runError }] : [];
  writeReport(results, { cases: fault === 'incomplete' ? CASES.slice(0, 10) : CASES, errors });
}
if (fault === 'interrupted') process.exit(130);
const allPassed = Object.values(results).every((list) => list.every((result) => result.status === 'passed'));
process.exit(allPassed && fault !== 'run-error' ? 0 : 1);
`;
}

/** Writes the stand-in Playwright CLI where run-visual.mjs in `repo` looks for it. */
export function installFakePlaywright(repo) {
  const cli = path.join(repo, 'node_modules', '@playwright', 'test', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  // Playwright's own cli.js is CommonJS; this stand-in is an ES module, so its package says so.
  fs.writeFileSync(path.join(path.dirname(cli), 'package.json'), '{ "type": "module" }\n');
  fs.writeFileSync(cli, fakePlaywrightSource());
  return cli;
}

/* ------------------------------------------------------------------------ */
/* Child processes                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Runs `node <args>` asynchronously, so several cases run at once, with a
 * finite deadline after which the child is killed with SIGKILL.
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<{ status: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string, out: string }>}
 */
export function runNode(args, { cwd, env, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      resolve({ status, signal, timedOut, stdout: out, stderr: err, out: `${out}${err}` });
    });
  });
}
