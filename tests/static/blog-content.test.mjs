/* Cabrillo Coast LLC — draft privacy, publishing configuration and article schema (AC-01, AC-04, F-017) */
/**
 * Source checks over the repository for AC-01 (draft privacy and publishing
 * configuration) and AC-04 (article schema). Article content (the
 * tracked-content rules, the front-matter schema, images and unsafe markup)
 * is judged by `scripts/lib/articles.mjs`, the module `guard` uses, so commit
 * time and test time judge it identically. The `.gitignore`, hook,
 * configuration and gem checks encode their requirements in this suite.
 *
 * Standing constraints:
 *   - `_config.yml` and `_config.preview.yml` are read with the types
 *     Jekyll's YAML loader gives them, so a value that only looks right, such
 *     as `future: "false"`, fails. The preview restates the `exclude` list
 *     without `assets/drafts` and sets nothing else, so the overlay's only
 *     effect is that draft images render in the preview.
 *   - A hook must be executable, with index mode `100755` once tracked and
 *     tracked at all under `CI=true`, because a clone receives the mode the
 *     index records.
 *   - Draft contents are never read: drafts are private and may be
 *     incomplete, so only their filenames join the slug check.
 *   - Every check also runs against inputs it must refuse and inputs it must
 *     accept, through the same function the repository check uses.
 *   - Paths resolve from this file's location (`ROOT`), never from
 *     `process.cwd()`, and git runs in `ROOT`, so the answer is the same from
 *     any directory. The suite reads no build output and needs no network. It
 *     never writes inside the repository, changes its index or changes
 *     `process.env`: synthetic roots and temporary git repositories, run with
 *     no system, global or environment git configuration and an empty
 *     template (`TEMP_GIT_ENV`), live in one `os.tmpdir()` folder removed
 *     after the run, including a run stopped by a signal (`PARENT_REMOVER`).
 *
 * Run: node --test tests/static/blog-content.test.mjs (Node 22 or later).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

import {
  ARTICLE_PATH_RE,
  SLUG_MAX,
  SLUG_RE,
  checkTrackedContent,
  parseArticle,
  scanUnsafeMarkup,
  validateArticle,
} from '../../scripts/lib/articles.mjs';

/* Constants                                                                 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Today as `YYYY-MM-DD` in UTC, the date the article rules compare against. */
const TODAY_UTC = new Date().toISOString().slice(0, 10);

/** The fixed "today" of the synthetic cases, so their date boundaries never move with the calendar. */
const FIXED_TODAY = '2026-06-15';

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

/** For each `GITIGNORE_ENTRIES` entry, a path `git check-ignore` must report as ignored by `.gitignore` itself. */
const IGNORE_PROBES = Object.freeze({
  '_drafts/': '_drafts/x.md',
  'assets/drafts/': 'assets/drafts/x/y.png',
  '_site/': '_site/index.html',
  '.jekyll-cache/': '.jekyll-cache/x',
  '.jekyll-metadata': '.jekyll-metadata',
  '.sass-cache/': '.sass-cache/x',
  'vendor/': 'vendor/bundle/x',
  '.bundle/': '.bundle/config',
  'node_modules/': 'node_modules/x/package.json',
  'tests/visual/test-results/': 'tests/visual/test-results/x.png',
  'tests/visual/report/': 'tests/visual/report/index.html',
});

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

/**
 * The hooks and the guard command each must end with (AAP 0.6.2): `command`
 * is the exact last line, `args` what guard must receive, and `stdin` what a
 * behavioural run feeds the hook (for pre-push, the ref line git passes),
 * which guard must receive unchanged.
 */
const HOOKS = Object.freeze([
  Object.freeze({
    file: '.githooks/pre-commit',
    command: 'exec node scripts/article.mjs guard --staged',
    args: Object.freeze(['guard', '--staged']),
    stdin: '',
  }),
  Object.freeze({
    file: '.githooks/pre-push',
    command: 'exec node scripts/article.mjs guard --pre-push',
    args: Object.freeze(['guard', '--pre-push']),
    stdin: `refs/heads/feature ${'1'.repeat(40)} refs/heads/feature ${'0'.repeat(40)}\n`,
  }),
]);

/** The line each hook must run before guard, so the relative tool path resolves from any subfolder. */
const HOOK_CD_LINE = 'cd "$(git rev-parse --show-toplevel)" || exit 1';

/** `url` of the project-path deployment, used once `CNAME` is removed (AAP 0.5.3). */
const PROJECT_URL = 'https://randyamiller.github.io';

/**
 * The github-pages version `Gemfile` pins and `Gemfile.lock` resolves. A
 * re-pin changes only `PAGES_VERSION`, `LOCKED_GEMS` and `NOKOGIRI_VERSION`
 * (README, "Keeping the build in step with Pages"): every other pinned
 * string in this suite is derived from them.
 */
const PAGES_VERSION = '232';

/** Gem versions `Gemfile.lock` must resolve, matching pages.github.com/versions.json. */
const LOCKED_GEMS = Object.freeze([
  ['github-pages', PAGES_VERSION],
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

/**
 * The parent of every synthetic root and temporary repository, removed after
 * the run. Its real path is used so that `GIT_CEILING_DIRECTORIES`, which git
 * compares against resolved paths, matches where `os.tmpdir()` is a symbolic
 * link (macOS `/var`).
 */
const PARENT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blog-content-')));
const removeParent = () => rmSync(PARENT, { recursive: true, force: true });
after(removeParent);
process.on('exit', removeParent);

/**
 * Removes `PARENT` after an interrupted run too. A signal ends this process
 * at once, before `after()` or the `exit` handler can run: Ctrl-C reaches
 * every process in the terminal's group, and `node --test`, interrupted
 * itself, sends this file's process SIGTERM and exits. A signal handler here
 * would not help, because Node runs one only when the event loop turns,
 * which these synchronous cases do not do until the file ends: the run
 * would go on after Ctrl-C and then die writing to the runner's closed
 * output, removing nothing. Instead a small process in its own session, out
 * of reach of the terminal's signals and holding none of this process's
 * output, reads a pipe that only this process holds open. End of file there
 * comes however this process ends, SIGKILL included. If `PARENT` is still
 * there, the remover deletes it, again two seconds later in case a git or
 * hook run this process started was still writing to it, and exits. The
 * signal still ends this process as it would anyway, so the exit status
 * still reports it.
 */
const PARENT_REMOVER = [
  "const { existsSync, rmSync } = require('node:fs');",
  'const dir = process.argv[1];',
  'const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10 });',
  "process.stdin.on('error', remove).on('end', () => {",
  '  if (!existsSync(dir)) return;',
  '  remove();',
  '  setTimeout(remove, 2000);',
  '}).resume();',
].join('\n');
const parentRemover = spawn(process.execPath, ['-e', PARENT_REMOVER, PARENT], {
  detached: true,
  stdio: ['pipe', 'ignore', 'ignore'],
});
parentRemover.on('error', (error) => {
  process.stderr.write(`warning: cannot start the process that removes ${PARENT} after an interrupted run: `
    + `${error.message}\n`);
});
parentRemover.stdin?.unref();
parentRemover.unref();

const TEMP_GIT_CONFIG = path.join(PARENT, 'gitconfig');
writeFileSync(TEMP_GIT_CONFIG, '');
const TEMP_HOME = path.join(PARENT, 'home');
mkdirSync(TEMP_HOME);
const TEMP_GIT_TEMPLATE = path.join(PARENT, 'git-template');
mkdirSync(TEMP_GIT_TEMPLATE);

/** Variables that inject git configuration (`git -c` exports `GIT_CONFIG_PARAMETERS`). */
const GIT_CONFIG_VARS = Object.freeze(['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_SYSTEM']);

/**
 * Environment for git, and for hooks, in temporary repositories: the
 * redirecting and configuration variables are removed; the system
 * configuration is turned off and the global one is an empty file; `HOME`
 * and `XDG_CONFIG_HOME` name an empty folder; `GIT_TEMPLATE_DIR`, which
 * outranks `init.templateDir` (no call passes `--template`), names an empty
 * folder, so `git init` copies no hooks, configuration or `info/exclude`
 * into a new repository; and `GIT_CEILING_DIRECTORIES` stops discovery at
 * `PARENT`. No developer setting (`core.hooksPath`, excludes files,
 * templates) can therefore influence a case. A copy, so `process.env` itself
 * is never changed.
 */
const TEMP_GIT_ENV = { ...process.env };
for (const name of Object.keys(TEMP_GIT_ENV)) {
  if (GIT_REDIRECT_VARS.includes(name) || GIT_CONFIG_VARS.includes(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) {
    delete TEMP_GIT_ENV[name];
  }
}
Object.assign(TEMP_GIT_ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: TEMP_GIT_CONFIG,
  HOME: TEMP_HOME,
  XDG_CONFIG_HOME: TEMP_HOME,
  GIT_TEMPLATE_DIR: TEMP_GIT_TEMPLATE,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CEILING_DIRECTORIES: PARENT,
});

/* File and git helpers                                                      */

/** Absolute path of a repository-relative POSIX path. */
function abs(rel) {
  return path.join(ROOT, ...rel.split('/'));
}

/** Reads a repository file as UTF-8. */
function read(rel) {
  return readFileSync(abs(rel), 'utf8');
}

/** Decodes UTF-8 exactly, as `scripts/article.mjs` does: an invalid byte is an error, a leading byte-order mark is kept. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * An article's text decoded as `check`, `publish` and `guard` decode it, or
 * `null` when the bytes are not valid UTF-8. The Pages build cannot read such
 * an article: it leaves it out of the site and still succeeds, so a lossy
 * read here would pass a post that never goes live.
 *
 * @param {Uint8Array} bytes The article's complete content.
 * @returns {string | null}
 */
function decodeArticle(bytes) {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch (err) {
    if (err?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return null;
    throw err;
  }
}

/** A repository article read with `decodeArticle`. */
function readArticle(rel) {
  return decodeArticle(readFileSync(abs(rel)));
}

/** The finding for an article `decodeArticle` cannot decode. */
function notUtf8Finding(rel) {
  return `${rel}: not valid UTF-8; save the file as UTF-8 (the Pages build silently leaves out a file in any `
    + 'other encoding)';
}

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
 * The `imageExists` callback `validateArticle` takes, for the site whose
 * source is `root`: whether a root-relative public path such as
 * `/assets/blog/foo/fig.png` names an existing regular file below `root`
 * (symbolic links followed). A path whose real location is outside `root` is
 * refused, although `validateArticle` has already rejected external,
 * `data:` and `..` sources before calling it.
 */
function makeImageExists(root) {
  const realRoot = realpathSync(root);
  return (publicPath) => {
    const target = path.resolve(realRoot, ...publicPath.replace(/^\/+/, '').split('/'));
    try {
      const real = realpathSync(target);
      if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return false;
      return statSync(real).isFile();
    } catch {
      return false;
    }
  };
}

/** The file line on which `body`, the remainder `parseArticle` returned for `text`, starts. */
function bodyStartLine(text, body) {
  return text.slice(0, text.length - body.length).split('\n').length;
}

/* Synthetic roots and temporary repositories (below PARENT only)            */

function tempFolder(name) {
  return mkdtempSync(path.join(PARENT, `${name}-`));
}

/** Writes `files`, a map of POSIX paths relative to `root` to contents, creating folders as needed. */
function writeFiles(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
}

/** Runs git in a temporary repository with `TEMP_GIT_ENV`; returns its standard output and throws with git's message on failure. */
function tempGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: TEMP_GIT_ENV, timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** A new git repository below `PARENT` with `files` written into its work tree (nothing is staged). */
function tempRepository(name, files = {}) {
  const dir = tempFolder(name);
  tempGit(dir, ['init', '-q']);
  writeFiles(dir, files);
  return dir;
}

/** Replaces the one occurrence of `search` in `text`; a control fails loudly if its target ever disappears. */
function replaceOnce(text, search, replacement) {
  const at = text.indexOf(search);
  assert.ok(at !== -1 && text.indexOf(search, at + 1) === -1, `expected exactly one ${JSON.stringify(search)} to replace`);
  return text.slice(0, at) + replacement + text.slice(at + search.length);
}

/** `text` escaped for literal use inside `new RegExp` (Node 22 has no `RegExp.escape`). */
function regExpLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A version that can never equal `version`: its last numeric component plus
 * one (`2.5.9` becomes `2.5.10`), or `version` with `.1` appended when it
 * does not end in a number.
 */
function strayVersion(version) {
  const last = /(\d+)$/.exec(version);
  return last === null ? `${version}.1` : `${version.slice(0, last.index)}${BigInt(last[1]) + 1n}`;
}

function assertReports(problems, pattern, label) {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `${label}: expected a problem matching ${pattern}, got:\n${problems.length === 0 ? '(none)' : problems.join('\n')}`,
  );
}

/**
 * Asserts that `findings` holds exactly one entry per pattern in `expected`,
 * in order, each matching its pattern; `[]` asserts that there are none.
 */
function assertFindings(findings, expected, label) {
  const shown = findings.length === 0 ? '(none)' : findings.join('\n');
  assert.equal(findings.length, expected.length, `${label}: expected ${expected.length} finding(s), got:\n${shown}`);
  expected.forEach((pattern, index) => {
    assert.match(findings[index], pattern, `${label}: finding ${index + 1} is not the expected one:\n${shown}`);
  });
}

/** An article source: `frontMatter` lines between `---` delimiters, then `body` exactly as given. */
function articleSource(frontMatter, body) {
  return `${['---', ...frontMatter, '---'].join('\n')}\n${body}`;
}

const VALID_FRONT_MATTER = Object.freeze(['title: "A valid title"', 'summary: "A valid summary."', 'tags: [testing]']);

/* .gitignore probes                                                         */

/**
 * Problems with how the repository at `cwd` ignores each `IGNORE_PROBES`
 * path, from one `git check-ignore --no-index -v -n` call: a probe counts as
 * ignored only when its deciding pattern comes from the root `.gitignore`
 * and is not a `!` negation. A later negation such as `!node_modules/`, a
 * missing entry and a pattern only in `.git/info/exclude` or a global
 * excludes file (which other clones lack) are all reported.
 *
 * @param {string} cwd Top level of the work tree to ask.
 * @param {Record<string, string>} env Environment for git.
 * @returns {string[]} One problem per probe that is not ignored by `.gitignore`.
 */
function ignoreProbeProblems(cwd, env) {
  const probes = GITIGNORE_ENTRIES.map((entry) => IGNORE_PROBES[entry]);
  const result = spawnSync('git', ['check-ignore', '--no-index', '-v', '-n', '--', ...probes], { cwd, env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  // Exit 0: some probe is ignored; 1: none is. Anything else is git failing.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed in ${cwd} (exit ${result.status}): ${result.stderr.trim()}`);
  }
  // Each line is <source>:<line>:<pattern>\t<path>; a path no pattern matches prints ::\t<path>.
  const verdicts = new Map();
  for (const line of result.stdout.split('\n')) {
    if (line === '') continue;
    const m = /^(.*?):(\d*):(.*)\t(.*)$/.exec(line);
    if (m === null) throw new Error(`unexpected git check-ignore output in ${cwd}: ${line}`);
    verdicts.set(m[4], { source: m[1], line: m[2], pattern: m[3] });
  }
  const problems = [];
  GITIGNORE_ENTRIES.forEach((entry, index) => {
    const probe = probes[index];
    const verdict = verdicts.get(probe);
    if (verdict === undefined) problems.push(`${probe} (${entry}): git check-ignore reported nothing for it`);
    else if (verdict.source === '') problems.push(`${probe} (${entry}) is not ignored by any pattern`);
    else if (verdict.source !== '.gitignore') {
      problems.push(`${probe} (${entry}) is ignored only by ${verdict.source}:${verdict.line}; .gitignore itself must ignore it`);
    } else if (verdict.pattern.startsWith('!')) {
      problems.push(`${probe} (${entry}) is re-included by .gitignore:${verdict.line} (${verdict.pattern})`);
    }
  });
  return problems;
}

/* Hook wrappers                                                             */

/** Balanced single- and double-quoted shell strings. */
const QUOTED_STRING_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g;

/** The only redirections a hook's checking clause may use; removed before its command is inspected. */
const HOOK_REDIRECTION_RE = /(?<=^|\s)(?:>\/dev\/null|2>&1|>&2)(?=\s|$)/g;

/** A checking clause that ends the hook on failure: `<cmd> || exit 1`. */
const EXIT_CLAUSE_RE = /^(.+?)\s*\|\|\s*exit 1$/;

/** A checking clause that explains, then ends the hook: `<cmd> || { echo "<text>" >&2; exit 1; }`. */
const ECHO_CLAUSE_RE = /^(.+?)\s*\|\|\s*\{\s*echo\s+"(?:[^"\\$`]|\\.)*"\s*>&2;\s*exit 1;\s*\}$/;

/** Words that, in a checking clause, could end or replace the hook or change what its final `exec` runs. */
const HOOK_FORBIDDEN_WORDS = new Set([
  'exit', 'exec', 'return', 'trap', 'set', 'alias', 'unalias', 'eval', 'source', '.', 'export', 'unset', 'readonly', 'cd', 'shift',
]);

/** Why one active hook line is not an acceptable checking clause, or `null` when it is. */
function hookClauseProblem(line) {
  const clause = EXIT_CLAUSE_RE.exec(line) ?? ECHO_CLAUSE_RE.exec(line);
  if (clause === null) {
    return 'every line before guard must be a check that ends the hook on failure: <command> || exit 1 or <command> || { echo "…" >&2; exit 1; }';
  }
  const command = clause[1];
  if (command.includes('$(') || command.includes('`')) return 'a check must not use command substitution';
  const bare = command.replace(QUOTED_STRING_RE, ' ').replace(HOOK_REDIRECTION_RE, ' ').trim();
  if (/["']/.test(bare)) return 'a check must not leave a quote unclosed';
  if (/[;&|<>]/.test(bare)) return 'a check must be one simple command, with no ;, &, | or redirection other than >/dev/null, 2>&1 and >&2';
  const words = bare.split(/\s+/);
  if (words[0] === '') return 'a check must run a command';
  if (/^[A-Za-z_]\w*=/.test(words[0])) return 'a check must not assign a variable';
  const forbidden = words.find((word) => HOOK_FORBIDDEN_WORDS.has(word));
  return forbidden === undefined ? null : `a check must not use ${forbidden}`;
}

/**
 * Problems with a hook wrapper's text, judged without running it. A valid
 * wrapper is a `#!/bin/sh` script whose active lines (non-blank lines not
 * starting with `#`) are `HOOK_CD_LINE`, checking clauses that end the hook
 * on failure (`hookClauseProblem`), and last, exactly `command`, so guard
 * replaces the shell with its own arguments, inherited standard input and
 * exit status. Continuation lines and here-documents are refused, because
 * they would make the lines read here differ from the commands the shell
 * runs; guard may appear on one active line only.
 *
 * @param {string} text Hook file contents.
 * @param {string} command The exact `exec node scripts/article.mjs guard …` line.
 * @returns {string[]} Problems, each naming its line; `[]` for a valid wrapper.
 */
function hookWrapperProblems(text, command) {
  const problems = [];
  if (text.includes('\r')) problems.push('the hook must use LF line endings; a CR breaks the #! line and every command');
  const lines = text.split('\n');
  if (lines[0] !== '#!/bin/sh') problems.push(`line 1 must be #!/bin/sh (got ${JSON.stringify(lines[0])})`);

  const active = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (index > 0 && trimmed !== '' && !trimmed.startsWith('#')) active.push({ n: index + 1, line: trimmed });
  });
  for (const { n, line } of active) {
    if (line.endsWith('\\')) problems.push(`line ${n} continues onto the next line (\\), so it is not the command it appears to be`);
    if (line.includes('<<')) problems.push(`line ${n} opens a here-document (<<), so the lines after it are not commands`);
  }

  const last = active.at(-1);
  if (last === undefined || last.line !== command) {
    problems.push(`the last command must be exactly ${command} (got ${last === undefined ? 'no command' : `line ${last.n}: ${last.line}`})`);
  }
  const guardLines = active.filter(({ line }) => /\barticle\.mjs\s+guard\b/.test(line.replace(QUOTED_STRING_RE, '""')));
  if (guardLines.length !== 1) {
    const where = guardLines.length === 0 ? '' : `: lines ${guardLines.map(({ n }) => n).join(', ')}`;
    problems.push(`guard must run on exactly one line (found ${guardLines.length}${where})`);
  }
  const cdIndex = active.findIndex(({ line }) => line === HOOK_CD_LINE);
  if (cdIndex === -1 || cdIndex === active.length - 1) problems.push(`${HOOK_CD_LINE} must run before guard`);

  active.forEach(({ n, line }, index) => {
    if (index === cdIndex || index === active.length - 1) return;
    const problem = hookClauseProblem(line);
    if (problem !== null) problems.push(`line ${n}: ${problem} (${line})`);
  });
  return problems;
}

/**
 * Problems with a hook's index entries (AC-01), judged from
 * `git ls-files -s -- <file>` output so that tracked, untracked and conflict
 * states can be checked without touching an index: once tracked, every entry
 * (each conflict stage included) must have mode `100755`. An untracked hook
 * is refused when `ci` is true, and otherwise yields a diagnostic, because
 * `guard --staged` enforces the mode when it is first committed.
 *
 * @param {{ file: string, lsFiles: string, ci: boolean }} args `lsFiles` is the command's output.
 * @returns {{ problems: string[], diagnostic: string | null }}
 */
function hookIndexProblems({ file, lsFiles, ci }) {
  const entries = lsFiles.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
  if (entries.length === 0) {
    return ci
      ? { problems: [`${file} is not tracked; hooks must be tracked in CI`], diagnostic: null }
      : { problems: [], diagnostic: `${file} not yet tracked; guard --staged enforces 100755 at commit` };
  }
  const problems = [];
  for (const entry of entries) {
    const m = /^(\d{6}) [0-9a-f]{40}(?:[0-9a-f]{24})? ([0-3])\t(.+)$/.exec(entry);
    if (m === null) {
      problems.push(`${file}: unexpected git ls-files -s entry ${JSON.stringify(entry)}`);
    } else if (m[3] !== file) {
      problems.push(`${file}: git ls-files -s listed ${m[3]} instead`);
    } else if (m[1] !== '100755') {
      const stage = m[2] === '0' ? '' : ` at conflict stage ${m[2]}`;
      problems.push(`${file} is tracked with mode ${m[1]}${stage}; run git update-index --chmod=+x ${file}`);
    }
  }
  return { problems, diagnostic: null };
}

/**
 * The stand-in for `scripts/article.mjs` in behavioural hook runs: it records
 * its arguments, working folder and standard input as JSON in the file named
 * by `BLOG_CONTENT_GUARD_RECORD`, then exits with `BLOG_CONTENT_GUARD_EXIT`.
 */
const GUARD_STAND_IN = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "const stdin = readFileSync(0, 'utf8');",
  'const record = { argv: process.argv.slice(2), cwd: process.cwd(), stdin };',
  'writeFileSync(process.env.BLOG_CONTENT_GUARD_RECORD, JSON.stringify(record));',
  'process.exitCode = Number(process.env.BLOG_CONTENT_GUARD_EXIT);',
  '',
].join('\n');

/**
 * Problems seen when the hook `text` is run directly with `sh` rather than
 * invoked by git, so git supplies neither the working folder nor the
 * environment it gives a hook: the hook is written to `hook.file` in a new
 * temporary repository whose `scripts/article.mjs` is the stand-in guard
 * `GUARD_STAND_IN`, and run from the subfolder `sub/folder` with
 * `TEMP_GIT_ENV`, this Node first on `PATH` and `hook.stdin` on standard
 * input, once with the stand-in exiting 1 and once exiting 0. Standard input
 * is a file holding `hook.stdin`, opened afresh for each run, never a pipe, so
 * no write can race a hook that exits without reading it and abort the check
 * before the hook's behaviour is judged. Guard must be reached both times with
 * `hook.args`, the repository's real top level as its working folder (the hook
 * must find the root itself) and `hook.stdin` unchanged, and the hook must
 * exit with the stand-in's status. Nothing touches this repository.
 *
 * @returns {string[]} Problems; `[]` when the hook hands guard everything.
 */
function hookBehaviourProblems(text, hook) {
  const caseDir = tempFolder('hook-run');
  const repo = path.join(caseDir, 'repo');
  mkdirSync(repo);
  tempGit(repo, ['init', '-q']);
  writeFiles(repo, { [hook.file]: text, 'scripts/article.mjs': GUARD_STAND_IN, 'sub/folder/.keep': '' });
  const top = realpathSync(repo);
  const stdinFile = path.join(caseDir, 'stdin.txt');
  writeFileSync(stdinFile, hook.stdin);

  const problems = [];
  for (const code of [1, 0]) {
    const record = path.join(caseDir, `guard-exit-${code}.json`);
    // A new descriptor per run, so each run reads hook.stdin from its start.
    const stdin = openSync(stdinFile, 'r');
    let result;
    try {
      result = spawnSync('sh', [path.join(repo, ...hook.file.split('/'))], {
        cwd: path.join(repo, 'sub', 'folder'),
        env: {
          ...TEMP_GIT_ENV,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${TEMP_GIT_ENV.PATH ?? ''}`,
          BLOG_CONTENT_GUARD_RECORD: record,
          BLOG_CONTENT_GUARD_EXIT: String(code),
        },
        stdio: [stdin, 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 30000,
      });
    } finally {
      closeSync(stdin);
    }
    if (result.error) throw result.error;
    const run = `with guard exiting ${code}`;
    if (result.status !== code) {
      const stderr = result.stderr.trim();
      problems.push(`${run}: the hook exited ${result.status ?? result.signal}, not ${code}${stderr === '' ? '' : ` (${stderr})`}`);
    }
    if (!existsSync(record)) {
      problems.push(`${run}: the hook never ran scripts/article.mjs`);
      continue;
    }
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    if (JSON.stringify(seen.argv) !== JSON.stringify(hook.args)) {
      problems.push(`${run}: guard received arguments ${JSON.stringify(seen.argv)}, not ${JSON.stringify(hook.args)}`);
    }
    if (seen.cwd !== top) problems.push(`${run}: guard ran in ${seen.cwd}, not the repository root ${top}`);
    if (seen.stdin !== hook.stdin) {
      problems.push(`${run}: guard read standard input ${JSON.stringify(seen.stdin)}, not ${JSON.stringify(hook.stdin)}`);
    }
  }
  return problems;
}

/**
 * Disabled or altered wrappers, each made from a real hook's text: the hook
 * it starts from, the change, the problem the static check must report and
 * the problems a behavioural run must show.
 */
const HOOK_CONTROLS = Object.freeze([
  {
    name: 'the guard command only in a comment, then exit 0',
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, `${HOOKS[0].command}\n`, `# ${HOOKS[0].command}\nexit 0\n`),
    wrapper: /^the last command must be exactly exec node scripts\/article\.mjs guard --staged/,
    behaviour: [/^with guard exiting 1: the hook exited 0, not 1$/, /^with guard exiting 1: the hook never ran scripts\/article\.mjs$/],
  },
  {
    name: 'exit 0 before the exec',
    hook: HOOKS[1],
    change: (text) => replaceOnce(text, `${HOOKS[1].command}\n`, `exit 0\n${HOOKS[1].command}\n`),
    wrapper: /^line \d+: every line before guard must be a check that ends the hook on failure/,
    behaviour: [/^with guard exiting 1: the hook exited 0, not 1$/, /^with guard exiting 1: the hook never ran scripts\/article\.mjs$/],
  },
  {
    name: 'guard run without exec, its failure ignored',
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, `${HOOKS[0].command}\n`, 'node scripts/article.mjs guard --staged || true\n'),
    wrapper: /^the last command must be exactly exec node scripts\/article\.mjs guard --staged/,
    behaviour: [/^with guard exiting 1: the hook exited 0, not 1$/],
  },
  {
    name: 'the wrong guard mode',
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, `${HOOKS[0].command}\n`, `${HOOKS[1].command}\n`),
    wrapper: /^the last command must be exactly exec node scripts\/article\.mjs guard --staged \(got line \d+: exec node scripts\/article\.mjs guard --pre-push\)$/,
    behaviour: [/^with guard exiting 1: guard received arguments \["guard","--pre-push"\], not \["guard","--staged"\]$/],
  },
  {
    name: 'no cd to the repository root',
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, `${HOOK_CD_LINE}\n`, ''),
    wrapper: /^cd "\$\(git rev-parse --show-toplevel\)" \|\| exit 1 must run before guard$/,
    behaviour: [/^with guard exiting 1: the hook never ran scripts\/article\.mjs$/, /^with guard exiting 0: the hook exited 1, not 0/],
  },
  {
    name: 'standard input replaced by /dev/null on the pre-push exec',
    hook: HOOKS[1],
    change: (text) => replaceOnce(text, `${HOOKS[1].command}\n`, `${HOOKS[1].command} < /dev/null\n`),
    wrapper: /^the last command must be exactly exec node scripts\/article\.mjs guard --pre-push \(got line \d+: .* < \/dev\/null\)$/,
    behaviour: [/^with guard exiting 1: guard read standard input "", not "refs\/heads\/feature /],
  },
  {
    name: 'a true || \\ continuation before the exec',
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, `${HOOKS[0].command}\n`, `true || \\\n${HOOKS[0].command}\n`),
    wrapper: /^line \d+ continues onto the next line/,
    behaviour: [/^with guard exiting 1: the hook exited 0, not 1$/, /^with guard exiting 1: the hook never ran scripts\/article\.mjs$/],
  },
  // Checked without a run: each breaks one rule of the static check.
  ...[
    ['a check followed by ; exit 0', 'command -v node >/dev/null 2>&1; exit 0 || exit 1', /: a check must be one simple command/],
    ['an alias for exec', 'alias exec=true || exit 1', /: a check must not use alias/],
    ['a command substitution in a check', '[ -f "$(exit 0)" ] || exit 1', /: a check must not use command substitution/],
    ['a variable assignment', 'GIT_INDEX_FILE=/dev/null || exit 1', /: a check must not assign a variable/],
    ['an unclosed quote', 'echo "unclosed || exit 1', /: a check must not leave a quote unclosed/],
    ['a here-document', 'cat <<EOF || exit 1', /opens a here-document/],
  ].map(([name, line, wrapper]) => ({
    name,
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, `${HOOKS[0].command}\n`, `${line}\n${HOOKS[0].command}\n`),
    wrapper,
  })),
  {
    name: 'a #!/bin/bash line',
    hook: HOOKS[0],
    change: (text) => replaceOnce(text, '#!/bin/sh\n', '#!/bin/bash\n'),
    wrapper: /^line 1 must be #!\/bin\/sh/,
  },
  {
    name: 'CRLF line endings',
    hook: HOOKS[0],
    change: (text) => text.replace(/\n/g, '\r\n'),
    wrapper: /must use LF line endings/,
  },
]);

/* Typed, fail-closed YAML reader for the Jekyll configuration files         */

/**
 * Plain scalars that SafeYAML 1.0.5, which Jekyll 3.10 loads its
 * configuration with, reads as numbers, dates or times instead of text: its
 * integer, float, date and time patterns.
 */
const YAML_TYPED_PLAIN_RES = Object.freeze([
  /^[-+]?(?:0|[1-9][0-9_,]*)$/,
  /^0[0-7_]+$/,
  /^[-+]?0x[0-9a-fA-F_]+$/,
  /^0b[01_]+$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/,
  /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]+(?:[eE][-+][0-9]+)?$/,
  /^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/,
  /^\d{4}-\d{1,2}-\d{1,2}(?:(?:[Tt]| +)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?: *(?:Z|[-+]\d{1,2}(?::?\d{2})?))?)?$/,
]);

/**
 * The key forms the reader accepts, each with its normalization: plain
 * (`baseurl`), double-quoted (`"baseurl"`, escapes `\"` and `\\` only) and
 * single-quoted (`'baseurl'`, `''` for a quote). Spaces may stand before the
 * `:`, and a space or the end of the line must follow it.
 */
const YAML_KEY_FORMS = Object.freeze([
  [/^([A-Za-z0-9_][A-Za-z0-9_./-]*) *:(?= |$)/, (m) => m[1]],
  [/^"((?:[^"\\]|\\["\\])*)" *:(?= |$)/, (m) => m[1].replace(/\\(["\\])/g, '$1')],
  [/^'((?:[^']|'')*)' *:(?= |$)/, (m) => m[1].replace(/''/g, "'")],
]);

/** What may follow a closing quote or bracket: nothing, or a ` # comment`. */
const YAML_TRAILER_RE = /^(?: *| +#.*)$/;

/** The value of an entry whose value could not be read; the reason is in `unsupported`. */
const YAML_UNREADABLE = Object.freeze({ kind: 'other', value: null, quoted: false });

/**
 * Reads the quoted scalar that starts at `text[start]` and closes on the same
 * line: double-quoted with the escapes `\"` and `\\` only, or single-quoted
 * with `''` for a quote. Returns `{ value, end }` (the index after the
 * closing quote) or `{ error }`.
 */
function readYamlQuoted(text, start) {
  const quote = text[start];
  let value = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        value += "'";
        i += 1;
        continue;
      }
      return { value, end: i + 1 };
    }
    if (quote === '"' && c === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next !== '"' && next !== '\\') return { error: `the escape \\${next} is not supported in a double-quoted string` };
      value += next;
      i += 1;
      continue;
    }
    value += c;
  }
  return { error: `a ${quote === '"' ? 'double' : 'single'}-quoted string must close on the same line` };
}

/**
 * The value SafeYAML 1.0.5 makes of the plain (unquoted) scalar `text`:
 * `''`, `~` and `null` in any letter case are null; `yes`, `on`, `true`,
 * `no`, `off` and `false` in any letter case are booleans; numbers, dates
 * and times are `other`; everything else is a string.
 */
function plainYamlValue(text) {
  if (text === '' || /^(?:~|null)$/i.test(text)) return { kind: 'null', value: null, quoted: false };
  if (/^(?:yes|no|on|off|true|false)$/i.test(text)) return { kind: 'bool', value: /^(?:yes|on|true)$/i.test(text), quoted: false };
  if (YAML_TYPED_PLAIN_RES.some((re) => re.test(text))) return { kind: 'other', value: text, quoted: false };
  return { kind: 'string', value: text, quoted: false };
}

/** Why the plain scalar `text` cannot be read here, or `null`; `inFlow` adds the flow-list rules. */
function plainYamlProblem(text, inFlow) {
  if (/^[&*]/.test(text)) return 'anchors and aliases (& and *) are not supported';
  if (text.startsWith('!')) return 'YAML tags (!) are not supported';
  if (/^[|>]/.test(text)) return 'block scalars (| and >) are not supported';
  if (text.startsWith('{')) return 'flow mappings ({ … }) are not supported';
  if (/^[%@`,\]}]/.test(text)) return `a plain value must not start with ${text[0]}`;
  if (/^[-?:](?: |$)/.test(text)) return `${text[0]} followed by a space cannot start a value here`;
  if (/: |:$/.test(text)) return 'a plain value must not contain ": " or end with ":"';
  if (inFlow && /[[{}]/.test(text)) return 'nested lists and mappings are not supported in a flow list';
  return null;
}

/**
 * Reads the one-line flow list that starts at `text[0]`, such as
 * `[a, "b, c"]`: quoted items keep their commas, plain items are typed by
 * `plainYamlValue`, and empty items, a trailing comma, comments, nesting and
 * an unclosed list are errors. Returns `{ value, end }` or `{ error }`.
 */
function readYamlFlowList(text) {
  const items = [];
  let i = 1;
  const skipSpaces = () => {
    while (text[i] === ' ') i += 1;
  };
  skipSpaces();
  if (text[i] === ']') return { value: { kind: 'list', items }, end: i + 1 };
  for (;;) {
    skipSpaces();
    const c = text[i];
    if (c === undefined) return { error: 'a flow list must close with ] on the same line' };
    if (c === ',' || c === ']') return { error: 'a flow list must not contain empty items' };
    if (c === '"' || c === "'") {
      const quoted = readYamlQuoted(text, i);
      if (quoted.error) return quoted;
      items.push({ kind: 'string', value: quoted.value, quoted: true });
      i = quoted.end;
    } else {
      let end = i;
      while (end < text.length && text[end] !== ',' && text[end] !== ']') end += 1;
      const raw = text.slice(i, end).replace(/ +$/, '');
      if (raw.startsWith('#') || raw.includes(' #')) return { error: 'a comment is not allowed inside a flow list' };
      const problem = plainYamlProblem(raw, true);
      if (problem !== null) return { error: problem };
      items.push(plainYamlValue(raw));
      i = end;
    }
    skipSpaces();
    if (text[i] === ',') {
      i += 1;
      skipSpaces();
      if (text[i] === ']') return { error: 'a flow list must not end with a comma' };
      continue;
    }
    if (text[i] === ']') return { value: { kind: 'list', items }, end: i + 1 };
    if (text[i] === undefined) return { error: 'a flow list must close with ] on the same line' };
    return { error: `unexpected ${JSON.stringify(text[i])} after a flow list item` };
  }
}

/**
 * Reads what follows `key:` or `- ` on one line: `{ empty: true }` when
 * nothing does (the node is null, or continues on the lines below), `{ value }`
 * for a quoted or plain scalar or a one-line flow list, and `{ error }` for
 * every other construct.
 */
function readYamlValue(rest) {
  const text = rest.replace(/^ +/, '');
  if (text === '' || text.startsWith('#')) return { empty: true };
  if (text[0] === '"' || text[0] === "'") {
    const quoted = readYamlQuoted(text, 0);
    if (quoted.error) return quoted;
    if (!YAML_TRAILER_RE.test(text.slice(quoted.end))) return { error: 'only a comment ( # …) may follow the closing quote' };
    return { value: { kind: 'string', value: quoted.value, quoted: true } };
  }
  if (text[0] === '[') {
    const list = readYamlFlowList(text);
    if (list.error) return list;
    if (!YAML_TRAILER_RE.test(text.slice(list.end))) return { error: 'only a comment ( # …) may follow the closing ]' };
    return { value: list.value };
  }
  const plain = text.replace(/ +#.*$/, '').replace(/ +$/, '');
  const problem = plainYamlProblem(plain, false);
  return problem === null ? { value: plainYamlValue(plain) } : { error: problem };
}

/** The key at the start of a line body, normalized (`YAML_KEY_FORMS`), and the text after its `:`; `null` when the line has no key. */
function readYamlKey(body) {
  for (const [form, normalize] of YAML_KEY_FORMS) {
    const m = form.exec(body);
    if (m !== null) return { key: normalize(m), rest: body.slice(m[0].length) };
  }
  return null;
}

/** Whether a line body is a block-list item: `-` followed by a space or the end of the line. */
function isYamlItem(body) {
  return /^-(?: |$)/.test(body);
}

/**
 * Reads a Jekyll configuration file with the types SafeYAML 1.0.5 gives it,
 * without a YAML library, and fails closed: whatever it cannot read for
 * certain is listed in `unsupported` instead of guessed.
 *
 * The whole document is parsed as block YAML, nested levels included, so a
 * line that SafeYAML would reject cannot hide below a key the checks never
 * read. Understood: blank and `#` comment lines; a first-line `---`; block
 * mappings whose keys are plain or quoted (normalized, so `"baseurl"` and
 * `baseurl :` both define `baseurl`) and line up at one indentation; block
 * lists whose `- ` items line up at one indentation, a list directly below a
 * key at the key's own indentation included; compact nodes on an item's line
 * (`- scope:`, `- - x`), which start at their own column; scalar values,
 * quoted (always strings) or plain (typed by `plainYamlValue`), with an
 * optional ` # comment`; and one-line flow lists.
 *
 * Refused, with the line number: any other column-0 construct (`? `, `<<`,
 * `---` or `...` after content, `%` directives); tabs; anchors and aliases;
 * tags; block scalars; flow mappings; plain values containing `: ` or ending
 * in `:`; unclosed quotes or lists; anything but a ` # comment` after a
 * closing quote or bracket; escapes other than `\"` and `\\`; at any depth, a
 * mapping line without a key, a line continuing a value already written on
 * the line above, and a line that lines up with neither its siblings nor the
 * level it closes.
 *
 * @param {string} text File contents.
 * @returns {{
 *   keys: string[],
 *   duplicates: string[],
 *   unsupported: string[],
 *   has(key: string): boolean,
 *   get(key: string): { kind: 'null' | 'bool' | 'string' | 'list' | 'mapping' | 'other', value?: unknown, quoted?: boolean, items?: object[], entries?: object[] } | undefined,
 * }} `keys` are the top-level keys in file order; a key written twice is in
 *   `duplicates`, and `get` returns its last value, the one Ruby's YAML parser
 *   keeps. A list's `items` and a mapping's `entries` (`{ key, line, value }`)
 *   hold values of the same shape.
 */
function readTopLevelYaml(text) {
  const unsupported = [];
  const fail = (n, why) => unsupported.push(`line ${n}: ${why}`);

  // Content lines as { n, indent, body }: blank and comment lines, refused markers and lines with tabs are left out.
  const lines = [];
  let content = false;
  text.replace(/^\uFEFF/, '').split('\n').forEach((raw, index) => {
    const n = index + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (/^[ \t]*(?:#.*)?$/.test(line)) return;
    if (line.includes('\t')) {
      fail(n, 'tabs are not supported');
      return;
    }
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    if (indent === 0 && /^(?:---|\.\.\.)(?: |$)/.test(body)) {
      if (!content && /^---(?: +#.*)?$/.test(body)) {
        content = true;
        return;
      }
      fail(n, `the document marker ${body.slice(0, 3)} is supported only as the first line, alone`);
      return;
    }
    if (indent === 0 && body.startsWith('%')) {
      fail(n, 'YAML directives (%) are not supported');
      return;
    }
    content = true;
    lines.push({ n, indent, body });
  });

  let pos = 0;
  const NULL_VALUE = Object.freeze({ kind: 'null', value: null, quoted: false });

  /** Passes over the lines indented deeper than `indent`, which belong to a node already refused. */
  const skipDeeper = (indent) => {
    while (pos < lines.length && lines[pos].indent > indent) pos += 1;
  };

  /** Refuses `lines[pos]`, indented deeper than the level `indent` it stands in, and passes over it. */
  const misaligned = (indent) => {
    fail(lines[pos].n, `this line is indented ${lines[pos].indent} spaces, deeper than the ${indent} its mapping or list uses`);
    pos += 1;
  };

  const readNode = () => (isYamlItem(lines[pos].body) ? readList(lines[pos].indent) : readMapping(lines[pos].indent));

  /**
   * The value of the key (`keyed`) or item on line `line` at `indent`, whose
   * text after `:` or `- ` is `rest`: that inline value, which no deeper line
   * may continue, or, when the line ends there, the node on the deeper lines
   * below (a list may also sit at a key's own indentation), or null.
   */
  const readValue = (line, rest, indent, keyed) => {
    const value = readYamlValue(rest);
    if (value.error) {
      fail(line.n, value.error);
      skipDeeper(indent);
      return YAML_UNREADABLE;
    }
    const next = lines[pos];
    if (!value.empty) {
      if (next === undefined || next.indent <= indent) return value.value;
      fail(next.n, `the value written on line ${line.n} cannot continue onto another line`);
      skipDeeper(indent);
      return YAML_UNREADABLE;
    }
    if (next !== undefined && next.indent > indent) return readNode();
    if (keyed && next !== undefined && next.indent === indent && isYamlItem(next.body)) return readList(indent);
    return NULL_VALUE;
  };

  /** The block mapping whose keys stand at `indent`, from `lines[pos]` to the first line that ends it. */
  function readMapping(indent) {
    const entries = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      const line = lines[pos];
      if (line.indent > indent) {
        misaligned(indent);
        continue;
      }
      if (isYamlItem(line.body)) break;
      const key = readYamlKey(line.body);
      pos += 1;
      if (key === null) {
        fail(line.n, 'a line of a mapping must be key: value');
        skipDeeper(indent);
        continue;
      }
      entries.push({ key: key.key, line: line.n, value: readValue(line, key.rest, indent, true) });
    }
    return { kind: 'mapping', entries };
  }

  /** The block list whose `- ` items stand at `indent`, from `lines[pos]` to the first line that ends it. */
  function readList(indent) {
    const items = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      const line = lines[pos];
      if (line.indent > indent) {
        misaligned(indent);
        continue;
      }
      if (!isYamlItem(line.body)) break;
      const rest = line.body.replace(/^-(?: +|$)/, '');
      if (isYamlItem(rest) || readYamlKey(rest) !== null) {
        // A compact node on the item's line starts at its own column, where its later lines must line up.
        lines[pos] = { n: line.n, indent: indent + line.body.length - rest.length, body: rest };
        items.push(readNode());
        continue;
      }
      pos += 1;
      items.push(readValue(line, rest, indent, false));
    }
    return { kind: 'list', items };
  }

  const entries = [];
  while (pos < lines.length) {
    entries.push(...readMapping(0).entries);
    if (pos < lines.length) {
      // readMapping(0) stops only at a column-0 list item, which no top-level key owns.
      fail(lines[pos].n, 'a top-level line must be key: value');
      pos += 1;
      skipDeeper(0);
    }
  }

  const keys = entries.map((entry) => entry.key);
  const duplicates = [...new Set(keys.filter((k, index) => keys.indexOf(k) !== index))];
  const last = (k) => entries.findLast((entry) => entry.key === k);
  return {
    keys,
    duplicates,
    unsupported,
    has: (k) => last(k) !== undefined,
    get: (k) => last(k)?.value,
  };
}

/** A typed value from `readTopLevelYaml`, described for a failure message. */
function describeYaml(value) {
  if (value === undefined) return 'no such key';
  if (value.kind === 'null') return 'null';
  if (value.kind === 'bool') return `boolean ${value.value}`;
  if (value.kind === 'string') return `${value.quoted ? 'quoted ' : ''}string ${JSON.stringify(value.value)}`;
  if (value.kind === 'list') return `a list of ${value.items.length}`;
  if (value.kind === 'mapping') return 'a mapping';
  return value.value === null ? 'a value this reader cannot read' : `the non-string value ${value.value}`;
}

/** The items of a list of strings as `{ items }`, or `{ problem }` when `value` is anything else. */
function stringListOf(value) {
  if (value?.kind !== 'list') return { problem: `must be a list (got ${describeYaml(value)})` };
  const other = value.items.findIndex((item) => item.kind !== 'string');
  if (other !== -1) return { problem: `item ${other + 1} must be a string (got ${describeYaml(value.items[other])})` };
  return { items: value.items.map((item) => item.value) };
}

function readingProblems(config, label) {
  return [
    ...config.unsupported.map((entry) => `${label}: unsupported YAML at ${entry}`),
    ...config.duplicates.map((key) => `${label}: top-level key ${key} is written more than once`),
  ];
}

/**
 * Problems with `_config.yml`'s text (AC-01): `theme` must be null and
 * `future` boolean false as Jekyll reads them; `title`, `timezone`,
 * `permalink` and `url` exact strings, `url` following `cnameHost`; no base
 * path, `plugins` or `gems` key; `exclude` a list of strings holding every
 * `CONFIG_EXCLUDES` entry; and nothing the reader refuses.
 *
 * @param {string} text `_config.yml` contents.
 * @param {{ cnameHost: string | null }} options The trimmed `CNAME` contents, or `null` when `CNAME` is absent.
 * @returns {string[]} Problems; `[]` for a valid configuration.
 */
function configProblems(text, { cnameHost }) {
  const config = readTopLevelYaml(text);
  const problems = readingProblems(config, '_config.yml');

  const theme = config.get('theme');
  if (theme?.kind !== 'null') problems.push(`theme must be null (got ${describeYaml(theme)})`);
  const future = config.get('future');
  if (future?.kind !== 'bool' || future.value !== false) problems.push(`future must be boolean false (got ${describeYaml(future)})`);

  const strings = [['title', 'Cabrillo Coast'], ['timezone', 'Etc/UTC'], ['permalink', '/blog/:title/']];
  if (cnameHost === '') problems.push('CNAME must name the custom-domain host');
  else strings.push(['url', cnameHost === null ? PROJECT_URL : `https://${cnameHost}`]);
  for (const [key, wanted] of strings) {
    const value = config.get(key);
    if (value?.kind !== 'string' || value.value !== wanted) {
      const mode = key === 'url' ? ` while CNAME is ${cnameHost === null ? 'absent' : 'present'}` : '';
      problems.push(`${key} must be the string ${JSON.stringify(wanted)}${mode} (got ${describeYaml(value)})`);
    }
  }

  // Pages supplies the base path through jekyll-github-metadata; setting it here breaks one of the two deployment modes.
  if (config.has('baseurl')) problems.push('_config.yml must not set baseurl');
  // gems is Jekyll 3's deprecated spelling of plugins; neither may switch on feed, sitemap or SEO plugins.
  for (const key of ['plugins', 'gems']) if (config.has(key)) problems.push(`_config.yml must not set ${key}`);

  const exclude = stringListOf(config.get('exclude'));
  if (exclude.problem) {
    problems.push(`exclude ${exclude.problem}`);
  } else {
    const missing = CONFIG_EXCLUDES.filter((entry) => !exclude.items.includes(entry));
    if (missing.length > 0) problems.push(`exclude must list: ${missing.join(', ')}`);
  }
  return problems;
}

/**
 * Problems with `_config.preview.yml` against `_config.yml` (AC-01): the
 * preview must set `exclude` and nothing else, and its list must be the base
 * list without `PREVIEW_ONLY_INCLUDED`, which the base lists exactly once.
 *
 * @returns {string[]} Problems; `[]` for a valid overlay.
 */
function previewProblems(baseText, previewText) {
  const base = readTopLevelYaml(baseText);
  const preview = readTopLevelYaml(previewText);
  const problems = [...readingProblems(base, '_config.yml'), ...readingProblems(preview, '_config.preview.yml')];
  if (preview.keys.length !== 1 || preview.keys[0] !== 'exclude') {
    problems.push(`_config.preview.yml must set exclude and nothing else (got ${preview.keys.join(', ') || 'no keys'})`);
  }

  const baseExclude = stringListOf(base.get('exclude'));
  const previewExclude = stringListOf(preview.get('exclude'));
  if (baseExclude.problem) problems.push(`_config.yml exclude ${baseExclude.problem}`);
  if (previewExclude.problem) problems.push(`_config.preview.yml exclude ${previewExclude.problem}`);
  if (baseExclude.problem || previewExclude.problem) return problems;

  if (baseExclude.items.filter((entry) => entry === PREVIEW_ONLY_INCLUDED).length !== 1) {
    problems.push(`_config.yml exclude must list ${PREVIEW_ONLY_INCLUDED} exactly once`);
  }
  if (previewExclude.items.length !== baseExclude.items.length - 1) {
    problems.push('_config.preview.yml exclude must hold exactly one entry fewer than _config.yml');
  }
  const wanted = baseExclude.items.filter((entry) => entry !== PREVIEW_ONLY_INCLUDED).sort();
  if (JSON.stringify([...previewExclude.items].sort()) !== JSON.stringify(wanted)) {
    problems.push(`_config.preview.yml exclude must equal the _config.yml list without ${PREVIEW_ONLY_INCLUDED}`);
  }
  return problems;
}

/** The trimmed `CNAME` contents, or `null` when the repository has no `CNAME`. */
function cnameHost() {
  return exists('CNAME') ? read('CNAME').trim() : null;
}

/* Gem pins                                                                  */

/** The active `source` line `Gemfile` must have. */
const GEM_SOURCE_RE = /^source\s+(["'])https:\/\/rubygems\.org\1$/;

/** One argument of a `gem` declaration: a quoted string, or an option `key: value` / `:key => value`. */
const GEM_STRING_ARG_RE = /^(["'])([^"'\\]*)\1$/;
const GEM_OPTION_ARG_RE = /^(?:([a-z_]+):|:([a-z_]+)\s*=>)\s*(?::([a-z_]+)|(["'])([^"'\\]*)\4)$/;

/** `line` without a Ruby `#` comment that stands outside a string. */
function stripRubyComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** `text` split on the commas that stand outside strings. */
function splitRubyArgs(text) {
  const args = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ',') {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

/**
 * The arguments of `gem <args>` as `{ name, requirements, options }`, or
 * `null` when they are not a quoted name, quoted requirements and then
 * `key: :symbol` / `:key => :symbol` (or quoted) options only.
 */
function readGemArgs(text) {
  const args = splitRubyArgs(text);
  const name = GEM_STRING_ARG_RE.exec(args[0]);
  if (name === null) return null;
  const requirements = [];
  const options = {};
  for (const arg of args.slice(1)) {
    const string = GEM_STRING_ARG_RE.exec(arg);
    if (string !== null && Object.keys(options).length === 0) {
      requirements.push(string[2]);
      continue;
    }
    const option = GEM_OPTION_ARG_RE.exec(arg);
    if (option === null) return null;
    setOwnOption(options, option[1] ?? option[2], option[3] === undefined ? option[5] : `:${option[3]}`);
  }
  return { name: name[2], requirements, options };
}

/** Records a gem option as an own property, so a key such as `__proto__` cannot alter the prototype. */
function setOwnOption(options, key, value) {
  Object.defineProperty(options, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Problems with `Gemfile` (AC-01): comments outside strings, `=begin` …
 * `=end` blocks and everything after `__END__` are inactive. Every active
 * statement must be `source "https://rubygems.org"` (exactly once) or a `gem`
 * declaration, so a pin inside `if false … end` or `group … do … end` is
 * refused; and exactly one active `github-pages` declaration, pinned to
 * `PAGES_VERSION` with `group: :jekyll_plugins`, and one `nokogiri`
 * declaration, pinned to `NOKOGIRI_VERSION`, must exist.
 *
 * @returns {string[]} Problems; `[]` for a valid Gemfile.
 */
function gemfileProblems(text) {
  const problems = [];
  const gems = [];
  let sources = 0;
  let embedded = null;
  for (const [index, raw] of text.split('\n').entries()) {
    const n = index + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (embedded !== null) {
      if (/^=end(?:\s|$)/.test(line)) embedded = null;
      continue;
    }
    if (/^=begin(?:\s|$)/.test(line)) {
      embedded = n;
      continue;
    }
    if (line === '__END__') break;
    const statement = stripRubyComment(line).trim();
    if (statement === '') continue;
    if (GEM_SOURCE_RE.test(statement)) {
      sources += 1;
      continue;
    }
    const gem = /^gem\s+(.*)$/.exec(statement);
    if (gem === null) {
      problems.push(`Gemfile line ${n}: only source "https://rubygems.org" and gem declarations are allowed (got ${statement})`);
      continue;
    }
    const declaration = readGemArgs(gem[1]);
    if (declaration === null) problems.push(`Gemfile line ${n}: cannot read the gem declaration (${statement})`);
    else gems.push({ n, ...declaration });
  }
  if (embedded !== null) problems.push(`Gemfile line ${embedded}: =begin has no =end`);
  if (sources !== 1) problems.push(`Gemfile must declare source "https://rubygems.org" exactly once (found ${sources})`);

  const pins = [
    { name: 'github-pages', requirements: [PAGES_VERSION], options: { group: ':jekyll_plugins' }, shown: `gem "github-pages", "${PAGES_VERSION}", group: :jekyll_plugins` },
    { name: 'nokogiri', requirements: [NOKOGIRI_VERSION], options: {}, shown: `gem "nokogiri", "${NOKOGIRI_VERSION}"` },
  ];
  for (const pin of pins) {
    const found = gems.filter((gem) => gem.name === pin.name);
    if (found.length !== 1) {
      problems.push(`Gemfile must declare ${pin.shown} exactly once as an active line (found ${found.length})`);
      continue;
    }
    const [gem] = found;
    const requirements = JSON.stringify(gem.requirements);
    const options = JSON.stringify(gem.options);
    if (requirements !== JSON.stringify(pin.requirements) || options !== JSON.stringify(pin.options)) {
      problems.push(`Gemfile line ${gem.n}: must be ${pin.shown} (got requirements ${requirements}, options ${options})`);
    }
  }
  return problems;
}

/**
 * The resolved gems of `Gemfile.lock`: the `    name (version)` entries of the
 * `specs:` block of every `GEM` section, as a map of name to versions (a
 * platform gem carries `version-platform`). Dependency lines (six spaces),
 * `DEPENDENCIES` and every other section are not specs.
 */
function lockSpecs(text) {
  const specs = new Map();
  let inGem = false;
  let inSpecs = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (/^\S/.test(line)) {
      inGem = line === 'GEM';
      inSpecs = false;
      continue;
    }
    if (!inGem) continue;
    if (/^ {2}\S/.test(line)) {
      inSpecs = line === '  specs:';
      continue;
    }
    const m = inSpecs ? /^ {4}([^\s(]+) \(([^\s()]+)\)$/.exec(line) : null;
    if (m !== null) specs.set(m[1], [...(specs.get(m[1]) ?? []), m[2]]);
  }
  return specs;
}

/**
 * Problems with `Gemfile.lock` (AC-01): its `GEM` specs must resolve every
 * `LOCKED_GEMS` version, and a non-empty set of nokogiri entries, each
 * `NOKOGIRI_VERSION` or `NOKOGIRI_VERSION-<platform>`.
 *
 * @returns {string[]} Problems; `[]` for a valid lock.
 */
function lockProblems(text) {
  const specs = lockSpecs(text);
  const problems = [];
  for (const [name, version] of [...LOCKED_GEMS, ['nokogiri', NOKOGIRI_VERSION]]) {
    const versions = specs.get(name) ?? [];
    if (versions.length === 0) {
      problems.push(`Gemfile.lock GEM specs must resolve ${name} (${version}${name === 'nokogiri' ? '[-platform]' : ''})`);
      continue;
    }
    const stray = versions.filter((v) => v !== version && !v.startsWith(`${version}-`));
    if (stray.length > 0) problems.push(`Gemfile.lock resolves ${name} ${stray.join(', ')}, not ${version}`);
  }
  return problems;
}

/** `lock` without the `GEM` spec entries of `name` and their dependency lines. */
function dropLockSpec(lock, name) {
  let dropping = false;
  return lock
    .split('\n')
    .filter((line) => {
      if (/^ {4}\S/.test(line)) dropping = line.startsWith(`    ${name} (`);
      else if (!/^ {6}/.test(line)) dropping = false;
      return !dropping;
    })
    .join('\n');
}

/* AC-01: draft privacy and publishing configuration                         */

test('[AC-01][F-017] nothing in a _drafts/ folder at any depth or under assets/drafts/ is tracked', () => {
  assertRepositoryRoot();
  // Jekyll reads `<dir>/_drafts/` in every folder it builds, so a nested one such as blog/_drafts/ counts too.
  const tracked = git(['ls-files', '--', '_drafts', 'assets/drafts', ':(glob)**/_drafts/**']).trim();
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

  // An article that is not valid UTF-8 is refused, as guard refuses it, rather than checked as replacement characters.
  const articlePaths = paths.filter((p) => ARTICLE_PATH_RE.test(p) && isFile(p));
  const articles = [];
  const undecodable = [];
  for (const p of articlePaths) {
    const text = readArticle(p);
    if (text === null) undecodable.push(notUtf8Finding(p));
    else articles.push({ path: p, text });
  }
  const checked = new Set(articlePaths);
  for (const fixture of REQUIRED_FIXTURES) {
    assert.ok(checked.has(fixture), `${fixture} must be present and not git-ignored, so its rules are checked`);
  }
  t.diagnostic(`checked ${paths.length} paths and ${articlePaths.length} articles against ${TODAY_UTC} (UTC)`);

  const findings = [...undecodable, ...checkTrackedContent({ paths, articles, todayUtc: TODAY_UTC })];
  assert.deepEqual(findings, [], `tracked content breaks the publishing rules:\n${findings.join('\n')}`);
});

/** The post at the centre of the synthetic trees, dated before `FIXED_TODAY`. */
const ALPHA_PATH = '_posts/2026-03-01-alpha.md';

/** `ALPHA_PATH`'s source: `frontMatter` (valid by default), its image on file line 8, then `extraBody`. */
function alphaSource({ frontMatter = VALID_FRONT_MATTER, extraBody = '' } = {}) {
  return articleSource(
    frontMatter,
    `An article body with a figure.\n\n![A figure]({{ '/assets/blog/alpha/fig.png' | relative_url }})\n${extraBody}`,
  );
}

/** A complete valid tree: configuration, one post and that post's image. Each call gives a fresh copy. */
function baseTree() {
  return {
    paths: ['_config.yml', ALPHA_PATH, 'assets/blog/alpha/fig.png'],
    articles: [{ path: ALPHA_PATH, text: alphaSource() }],
  };
}

/** Puts an article into `tree`: its path into `paths` (once) and its text into `articles`, replacing any earlier text. */
function setArticle(tree, rel, text) {
  if (!tree.paths.includes(rel)) tree.paths.push(rel);
  tree.articles = [...tree.articles.filter((article) => article.path !== rel), { path: rel, text }];
}

/** Removes a path, and its article if it has one, from `tree`. */
function removePath(tree, rel) {
  tree.paths = tree.paths.filter((p) => p !== rel);
  tree.articles = tree.articles.filter((article) => article.path !== rel);
}

/** A future-date refusal for `rel`, dated the day after `FIXED_TODAY`. */
function futureRefusal(rel) {
  return new RegExp(`^${regExpLiteral(rel)}: dated 2026-06-16, after today \\(UTC 2026-06-15\\); future-dated posts are not allowed$`);
}

/** The refusal of `rel` as a tracked draft or draft image. */
function draftRefusal(rel) {
  return new RegExp(`^${regExpLiteral(rel)}: drafts and draft images must never be tracked \\(git rm --cached; `);
}

/** The refusal of `rel` for sitting in a `_posts/` folder below the repository root. */
function nestedPostsRefusal(rel) {
  return new RegExp(`^${regExpLiteral(rel)}: articles belong only in the root _posts/ folder; Jekyll can read a nested `
    + '_posts/ folder as posts, but the article checks cover only the root one$');
}

/** The refusal of `rel` for its folder `folder` inside `_posts/`, a name Jekyll can skip. */
function skippedFolderRefusal(rel, folder) {
  return new RegExp(`^${regExpLiteral(rel)}: folder ${regExpLiteral(folder)}/ is not allowed in _posts/; Jekyll can skip folders `
    + 'whose names start with _, \\., # or ~, so a post in one could stay off the site while public on GitHub$');
}

/**
 * Tree cases for `checkTrackedContent` against `FIXED_TODAY`: each changes a
 * fresh `baseTree()` and lists the refusals the change must produce, in
 * order. The first leaves the tree valid, so a constant-empty helper passes
 * it and fails every other case.
 */
const TREE_CASES = Object.freeze([
  { name: 'the valid base tree is accepted', change: () => {}, expect: [] },
  {
    name: 'a tracked draft is refused',
    change: (tree) => tree.paths.push('_drafts/secret.md'),
    expect: [/^_drafts\/secret\.md: drafts and draft images must never be tracked/],
  },
  {
    name: 'a tracked draft image is refused',
    change: (tree) => tree.paths.push('assets/drafts/secret/fig.png'),
    expect: [/^assets\/drafts\/secret\/fig\.png: drafts and draft images must never be tracked/],
  },
  {
    name: 'a tracked draft in a nested _drafts/ folder is refused',
    change: (tree) => tree.paths.push('blog/_drafts/secret.md'),
    expect: [draftRefusal('blog/_drafts/secret.md')],
  },
  {
    name: 'a draft folder inside _posts/ is refused as a draft and, being in _posts/, as a misnamed post',
    change: (tree) => tree.paths.push('_posts/_drafts/x.md'),
    expect: [draftRefusal('_posts/_drafts/x.md'), /^_posts\/_drafts\/x\.md: post filename must be YYYY-MM-DD-<slug>\.md$/],
  },
  {
    name: 'a valid, past-dated post in a nested _posts/ folder is refused',
    change: (tree) => setArticle(tree, 'blog/_posts/2026-03-02-beta.md', articleSource(VALID_FRONT_MATTER, 'Body.\n')),
    expect: [nestedPostsRefusal('blog/_posts/2026-03-02-beta.md')],
  },
  {
    name: 'a future-dated post in a nested _posts/ folder at any depth is refused',
    change: (tree) => tree.paths.push('blog/_posts/2026-06-16-later.md', 'a/b/_posts/2026-06-16-deep.md'),
    expect: [nestedPostsRefusal('blog/_posts/2026-06-16-later.md'), nestedPostsRefusal('a/b/_posts/2026-06-16-deep.md')],
  },
  {
    name: 'a nested post with a published: key is refused for its folder and its key',
    change: (tree) => setArticle(tree, 'blog/_posts/2026-03-02-beta.md', articleSource([...VALID_FRONT_MATTER, 'published: false'], 'Body.\n')),
    expect: [nestedPostsRefusal('blog/_posts/2026-03-02-beta.md'), /^blog\/_posts\/2026-03-02-beta\.md: published: is not allowed/],
  },
  {
    name: 'a valid, past-dated post in a folder Jekyll skips (_posts/_hold/) is refused',
    change: (tree) => setArticle(tree, '_posts/_hold/2026-03-02-held.md', articleSource(VALID_FRONT_MATTER, 'Body.\n')),
    expect: [skippedFolderRefusal('_posts/_hold/2026-03-02-held.md', '_hold')],
  },
  {
    name: 'posts in _posts/ folders led by ., # or ~, and in a deeper _ folder, are refused',
    change: (tree) => tree.paths.push(
      '_posts/.dot/2026-03-02-dot.md',
      '_posts/#hash/2026-03-02-hash.md',
      '_posts/~tilde/2026-03-02-tilde.md',
      '_posts/2026/_x/2026-03-02-deep.md',
    ),
    expect: [
      skippedFolderRefusal('_posts/.dot/2026-03-02-dot.md', '.dot'),
      skippedFolderRefusal('_posts/#hash/2026-03-02-hash.md', '#hash'),
      skippedFolderRefusal('_posts/~tilde/2026-03-02-tilde.md', '~tilde'),
      skippedFolderRefusal('_posts/2026/_x/2026-03-02-deep.md', '_x'),
    ],
  },
  {
    name: 'a post in a skipped folder is refused for its folder, not as a second post with its slug',
    change: (tree) => tree.paths.push('_posts/_hold/2026-03-02-alpha.md'),
    expect: [skippedFolderRefusal('_posts/_hold/2026-03-02-alpha.md', '_hold')],
  },
  {
    name: 'a post in a skipped folder does not count as the post of its image folder',
    change: (tree) => {
      removePath(tree, ALPHA_PATH);
      setArticle(tree, '_posts/_hold/2026-03-01-alpha.md', alphaSource());
    },
    expect: [
      skippedFolderRefusal('_posts/_hold/2026-03-01-alpha.md', '_hold'),
      /^assets\/blog\/alpha\/: image folder has no matching _posts\/\*-alpha\.md$/,
    ],
  },
  {
    name: 'folder names are matched whole: my_drafts/, my_posts/, _postscript.md, _drafts.md, _posts/sub/ and _posts/sub~/ are accepted',
    change: (tree) => {
      tree.paths.push('notes/my_drafts/x.md', 'docs/_postscript.md', 'docs/_drafts.md', 'blog/my_posts/x.md');
      tree.paths.push('_posts/sub~/2026-03-03-gamma.md');
      setArticle(tree, '_posts/sub/2026-03-02-beta.md', articleSource(VALID_FRONT_MATTER, 'Body.\n'));
    },
    expect: [],
  },
  {
    name: 'a published: key in a post is refused',
    change: (tree) => setArticle(tree, ALPHA_PATH, alphaSource({ frontMatter: [...VALID_FRONT_MATTER, 'published: false'] })),
    expect: [/^_posts\/2026-03-01-alpha\.md: published: is not allowed/],
  },
  {
    name: 'a published: key in a fixture article is refused',
    change: (tree) => setArticle(tree, 'tests/fixtures/posts/2026-03-02-beta.md', articleSource([...VALID_FRONT_MATTER, 'published: true'], 'Body.\n')),
    expect: [/^tests\/fixtures\/posts\/2026-03-02-beta\.md: published: is not allowed/],
  },
  {
    name: 'a post path dated the day after today is refused',
    change: (tree) => tree.paths.push('_posts/2026-06-16-later.md'),
    expect: [futureRefusal('_posts/2026-06-16-later.md')],
  },
  {
    name: 'a fixture path dated the day after today is refused',
    change: (tree) => tree.paths.push('tests/fixtures/posts/2026-06-16-later.md'),
    expect: [futureRefusal('tests/fixtures/posts/2026-06-16-later.md')],
  },
  {
    name: 'a checked post dated the day after today is refused once',
    change: (tree) => setArticle(tree, '_posts/2026-06-16-later.md', articleSource(VALID_FRONT_MATTER, 'Body.\n')),
    expect: [futureRefusal('_posts/2026-06-16-later.md')],
  },
  {
    name: 'a post dated today is accepted',
    change: (tree) => setArticle(tree, '_posts/2026-06-15-today.md', articleSource(VALID_FRONT_MATTER, 'Body.\n')),
    expect: [],
  },
  {
    name: 'a fixture article dated today is accepted',
    change: (tree) => setArticle(tree, 'tests/fixtures/posts/2026-06-15-today.md', articleSource(VALID_FRONT_MATTER, 'Body.\n')),
    expect: [],
  },
  {
    name: 'a new image folder without a post is refused',
    change: (tree) => tree.paths.push('assets/blog/ghost/fig.png'),
    expect: [/^assets\/blog\/ghost\/: image folder has no matching _posts\/\*-ghost\.md$/],
  },
  {
    name: 'deleting a post whose image folder remains is refused',
    change: (tree) => removePath(tree, ALPHA_PATH),
    expect: [/^assets\/blog\/alpha\/: image folder has no matching _posts\/\*-alpha\.md$/],
  },
  {
    name: 'an article without a title is refused',
    change: (tree) => setArticle(tree, ALPHA_PATH, alphaSource({ frontMatter: VALID_FRONT_MATTER.filter((line) => !line.startsWith('title:')) })),
    expect: [/^_posts\/2026-03-01-alpha\.md: title is required$/],
  },
  {
    name: 'an article whose front matter does not parse is refused',
    change: (tree) => setArticle(tree, ALPHA_PATH, alphaSource({ frontMatter: ['title: Unquoted', ...VALID_FRONT_MATTER.slice(1)] })),
    expect: [/^_posts\/2026-03-01-alpha\.md: front matter line 2: title must be a double-quoted string$/],
  },
  {
    name: 'a <script> tag in an article is refused',
    change: (tree) => setArticle(tree, ALPHA_PATH, alphaSource({ extraBody: '\n<script>alert(1)</script>\n' })),
    expect: [/^_posts\/2026-03-01-alpha\.md:10: unsafe markup: <script>alert\(1\)<\/script>$/],
  },
  {
    name: 'an onerror= attribute in an article is refused',
    change: (tree) => setArticle(tree, ALPHA_PATH, alphaSource({ extraBody: '\n<span onerror="alert(1)">Caption</span>\n' })),
    expect: [/^_posts\/2026-03-01-alpha\.md:10: unsafe markup: <span onerror="alert\(1\)">Caption<\/span>$/],
  },
  {
    name: 'an image the tree does not hold is refused',
    change: (tree) => removePath(tree, 'assets/blog/alpha/fig.png'),
    expect: [/^_posts\/2026-03-01-alpha\.md:8: image \/assets\/blog\/alpha\/fig\.png does not exist$/],
  },
]);

test('[AC-01][F-017] checkTrackedContent accepts a valid synthetic tree and refuses each unpublishable change to it', async (t) => {
  for (const { name, change, expect } of TREE_CASES) {
    await t.test(`[AC-01][F-017] tracked content: ${name}`, () => {
      const tree = baseTree();
      change(tree);
      assertFindings(checkTrackedContent({ ...tree, todayUtc: FIXED_TODAY }), expect, name);
    });
  }
});

test('[AC-01][F-017] .gitignore lists every build, tooling, draft and draft-image entry and its own patterns ignore each one', () => {
  assert.ok(exists('.gitignore'), '.gitignore is missing');
  const lines = new Set(read('.gitignore').split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  assert.deepEqual(missing, [], `.gitignore must list: ${missing.join(', ')}`);
  assert.deepEqual(Object.keys(IGNORE_PROBES), [...GITIGNORE_ENTRIES], 'every .gitignore entry needs exactly one probe path');

  assertRepositoryRoot();
  const problems = ignoreProbeProblems(ROOT, GIT_ENV);
  assert.deepEqual(problems, [], `.gitignore must itself ignore every entry:\n${problems.join('\n')}`);
});

test('[AC-01][F-017] the ignore probes refuse a negated, missing or borrowed .gitignore entry', async (t) => {
  const listed = `${GITIGNORE_ENTRIES.join('\n')}\n`;
  const controls = [
    { name: 'every entry listed', files: { '.gitignore': listed }, expect: [] },
    {
      name: 'a later !node_modules/',
      files: { '.gitignore': `${listed}!node_modules/\n` },
      expect: [/^node_modules\/x\/package\.json \(node_modules\/\) is (?:not ignored by any pattern|re-included by \.gitignore:\d+ \(!node_modules\/\))$/],
    },
    {
      name: 'a later !.jekyll-metadata',
      files: { '.gitignore': `${listed}!.jekyll-metadata\n` },
      expect: [/^\.jekyll-metadata \(\.jekyll-metadata\) is re-included by \.gitignore:12 \(!\.jekyll-metadata\)$/],
    },
    {
      name: 'vendor/ left out',
      files: { '.gitignore': listed.replace('vendor/\n', '') },
      expect: [/^vendor\/bundle\/x \(vendor\/\) is not ignored by any pattern$/],
    },
    {
      name: '.bundle/ only in .git/info/exclude',
      files: { '.gitignore': listed.replace('.bundle/\n', ''), '.git/info/exclude': '.bundle/\n' },
      expect: [/^\.bundle\/config \(\.bundle\/\) is ignored only by \.git\/info\/exclude:1; \.gitignore itself must ignore it$/],
    },
  ];
  for (const { name, files, expect } of controls) {
    await t.test(`[AC-01][F-017] ignore control: ${name}`, () => {
      const repo = tempRepository('ignore', files);
      assertFindings(ignoreProbeProblems(repo, TEMP_GIT_ENV), expect, name);
    });
  }
});

test('[AC-01][F-017] .githooks/pre-commit and .githooks/pre-push run guard and are executable', async (t) => {
  assertRepositoryRoot();
  for (const hook of HOOKS) {
    await t.test(`[AC-01][F-017] ${hook.file} runs ${hook.command}`, (st) => {
      assert.ok(isFile(hook.file), `${hook.file} is missing`);
      const wrapper = hookWrapperProblems(read(hook.file), hook.command);
      assert.deepEqual(wrapper, [], `${hook.file} must be a #!/bin/sh wrapper that ends with ${hook.command}:\n${wrapper.join('\n')}`);

      if (process.platform === 'win32') {
        st.diagnostic('exec bit not checkable on win32');
      } else {
        const mode = statSync(abs(hook.file)).mode;
        assert.notEqual(mode & 0o111, 0, `${hook.file} must be executable in the working tree (chmod +x)`);
      }

      const { problems, diagnostic } = hookIndexProblems({
        file: hook.file,
        lsFiles: git(['ls-files', '-s', '--', hook.file]),
        ci: process.env.CI === 'true',
      });
      if (diagnostic !== null) st.diagnostic(diagnostic);
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  }
});

test('[AC-01][F-017] the hook index check refuses untracked hooks in CI and every mode but 100755', async (t) => {
  const file = HOOKS[0].file;
  const entry = (mode, stage = 0, oid = '1'.repeat(40)) => `${mode} ${oid} ${stage}\t${file}\n`;
  const controls = [
    { name: 'untracked in CI', lsFiles: '', ci: true, expect: [/^\.githooks\/pre-commit is not tracked; hooks must be tracked in CI$/], diagnostic: null },
    {
      name: 'untracked locally',
      lsFiles: '',
      ci: false,
      expect: [],
      diagnostic: /^\.githooks\/pre-commit not yet tracked; guard --staged enforces 100755 at commit$/,
    },
    { name: 'tracked 100755', lsFiles: entry('100755'), ci: true, expect: [], diagnostic: null },
    { name: 'tracked 100755 with a SHA-256 object id', lsFiles: entry('100755', 0, '2'.repeat(64)), ci: true, expect: [], diagnostic: null },
    {
      name: 'tracked 100644',
      lsFiles: entry('100644'),
      ci: false,
      expect: [/^\.githooks\/pre-commit is tracked with mode 100644; run git update-index --chmod=\+x /],
      diagnostic: null,
    },
    { name: 'tracked as a symbolic link (120000)', lsFiles: entry('120000'), ci: true, expect: [/ is tracked with mode 120000; /], diagnostic: null },
    {
      name: 'conflict stages where one is 100644',
      lsFiles: `${entry('100755', 1)}${entry('100644', 2)}${entry('100755', 3)}`,
      ci: true,
      expect: [/ is tracked with mode 100644 at conflict stage 2; /],
      diagnostic: null,
    },
    {
      name: 'output that is not an index entry',
      lsFiles: 'fatal: not a git repository\n',
      ci: true,
      expect: [/: unexpected git ls-files -s entry /],
      diagnostic: null,
    },
  ];
  for (const { name, lsFiles, ci, expect, diagnostic } of controls) {
    await t.test(`[AC-01][F-017] hook index control: ${name}`, () => {
      const result = hookIndexProblems({ file, lsFiles, ci });
      assertFindings(result.problems, expect, name);
      if (diagnostic === null) assert.equal(result.diagnostic, null, `${name}: no diagnostic expected`);
      else assert.match(result.diagnostic ?? '', diagnostic, `${name}: expected a diagnostic`);
    });
  }
});

test('[AC-01][F-017] each hook, run from a subfolder of a temporary repository, hands guard its mode, the root, its input and its exit status', async (t) => {
  for (const hook of HOOKS) {
    await t.test(`[AC-01][F-017] ${hook.file} runs guard as git would`, (st) => {
      if (process.platform === 'win32') {
        st.diagnostic('hooks run under sh; behavioural run skipped on win32');
        return;
      }
      assert.ok(isFile(hook.file), `${hook.file} is missing`);
      const problems = hookBehaviourProblems(read(hook.file), hook);
      assert.deepEqual(problems, [], `${hook.file} does not hand guard what git gives it:\n${problems.join('\n')}`);
    });
  }
});

test('[AC-01][F-017] the hook checks refuse wrappers that disable or alter guard', async (t) => {
  for (const control of HOOK_CONTROLS) {
    await t.test(`[AC-01][F-017] hook control: ${control.name}`, (st) => {
      const text = control.change(read(control.hook.file));
      assertReports(hookWrapperProblems(text, control.hook.command), control.wrapper, `${control.name} (static)`);
      if (control.behaviour === undefined) return;
      if (process.platform === 'win32') {
        st.diagnostic('hooks run under sh; behavioural run skipped on win32');
        return;
      }
      const problems = hookBehaviourProblems(text, control.hook);
      for (const pattern of control.behaviour) assertReports(problems, pattern, `${control.name} (run)`);
    });
  }
});

test('[AC-01][F-017] _config.yml disables the theme and future posts, sets no base path and excludes repository files', () => {
  assert.ok(exists('_config.yml'), '_config.yml is missing');
  const problems = configProblems(read('_config.yml'), { cnameHost: cnameHost() });
  assert.deepEqual(problems, [], `_config.yml breaks the publishing configuration:\n${problems.join('\n')}`);
});

test('[AC-01][F-017] _config.preview.yml only restates the exclude list without assets/drafts', () => {
  assert.ok(exists('_config.yml'), '_config.yml is missing');
  assert.ok(exists('_config.preview.yml'), '_config.preview.yml is missing');
  const problems = previewProblems(read('_config.yml'), read('_config.preview.yml'));
  assert.deepEqual(problems, [], `_config.preview.yml breaks the preview overlay:\n${problems.join('\n')}`);
});

/** The `exclude` block list as `_config.yml` writes it, replaced by a flow list in one control. */
const EXCLUDE_BLOCK = `exclude:\n${CONFIG_EXCLUDES.map((entry) => `  - ${entry}\n`).join('')}`;

/** The `defaults` block as `_config.yml` writes it: a list holding one mapping with nested mappings. */
const DEFAULTS_BLOCK = [
  'defaults:',
  '  - scope:',
  '      path: ""',
  '      type: posts',
  '    values:',
  '      layout: post',
  '      author: "Randy Miller"',
  '',
].join('\n');

/** The `CNAME` host the configuration controls assume unless a control names its own. */
const CONTROL_CNAME_HOST = 'www.cabrillocoast.com';

/**
 * A fixed, valid custom-domain `_config.yml` for `CONTROL_CNAME_HOST`, holding
 * every line the controls change exactly once. The controls change this text,
 * never the repository's, so they neither depend on the deployment mode, the
 * `url` spelling or the defaults the owner has chosen, nor repeat a problem in
 * the real files, which only the `_config.yml` and `_config.preview.yml` tests
 * judge.
 */
const CONTROL_CONFIG = [
  '# A known-good custom-domain configuration for the controls.',
  'title: Cabrillo Coast',
  'description: Technical articles on software architecture, technical leadership and agentic AI from Cabrillo Coast.',
  `url: "https://${CONTROL_CNAME_HOST}"`,
  'timezone: Etc/UTC',
  'theme: null',
  'permalink: /blog/:title/',
  'future: false',
  EXCLUDE_BLOCK,
  DEFAULTS_BLOCK,
].join('\n');

/**
 * A fixed, valid `_config.preview.yml` for `CONTROL_CONFIG`: its `exclude`
 * list without `PREVIEW_ONLY_INCLUDED`. The preview controls change this text,
 * never the repository's, for the same reason as `CONTROL_CONFIG`.
 */
const CONTROL_PREVIEW = `# A known-good preview overlay for the controls.\n${EXCLUDE_BLOCK.replace('  - assets/drafts\n', '')}`;

/** A refusal by `readTopLevelYaml`, reported by `configProblems` or `previewProblems`. */
const UNSUPPORTED = /^_config(?:\.preview)?\.yml: unsupported YAML at line \d+: /;

/**
 * Controls for `configProblems`, each a change to `CONTROL_CONFIG`, checked
 * with `CONTROL_CNAME_HOST` as the `CNAME` host unless the control sets its own
 * `cnameHost` (`null`: `CNAME` absent), and the problems it must produce, in
 * order (`[]`: still valid). They pin the reading SafeYAML gives: quoted values
 * are strings, plain booleans and nulls ignore letter case, quoted and spaced
 * keys are keys, and what the reader cannot read is refused instead of
 * guessed. They also pin the two accepted `CNAME`/`url` states, whatever the
 * `url` quoting, and the refusal of the two inconsistent ones.
 */
const CONFIG_CONTROLS = Object.freeze([
  {
    name: 'future: "false" is a string',
    change: (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: "false"\n'),
    expect: [/^future must be boolean false \(got quoted string "false"\)$/],
  },
  {
    name: 'theme: "null" is a string',
    change: (text) => replaceOnce(text, '\ntheme: null\n', '\ntheme: "null"\n'),
    expect: [/^theme must be null \(got quoted string "null"\)$/],
  },
  {
    name: "theme: 'null' is a string",
    change: (text) => replaceOnce(text, '\ntheme: null\n', "\ntheme: 'null'\n"),
    expect: [/^theme must be null \(got quoted string "null"\)$/],
  },
  { name: 'future: False is boolean false', change: (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: False\n'), expect: [] },
  { name: 'future: fAlse is boolean false', change: (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: fAlse\n'), expect: [] },
  { name: 'theme: ~ is null', change: (text) => replaceOnce(text, '\ntheme: null\n', '\ntheme: ~\n'), expect: [] },
  {
    name: 'future: false false is a string',
    change: (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: false false\n'),
    expect: [/^future must be boolean false \(got string "false false"\)$/],
  },
  {
    name: 'future: 0 is a number, not false',
    change: (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: 0\n'),
    expect: [/^future must be boolean false \(got the non-string value 0\)$/],
  },
  { name: 'a quoted "baseurl" key is a key', change: (text) => `${text}"baseurl": /x\n`, expect: [/^_config\.yml must not set baseurl$/] },
  { name: 'baseurl : /x is a key', change: (text) => `${text}baseurl : /x\n`, expect: [/^_config\.yml must not set baseurl$/] },
  { name: "a single-quoted 'plugins' key is a key", change: (text) => `${text}'plugins': [jekyll-feed]\n`, expect: [/^_config\.yml must not set plugins$/] },
  {
    name: 'an appended quoted "future": true duplicates future and wins',
    change: (text) => `${text}"future": true\n`,
    expect: [/^_config\.yml: top-level key future is written more than once$/, /^future must be boolean false \(got boolean true\)$/],
  },
  {
    name: 'future: !!bool false carries a YAML tag',
    change: (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: !!bool false\n'),
    expect: [
      /^_config\.yml: unsupported YAML at line \d+: YAML tags \(!\) are not supported$/,
      /^future must be boolean false \(got a value this reader cannot read\)$/,
    ],
  },
  {
    name: 'an unclosed title quote',
    change: (text) => replaceOnce(text, '\ntitle: Cabrillo Coast\n', '\ntitle: "Cabrillo Coast\n'),
    expect: [
      /^_config\.yml: unsupported YAML at line \d+: a double-quoted string must close on the same line$/,
      /^title must be the string "Cabrillo Coast" \(got a value this reader cannot read\)$/,
    ],
  },
  {
    name: 'exclude written as a flow list',
    change: (text) => replaceOnce(text, EXCLUDE_BLOCK, `exclude: [${CONFIG_EXCLUDES.join(', ')}]\n`),
    expect: [],
  },
  {
    name: 'exclude items at column 0',
    change: (text) => replaceOnce(text, EXCLUDE_BLOCK, `exclude:\n${CONFIG_EXCLUDES.map((entry) => `- ${entry}\n`).join('')}`),
    expect: [],
  },
  {
    name: 'an exclude entry removed',
    change: (text) => replaceOnce(text, '  - assets/drafts\n', ''),
    expect: [/^exclude must list: assets\/drafts$/],
  },
  {
    name: 'defaults written with its list at column 0',
    change: (text) => replaceOnce(text, DEFAULTS_BLOCK, DEFAULTS_BLOCK.replace(/\n {2}/g, '\n')),
    expect: [],
  },
  {
    name: 'a nested list at its key\'s own indentation',
    change: (text) => replaceOnce(text, '      author: "Randy Miller"\n', '      tags:\n      - a\n      - b\n'),
    expect: [],
  },
  {
    name: 'url not matching the CNAME host',
    change: (text) => replaceOnce(text, '\nurl: "https://www.cabrillocoast.com"\n', '\nurl: "https://elsewhere.example"\n'),
    expect: [/^url must be the string "https:\/\/www\.cabrillocoast\.com" while CNAME is present \(got quoted string "https:\/\/elsewhere\.example"\)$/],
  },
  {
    name: 'project mode: CNAME absent and the github.io url',
    change: (text) => replaceOnce(text, '\nurl: "https://www.cabrillocoast.com"\n', `\nurl: "${PROJECT_URL}"\n`),
    cnameHost: null,
    expect: [],
  },
  {
    name: 'CNAME absent with the custom-domain url',
    change: (text) => text,
    cnameHost: null,
    expect: [/^url must be the string "https:\/\/randyamiller\.github\.io" while CNAME is absent \(got quoted string "https:\/\/www\.cabrillocoast\.com"\)$/],
  },
  {
    name: 'CNAME present with the github.io url',
    change: (text) => replaceOnce(text, '\nurl: "https://www.cabrillocoast.com"\n', `\nurl: "${PROJECT_URL}"\n`),
    expect: [/^url must be the string "https:\/\/www\.cabrillocoast\.com" while CNAME is present \(got quoted string "https:\/\/randyamiller\.github\.io"\)$/],
  },
  {
    name: 'an unquoted custom-domain url',
    change: (text) => replaceOnce(text, '\nurl: "https://www.cabrillocoast.com"\n', '\nurl: https://www.cabrillocoast.com\n'),
    expect: [],
  },
  {
    name: 'a single-quoted github.io url while CNAME is absent',
    change: (text) => replaceOnce(text, '\nurl: "https://www.cabrillocoast.com"\n', `\nurl: '${PROJECT_URL}'\n`),
    cnameHost: null,
    expect: [],
  },
  {
    name: 'an empty CNAME',
    change: (text) => text,
    cnameHost: '',
    expect: [/^CNAME must name the custom-domain host$/],
  },
  // Constructs the reader refuses: each must surface as unsupported, never pass as a reading.
  ...[
    ['a complex key', (text) => `${text}? future\n: true\n`],
    ['a merge key', (text) => `${text}<<: *defaults\n`],
    ['a second document', (text) => `${text}---\nfuture: true\n`],
    ['a document end marker', (text) => `${text}...\n`],
    ['a directive', (text) => `%YAML 1.1\n---\n${text}`],
    ['tab indentation', (text) => replaceOnce(text, '  - README.md\n', '\t- README.md\n')],
    ['an anchor', (text) => replaceOnce(text, '\ntheme: null\n', '\ntheme: &none null\n')],
    ['an alias', (text) => replaceOnce(text, '\ntheme: null\n', '\ntheme: *none\n')],
    ['a block scalar', (text) => replaceOnce(text, '\ntitle: Cabrillo Coast\n', '\ntitle: >\n  Cabrillo Coast\n')],
    ['a flow mapping', (text) => replaceOnce(text, '\nfuture: false\n', '\nfuture: { value: false }\n')],
    ['a plain value containing ": "', (text) => replaceOnce(text, '\ntitle: Cabrillo Coast\n', '\ntitle: Cabrillo: Coast\n')],
    ['a plain value ending in ":"', (text) => replaceOnce(text, '\ntitle: Cabrillo Coast\n', '\ntitle: Cabrillo Coast:\n')],
    ['text after a closing quote', (text) => replaceOnce(text, '\nurl: "https://www.cabrillocoast.com"\n', '\nurl: "https://www.cabrillocoast.com" extra\n')],
    ['text after a closing bracket', (text) => replaceOnce(text, EXCLUDE_BLOCK, `exclude: [${CONFIG_EXCLUDES.join(', ')}] extra\n`)],
    ['an unclosed flow list', (text) => replaceOnce(text, EXCLUDE_BLOCK, `exclude: [${CONFIG_EXCLUDES.join(', ')}\n`)],
    ['a nested flow list', (text) => replaceOnce(text, EXCLUDE_BLOCK, `exclude: [[${CONFIG_EXCLUDES.join(', ')}]]\n`)],
    ['a value continued on an indented line', (text) => replaceOnce(text, '\ntitle: Cabrillo Coast\n', '\ntitle: Cabrillo\n  Coast\n')],
    ['an indented first line', (text) => `  future: true\n${text}`],
    ['a scalar list item with deeper lines', (text) => replaceOnce(text, '  - README.md\n', '  - README.md\n    continued\n')],
    ['an item indented deeper than its siblings', (text) => replaceOnce(text, '  - Gemfile\n', '    - Gemfile\n')],
    ['an item indented less than its siblings', (text) => replaceOnce(text, '  - README.md\n', '    - README.md\n')],
    ['an anchor in nested content', (text) => replaceOnce(text, '      layout: post\n', '      layout: &layout post\n')],
    // Malformed nesting that SafeYAML 1.0.5 rejects must not pass below a key no check reads.
    ['a nested value continued on a deeper line', (text) => replaceOnce(text, '      author: "Randy Miller"\n', '      author: "Randy Miller"\n        stray\n')],
    ['a nested line without a key', (text) => replaceOnce(text, '    values:\n', '    values\n')],
    ['a nested key between two indentation levels', (text) => replaceOnce(text, '    values:\n', '   values:\n')],
    ['a nested key indented deeper than its sibling', (text) => replaceOnce(text, '      author:', '       author:')],
    ['a nested key indented less than its sibling', (text) => replaceOnce(text, '      author:', '     author:')],
    ['a list item below a nested scalar at its indentation', (text) => replaceOnce(text, '      layout: post\n', '      layout: post\n      - stray\n')],
    ['a nested block scalar', (text) => replaceOnce(text, '      layout: post\n', '      layout: |\n        post\n')],
    ['a top-level line without a key', (text) => `${text}future:false\n`],
    ['a key with an unsupported escape', (text) => `${text}"base\\u0075rl": /x\n`],
  ].map(([name, change]) => ({ name: `${name} is refused`, change, unsupported: true })),
]);

/** Controls for `previewProblems`, each a change to `CONTROL_PREVIEW`, judged against `CONTROL_CONFIG`. */
const PREVIEW_CONTROLS = Object.freeze([
  {
    name: 'an extra quoted "future": true key',
    change: (text) => `${text}"future": true\n`,
    expect: [/^_config\.preview\.yml must set exclude and nothing else \(got exclude, future\)$/],
  },
  {
    name: 'exclude written as a flow list',
    change: (text) => replaceOnce(
      text,
      EXCLUDE_BLOCK.replace('  - assets/drafts\n', ''),
      `exclude: [${CONFIG_EXCLUDES.filter((entry) => entry !== PREVIEW_ONLY_INCLUDED).join(', ')}]\n`,
    ),
    expect: [],
  },
  {
    name: 'assets/drafts kept in the preview',
    change: (text) => `${text}  - assets/drafts\n`,
    expect: [
      /^_config\.preview\.yml exclude must hold exactly one entry fewer than _config\.yml$/,
      /^_config\.preview\.yml exclude must equal the _config\.yml list without assets\/drafts$/,
    ],
  },
  {
    name: 'an entry missing from the preview',
    change: (text) => replaceOnce(text, '  - scripts\n', ''),
    expect: [
      /^_config\.preview\.yml exclude must hold exactly one entry fewer than _config\.yml$/,
      /^_config\.preview\.yml exclude must equal the _config\.yml list without assets\/drafts$/,
    ],
  },
  {
    name: 'a duplicated exclude key',
    change: (text) => `${text}exclude: []\n`,
    expect: [
      /^_config\.preview\.yml: top-level key exclude is written more than once$/,
      /^_config\.preview\.yml must set exclude and nothing else \(got exclude, exclude\)$/,
      /^_config\.preview\.yml exclude must hold exactly one entry fewer than _config\.yml$/,
      /^_config\.preview\.yml exclude must equal the _config\.yml list without assets\/drafts$/,
    ],
  },
  {
    name: 'an unclosed quote in the preview',
    change: (text) => replaceOnce(text, '  - scripts\n', '  - "scripts\n'),
    unsupported: true,
  },
]);

test('[AC-01][F-017] the configuration checks read YAML types and keys as Jekyll does and refuse what they cannot read', async (t) => {
  // Each control's expectation is a change from these valid texts, so they must pass unchanged.
  await t.test('[AC-01][F-017] the control _config.yml is valid for its CNAME host', () => {
    assertFindings(configProblems(CONTROL_CONFIG, { cnameHost: CONTROL_CNAME_HOST }), [], 'CONTROL_CONFIG');
  });
  await t.test('[AC-01][F-017] the control _config.preview.yml is valid for the control _config.yml', () => {
    assertFindings(previewProblems(CONTROL_CONFIG, CONTROL_PREVIEW), [], 'CONTROL_PREVIEW');
  });
  for (const control of CONFIG_CONTROLS) {
    await t.test(`[AC-01][F-017] _config.yml control: ${control.name}`, () => {
      const host = 'cnameHost' in control ? control.cnameHost : CONTROL_CNAME_HOST;
      const problems = configProblems(control.change(CONTROL_CONFIG), { cnameHost: host });
      if (control.unsupported) assertReports(problems, UNSUPPORTED, control.name);
      else assertFindings(problems, control.expect, control.name);
    });
  }
  for (const control of PREVIEW_CONTROLS) {
    await t.test(`[AC-01][F-017] _config.preview.yml control: ${control.name}`, () => {
      const problems = previewProblems(CONTROL_CONFIG, control.change(CONTROL_PREVIEW));
      if (control.unsupported) assertReports(problems, UNSUPPORTED, control.name);
      else assertFindings(problems, control.expect, control.name);
    });
  }
});

/** A value from `readTopLevelYaml` as plain data: mappings as objects, lists as arrays, scalars as their values. */
function plainYaml(value) {
  if (value.kind === 'mapping') return Object.fromEntries(value.entries.map((entry) => [entry.key, plainYaml(entry.value)]));
  if (value.kind === 'list') return value.items.map(plainYaml);
  return value.value;
}

test('[AC-01][F-017] the YAML reader reads the nested defaults: block to the structure SafeYAML loads', async (t) => {
  // The variants change CONTROL_CONFIG, so an owner's own default author never fails this reader check.
  // The values SafeYAML 1.0.5 loads for each variant.
  const variants = [
    {
      name: 'as the control configuration writes it',
      text: CONTROL_CONFIG,
      expect: [{ scope: { path: '', type: 'posts' }, values: { layout: 'post', author: 'Randy Miller' } }],
    },
    {
      name: 'with its list at column 0',
      text: replaceOnce(CONTROL_CONFIG, DEFAULTS_BLOCK, DEFAULTS_BLOCK.replace(/\n {2}/g, '\n')),
      expect: [{ scope: { path: '', type: 'posts' }, values: { layout: 'post', author: 'Randy Miller' } }],
    },
    {
      name: 'with a nested list at its key\'s own indentation',
      text: replaceOnce(CONTROL_CONFIG, '      author: "Randy Miller"\n', '      tags:\n      - a\n      - b\n'),
      expect: [{ scope: { path: '', type: 'posts' }, values: { layout: 'post', tags: ['a', 'b'] } }],
    },
  ];
  for (const { name, text, expect } of variants) {
    await t.test(`[AC-01][F-017] defaults: ${name}`, () => {
      const config = readTopLevelYaml(text);
      assert.deepEqual(config.unsupported, [], `${name}: the reader refused valid YAML:\n${config.unsupported.join('\n')}`);
      assert.deepEqual(plainYaml(config.get('defaults')), expect, `${name}: defaults: was read wrongly`);
    });
  }
});


test('[AC-01][F-017] Gemfile and Gemfile.lock pin the GitHub Pages gem versions', () => {
  assert.ok(exists('Gemfile'), 'Gemfile is missing');
  const gemfile = gemfileProblems(read('Gemfile'));
  assert.deepEqual(gemfile, [], `Gemfile must pin the GitHub Pages gems on active lines:\n${gemfile.join('\n')}`);

  assert.ok(exists('Gemfile.lock'), 'Gemfile.lock is missing; run bundle lock');
  const lock = lockProblems(read('Gemfile.lock'));
  assert.deepEqual(lock, [], `Gemfile.lock must resolve the GitHub Pages gem versions:\n${lock.join('\n')}`);
});

/** The two pin lines as `Gemfile` writes them; the controls rewrite them. */
const PAGES_PIN = `gem "github-pages", "${PAGES_VERSION}", group: :jekyll_plugins\n`;
const NOKOGIRI_PIN = `gem "nokogiri", "${NOKOGIRI_VERSION}"\n`;

/** A `~> major.minor` requirement around the nokogiri pin, which admits releases other than the pin. */
const NOKOGIRI_PESSIMISTIC = `~> ${NOKOGIRI_VERSION.split('.').slice(0, 2).join('.')}`;

/** The jekyll version the lock must resolve, and versions the controls substitute for the pins. */
const JEKYLL_VERSION = new Map(LOCKED_GEMS).get('jekyll');
const JEKYLL_STRAY = strayVersion(JEKYLL_VERSION);
const NOKOGIRI_STRAY = strayVersion(NOKOGIRI_VERSION);

/** Controls for `gemfileProblems`, each a change to the real `Gemfile` and the problems it must produce, in order. */
const GEMFILE_CONTROLS = Object.freeze([
  {
    name: 'both pins commented out',
    change: (text) => replaceOnce(replaceOnce(text, PAGES_PIN, `# ${PAGES_PIN}`), NOKOGIRI_PIN, `# ${NOKOGIRI_PIN}`),
    expect: [
      /^Gemfile must declare gem "github-pages", .* exactly once as an active line \(found 0\)$/,
      /^Gemfile must declare gem "nokogiri", .* exactly once as an active line \(found 0\)$/,
    ],
  },
  {
    name: `nokogiri pinned as ${NOKOGIRI_PESSIMISTIC}`,
    change: (text) => replaceOnce(text, NOKOGIRI_PIN, `gem "nokogiri", "${NOKOGIRI_PESSIMISTIC}"\n`),
    expect: [new RegExp(`^Gemfile line \\d+: ${regExpLiteral(
      `must be gem "nokogiri", "${NOKOGIRI_VERSION}" (got requirements ${JSON.stringify([NOKOGIRI_PESSIMISTIC])}, options {})`,
    )}$`)],
  },
  {
    name: 'github-pages without its group',
    change: (text) => replaceOnce(text, PAGES_PIN, `gem "github-pages", "${PAGES_VERSION}"\n`),
    expect: [new RegExp(`^Gemfile line \\d+: ${regExpLiteral(
      `must be ${PAGES_PIN.trimEnd()} (got requirements ${JSON.stringify([PAGES_VERSION])}, options {})`,
    )}$`)],
  },
  {
    name: 'both pins inside if false … end',
    change: (text) => replaceOnce(text, `${PAGES_PIN}${NOKOGIRI_PIN}`, `if false\n${PAGES_PIN}${NOKOGIRI_PIN}end\n`),
    expect: [
      /^Gemfile line \d+: only source "https:\/\/rubygems\.org" and gem declarations are allowed \(got if false\)$/,
      /^Gemfile line \d+: only source "https:\/\/rubygems\.org" and gem declarations are allowed \(got end\)$/,
    ],
  },
  {
    name: 'both pins inside =begin … =end',
    change: (text) => replaceOnce(text, `${PAGES_PIN}${NOKOGIRI_PIN}`, `=begin\n${PAGES_PIN}${NOKOGIRI_PIN}=end\n`),
    expect: [/^Gemfile must declare gem "github-pages", .* \(found 0\)$/, /^Gemfile must declare gem "nokogiri", .* \(found 0\)$/],
  },
  {
    name: 'both pins after __END__',
    change: (text) => replaceOnce(text, PAGES_PIN, `__END__\n${PAGES_PIN}`),
    expect: [/^Gemfile must declare gem "github-pages", .* \(found 0\)$/, /^Gemfile must declare gem "nokogiri", .* \(found 0\)$/],
  },
  {
    name: 'a pin disabled by a trailing if false',
    change: (text) => replaceOnce(text, NOKOGIRI_PIN, `gem "nokogiri", "${NOKOGIRI_VERSION}" if false\n`),
    expect: [
      new RegExp(`^Gemfile line \\d+: ${regExpLiteral(`cannot read the gem declaration (${NOKOGIRI_PIN.trimEnd()} if false)`)}$`),
      /^Gemfile must declare gem "nokogiri", .* \(found 0\)$/,
    ],
  },
  {
    name: 'a second nokogiri declaration',
    change: (text) => `${text}gem "nokogiri", "${NOKOGIRI_STRAY}"\n`,
    expect: [/^Gemfile must declare gem "nokogiri", .* exactly once as an active line \(found 2\)$/],
  },
  {
    name: 'single quotes, :group => and trailing comments are accepted',
    change: (text) => replaceOnce(
      replaceOnce(text, PAGES_PIN, `gem 'github-pages', '${PAGES_VERSION}', :group => :jekyll_plugins # Pages\n`),
      NOKOGIRI_PIN,
      `gem 'nokogiri', '${NOKOGIRI_VERSION}' # the version Pages runs\n`,
    ),
    expect: [],
  },
]);

/** Controls for `lockProblems`, each a change to the real `Gemfile.lock`. */
const LOCK_CONTROLS = Object.freeze([
  {
    name: 'nokogiri missing from the GEM specs while DEPENDENCIES still names it',
    change: (text) => dropLockSpec(text, 'nokogiri'),
    expect: [new RegExp(`^${regExpLiteral(`Gemfile.lock GEM specs must resolve nokogiri (${NOKOGIRI_VERSION}[-platform])`)}$`)],
  },
  {
    name: `nokogiri resolved as ${NOKOGIRI_STRAY}`,
    change: (text) => text.replaceAll(`    nokogiri (${NOKOGIRI_VERSION}`, `    nokogiri (${NOKOGIRI_STRAY}`),
    expect: [new RegExp(
      `^Gemfile\\.lock resolves nokogiri ${regExpLiteral(NOKOGIRI_STRAY)}-.*, not ${regExpLiteral(NOKOGIRI_VERSION)}$`,
    )],
  },
  {
    name: `github-pages (${PAGES_VERSION}) only as a dependency line`,
    change: (text) => replaceOnce(text, `\n    github-pages (${PAGES_VERSION})\n`, `\n      github-pages (${PAGES_VERSION})\n`),
    expect: [new RegExp(`^${regExpLiteral(`Gemfile.lock GEM specs must resolve github-pages (${PAGES_VERSION})`)}$`)],
  },
  {
    name: `jekyll resolved as ${JEKYLL_STRAY}`,
    change: (text) => replaceOnce(text, `\n    jekyll (${JEKYLL_VERSION})\n`, `\n    jekyll (${JEKYLL_STRAY})\n`),
    expect: [new RegExp(`^${regExpLiteral(`Gemfile.lock resolves jekyll ${JEKYLL_STRAY}, not ${JEKYLL_VERSION}`)}$`)],
  },
]);

test('[AC-01][F-017] the gem pin checks read only active Gemfile lines and resolved GEM specs', async (t) => {
  for (const [label, file, controls, check] of [
    ['Gemfile', 'Gemfile', GEMFILE_CONTROLS, gemfileProblems],
    ['Gemfile.lock', 'Gemfile.lock', LOCK_CONTROLS, lockProblems],
  ]) {
    const original = read(file);
    for (const { name, change, expect } of controls) {
      await t.test(`[AC-01][F-017] ${label} control: ${name}`, () => {
        const changed = change(original);
        assert.notEqual(changed, original, `${name}: the control must change ${file}`);
        assertFindings(check(changed), expect, name);
      });
    }
  }
});

test('[AC-01][F-017] .nojekyll is absent, so GitHub Pages keeps running Jekyll for the blog', () => {
  assert.equal(existsSync(path.join(ROOT, '.nojekyll')), false, '.nojekyll would switch Jekyll off and stop the blog from rendering');
});

/* AC-04: article schema                                                     */

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

  const imageExists = makeImageExists(ROOT);
  for (const rel of [...posts, ...fixtures]) {
    await t.test(`[AC-04][F-017] ${rel} passes the article schema`, () => {
      const slug = postSlug(rel);
      assert.ok(slug !== null, `${rel}: filename must be YYYY-MM-DD-<slug>.md`);
      assert.match(slug, SLUG_RE, `${rel}: slug "${slug}" must be lowercase letters, digits and single hyphens`);
      assert.ok(slug.length <= SLUG_LIMIT, `${rel}: slug must be at most ${SLUG_LIMIT} characters (got ${slug.length})`);

      const text = readArticle(rel);
      assert.notEqual(text, null, notUtf8Finding(rel));
      const { data, body, errors } = parseArticle(text);
      assert.deepEqual(errors, [], `${rel}: front matter does not parse:\n${errors.join('\n')}`);

      const findings = validateArticle({
        path: rel,
        data,
        body,
        kind: 'post',
        todayUtc: TODAY_UTC,
        imageExists,
        bodyStartLine: bodyStartLine(text, body),
      });
      assert.deepEqual(findings, [], `${rel} breaks the article schema:\n${findings.join('\n')}`);
    });
  }
});

test('[AC-04][F-017] articles are read as exact UTF-8, so a file the Pages build cannot read fails these checks', async (t) => {
  const frontMatter = (title) => Buffer.concat([Buffer.from('---\ntitle: "'), title, Buffer.from('"\n---\n\nBody.\n')]);
  for (const [name, bytes] of [
    ['Latin-1 é', frontMatter(Buffer.from([0x63, 0x61, 0x66, 0xe9]))],
    ['Windows-1252 curly quotes', frontMatter(Buffer.from([0x93, 0x51, 0x94]))],
    ['a UTF-16 byte-order mark', Buffer.from([0xff, 0xfe, 0x2d, 0x00, 0x2d, 0x00, 0x2d, 0x00])],
    ['a truncated two-byte sequence', frontMatter(Buffer.from([0x41, 0xc3, 0x28]))],
    ['an overlong form', frontMatter(Buffer.from([0xc0, 0xaf]))],
    ['a surrogate', frontMatter(Buffer.from([0xed, 0xa0, 0x80]))],
  ]) {
    await t.test(`[AC-04][F-017] ${name} is not read as an article`, () => {
      assert.equal(decodeArticle(bytes), null, `${name} must not decode`);
    });
  }
  await t.test('[AC-04][F-017] valid UTF-8 with a byte-order mark and CRLF lines is read exactly', () => {
    const text = '\uFEFF---\r\ntitle: "Café"\r\n---\r\n\r\nR&D café.\r\n';
    assert.equal(decodeArticle(Buffer.from(text, 'utf8')), text);
  });
});

/** The post most schema cases validate, dated before `FIXED_TODAY`. */
const SCHEMA_POST = '_posts/2026-03-01-schema-case.md';

/** A change to front-matter lines that sets `key` to the raw YAML `value`, replacing any earlier line for it. */
const setField = (key, value) => (lines) => [...lines.filter((line) => !line.startsWith(`${key}:`)), `${key}: ${value}`];

const dropField = (key) => (lines) => lines.filter((line) => !line.startsWith(`${key}:`));

/**
 * Cases for the exported `validateArticle`, kept apart from the tree cases
 * (`checkTrackedContent`) and the image cases: each changes
 * `VALID_FRONT_MATTER` (`fields`, applied in order), and optionally the path,
 * kind or body, and lists the findings it must produce. Accepted cases sit on
 * the schema's boundaries, so a validator that refuses too much fails too.
 */
const SCHEMA_CASES = Object.freeze([
  { name: 'the valid base article is accepted', expect: [] },
  { name: 'a 1-character title and summary are accepted', fields: [setField('title', '"A"'), setField('summary', '"B"')], expect: [] },
  {
    name: 'a 100-character title and a 200-character summary are accepted',
    fields: [setField('title', `"${'t'.repeat(100)}"`), setField('summary', `"${'s'.repeat(200)}"`)],
    expect: [],
  },
  { name: 'a title of 100 emoji is accepted, counted by code point', fields: [setField('title', `"${'😀'.repeat(100)}"`)], expect: [] },
  { name: 'five tags are accepted', fields: [setField('tags', '[a, b, c, d, e]')], expect: [] },
  { name: 'kebab-case tags with digits are accepted', fields: [setField('tags', '[node-22, "web-perf"]')], expect: [] },
  { name: 'updated equal to the post date is accepted', fields: [setField('updated', '2026-03-01')], expect: [] },
  { name: 'a post dated today is accepted', path: '_posts/2026-06-15-schema-case.md', expect: [] },
  { name: 'a 60-character slug is accepted', path: `_posts/2026-03-01-${'a'.repeat(60)}.md`, expect: [] },
  { name: 'author "Jane Doe" is accepted', fields: [setField('author', '"Jane Doe"')], expect: [] },
  { name: 'a draft is accepted', path: '_drafts/schema-case.md', kind: 'draft', expect: [] },
  { name: 'TODO: inside fenced code is accepted', body: 'Body.\n\n```text\nTODO: shown as code\n```\n', expect: [] },

  { name: 'a missing title is refused', fields: [dropField('title')], expect: [/: title is required$/] },
  { name: 'a blank title is refused', fields: [setField('title', '"   "')], expect: [/: title is required$/] },
  { name: 'a 101-character title is refused', fields: [setField('title', `"${'t'.repeat(101)}"`)], expect: [/: title must be 1 to 100 characters \(got 101\)$/] },
  { name: 'a title of 101 emoji is refused', fields: [setField('title', `"${'😀'.repeat(101)}"`)], expect: [/: title must be 1 to 100 characters \(got 101\)$/] },
  { name: 'a missing summary is refused', fields: [dropField('summary')], expect: [/: summary is required$/] },
  { name: 'a 201-character summary is refused', fields: [setField('summary', `"${'s'.repeat(201)}"`)], expect: [/: summary must be 1 to 200 characters \(got 201\)$/] },
  { name: 'missing tags are refused', fields: [dropField('tags')], expect: [/: tags must list 1 to 5 tags \(tags is missing\)$/] },
  { name: 'an empty tag list is refused', fields: [setField('tags', '[]')], expect: [/: tags must list 1 to 5 tags \(got 0\)$/] },
  { name: 'six tags are refused', fields: [setField('tags', '[a, b, c, d, e, f]')], expect: [/: tags must list 1 to 5 tags \(got 6\)$/] },
  { name: 'an uppercase tag is refused', fields: [setField('tags', '[Node]')], expect: [/: tag "Node" must be lowercase kebab-case$/] },
  { name: 'an underscore tag is refused', fields: [setField('tags', '[node_js]')], expect: [/: tag "node_js" must be lowercase kebab-case$/] },
  { name: 'tags written as a plain string are refused', fields: [setField('tags', 'testing')], expect: [/: tags must be a flow list such as \[a, b\]$/] },
  { name: 'an unknown key is refused', fields: [setField('colour', 'blue')], expect: [/: unknown front-matter key colour$/] },
  { name: 'published: is refused', fields: [setField('published', 'false')], expect: [/: published: is not allowed; /] },
  { name: 'layout: is refused', fields: [setField('layout', 'post')], expect: [/: layout: is not allowed; /] },
  { name: 'permalink: is refused', fields: [setField('permalink', '/elsewhere/')], expect: [/: permalink: is not allowed; /] },
  { name: 'date: is refused', fields: [setField('date', '2026-03-01')], expect: [/: date: is not allowed; /] },
  { name: 'categories: is refused', fields: [setField('categories', '[news]')], expect: [/: categories: is not allowed; /] },
  { name: 'updated 2026-02-30 is refused', fields: [setField('updated', '2026-02-30')], expect: [/: updated must be a real date written YYYY-MM-DD \(got "2026-02-30"\)$/] },
  { name: 'updated before the post date is refused', fields: [setField('updated', '2026-02-28')], expect: [/: updated 2026-02-28 is earlier than the post date 2026-03-01$/] },
  { name: 'updated: soon is refused', fields: [setField('updated', 'soon')], expect: [/: updated must be a real date written YYYY-MM-DD \(got "soon"\)$/] },
  { name: 'an empty author is refused', fields: [setField('author', '""')], expect: [/: author must be a non-empty double-quoted string$/] },
  { name: 'a blank author is refused', fields: [setField('author', '"  "')], expect: [/: author must be a non-empty double-quoted string$/] },
  { name: 'an empty body is refused', body: '', expect: [/: body is empty$/] },
  { name: 'a whitespace-only body is refused', body: ' \n\t\n', expect: [/: body is empty$/] },
  { name: 'TODO: in the title is refused', fields: [setField('title', '"TODO: name this"')], expect: [/: title still contains a TODO: placeholder$/] },
  { name: 'TODO: in the body is refused', body: 'Line one.\nTODO: finish\n', expect: [/^_posts\/2026-03-01-schema-case\.md:7: body still contains a TODO: placeholder$/] },
  { name: 'a post filename without a date is refused', path: '_posts/schema-case.md', expect: [/: post filename must be YYYY-MM-DD-<slug>\.md$/] },
  { name: 'a 2026-02-30 filename is refused', path: '_posts/2026-02-30-schema-case.md', expect: [/: filename date 2026-02-30 is not a real calendar date$/] },
  {
    name: 'a filename dated the day after today is refused',
    path: '_posts/2026-06-16-schema-case.md',
    expect: [/: dated 2026-06-16, after today \(UTC 2026-06-15\); future-dated posts are not allowed$/],
  },
  { name: 'the slug Bad_Slug is refused', path: '_posts/2026-03-01-Bad_Slug.md', expect: [/: slug must be lowercase letters, digits and single hyphens \(got "Bad_Slug"\)$/] },
  {
    name: 'a slug with a double hyphen is refused',
    path: '_posts/2026-03-01-bad--slug.md',
    expect: [/: slug must be lowercase letters, digits and single hyphens \(got "bad--slug"\)$/],
  },
  {
    name: 'a slug with a trailing hyphen is refused',
    path: '_posts/2026-03-01-bad-slug-.md',
    expect: [/: slug must be lowercase letters, digits and single hyphens \(got "bad-slug-"\)$/],
  },
  { name: 'a 61-character slug is refused', path: `_posts/2026-03-01-${'a'.repeat(61)}.md`, expect: [/: slug must be at most 60 characters \(got 61\)$/] },
  {
    name: 'the draft _drafts/Bad.md is refused',
    path: '_drafts/Bad.md',
    kind: 'draft',
    expect: [/: slug must be lowercase letters, digits and single hyphens \(got "Bad"\)$/],
  },
  { name: 'a draft that is not Markdown is refused', path: '_drafts/notes.txt', kind: 'draft', expect: [/: draft filename must be <slug>\.md$/] },
]);

/**
 * Front matter `parseArticle` must refuse, each with the error it must
 * report. File line 1 is the opening `---`, so `VALID_FRONT_MATTER` fills
 * lines 2 to 4.
 */
const PARSE_CASES = Object.freeze([
  { name: 'missing front matter', text: 'Just a body.\n', error: /^missing front matter: the file must start with a --- line$/ },
  { name: 'unclosed front matter', text: '---\ntitle: "A valid title"\n\nBody.\n', error: /^unclosed front matter: no closing --- line$/ },
  { name: 'an unquoted title', lines: ['title: Plain words', ...VALID_FRONT_MATTER.slice(1)], error: /^front matter line 2: title must be a double-quoted string$/ },
  {
    name: 'a single-quoted summary',
    lines: [VALID_FRONT_MATTER[0], "summary: 'Single quoted.'", VALID_FRONT_MATTER[2]],
    error: /^front matter line 3: summary: single-quoted strings are not supported; use double quotes$/,
  },
  { name: 'a duplicate key', lines: [...VALID_FRONT_MATTER, 'tags: [other]'], error: /^front matter line 5: duplicate key tags$/ },
  { name: 'an indented line', lines: [...VALID_FRONT_MATTER, '  author: "Jane Doe"'], error: /^front matter line 5: indentation is not supported$/ },
  { name: 'a block list', lines: [...VALID_FRONT_MATTER.slice(0, 2), 'tags:', '- testing'], error: /^front matter line 5: block lists are not supported; use tags: \[a, b\]$/ },
  { name: 'a block scalar', lines: [VALID_FRONT_MATTER[0], 'summary: |', VALID_FRONT_MATTER[2]], error: /^front matter line 3: summary: block scalars \(\| and >\) are not supported$/ },
  { name: 'an anchor', lines: [...VALID_FRONT_MATTER.slice(0, 2), 'tags: &tags [testing]'], error: /^front matter line 4: anchors and aliases \(& and \*\) are not supported$/ },
  { name: 'a YAML tag', lines: [...VALID_FRONT_MATTER, 'updated: !!str 2026-03-01'], error: /^front matter line 5: YAML tags \(!\) are not supported$/ },
  { name: 'a flow mapping', lines: [...VALID_FRONT_MATTER.slice(0, 2), 'tags: {a: 1}'], error: /^front matter line 4: flow mappings \(\{ … \}\) are not supported$/ },
  {
    name: 'a bare null in a flow list',
    lines: [...VALID_FRONT_MATTER.slice(0, 2), 'tags: [testing, null]'],
    error: /^front matter line 4: bare null in a flow list is read by YAML as null, not text; write "null"$/,
  },
  {
    name: 'a bare true in a flow list',
    lines: [...VALID_FRONT_MATTER.slice(0, 2), 'tags: [true]'],
    error: /^front matter line 4: bare true in a flow list is read by YAML as a boolean, not text; write "true"$/,
  },
  {
    name: 'an unclosed quote',
    lines: ['title: "Never closed', ...VALID_FRONT_MATTER.slice(1)],
    error: /^front matter line 2: title: a double-quoted string must close on the same line$/,
  },
]);

test('[AC-04][F-017] parseArticle and validateArticle accept the schema boundaries and refuse each rule break', async (t) => {
  for (const { name, path: rel = SCHEMA_POST, kind = 'post', fields = [], body = 'Body.\n', expect } of SCHEMA_CASES) {
    await t.test(`[AC-04][F-017] schema: ${name}`, () => {
      const text = articleSource(fields.reduce((lines, change) => change(lines), [...VALID_FRONT_MATTER]), body);
      const parsed = parseArticle(text);
      assert.deepEqual(parsed.errors, [], `${name}: the case's front matter must parse:\n${parsed.errors.join('\n')}`);
      const findings = validateArticle({
        path: rel,
        data: parsed.data,
        body: parsed.body,
        kind,
        todayUtc: FIXED_TODAY,
        bodyStartLine: bodyStartLine(text, parsed.body),
      });
      assertFindings(findings, expect, name);
      for (const finding of findings) assert.ok(finding.startsWith(`${rel}:`), `${name}: every finding must start with the path:\n${finding}`);
    });
  }
  for (const { name, text, lines, error } of PARSE_CASES) {
    await t.test(`[AC-04][F-017] front matter: ${name} is refused`, () => {
      const { errors } = parseArticle(text ?? articleSource(lines, 'Body.\n'));
      assertReports(errors, error, name);
    });
  }
});

/** `VALID_FRONT_MATTER` with its line `index` (0 for title, 1 for summary, 2 for tags) replaced by `text`. */
const replaceLine = (index, text) => VALID_FRONT_MATTER.map((line, i) => (i === index ? text : line));

/** A pattern matching exactly the finding `${SCHEMA_POST}: ${message}`. */
const schemaFinding = (message) => new RegExp(`^${regExpLiteral(`${SCHEMA_POST}: ${message}`)}$`);

/**
 * Front matter in which `parseArticle` refuses a title, summary or tags line,
 * or lacks the line, with every finding `check` reports for it: the parse
 * errors, then the `validateArticle` findings. A refused line's error names
 * its key and is the key's only finding, never followed by "is required";
 * a truly missing key is still reported, and a disguised `published` key is
 * still refused.
 */
const REFUSED_KEY_CASES = Object.freeze([
  { name: 'an unquoted title', lines: replaceLine(0, 'title: Unquoted title'), expect: ['front matter line 2: title must be a double-quoted string'] },
  {
    name: 'a single-quoted title',
    lines: replaceLine(0, "title: 'Single quoted'"),
    expect: ['front matter line 2: title: single-quoted strings are not supported; use double quotes'],
  },
  {
    name: 'an unterminated title',
    lines: replaceLine(0, 'title: "Never closed'),
    expect: ['front matter line 2: title: a double-quoted string must close on the same line'],
  },
  {
    name: 'a title with text after its closing quote',
    lines: replaceLine(0, 'title: "Closed" junk'),
    expect: ['front matter line 2: title: only a comment ( # …) may follow the closing quote'],
  },
  {
    name: 'a title with a \\n escape',
    lines: replaceLine(0, 'title: "Line\\nbreak"'),
    expect: ['front matter line 2: title: unsupported escape \\n in a double-quoted string; only \\" and \\\\ are allowed'],
  },
  { name: 'an empty title', lines: replaceLine(0, 'title:'), expect: ['front matter line 2: title has no value'] },
  { name: 'a title holding U+2028', lines: replaceLine(0, 'title: "a\u2028b"'), expect: ['front matter line 2: unsupported syntax'] },
  { name: 'a title with no space after its colon', lines: replaceLine(0, 'title:"No space"'), expect: ['front matter line 2: unsupported syntax'] },
  { name: 'an indented title', lines: replaceLine(0, '  title: "Present title"'), expect: ['front matter line 2: indentation is not supported'] },
  { name: 'a tab-indented title', lines: replaceLine(0, '\ttitle: "Present title"'), expect: ['front matter line 2: indentation is not supported'] },
  { name: 'a title with a space before its colon', lines: replaceLine(0, 'title : "Present title"'), expect: ['front matter line 2: unsupported syntax'] },
  { name: 'Title in capitals with a space before its colon', lines: replaceLine(0, 'Title : "Present"'), expect: ['front matter line 2: unsupported syntax'] },
  { name: 'an indented summary', lines: replaceLine(1, '  summary: "Present summary."'), expect: ['front matter line 3: indentation is not supported'] },
  { name: 'a summary with a tab before its colon', lines: replaceLine(1, 'summary\t: "Present summary."'), expect: ['front matter line 3: unsupported syntax'] },
  { name: 'an indented tags list', lines: replaceLine(2, '  tags: [testing]'), expect: ['front matter line 4: indentation is not supported'] },
  { name: 'Title: in capitals', lines: replaceLine(0, 'Title: "Capital key"'), expect: ['front matter line 2: key Title must be lowercase (title)'] },
  { name: 'an unquoted summary', lines: replaceLine(1, 'summary: Unquoted summary'), expect: ['front matter line 3: summary must be a double-quoted string'] },
  { name: 'SUMMARY: in capitals', lines: replaceLine(1, 'SUMMARY: "Upper case"'), expect: ['front matter line 3: key SUMMARY must be lowercase (summary)'] },
  {
    name: 'a tags list holding a bare null',
    lines: replaceLine(2, 'tags: [testing, null]'),
    expect: ['front matter line 4: bare null in a flow list is read by YAML as null, not text; write "null"'],
  },
  { name: 'Tags: in capitals', lines: replaceLine(2, 'Tags: [testing]'), expect: ['front matter line 4: key Tags must be lowercase (tags)'] },
  {
    name: 'Author: and Updated: in capitals',
    lines: [...VALID_FRONT_MATTER, 'Author: "Jane Doe"', 'Updated: 2026-03-01'],
    expect: ['front matter line 5: key Author must be lowercase (author)', 'front matter line 6: key Updated must be lowercase (updated)'],
  },
  { name: 'a missing title', lines: VALID_FRONT_MATTER.slice(1), expect: ['title is required'] },
  {
    name: 'a refused title beside a missing summary',
    lines: ['title: Unquoted title', VALID_FRONT_MATTER[2]],
    expect: ['front matter line 2: title must be a double-quoted string', 'summary is required'],
  },
  ...['Published: false', 'PUBLISHED: true', '"published": false', 'published : false', '? published', 'published:false'].map((line) => ({
    name: `the disguised published key ${JSON.stringify(line)}`,
    lines: [...VALID_FRONT_MATTER, line],
    expect: ['front matter line 5: unsupported syntax'],
  })),
]);

test('[AC-04][F-017] a front-matter line parseArticle refuses is its key\'s one finding, never also reported as missing', async (t) => {
  for (const { name, lines, expect } of REFUSED_KEY_CASES) {
    await t.test(`[AC-04][F-017] refused key: ${name}`, () => {
      const text = articleSource(lines, 'Body.\n');
      const { data, body, errors } = parseArticle(text);
      const findings = [
        ...errors.map((error) => `${SCHEMA_POST}: ${error}`),
        ...validateArticle({ path: SCHEMA_POST, data, body, kind: 'post', todayUtc: FIXED_TODAY, bodyStartLine: bodyStartLine(text, body) }),
      ];
      assertFindings(findings, expect.map(schemaFinding), name);
    });
  }
  await t.test('[AC-04][F-017] refused key: the record stays outside data, so a copy of data reports the key missing again', () => {
    const text = articleSource(replaceLine(0, 'title: Unquoted title'), 'Body.\n');
    const { data, body } = parseArticle(text);
    assert.deepEqual(Reflect.ownKeys(data), ['summary', 'tags'], 'data holds only the parsed keys');
    const args = { path: SCHEMA_POST, body, kind: 'post', todayUtc: FIXED_TODAY, bodyStartLine: bodyStartLine(text, body) };
    assert.deepEqual(validateArticle({ ...args, data }), []);
    assertFindings(validateArticle({ ...args, data: { ...data } }), [schemaFinding('title is required')], 'a copy of data');
  });
});


/** Bytes of a stand-in image; the rules only check that the file exists. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** The post the image cases validate, dated before `FIXED_TODAY`. */
const IMAGE_POST = '_posts/2026-03-01-img-case.md';

/**
 * Image cases for `validateArticle` with `makeImageExists` over a synthetic
 * root: the image markup (on file line 8), the findings it must produce and,
 * where given, the exact paths the callback must be asked about. Sources the
 * other rules refuse must never reach the callback.
 */
const IMAGE_CASES = Object.freeze([
  {
    name: 'a relative_url image with a . segment, an escape, a query and a fragment is accepted',
    image: "![A figure]({{ '/assets/blog/img-case/./sub/fig%201.png?v=2#x' | relative_url }})",
    expect: [],
    calls: ['/assets/blog/img-case/sub/fig 1.png'],
  },
  { name: 'a root-relative image is accepted', image: '![A figure](/assets/blog/img-case/fig.png)', expect: [], calls: ['/assets/blog/img-case/fig.png'] },
  {
    name: 'a site.baseurl image is accepted',
    image: '![A figure]({{ site.baseurl }}/assets/blog/img-case/fig.png)',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'an <img> tag with alt text is accepted',
    image: '<img src="{{ \'/assets/blog/img-case/fig.png\' | relative_url }}" alt="A figure">',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'a missing file is refused',
    image: "![A figure]({{ '/assets/blog/img-case/missing.png' | relative_url }})",
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image \/assets\/blog\/img-case\/missing\.png does not exist$/],
    calls: ['/assets/blog/img-case/missing.png'],
  },
  {
    name: 'a directory is refused',
    image: "![A figure]({{ '/assets/blog/img-case/folder' | relative_url }})",
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image \/assets\/blog\/img-case\/folder does not exist$/],
    calls: ['/assets/blog/img-case/folder'],
  },
  {
    name: 'an empty alt text is refused',
    image: "![]({{ '/assets/blog/img-case/fig.png' | relative_url }})",
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image has no alt text \(/],
  },
  {
    name: 'a blank alt text is refused',
    image: "![  ]({{ '/assets/blog/img-case/fig.png' | relative_url }})",
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image has no alt text \(/],
  },
  {
    name: 'an https image is refused',
    image: '![A figure](https://example.com/fig.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: external images are not allowed \(https:\/\/example\.com\/fig\.png\)$/],
    calls: [],
  },
  {
    name: 'a protocol-relative image is refused',
    image: '![A figure](//example.com/fig.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: external images are not allowed \(\/\/example\.com\/fig\.png\)$/],
    calls: [],
  },
  {
    name: 'a data: image is refused',
    image: '![A figure](data:image/png;base64,iVBORw0KGgo=)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: data: images are not allowed \(data:image\/png;base64,iVBORw0KGgo=\)$/],
    calls: [],
  },
  {
    name: "another post's image folder is refused",
    image: "![A figure]({{ '/assets/blog/other-slug/fig.png' | relative_url }})",
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image .*\/assets\/blog\/other-slug\/fig\.png.* must be under \/assets\/blog\/img-case\/$/],
    calls: [],
  },
  {
    name: 'a draft image folder in a post is refused',
    image: "![A figure]({{ '/assets/drafts/img-case/fig.png' | relative_url }})",
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image .*\/assets\/drafts\/img-case\/fig\.png.* must be under \/assets\/blog\/img-case\/$/],
    calls: [],
  },
  {
    name: 'a draft showing its own draft image is accepted',
    path: '_drafts/img-case.md',
    kind: 'draft',
    image: "![A figure]({{ '/assets/drafts/img-case/fig.png' | relative_url }})",
    expect: [],
    calls: ['/assets/drafts/img-case/fig.png'],
  },
  {
    name: 'a draft showing a post image folder is refused',
    path: '_drafts/img-case.md',
    kind: 'draft',
    image: "![A figure]({{ '/assets/blog/img-case/fig.png' | relative_url }})",
    expect: [/^_drafts\/img-case\.md:8: image .* must be under \/assets\/drafts\/img-case\/$/],
    calls: [],
  },
  {
    name: 'an escaped space is accepted',
    image: '![A figure](/assets/blog/img-case/sub/fig%201.png)',
    expect: [],
    calls: ['/assets/blog/img-case/sub/fig 1.png'],
  },
  {
    name: 'an encoded .. segment beside a non-UTF-8 escape is refused',
    image: '![A figure](/assets/blog/img-case/%2e%2e/other-slug/fig%ff.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/%2e%2e\/other-slug\/fig%ff\.png has malformed percent-encoding; write % itself as %25$/],
    calls: [],
  },
  {
    name: 'an encoded .. segment beside a malformed escape is refused',
    image: '![A figure](/assets/blog/img-case/%2e%2e/other-slug/fig%zz.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/%2e%2e\/other-slug\/fig%zz\.png has malformed percent-encoding; write % itself as %25$/],
    calls: [],
  },
  {
    name: 'a lone non-UTF-8 escape is refused',
    image: '![A figure](/assets/blog/img-case/fig%ff.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/fig%ff\.png has malformed percent-encoding; write % itself as %25$/],
    calls: [],
  },
  {
    name: 'a .. segment written as character references is refused',
    image: '![A figure](/assets/blog/img-case/&#46;&#46;/other-slug/fig.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/&#46;&#46;\/other-slug\/fig\.png must not contain character references \(&…;\); write the characters themselves$/],
    calls: [],
  },
  {
    name: 'an encoded .. segment written with named references is refused',
    image: '![A figure](/assets/blog/img-case/&percnt;2e&percnt;2e/other-slug/fig.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/&percnt;2e&percnt;2e\/other-slug\/fig\.png must not contain character references/],
    calls: [],
  },
  {
    name: 'a tab between two dots, which the browser drops, is refused',
    image: '![A figure](/assets/blog/img-case/.\t./other-slug/fig.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/\.\t\.\/other-slug\/fig\.png must not contain tabs, line breaks or other control characters$/],
    calls: [],
  },
  {
    name: 'an <img> tab written as a character reference is refused',
    image: '<img src="/assets/blog/img-case/.&#9;./other-slug/fig.png" alt="A figure">',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image path \/assets\/blog\/img-case\/\.\t\.\/other-slug\/fig\.png must not contain tabs, line breaks or other control characters$/],
    calls: [],
  },
  // kramdown attribute lists set the attributes the page renders, so their values are held to the same rules.
  {
    name: 'an attribute list setting an external src is refused',
    image: '![A figure](/assets/blog/img-case/fig.png){: src="https://example.com/pixel.png"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: "an attribute list setting a src in another article's folder is refused",
    image: '![A figure](/assets/blog/img-case/fig.png){: src="/assets/blog/other-slug/fig.png"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: image \/assets\/blog\/other-slug\/fig\.png must be under \/assets\/blog\/img-case\/$/],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'an attribute list setting a missing src in the own folder is refused',
    image: '![A figure](/assets/blog/img-case/fig.png){: src="/assets/blog/img-case/missing.png"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: image \/assets\/blog\/img-case\/missing\.png does not exist$/],
    calls: ['/assets/blog/img-case/fig.png', '/assets/blog/img-case/missing.png'],
  },
  {
    name: 'an attribute list setting an empty alt is refused',
    image: '![A figure](/assets/blog/img-case/fig.png){: alt=""}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: alt text is blank$/],
  },
  {
    name: 'an attribute list setting an alt that a character reference leaves blank is refused',
    image: '![A figure](/assets/blog/img-case/fig.png){: alt="&#32;"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: alt text is blank$/],
  },
  {
    name: 'an attribute list setting srcset is refused',
    image: '![A figure](/assets/blog/img-case/fig.png){: srcset="/assets/blog/img-case/fig.png 2x"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: srcset is not supported; use a single src$/],
  },
  {
    name: 'an ALD that an attribute list names is checked',
    image: '![A figure](/assets/blog/img-case/fig.png){: pix}\n\n{:pix: src="/assets/blog/other-slug/fig.png"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: image \/assets\/blog\/other-slug\/fig\.png must be under \/assets\/blog\/img-case\/$/],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'chained attribute lists are all checked',
    image: '![A figure](/assets/blog/img-case/fig.png){: .wide}{: src="https://example.com/pixel.png"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an attribute list after an <img> tag is checked',
    image: '<img src="/assets/blog/img-case/fig.png" alt="A figure">{: src="https://example.com/pixel.png"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an attribute list after a reference image is checked',
    image: '![A figure][pic]{: src="https://example.com/pixel.png"}\n\n[pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an attribute list on the link definition a reference image uses is checked',
    image: '![A figure][pic]\n\n[pic]: /assets/blog/img-case/fig.png\n{: srcset="/assets/blog/other-slug/fig.png 2x"}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: srcset is not supported; use a single src$/],
  },
  {
    name: 'an attribute list on the line before the link definition a reference image uses is checked',
    image: '![A figure][pic]\n\n{: SRC="/assets/blog/other-slug/fig.png"}\n[pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: image \/assets\/blog\/other-slug\/fig\.png must be under \/assets\/blog\/img-case\/$/],
  },
  {
    name: 'a srcset on the line before the link definition a reference image uses is refused',
    image: '![A figure][pic]\n\n{: srcset="/assets/blog/other-slug/fig.png 2x"}\n[pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: srcset is not supported; use a single src$/],
  },
  {
    name: 'an ALD named on the line before the link definition a reference image uses is checked',
    image: '![A figure][pic]\n\n{:ext: SRC="https://example.com/pixel.png"}\n\n{: ext}\n[pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an attribute list over two lines before the link definition a reference image uses is checked',
    image: '![A figure][pic]\n\n{: SRC="https://example.com/pixel.png"\n}\n[pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'a link definition inside a blockquote, with the attribute list before it, is checked',
    image: '![A figure][pic]\n\n> {: SRC="https://example.com/pixel.png"}\n> [pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'a link definition inside a blockquote is checked',
    image: '![A figure][pic]\n\n> [pic]: https://example.com/pixel.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'a link definition opening a list item is checked',
    image: '![A figure][pic]\n\n- [pic]: https://example.com/pixel.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'a link definition opening a footnote is checked',
    image: '![A figure][pic]\n\n[^1]: [pic]: https://example.com/pixel.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an earlier definition of a label is checked while a later one may be paragraph text kramdown does not read',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n\nSome text\n[pic]: /assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: another link definition of this image's label: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'consecutive definitions of a label are decided by the last, which kramdown renders',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n[pic]: /assets/blog/img-case/fig.png',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'an earlier definition of a label is checked while the later one stands in a raw HTML block, blank lines around it',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n\n<div>\n\n[pic]: /assets/blog/img-case/fig.png\n\n</div>',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: another link definition of this image's label: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an earlier definition of a label is checked while the later one is a setext header',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n\n[pic]: /assets/blog/img-case/fig.png\n---',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: another link definition of this image's label: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an earlier definition of a label is checked while the later one is a table row',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n\n[pic]: /assets/blog/img-case/fig.png |',
    expect: [
      /^_posts\/2026-03-01-img-case\.md:8: image \/assets\/blog\/img-case\/fig\.png \| does not exist$/,
      /^_posts\/2026-03-01-img-case\.md:8: another link definition of this image's label: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/,
    ],
  },
  {
    name: 'an earlier definition of a label is checked while the later one puts its destination on the next line',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n\n[pic]:\n/assets/blog/img-case/fig.png',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: another link definition of this image's label: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/],
  },
  {
    name: 'an earlier definition of a label is checked while kramdown declines the later one for a space before a quote',
    image: '![A figure][pic]\n\n[pic]: https://example.com/pixel.png\n\n[pic]: /assets/blog/img-case/fig.png "a" \'b\'',
    expect: [
      /^_posts\/2026-03-01-img-case\.md:8: image \/assets\/blog\/img-case\/fig\.png "a" does not exist$/,
      /^_posts\/2026-03-01-img-case\.md:8: another link definition of this image's label: external images are not allowed \(https:\/\/example\.com\/pixel\.png\)$/,
    ],
  },
  {
    name: 'an attribute list a blank line separates from the link definition, which kramdown drops, is accepted',
    image: '![A figure][pic]\n\n{: SRC="https://example.com/pixel.png"}\n\n[pic]: /assets/blog/img-case/fig.png',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'a class attribute list before the link definition is accepted',
    image: '![A figure][pic]\n\n{: .wide}\n[pic]: /assets/blog/img-case/fig.png',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'an attribute list with backslash escapes, which move its end, is refused',
    image: '![A figure](/assets/blog/img-case/fig.png){: src="/assets/blog/other-slug/fig.png" \\}',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: attribute list on the image cannot be checked; remove its backslash escapes$/],
  },
  {
    name: 'an <img> repeating its src is refused',
    image: '<img src="/assets/blog/img-case/fig.png" src="https://example.com/pixel.png" alt="A figure">',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: <img> repeats the src attribute; write it once$/],
  },
  {
    name: 'an alt text that a character reference leaves blank is refused',
    image: '![&#32;](/assets/blog/img-case/fig.png)',
    expect: [/^_posts\/2026-03-01-img-case\.md:8: image has no alt text \(/],
  },
  {
    name: 'an attribute list setting a src in the own folder is accepted',
    image: '![A figure](/assets/blog/img-case/fig.png){: src="/assets/blog/img-case/sub/fig%201.png"}',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png', '/assets/blog/img-case/sub/fig 1.png'],
  },
  { name: 'a class attribute list is accepted', image: '![A figure](/assets/blog/img-case/fig.png){: .wide}', expect: [], calls: ['/assets/blog/img-case/fig.png'] },
  { name: 'an id attribute list is accepted', image: '![A figure](/assets/blog/img-case/fig.png){: #fig}', expect: [], calls: ['/assets/blog/img-case/fig.png'] },
  { name: 'a loading attribute list is accepted', image: '![A figure](/assets/blog/img-case/fig.png){: loading="lazy"}', expect: [], calls: ['/assets/blog/img-case/fig.png'] },
  {
    name: 'an attribute list after a space, which kramdown leaves as text, is accepted',
    image: '![A figure](/assets/blog/img-case/fig.png) {: src="https://example.com/pixel.png"}',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
  {
    name: 'an attribute list on the next line, which kramdown gives the paragraph, is accepted',
    image: '![A figure](/assets/blog/img-case/fig.png)\n{: src="https://example.com/pixel.png"}',
    expect: [],
    calls: ['/assets/blog/img-case/fig.png'],
  },
]);

test('[AC-04][F-017] images need alt text and an existing regular file in the article\'s own folder, never external or data:', async (t) => {
  const root = tempFolder('images');
  writeFiles(root, {
    'assets/blog/img-case/fig.png': PNG,
    'assets/blog/img-case/sub/fig 1.png': PNG,
    'assets/blog/other-slug/fig.png': PNG,
    'assets/drafts/img-case/fig.png': PNG,
    // Files named as the raw text of encoded paths, so a check of that text instead of the request would pass.
    'assets/blog/img-case/%2e%2e/other-slug/fig%ff.png': PNG,
    'assets/blog/img-case/%2e%2e/other-slug/fig%zz.png': PNG,
    'assets/blog/img-case/fig%ff.png': PNG,
    'assets/blog/img-case/&#46;&#46;/other-slug/fig.png': PNG,
  });
  mkdirSync(path.join(root, 'assets', 'blog', 'img-case', 'folder'));
  const imageExists = makeImageExists(root);

  for (const { name, path: rel = IMAGE_POST, kind = 'post', image, expect, calls } of IMAGE_CASES) {
    await t.test(`[AC-04][F-017] image: ${name}`, () => {
      const text = articleSource(VALID_FRONT_MATTER, `An article body with a figure.\n\n${image}\n`);
      const { data, body, errors } = parseArticle(text);
      assert.deepEqual(errors, [], `the case's front matter must parse:\n${errors.join('\n')}`);
      const asked = [];
      const recording = (publicPath) => {
        asked.push(publicPath);
        return imageExists(publicPath);
      };
      const findings = validateArticle({ path: rel, data, body, kind, todayUtc: FIXED_TODAY, imageExists: recording, bodyStartLine: bodyStartLine(text, body) });
      assertFindings(findings, expect, name);
      if (calls !== undefined) assert.deepEqual(asked, calls, `${name}: imageExists was asked about ${JSON.stringify(asked)}`);
    });
  }

  await t.test('[AC-04][F-017] image: the callback follows links inside the root and refuses paths that resolve outside it', (st) => {
    assert.equal(imageExists('/assets/blog/img-case/fig.png'), true, 'a regular file must exist');
    assert.equal(imageExists('/assets/blog/img-case/folder'), false, 'a directory is not an image');
    assert.equal(imageExists('/assets/blog/img-case/absent.png'), false, 'a missing file does not exist');
    writeFiles(PARENT, { 'outside-the-root.png': PNG });
    assert.equal(imageExists('/../outside-the-root.png'), false, 'a path outside the root must be refused');
    if (process.platform === 'win32') {
      st.diagnostic('symbolic links not created on win32');
      return;
    }
    symlinkSync('fig.png', path.join(root, 'assets', 'blog', 'img-case', 'linked.png'));
    symlinkSync(path.join(PARENT, 'outside-the-root.png'), path.join(root, 'assets', 'blog', 'img-case', 'escape.png'));
    symlinkSync('absent.png', path.join(root, 'assets', 'blog', 'img-case', 'dangling.png'));
    assert.equal(imageExists('/assets/blog/img-case/linked.png'), true, 'a link to a file inside the root must be followed');
    assert.equal(imageExists('/assets/blog/img-case/escape.png'), false, 'a link resolving outside the root must be refused');
    assert.equal(imageExists('/assets/blog/img-case/dangling.png'), false, 'a dangling link does not exist');
  });
});

/**
 * `scanUnsafeMarkup` cases for what kramdown passes through and a browser
 * runs although the raw source spells no `javascript:` and no tag name of
 * letters, digits and hyphens: character references in inline, angle-bracket
 * and reference-definition URLs, and handlers or `javascript:` values on tags
 * named with `:`, `_`, `.` or non-ASCII letters. `expect` is the exact list
 * of findings; the controls (autolinks, prose, code, ordinary links and
 * elements) must produce none.
 */
const UNSAFE_SOURCE_CASES = Object.freeze([
  {
    name: 'an inline destination with &#106; for the j',
    body: 'Intro.\n\n[open](&#106;avascript:alert(1)) end.\n',
    expect: [{ line: 3, text: '[open](&#106;avascript:alert(1)) end.' }],
  },
  {
    name: 'an inline destination with &#x6A; for the j',
    body: 'Intro.\n\n![A figure](&#x6A;avascript:alert(1))\n',
    expect: [{ line: 3, text: '![A figure](&#x6A;avascript:alert(1))' }],
  },
  {
    name: 'an inline destination with &#58; for the colon',
    body: 'Intro.\n\n[open](javascript&#58;alert(1))\n',
    expect: [{ line: 3, text: '[open](javascript&#58;alert(1))' }],
  },
  {
    name: 'an inline destination with &colon; for the colon',
    body: 'Intro.\n\n[open](javascript&colon;alert(1))\n',
    expect: [{ line: 3, text: '[open](javascript&colon;alert(1))' }],
  },
  {
    name: 'an inline destination with a leading &#32;',
    body: 'Intro.\n\n[open](&#32;javascript:alert(1))\n',
    expect: [{ line: 3, text: '[open](&#32;javascript:alert(1))' }],
  },
  {
    name: 'an angle-bracket destination with &#x09; between the letters',
    body: 'Intro.\n\n[open](<java&#x09;script:alert(1)>)\n',
    expect: [{ line: 3, text: '[open](<java&#x09;script:alert(1)>)' }],
  },
  {
    name: 'an angle-bracket destination after a space, with &#106; for the j',
    body: 'Intro.\n\n[open]( <&#106;avascript:alert(1)>)\n',
    expect: [{ line: 3, text: '[open]( <&#106;avascript:alert(1)>)' }],
  },
  {
    name: 'a reference definition with &#58; for the colon',
    body: 'Intro [id] end.\n\n[id]: javascript&#58;alert(1)\n',
    expect: [{ line: 3, text: '[id]: javascript&#58;alert(1)' }],
  },
  {
    name: 'an angle-bracket reference definition with &colon; for the colon',
    body: 'Intro [id] end.\n\n[id]: <javascript&colon;alert(1)>\n',
    expect: [{ line: 3, text: '[id]: <javascript&colon;alert(1)>' }],
  },
  {
    name: 'a reference definition with a leading &#9; and &#x6A; for the j',
    body: 'Intro [id] end.\n\n[id]:&#9;&#x6A;avascript:alert(1)\n',
    expect: [{ line: 3, text: '[id]:&#9;&#x6A;avascript:alert(1)' }],
  },
  {
    name: 'a handler on a tag named with a colon',
    body: 'Intro.\n\nHover <x:note onmouseover="alert(1)">here</x:note>.\n',
    expect: [{ line: 3, text: 'Hover <x:note onmouseover="alert(1)">here</x:note>.' }],
  },
  {
    name: 'a handler on a tag named with an underscore',
    body: 'Intro.\n\nHover <x_note onmouseover="alert(1)">here</x_note>.\n',
    expect: [{ line: 3, text: 'Hover <x_note onmouseover="alert(1)">here</x_note>.' }],
  },
  {
    name: 'a handler on a tag whose name starts with an underscore',
    body: 'Intro.\n\nClick <_note onclick="a()">here</_note>.\n',
    expect: [{ line: 3, text: 'Click <_note onclick="a()">here</_note>.' }],
  },
  {
    name: 'a handler on a tag named with a dot',
    body: 'Intro.\n\nClick <x.note onclick="a()">here</x.note>.\n',
    expect: [{ line: 3, text: 'Click <x.note onclick="a()">here</x.note>.' }],
  },
  {
    name: 'a handler on a tag named with a non-ASCII letter',
    body: 'Intro.\n\nClick <xé onclick="a()">here</xé>.\n',
    expect: [{ line: 3, text: 'Click <xé onclick="a()">here</xé>.' }],
  },
  {
    name: 'a handler on a tag whose name starts with a non-ASCII letter',
    body: 'Intro.\n\nClick <é onclick="a()">here</é>.\n',
    expect: [{ line: 3, text: 'Click <é onclick="a()">here</é>.' }],
  },
  {
    name: 'a handler on its own line of a tag named with a colon',
    body: 'Intro.\n\n<x:note\n  onclick="a()">here</x:note>\n',
    expect: [{ line: 4, text: 'onclick="a()">here</x:note>' }],
  },
  {
    name: 'a javascript: href on a tag named with a colon',
    body: 'Intro.\n\nOpen <x:a href="javascript:alert(1)">here</x:a>.\n',
    expect: [{ line: 3, text: 'Open <x:a href="javascript:alert(1)">here</x:a>.' }],
  },
  {
    name: 'an encoded javascript: href on a tag named with a dot',
    body: 'Intro.\n\nOpen <x.a href="&#106;avascript:alert(1)">here</x.a>.\n',
    expect: [{ line: 3, text: 'Open <x.a href="&#106;avascript:alert(1)">here</x.a>.' }],
  },
  {
    name: 'a URL-shaped tag name with a handler that opens an HTML block',
    body: 'Intro.\n\n<http:x onclick="alert(1)"></http:x>\n',
    expect: [{ line: 3, text: '<http:x onclick="alert(1)"></http:x>' }],
  },
  {
    name: 'a URL-shaped tag name with a javascript: href inside a raw HTML block',
    body: 'Intro.\n\n<div><mailto:x href="javascript:alert(1)"></mailto:x></div>\n',
    expect: [{ line: 3, text: '<div><mailto:x href="javascript:alert(1)"></mailto:x></div>' }],
  },
  {
    name: 'control: URL and address autolinks holding onclick= are links, not tags',
    body: 'See <https://example.com/?onclick=1>, <https://example.com/a/onclick=1>, <mailto:a@b.example> and <a@b.example>.\n',
    expect: [],
  },
  {
    name: 'control: a URL-shaped tag in running text is an autolink, there and in a table cell or span',
    body: 'Intro <http:x onclick="alert(1)"> end.\n\n| a | <https://e.example/x onclick=1> |\n|---|---|\n| b | c |\n\nSee <span><https://e.example/a onclick=1></span>.\n',
    expect: [],
  },
  {
    name: 'control: a heading about JavaScript',
    body: '## JavaScript: closures explained\n\nA closure keeps its scope.\n',
    expect: [],
  },
  {
    name: 'control: escaped brackets and character references in prose',
    body: 'Write &lt;javascript:x&gt; or &#93;(javascript:x) or &#x5d;: javascript:x as text.\n',
    expect: [],
  },
  {
    name: 'control: the payloads inside inline code',
    body: 'Avoid `[open](&#106;avascript:alert(1))` and `<x:note onclick="a()">`.\n',
    expect: [],
  },
  {
    name: 'control: the payloads inside a fenced block',
    body: 'Avoid these:\n\n```html\n<x:note onclick="a()">here</x:note>\n[open](&#106;avascript:alert(1))\n[id]: javascript&#58;alert(1)\n```\n',
    expect: [],
  },
  {
    name: 'control: ordinary links, images and reference definitions',
    body: 'See [MDN](https://developer.mozilla.org/), [the blog](/blog/), [a ref][id] and ![A figure](/assets/blog/x/fig.png).\n\n[id]: https://example.com/&#63;q=1\n',
    expect: [],
  },
  {
    name: 'control: a custom element named with a colon and no handler',
    body: 'A <x:note title="A &amp; B">note</x:note> and a <x.note class="wide">second</x.note>.\n',
    expect: [],
  },
]);

test('[AC-01][F-017] scanUnsafeMarkup refuses encoded javascript: destinations and handlers on every raw tag name, and leaves autolinks, prose and code alone', async (t) => {
  for (const { name, body, expect } of UNSAFE_SOURCE_CASES) {
    await t.test(`[AC-01][F-017] unsafe source: ${name}`, () => {
      assert.deepEqual(scanUnsafeMarkup(body), expect, `${name}: findings for ${JSON.stringify(body)}`);
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

/** Longest any one adversarial case may take; generous, as the host is shared and loaded. */
const FAST_LIMIT_MS = 5000;
/** Length of the long runs in the adversarial cases; a super-linear reading takes minutes at this size. */
const FAST_N = 200000;
/** Whitespace before a line terminator in a front-matter key line; a cubic reading takes hours at this size. */
const FAST_KEY_N = 50000;

/** The line numbers of scanner findings. */
function findingLines(findings) {
  return findings.map((finding) => finding.line);
}

/** The value of `key` and the errors `parseArticle` gives for the valid front matter with `line` as its `key` line. */
function parsedField(line, key) {
  const frontMatter = [...VALID_FRONT_MATTER.filter((entry) => !entry.startsWith(`${key}:`)), line];
  const { data, errors } = parseArticle(articleSource(frontMatter, 'Body.\n'));
  return { errors, value: data[key] };
}

/**
 * What `validateArticle` makes of the reference image `![Alt][id]` (body
 * line 1, file line 6) whose link definition is `definition`: the public
 * paths it asks the existence callback about, and its errors.
 */
function definitionImageFindings(definition) {
  const text = articleSource(VALID_FRONT_MATTER, `![Alt][id]\n\n${definition}\n`);
  const { data, body } = parseArticle(text);
  const asked = [];
  const errors = validateArticle({
    path: SCHEMA_POST, data, body, kind: 'post', todayUtc: FIXED_TODAY, bodyStartLine: bodyStartLine(text, body),
    imageExists: (publicPath) => {
      asked.push(publicPath);
      return true;
    },
  });
  return { asked, errors };
}

/**
 * Inputs on which a backtracking reading of the article rules, or one that
 * re-reads shared input for each item, costs time quadratic or worse in
 * their length: long fence runs, open or closed, at the top level and in
 * list items; closing-fence-shaped lines that never close each other; key
 * lines whose whitespace ends in a line terminator; long whitespace runs in
 * table rows, plain values, flow lists, raw tags, list items and autolinks;
 * many images sharing a label with many definitions; and many autolinks on
 * one line. Each case states the result the rules give at any size: markup
 * after an unclosed fence is still found, code stays masked, and values
 * parse as they do when short.
 */
const FAST_CASES = Object.freeze([
  {
    name: 'an unclosed fence of tildes leaves the markup after it scanned',
    run: () => findingLines(scanUnsafeMarkup(`${'~'.repeat(FAST_N)}\nordinary text\n<script>alert(1)</script>\n`)),
    expect: [3],
  },
  {
    name: 'an unclosed fence of backticks leaves the markup after it scanned',
    run: () => findingLines(scanUnsafeMarkup(`${'`'.repeat(FAST_N)}\nordinary text\n<script>alert(1)</script>\n`)),
    expect: [3],
  },
  {
    name: 'an unclosed fence mixing tildes and backticks leaves the markup after it scanned',
    run: () => findingLines(scanUnsafeMarkup(`${'~`'.repeat(FAST_N / 2)}\nordinary text\n<script>alert(1)</script>\n`)),
    expect: [3],
  },
  {
    name: 'an unclosed fence in a list item leaves the markup after it scanned',
    run: () => findingLines(scanUnsafeMarkup(`- ${'~'.repeat(FAST_N)}\n  ordinary text\n<script>alert(1)</script>\n`)),
    expect: [3],
  },
  {
    name: 'a fence opener whose info holds two words between long whitespace opens nothing',
    run: () => findingLines(scanUnsafeMarkup(`\`\`\`${' '.repeat(FAST_N)}a b\n<script>alert(1)</script>\n`)),
    expect: [2],
  },
  {
    name: 'a long closed fence still masks its content and nothing after it',
    run: () => findingLines(scanUnsafeMarkup(`${'~'.repeat(FAST_N)}\n<script>hidden()</script>\n${'~'.repeat(FAST_N)}\n<script>shown()</script>\n`)),
    expect: [4],
  },
  {
    name: 'closing-fence-shaped lines that never close each other leave the markup after them scanned',
    run: () => {
      const lines = Array.from({ length: 3000 }, (_, j) => `\`${'~'.repeat(j + 1)}\``);
      return findingLines(scanUnsafeMarkup(`${lines.join('\n')}\n<script>alert(1)</script>\n`));
    },
    expect: [3001],
  },
  {
    name: 'validateArticle reads an image after an unclosed fence',
    run: () => {
      const text = articleSource(VALID_FRONT_MATTER, `${'~'.repeat(FAST_N)}\n![](/assets/blog/schema-case/a.png)\n`);
      const { data, body } = parseArticle(text);
      const findings = validateArticle({ path: SCHEMA_POST, data, body, kind: 'post', todayUtc: FIXED_TODAY, imageExists: () => true, bodyStartLine: bodyStartLine(text, body) });
      return findings.map((finding) => /:7: image has no alt text/.test(finding));
    },
    expect: [true],
  },
  {
    name: 'a key line with whitespace before U+2028 is unsupported syntax',
    run: () => parseArticle(`---\ntitle:${' '.repeat(FAST_KEY_N)}\u2028X\n---\nBody\n`).errors,
    expect: ['front matter line 2: unsupported syntax'],
  },
  {
    name: 'a key line with whitespace before a lone carriage return is unsupported syntax',
    run: () => parseArticle(`---\ntitle:${' '.repeat(FAST_KEY_N)}\rX\n---\nBody\n`).errors,
    expect: ['front matter line 2: unsupported syntax'],
  },
  {
    name: 'a key line with tabs before U+2029 is unsupported syntax',
    run: () => parseArticle(`---\ntitle:${'\t'.repeat(FAST_KEY_N)}\u2029X\n---\nBody\n`).errors,
    expect: ['front matter line 2: unsupported syntax'],
  },
  {
    name: 'a table row with a long whitespace run before text gives no finding',
    run: () => findingLines(scanUnsafeMarkup(`\`a\` |${' '.repeat(FAST_N)}X\n`)),
    expect: [],
  },
  {
    name: 'a code span in a table row with a long whitespace run stays masked',
    run: () => findingLines(scanUnsafeMarkup(`\`<script>\` |${' '.repeat(FAST_N)}X\n`)),
    expect: [],
  },
  {
    name: 'a table cell holding a long interior run of Ruby whitespace keeps its code span masked',
    run: () => findingLines(scanUnsafeMarkup(`| \`<b>\` x${' \v'.repeat(FAST_N / 2)}X |\n`)),
    expect: [],
  },
  {
    name: 'a plain updated value keeps an interior whitespace run',
    run: () => parsedField(`updated: x${' '.repeat(FAST_N)}X`, 'updated'),
    expect: { errors: [], value: `x${' '.repeat(FAST_N)}X` },
  },
  {
    name: 'a plain updated value loses a comment after a long whitespace run',
    run: () => parsedField(`updated: 2026-01-01${' \t'.repeat(FAST_N / 2)}# note${' '.repeat(FAST_N)}`, 'updated'),
    expect: { errors: [], value: '2026-01-01' },
  },
  {
    name: 'a bare flow-list item keeps its interior whitespace and loses its trailing tabs',
    run: () => parsedField(`tags: [a${' '.repeat(FAST_N)}b${'\t'.repeat(FAST_N)}, c]`, 'tags'),
    expect: { errors: [], value: [`a${' '.repeat(FAST_N)}b`, 'c'] },
  },
  {
    name: 'a raw tag with long whitespace between its attributes is still checked',
    run: () => findingLines(scanUnsafeMarkup(`<a${' '.repeat(FAST_N)}href=x\n${' '.repeat(FAST_N)}onclick=alert(1)>\n`)),
    expect: [2],
  },
  {
    name: 'an unfinished block tag followed by long whitespace gives no finding',
    run: () => findingLines(scanUnsafeMarkup(`<div${' '.repeat(FAST_N)}\n${' '.repeat(FAST_N)}X\n`)),
    expect: [],
  },
  {
    name: 'a list item whose first line is a long whitespace run gives no finding',
    run: () => findingLines(scanUnsafeMarkup(`-${' '.repeat(FAST_N)}X\n`)),
    expect: [],
  },
  {
    name: 'a list item indented by alternating spaces and tabs is still scanned',
    run: () => findingLines(scanUnsafeMarkup(`- ${' \t'.repeat(FAST_N / 2)}<script>alert(1)</script>\n`)),
    expect: [1],
  },
  {
    name: 'a near rule with long whitespace between its markers gives no finding',
    run: () => findingLines(scanUnsafeMarkup(`*${' '.repeat(FAST_N)}*${' '.repeat(FAST_N)}X\n`)),
    expect: [],
  },
  {
    name: 'a link definition with long whitespace around an unclosed title gives its image the whole line as source',
    run: () => {
      const { asked, errors } = definitionImageFindings(`[id]: x${' '.repeat(FAST_N)}"t${' '.repeat(FAST_N)}`);
      return { asked, errors: errors.map((error) => /:6: page-relative image path x {76}\.\.\. is not allowed/.test(error)) };
    },
    expect: { asked: [], errors: [true] },
  },
  {
    name: 'a link definition with a long run of quoted words and no closing title gives its image the whole line as source',
    run: () => definitionImageFindings(`[id]: /assets/blog/schema-case/a.png${' "y'.repeat(FAST_N / 3)} z`),
    expect: { asked: [`/assets/blog/schema-case/a.png${' "y'.repeat(FAST_N / 3)} z`], errors: [] },
  },
  {
    name: 'a line of unclosed autolinks keeps its code span masked and the markup after it scanned',
    // Each unclosed autolink is read only to the end of its line, so this case repeats the opener, not a character, FAST_N times.
    run: () => findingLines(scanUnsafeMarkup(`\`<script>\` ${'<http:'.repeat(FAST_N)}\n<b onclick=x>\n`)),
    expect: [2],
  },
  {
    name: 'many images of a label with many definitions, each of which kramdown may render, check its source once',
    run: () => definitionImageFindings(`${'![Alt][id] '.repeat(FAST_N / 4)}\n\n${'Text\n[id]: /assets/blog/schema-case/a.png\n'.repeat(FAST_N / 20)}`),
    expect: { asked: ['/assets/blog/schema-case/a.png'], errors: [] },
  },
  {
    name: 'a line of many autolinks gives no finding and leaves the markup after it scanned',
    run: () => findingLines(scanUnsafeMarkup(`See ${'<https://e.example/a> '.repeat(FAST_N / 5)}\n<b onclick=x>\n`)),
    expect: [2],
  },
]);

test('[AC-04][F-017] the article rules stay fast on adversarial fences, front-matter lines, table rows and whitespace runs', { timeout: 600000 }, async (t) => {
  for (const { name, run, expect } of FAST_CASES) {
    await t.test(`[AC-04][F-017] fast: ${name}`, { timeout: 60000 }, () => {
      const started = performance.now();
      const result = run();
      const elapsed = performance.now() - started;
      assert.deepEqual(result, expect, `${name}: unexpected result`);
      assert.ok(elapsed < FAST_LIMIT_MS, `${name}: took ${Math.round(elapsed)} ms, over the ${FAST_LIMIT_MS} ms bound`);
    });
  }
});
