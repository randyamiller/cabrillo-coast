/* Cabrillo Coast LLC — tests for the article publishing tool (node:test, Node built-ins only) */
/**
 * AC-03 (F-017): `scripts/article.mjs` new, check, publish, unpublish and
 * guard, each run as a child process exactly as an author or a git hook runs
 * it.
 *
 * new, check, publish and unpublish run in temporary roots holding a copy of
 * `_templates/article.md`, addressed with `--root`. guard runs in temporary
 * git repositories, and --pre-push pushes to a local bare repository. All of
 * it is written below one folder in `os.tmpdir()`, removed after the run,
 * including a run stopped by a signal (`PARENT_REMOVER`).
 *
 * Every git call and every tool run is isolated from the developer's git
 * configuration, hooks and template, and from the variables a running git
 * hook exports, so none can influence a case or redirect it to this
 * repository; setup commits and pushes also use `--no-verify`. Failures part
 * way through are injected into `node:fs` calls rather than caused by file
 * permissions, which do not stop the root user the suite may run as.
 *
 * Run: node --test tests/unit/article-cli.test.mjs (Node 22 or later, git 2.32
 * or later for GIT_CONFIG_GLOBAL; HOME and XDG_CONFIG_HOME are redirected as
 * well, so older git versions read no personal configuration either).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

/* Paths and isolation                                                       */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTICLE_MJS = path.join(ROOT, 'scripts/article.mjs');
const TEMPLATE = path.join(ROOT, '_templates/article.md');

/**
 * The parent of every case folder. Its real path is used so that
 * `GIT_CEILING_DIRECTORIES`, which git compares against resolved paths,
 * matches even where `os.tmpdir()` is a symbolic link (macOS `/var`).
 */
const PARENT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'article-cli-')));
const removeParent = () => fs.rmSync(PARENT, { recursive: true, force: true });
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
 * tool run this process started was still writing to it, and exits. The
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

const GIT_CONFIG_FILE = path.join(PARENT, 'gitconfig');
fs.writeFileSync(GIT_CONFIG_FILE, '');
const FAKE_HOME = path.join(PARENT, 'home');
fs.mkdirSync(FAKE_HOME);

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
 * An empty folder that `git init` and `git clone` copy into every new
 * repository in place of a template, so none receives hooks, configuration
 * or an `info/exclude` from the template of the environment running the
 * tests. `GIT_TEMPLATE_DIR` outranks `init.templateDir`, and only an explicit
 * `--template` outranks it; no call here passes one.
 */
const EMPTY_TEMPLATE_DIR = path.join(PARENT, 'git-template');
fs.mkdirSync(EMPTY_TEMPLATE_DIR);

/**
 * The environment for git and the tool, derived from `base`: the variables in
 * `GIT_REDIRECT_VARS` and every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`
 * pair removed; the system configuration off and an empty file as the global
 * one; HOME and XDG_CONFIG_HOME redirected; `EMPTY_TEMPLATE_DIR` as the
 * template; a fixed identity, no terminal prompts, and `PARENT` as the
 * ceiling, so a temporary root that is not a repository never discovers an
 * enclosing one. A function of `base` so a case can show what it does to a
 * hostile environment.
 *
 * @param {NodeJS.ProcessEnv} base The environment to isolate.
 * @returns {NodeJS.ProcessEnv} A new object; `base` is not changed.
 */
function isolatedEnv(base) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (GIT_REDIRECT_VARS.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete env[name];
  }
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_CONFIG_FILE,
    HOME: FAKE_HOME,
    XDG_CONFIG_HOME: FAKE_HOME,
    GIT_TEMPLATE_DIR: EMPTY_TEMPLATE_DIR,
    GIT_AUTHOR_NAME: 'Article Test',
    GIT_COMMITTER_NAME: 'Article Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: PARENT,
  });
}

const ENV = isolatedEnv(process.env);

const GIT_CASE = { timeout: 60000 };

/** Bytes of a stand-in image; the tool only checks that the file exists and moves it. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/* Process helpers                                                           */

/**
 * Describes what happened to a child process, for a failure message: the
 * command line, the working directory, the exit status, the signal that
 * ended it, the error that kept it from starting or finishing (a spawn
 * failure, or `ETIMEDOUT` when its time limit ran out) and everything it
 * wrote to stdout and stderr, which is kept even when there is an error.
 *
 * @param {string} command The program that was spawned.
 * @param {string[]} args Its arguments.
 * @param {string | undefined} cwd Its working directory; undefined for this process's own.
 * @param {{ status: number | null, signal: string | null, error?: { code?: string, message: string } | null,
 *   stdout?: string | null, stderr?: string | null }} result What `spawnSync` returned, or the same
 *   fields recorded by a process that ran the child.
 * @returns {string}
 */
function describeSpawn(command, args, cwd, result) {
  const error = result.error ? `${result.error.code ?? 'no code'}: ${result.error.message}` : 'none';
  return [
    `command: ${JSON.stringify([command, ...args])}`,
    `cwd: ${cwd ?? process.cwd()}`,
    `status: ${result.status}, signal: ${result.signal}, error: ${error}`,
    `stdout:\n${result.stdout ?? ''}`,
    `stderr:\n${result.stderr ?? ''}`,
  ].join('\n');
}

/**
 * Runs a setup or probe child to completion (UTF-8 output, a 30-second limit
 * unless `options` says otherwise) and returns its result, failing with
 * `describeSpawn` unless it started, exited by itself with status 0 and was
 * ended by no signal, so its output is never used when it did not succeed.
 *
 * @param {string} command The program to spawn.
 * @param {string[]} args Its arguments.
 * @param {import('node:child_process').SpawnSyncOptions} [options] Passed to `spawnSync`.
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function spawnOk(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.signal !== null || result.status !== 0) {
    assert.fail(`a setup or probe command did not succeed\n${describeSpawn(command, args, options.cwd, result)}`);
  }
  return result;
}

/**
 * Runs `node [nodeArgs…] scripts/article.mjs <args>` with `ENV` plus `env`
 * (a case that puts a stand-in git on PATH passes that PATH in `env`).
 * Standard input is always given (empty by default) so `guard` never waits
 * on an open terminal. A tool that cannot be started or outlives its time
 * limit fails the case with `describeSpawn`; any exit status, refusals
 * included, is returned for the case to assert.
 *
 * @returns {{ status: number | null, signal: string | null, stdout: string, stderr: string, out: string }}
 */
function run(args, { cwd, input = '', nodeArgs = [], env = {} } = {}) {
  const argv = [...nodeArgs, ARTICLE_MJS, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd,
    input,
    env: { ...ENV, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error) {
    assert.fail(`the tool could not run to completion\n${describeSpawn(process.execPath, argv, cwd, result)}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    out: result.stdout + result.stderr,
  };
}

/** Runs a tool command in a temporary root: `--root <root>`, with the root as the working directory. */
function cli(root, ...args) {
  return run([...args, '--root', root], { cwd: root });
}

/** Asserts the exit code, showing the signal and the tool's output when it differs. */
function expectExit(result, code) {
  assert.equal(result.status, code,
    `expected exit code ${code}, got ${result.status} (signal ${result.signal}); output:\n${result.out}`);
}

/** Runs git with `ENV`; fails with `describeSpawn` unless git succeeds, and returns the trimmed stdout. */
function git(cwd, ...args) {
  return spawnOk('git', args, { cwd, env: ENV }).stdout.trim();
}

/** A setup commit; hooks never run for it. */
function commit(repo, message) {
  git(repo, 'commit', '-q', '--no-verify', '-m', message);
}

/** The index mode (`100644`, `100755`, …) of a staged path. */
function indexMode(repo, rel) {
  return git(repo, 'ls-files', '-s', '--', rel).split(' ')[0];
}

/* Fault injection                                                           */

/**
 * A `node --import` preload that makes chosen `node:fs` calls of the tool
 * misbehave, configured by the `ARTICLE_FAULTS` variable: a JSON list of
 * rules `{ fn, path, action, code, file, text }`. Each rule applies once, to
 * the first call of `fs[fn]` whose path contains `path`; for a call on a
 * file descriptor (`writeSync`), the path the descriptor was opened with.
 *   - `throw`: fail with error code `code` and do nothing;
 *   - `short-write`: (`writeSync`) write half the bytes, then fail with `code`;
 *   - `append-to-file`: append `text` to `file`, then make the call: an
 *     editor saving while the tool runs;
 *   - `run-tool`: run `node <argv…>` (with this preload, no rules and the
 *     extra variables `env`) to completion in `cwd`, write its
 *     `{ status, signal, error, stdout, stderr }` (`error` as
 *     `{ code, message }`, or null) to `out` as JSON, then make the call: a
 *     competing run of the tool at that exact moment.
 * `ARTICLE_FAKE_NOW` (an ISO time) fixes the clock, as for a run on the other
 * side of UTC midnight. The tool calls `fs.<fn>` on the module's default
 * export at call time, so the replaced functions are the ones it uses. The
 * preload is written here at run time rather than committed, so nothing
 * outside this suite can load it.
 */
const FAULT_PRELOAD = path.join(PARENT, 'fault-preload.mjs');
fs.writeFileSync(FAULT_PRELOAD, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

if (process.env.ARTICLE_FAKE_NOW) {
  const RealDate = Date;
  const now = new RealDate(process.env.ARTICLE_FAKE_NOW).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length > 0 ? args : [now])); }
    static now() { return now; }
  };
}
const runTool = (rule) => {
  const child = spawnSync(process.execPath, ['--import', import.meta.url, ...rule.argv], {
    cwd: rule.cwd,
    env: { ...process.env, ARTICLE_FAULTS: '[]', ...rule.env },
    encoding: 'utf8',
    timeout: 30000,
  });
  fs.writeFileSync(rule.out, JSON.stringify({
    status: child.status,
    signal: child.signal,
    error: child.error ? { code: child.error.code ?? null, message: child.error.message } : null,
    stdout: child.stdout,
    stderr: child.stderr,
  }));
};
const rules = JSON.parse(process.env.ARTICLE_FAULTS || '[]').map((rule) => ({ ...rule, used: false }));
const names = new Set(['openSync', 'closeSync', 'writeSync', ...rules.map((rule) => rule.fn)]);
const original = Object.fromEntries([...names].map((name) => [name, fs[name]]));
const fdPaths = new Map();
const pathOf = (target) => (typeof target === 'number' ? fdPaths.get(target) || '' : String(target));
const fault = (rule, name, target) => Object.assign(
  new Error(rule.code + ': injected fault, ' + name + " '" + pathOf(target) + "'"),
  { code: rule.code, syscall: name, path: pathOf(target) },
);
for (const name of names) {
  fs[name] = function injected(target, ...rest) {
    const rule = rules.find((r) => !r.used && r.fn === name && pathOf(target).includes(r.path));
    if (rule) rule.used = true;
    if (rule && rule.action === 'throw') throw fault(rule, name, target);
    if (rule && rule.action === 'short-write') {
      const [data, offset = 0, length = data.length - offset] = rest;
      original.writeSync.call(fs, target, data, offset, Math.floor(length / 2));
      throw fault(rule, name, target);
    }
    if (rule && rule.action === 'append-to-file') fs.appendFileSync(rule.file, rule.text);
    if (rule && rule.action === 'run-tool') runTool(rule);
    const result = original[name].call(fs, target, ...rest);
    if (name === 'openSync') fdPaths.set(result, pathOf(target));
    if (name === 'closeSync') fdPaths.delete(target);
    return result;
  };
}
`);
const FAULT_PRELOAD_URL = pathToFileURL(FAULT_PRELOAD).href;

/**
 * Runs a tool command in a temporary root as `cli` does, with the fault-injection
 * preload and the rules `faults` active.
 */
function cliWithFaults(root, faults, ...args) {
  return cliWith(root, { faults }, ...args);
}

/**
 * Runs a tool command in a temporary root as `cli` does, with the extra
 * variables `env`, such as the `TZ` of `offUtcZone()`, and, when `faults` is
 * given, the fault-injection preload with those rules active. A `run-tool`
 * run started by a rule inherits `env` too.
 */
function cliWith(root, { env = {}, faults } = {}, ...args) {
  return run([...args, '--root', root], {
    cwd: root,
    nodeArgs: faults === undefined ? [] : ['--import', FAULT_PRELOAD_URL],
    env: faults === undefined ? env : { ...env, ARTICLE_FAULTS: JSON.stringify(faults) },
  });
}

/* Dates, text and files                                                     */

/** Today's date in UTC as `YYYY-MM-DD`, the clock the tool dates posts by. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** The UTC date `days` days from now (negative for the past) as `YYYY-MM-DD`. */
function addDaysUtc(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** The calendar date in the time zone `timeZone` at the instant `when`, as `YYYY-MM-DD`. */
function dateIn(timeZone, when) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(when).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The variables for a tool run whose outcome depends on today's date: a `TZ`
 * whose local calendar date is not the UTC date, so a tool that dated by its
 * local clock instead of UTC fails the case on every host, a UTC CI runner
 * included. UTC-12 (`Etc/GMT+12`) is on the previous day until 12:00 UTC and
 * UTC+14 (`Etc/GMT-14`) on the next from 10:00 UTC; switching at 11:00 UTC
 * leaves the run an hour either way. Fails unless the zone's date differs
 * from the UTC date (an unknown zone throws), so a case cannot lose that
 * sensitivity unnoticed. Only crossing UTC midnight, which each case
 * already tolerates, can bring the two dates together during a run.
 *
 * @returns {{ TZ: string }}
 */
function offUtcZone() {
  const now = new Date();
  const TZ = now.getUTCHours() < 11 ? 'Etc/GMT+12' : 'Etc/GMT-14';
  const utc = now.toISOString().slice(0, 10);
  assert.notEqual(dateIn(TZ, now), utc, `the local date in ${TZ} must differ from the UTC date ${utc}`);
  return { TZ };
}

const PAST = addDaysUtc(-30);

/** Escapes text for use inside a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A double-quoted front-matter value, escaping the two characters the schema's parser reads as escapes. */
function quoted(value) {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * An article source: quoted `title` and `summary`, a flow list of `tags`, an
 * optional `updated` date and any `extra` front-matter lines, then the body.
 * The defaults (kebab-case tags, a non-empty body, no `updated` or `extra`)
 * pass every schema rule as a draft and as a post; a caller's `title`,
 * `summary`, `tags`, `body`, `updated` or `extra` may deliberately build an
 * article the schema rejects.
 */
function validArticle({
  title = 'A valid article',
  summary = 'A short, valid summary.',
  tags = ['testing', 'node'],
  body = 'Plain body text for the article.',
  updated,
  extra = '',
} = {}) {
  const lines = ['---', `title: ${quoted(title)}`, `summary: ${quoted(summary)}`, `tags: [${tags.join(', ')}]`];
  if (updated !== undefined) lines.push(`updated: ${updated}`);
  if (extra !== '') lines.push(...extra.split('\n'));
  lines.push('---', '', body, '');
  return lines.join('\n');
}

/** Absolute path of a POSIX path relative to a case folder. */
function abs(root, rel) {
  return path.join(root, ...rel.split('/'));
}

/** Writes a file (text or bytes), creating its parent folders. */
function write(root, rel, content) {
  const target = abs(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function exists(root, rel) {
  return fs.existsSync(abs(root, rel));
}

function read(root, rel) {
  return fs.readFileSync(abs(root, rel), 'utf8');
}

/** Names of the entries of a folder, or `[]` when it does not exist. */
function list(root, rel) {
  return exists(root, rel) ? fs.readdirSync(abs(root, rel)).sort() : [];
}

/* Case folders                                                              */

let caseCount = 0;

/** A new, empty folder for one case, inside `PARENT`. */
function caseDir(label) {
  caseCount += 1;
  const dir = path.join(PARENT, `${String(caseCount).padStart(3, '0')}-${label}`);
  fs.mkdirSync(dir);
  return dir;
}

/** The `_config.yml` of a temporary site root: the tool refuses a root without one. */
const SITE_CONFIG = '# A temporary site root for tests/unit/article-cli.test.mjs\n';

/** A temporary site root (not a git repository) holding `_config.yml` and a copy of the repository's article template. */
function makeRoot() {
  const root = caseDir('root');
  write(root, '_config.yml', SITE_CONFIG);
  write(root, '_templates/article.md', fs.readFileSync(TEMPLATE));
  return root;
}

/**
 * A temporary repository on branch `main` with one commit: a `.gitignore`
 * that ignores `_drafts/` and `assets/drafts/`, as the real one does. File
 * modes are tracked so the hook-mode rule is exercised.
 */
function makeRepo() {
  const repo = caseDir('repo');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.fileMode', 'true');
  write(repo, '.gitignore', '_drafts/\nassets/drafts/\n');
  git(repo, 'add', '.gitignore');
  commit(repo, 'init');
  return repo;
}

/**
 * `makeRepo()` plus a local bare `origin` that `main` has been pushed to,
 * which also creates `refs/remotes/origin/main`. `prepare(repo)` runs before
 * the push, for content the remote must already hold.
 *
 * @returns {{ repo: string, remote: string }}
 */
function makeRemoteRepo(prepare) {
  const repo = makeRepo();
  if (prepare) prepare(repo);
  const remote = caseDir('remote.git');
  git(remote, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
  return { repo, remote };
}

/** Runs `guard --staged` in a repository, as `.githooks/pre-commit` does. */
function guardStaged(repo) {
  return run(['guard', '--staged'], { cwd: repo });
}

/**
 * Runs `guard --pre-push` in a repository with the ref line git passes the
 * pre-push hook for pushing `HEAD` as `localRef` over `remoteSha`.
 */
function prePush(repo, localRef, remoteRef, remoteSha) {
  const localSha = git(repo, 'rev-parse', 'HEAD');
  return run(['guard', '--pre-push'], { cwd: repo, input: `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n` });
}

/**
 * Runs `guard --pre-push` as `.githooks/pre-push` runs it: `hookArgs`, the
 * `<remote> <url>` git passes the hook (or nothing), after `--`, and one ref
 * line per `[localRef, localSha, remoteRef, remoteSha]` of `refLines` on
 * standard input. Asserts that guard left the repository and every bare
 * repository in `remotes` exactly as it found them.
 */
function prePushHook(repo, remotes, hookArgs, refLines) {
  const input = refLines.map((fields) => `${fields.join(' ')}\n`).join('');
  return unchangedBy(
    () => ({ repo: repoSnapshot(repo), remotes: remotes.map((remote) => remoteSnapshot(remote)) }),
    () => run(['guard', '--pre-push', '--', ...hookArgs], { cwd: repo, input }),
    'the repository and its remotes',
  );
}

/* State snapshots                                                           */

/**
 * Every entry below `dir`, keyed by its POSIX path relative to `dir`: the
 * mode of a folder, the mode and target of a symbolic link, and the mode and
 * bytes of a file. A `.git` entry directly in `dir` is left out; `repoSnapshot`
 * records a repository's git state itself.
 *
 * @returns {Record<string, { mode: number, bytes?: Buffer, link?: string }>}
 */
function treeSnapshot(dir) {
  const entries = {};
  const walk = (rel) => {
    for (const name of fs.readdirSync(rel === '' ? dir : abs(dir, rel)).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (childRel === '.git') continue;
      const target = abs(dir, childRel);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        entries[childRel] = { mode: stat.mode };
        walk(childRel);
      } else if (stat.isSymbolicLink()) {
        entries[childRel] = { mode: stat.mode, link: fs.readlinkSync(target) };
      } else {
        entries[childRel] = { mode: stat.mode, bytes: fs.readFileSync(target) };
      }
    }
  };
  walk('');
  return entries;
}

/** Runs a read-only git query that must succeed with `GIT_OPTIONAL_LOCKS=0`, so it never refreshes the index. */
function gitQuiet(cwd, ...args) {
  return spawnOk('git', args, { cwd, env: { ...ENV, GIT_OPTIONAL_LOCKS: '0' } }).stdout;
}

/**
 * The state of a temporary repository (one with a commit, as `makeRepo`
 * makes) that a read-only command must leave as it found it: the bytes of
 * `.git/index`, read before any git command runs; every working-tree entry
 * from `treeSnapshot`, git-ignored ones such as `_drafts/` included; every
 * ref with its object, HEAD's symbolic ref and commit; and the porcelain
 * status, untracked and ignored files included. Its git commands use
 * `gitQuiet`, so taking a snapshot changes nothing either.
 */
function repoSnapshot(repo) {
  const indexFile = abs(repo, '.git/index');
  const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile) : null;
  return {
    index,
    worktree: treeSnapshot(repo),
    refs: gitQuiet(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: [gitQuiet(repo, 'rev-parse', '--symbolic-full-name', 'HEAD'), gitQuiet(repo, 'rev-parse', 'HEAD')],
    status: gitQuiet(repo, 'status', '--porcelain', '--untracked-files=all', '--ignored'),
  };
}

/** The refs of a bare remote and the text of its HEAD, which a refused push must leave as they were. */
function remoteSnapshot(remote) {
  return {
    refs: gitQuiet(remote, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: fs.readFileSync(path.join(remote, 'HEAD'), 'utf8'),
  };
}

/**
 * Runs `action` between two calls of `snapshot` and asserts that both
 * returned the same: the command left `what` exactly as it found it.
 *
 * @template T
 * @param {() => unknown} snapshot Records the state to keep.
 * @param {() => T} action Runs the command.
 * @param {string} what The state, as the failure message names it.
 * @returns {T} What `action` returned.
 */
function unchangedBy(snapshot, action, what) {
  const before = snapshot();
  const result = action();
  assert.deepEqual(snapshot(), before, `${what} must be exactly as before the command`);
  return result;
}

/** `cli(root, 'check', …files)`, asserting that check, read-only on every outcome, changed nothing in the root. */
function checkRoot(root, ...files) {
  return unchangedBy(() => treeSnapshot(root), () => cli(root, 'check', ...files), `the root ${root}`);
}

/** `guardStaged(repo)`, asserting that guard left the repository exactly as it found it. */
function guardStagedUnchanged(repo) {
  return unchangedBy(() => repoSnapshot(repo), () => guardStaged(repo), 'the repository');
}

/** `prePush(repo, …)`, asserting that guard left the repository and its remote exactly as it found them. */
function prePushUnchanged({ repo, remote }, localRef, remoteRef, remoteSha) {
  return unchangedBy(
    () => ({ repo: repoSnapshot(repo), remote: remoteSnapshot(remote) }),
    () => prePush(repo, localRef, remoteRef, remoteSha),
    'the repository and its remote',
  );
}

/* Temporary repository isolation                                            */

/** Hooks of the hostile template: client hooks `--no-verify` does not skip, and the hooks a push runs on the remote. */
const HOSTILE_HOOKS = [
  'post-checkout', 'post-commit', 'post-receive', 'pre-commit',
  'pre-push', 'pre-receive', 'reference-transaction', 'update',
];

/** Configuration keys the hostile template sets, as `git config --name-only` prints them. */
const HOSTILE_KEYS = ['commit.gpgsign', 'core.hookspath', 'user.name'];

/**
 * Writes a hostile git template into a new case folder. Each hook in
 * `HOSTILE_HOOKS` appends its name to a log and then fails, except
 * `reference-transaction`, which succeeds so that a repository can still be
 * created and the later hooks get their turn on git versions that run it
 * while `init` writes HEAD (older ones do not). Its `config` turns on commit
 * signing, points `core.hooksPath` at those hooks and sets an identity.
 *
 * @returns {{ dir: string, template: string, ran: () => string[] }} The case
 *   folder, the template folder, and the names of the hooks run so far.
 */
function hostileTemplate() {
  const dir = caseDir('hostile-template');
  const template = path.join(dir, 'template');
  const hooks = path.join(template, 'hooks');
  const log = path.join(dir, 'hooks-ran.log');
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of HOSTILE_HOOKS) {
    fs.writeFileSync(path.join(hooks, name), [
      '#!/bin/sh',
      `printf '%s\\n' ${shQuote(name)} >> ${shQuote(log)}`,
      `exit ${name === 'reference-transaction' ? 0 : 1}`,
      '',
    ].join('\n'), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(template, 'config'),
    `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${quoted(hooks)}\n[user]\n\tname = Hostile Template\n`);
  return {
    dir,
    template,
    ran: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []),
  };
}

/** The keys set in a repository's own configuration file (`.git/config`, or `config` of a bare repository). */
function localConfigKeys(repo) {
  return git(repo, 'config', '--local', '--list', '--name-only').split('\n');
}

/** Asserts that a repository's git folder holds no hooks and its configuration none of `HOSTILE_KEYS`. */
function assertNoTemplateImports(gitDir, label) {
  assert.deepEqual(list(gitDir, 'hooks'), [], `${label}: no hooks`);
  const keys = localConfigKeys(gitDir);
  for (const key of HOSTILE_KEYS) assert.equal(keys.includes(key), false, `${label}: no ${key}:\n${keys.join('\n')}`);
}

test('[AC-03][F-017] temporary repositories take no hooks or configuration from an inherited git template', GIT_CASE, async (t) => {
  await t.test('[AC-03][F-017] without the override, an inherited template is imported by init and run by clone and push', GIT_CASE, () => {
    const hostile = hostileTemplate();
    // Negative control: explicitly inherit the hostile template to prove isolation is necessary.
    const leaky = { ...ENV, GIT_TEMPLATE_DIR: hostile.template };
    /** Runs git with the leaky environment; returns its result and description, as the hostile hooks may fail it. */
    const leakyGit = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, env: leaky, encoding: 'utf8', timeout: 30000 });
      return { result, description: describeSpawn('git', args, cwd, result) };
    };

    const repo = path.join(hostile.dir, 'repo');
    const init = leakyGit(hostile.dir, 'init', '-q', '-b', 'main', repo);
    assert.equal(init.result.status, 0, init.description);
    assert.deepEqual(list(repo, '.git/hooks'), [...HOSTILE_HOOKS].sort(), 'init copies the template hooks');
    const keys = localConfigKeys(repo);
    for (const key of HOSTILE_KEYS) assert.ok(keys.includes(key), `init copies ${key}:\n${keys.join('\n')}`);

    const remote = path.join(hostile.dir, 'remote.git');
    const bare = leakyGit(hostile.dir, 'init', '-q', '--bare', remote);
    assert.equal(bare.result.status, 0, bare.description);
    assert.deepEqual(list(remote, 'hooks'), [...HOSTILE_HOOKS].sort(), 'a bare init copies them too');

    const source = makeRepo();
    leakyGit(hostile.dir, 'clone', '-q', source, path.join(hostile.dir, 'clone'));
    assert.ok(hostile.ran().includes('post-checkout'), `clone runs the template's post-checkout: ${hostile.ran()}`);

    const push = leakyGit(source, 'push', '-q', '--no-verify', remote, 'main');
    assert.notEqual(push.result.status, 0, `the remote's pre-receive refuses the push:\n${push.description}`);
    assert.ok(hostile.ran().includes('pre-receive'),
      `--no-verify does not skip the remote's pre-receive: ${hostile.ran()}`);
  });

  await t.test('[AC-03][F-017] isolatedEnv swaps an inherited template for the empty one, so init, commit, clone, checkout and push import and run nothing', GIT_CASE, () => {
    const hostile = hostileTemplate();
    const env = isolatedEnv({ ...process.env, GIT_TEMPLATE_DIR: hostile.template });
    assert.equal(env.GIT_TEMPLATE_DIR, EMPTY_TEMPLATE_DIR, 'the inherited template is replaced');
    /**
     * Runs git with the isolated environment, which must succeed, and returns
     * its trimmed stdout. Nothing passes --no-verify, so any imported hook runs.
     */
    const isolatedGit = (cwd, ...args) => spawnOk('git', args, { cwd, env }).stdout.trim();

    const repo = path.join(hostile.dir, 'repo');
    isolatedGit(hostile.dir, 'init', '-q', '-b', 'main', repo);
    write(repo, 'first.txt', 'first\n');
    isolatedGit(repo, 'add', 'first.txt');
    isolatedGit(repo, 'commit', '-q', '-m', 'First');
    const remote = path.join(hostile.dir, 'remote.git');
    isolatedGit(hostile.dir, 'init', '-q', '--bare', remote);
    isolatedGit(repo, 'remote', 'add', 'origin', remote);
    isolatedGit(repo, 'push', '-q', 'origin', 'main');

    const clone = path.join(hostile.dir, 'clone');
    isolatedGit(hostile.dir, 'clone', '-q', remote, clone);
    isolatedGit(clone, 'checkout', '-q', '-b', 'feature');
    write(clone, 'second.txt', 'second\n');
    isolatedGit(clone, 'add', 'second.txt');
    isolatedGit(clone, 'commit', '-q', '-m', 'Second');
    isolatedGit(clone, 'push', '-q', 'origin', 'feature');
    assert.equal(isolatedGit(remote, 'rev-parse', 'refs/heads/feature'), isolatedGit(clone, 'rev-parse', 'HEAD'),
      'the push from the clone arrived');

    assertNoTemplateImports(path.join(repo, '.git'), 'repository');
    assertNoTemplateImports(remote, 'bare remote');
    assertNoTemplateImports(path.join(clone, '.git'), 'clone');
    assert.deepEqual(hostile.ran(), [], 'no hook of the hostile template ran');
    assert.deepEqual(fs.readdirSync(EMPTY_TEMPLATE_DIR), [], 'the empty template stays empty');
  });

  await t.test('[AC-03][F-017] ENV uses the empty template, so makeRepo, makeRemoteRepo and a clone carry no hooks', GIT_CASE, () => {
    assert.equal(ENV.GIT_TEMPLATE_DIR, EMPTY_TEMPLATE_DIR);
    assert.deepEqual(fs.readdirSync(EMPTY_TEMPLATE_DIR), [], 'the template folder is empty');
    const plain = makeRepo();
    const { repo, remote } = makeRemoteRepo();
    const clone = caseDir('clone');
    git(PARENT, 'clone', '-q', remote, clone);
    assertNoTemplateImports(path.join(plain, '.git'), 'makeRepo');
    assertNoTemplateImports(path.join(repo, '.git'), 'makeRemoteRepo repository');
    assertNoTemplateImports(remote, 'makeRemoteRepo remote');
    assertNoTemplateImports(path.join(clone, '.git'), 'clone');
  });
});

/* Usage                                                                     */

test('[AC-03][F-017] usage errors exit 2: no command, an unknown command, publish without a slug', () => {
  const root = makeRoot();
  for (const args of [[], ['frobnicate'], ['publish']]) {
    const result = cli(root, ...args);
    expectExit(result, 2);
    assert.match(result.stderr, /Usage:/, `usage block for ${JSON.stringify(args)}`);
  }
  assert.deepEqual(list(root, '.'), ['_config.yml', '_templates'], 'a usage error writes nothing');
});

test('[AC-03][F-017] guard --pre-push takes git\'s <remote> <url> as both or neither, guard --staged takes none, and any other count exits 2', GIT_CASE, () => {
  const repo = makeRepo();
  const refusals = [
    [['guard', '--pre-push', 'origin'], /^error: guard --pre-push takes either no arguments or <remote> <url>, not 1 argument: origin\n/],
    [['guard', '--pre-push', '--', 'origin'], /^error: guard --pre-push takes either no arguments or <remote> <url>, not 1 argument/],
    [['guard', '--pre-push', 'origin', 'url', 'extra'], /^error: guard --pre-push takes either no arguments or <remote> <url>, not 3 arguments/],
    [['guard', '--pre-push', '--', 'origin', 'url', 'extra'], /^error: guard --pre-push takes either no arguments or <remote> <url>, not 3 arguments/],
    [['guard', '--staged', 'origin'], /^error: unexpected arguments for guard --staged: origin\n/],
    [['guard', '--staged', '--', 'origin', 'url'], /^error: unexpected arguments for guard --staged: origin url\n/],
  ];
  for (const [args, error] of refusals) {
    const result = unchangedBy(() => repoSnapshot(repo), () => run(args, { cwd: repo }), 'the repository');
    expectExit(result, 2);
    assert.match(result.stderr, error, `${args.join(' ')}:\n${result.out}`);
    assert.match(result.stderr, /\nUsage: /, `${args.join(' ')}: the usage block follows`);
    assert.equal(result.stdout, '', `${args.join(' ')} checks nothing`);
  }
  // After --, a remote name or URL that starts with - is an argument, never an option; nothing is pushed here.
  for (const args of [['guard', '--pre-push', 'origin', 'url'], ['guard', '--pre-push', '--', '-remote', '--root=/nonexistent']]) {
    const result = run(args, { cwd: repo });
    expectExit(result, 0);
    assert.equal(result.out, '', `${args.join(' ')}: an empty push prints nothing`);
  }
});

/* new <slug>                                                                */

test('[AC-03][F-017] new copies the template to _drafts/<slug>.md, creates assets/drafts/<slug>/ and warns without core.hooksPath', () => {
  const root = makeRoot();
  const result = cli(root, 'new', 'my-slug');
  expectExit(result, 0);
  assert.deepEqual(fs.readFileSync(abs(root, '_drafts/my-slug.md')), fs.readFileSync(TEMPLATE),
    'the draft is a byte-for-byte copy of _templates/article.md');
  assert.ok(fs.statSync(abs(root, 'assets/drafts/my-slug')).isDirectory(), 'assets/drafts/my-slug/ is a folder');
  assert.deepEqual(list(root, 'assets/drafts/my-slug'), [], 'the image folder starts empty');
  assert.match(result.out, /core\.hooksPath/, 'the root is not a hooks-enabled clone, so new warns');
});

test('[AC-03][F-017] new does not warn in a clone whose core.hooksPath is .githooks', GIT_CASE, () => {
  const repo = makeRepo();
  git(repo, 'config', 'core.hooksPath', '.githooks');
  write(repo, '_config.yml', SITE_CONFIG);
  write(repo, '_templates/article.md', fs.readFileSync(TEMPLATE));
  const result = cli(repo, 'new', 'hooked');
  expectExit(result, 0);
  assert.ok(exists(repo, '_drafts/hooked.md'));
  assert.doesNotMatch(result.stderr, /core\.hooksPath/);
});

test('[AC-03][F-017] new refuses an invalid slug and writes nothing; a 60-character slug is accepted', async (t) => {
  for (const slug of ['Bad_Slug', 'a--b', 'a'.repeat(61)]) {
    await t.test(`[AC-03][F-017] new refuses the slug ${JSON.stringify(slug)}`, () => {
      const root = makeRoot();
      const result = cli(root, 'new', slug);
      expectExit(result, 1);
      assert.match(result.stderr, /invalid slug/i);
      assert.equal(exists(root, '_drafts'), false, 'no _drafts/ folder');
      assert.equal(exists(root, 'assets'), false, 'no image folder');
    });
  }
  await t.test('[AC-03][F-017] new accepts a 60-character slug', () => {
    const root = makeRoot();
    const slug = 'a'.repeat(60);
    expectExit(cli(root, 'new', slug), 0);
    assert.ok(exists(root, `_drafts/${slug}.md`));
    assert.ok(exists(root, `assets/drafts/${slug}`));
  });
});

test('[AC-03][F-017] new refuses a slug already used by a draft or a post and leaves both untouched', () => {
  const root = makeRoot();
  const draftText = validArticle({ title: 'Existing draft' });
  const postText = validArticle({ title: 'Existing post' });
  write(root, '_drafts/dup.md', draftText);
  write(root, `_posts/${PAST}-taken.md`, postText);

  const dup = cli(root, 'new', 'dup');
  expectExit(dup, 1);
  assert.match(dup.stderr, /_drafts\/dup\.md/);
  assert.equal(read(root, '_drafts/dup.md'), draftText, 'the existing draft is not overwritten');
  assert.equal(exists(root, 'assets/drafts/dup'), false);

  const taken = cli(root, 'new', 'taken');
  expectExit(taken, 1);
  assert.match(taken.stderr, new RegExp(escapeRegExp(`_posts/${PAST}-taken.md`)));
  assert.equal(read(root, `_posts/${PAST}-taken.md`), postText, 'the post is unchanged');
  assert.equal(exists(root, '_drafts/taken.md'), false, 'no draft is created for a published slug');
  assert.equal(exists(root, 'assets/drafts/taken'), false);
});

test('[AC-03][F-017] new leaves no draft when its image folder cannot be created, and can be run again', async (t) => {
  await t.test('[AC-03][F-017] new with a file at assets/drafts rolls the draft back and names the path', () => {
    const root = makeRoot();
    write(root, 'assets/drafts', 'a file, not a folder');
    const failed = cli(root, 'new', 'blocked');
    expectExit(failed, 1);
    assert.match(failed.stderr, /cannot create assets\/drafts\/blocked\/ \(ENOTDIR/,
      'the failing path and its error');
    assert.match(failed.stderr, /every change was rolled back/);
    assert.equal(exists(root, '_drafts/blocked.md'), false, 'no draft is left behind');
    assert.equal(read(root, 'assets/drafts'), 'a file, not a folder', 'the existing file is untouched');

    fs.rmSync(abs(root, 'assets/drafts'));
    expectExit(cli(root, 'new', 'blocked'), 0);
    assert.deepEqual(fs.readFileSync(abs(root, '_drafts/blocked.md')), fs.readFileSync(TEMPLATE));
    assert.ok(fs.statSync(abs(root, 'assets/drafts/blocked')).isDirectory());
  });
  await t.test('[AC-03][F-017] new with a file at assets/drafts/<slug> refuses before writing anything', () => {
    const root = makeRoot();
    write(root, 'assets/drafts/occupied', 'a file, not a folder');
    const refused = cli(root, 'new', 'occupied');
    expectExit(refused, 1);
    assert.match(refused.stderr, /assets\/drafts\/occupied is not a folder/);
    assert.equal(exists(root, '_drafts'), false, 'nothing is written, not even _drafts/');
    assert.equal(read(root, 'assets/drafts/occupied'), 'a file, not a folder', 'the existing file is untouched');
  });
});

/* check [files…]                                                            */

test('[AC-03][F-017] check rejects the untouched template and accepts a valid draft', () => {
  const root = makeRoot();
  expectExit(cli(root, 'new', 'fresh-template'), 0);
  const fresh = checkRoot(root, '_drafts/fresh-template.md');
  expectExit(fresh, 1);
  assert.match(fresh.stderr, /TODO/, 'leftover TODO: markers are reported');
  assert.match(fresh.stderr, /tags/, 'the empty tags list is reported');

  write(root, '_drafts/valid-draft.md', validArticle());
  expectExit(checkRoot(root, '_drafts/valid-draft.md'), 0);
});

test('[AC-03][F-017] check applies the schema to posts: an updated date is accepted, a published: key is not', () => {
  const root = makeRoot();
  write(root, `_posts/${PAST}-revised.md`, validArticle({ updated: todayUtc() }));
  expectExit(checkRoot(root, `_posts/${PAST}-revised.md`), 0);

  write(root, `_posts/${PAST}-hidden.md`, validArticle({ extra: 'published: false' }));
  const hidden = checkRoot(root, `_posts/${PAST}-hidden.md`);
  expectExit(hidden, 1);
  assert.match(hidden.stderr, /published/);
});

test('[AC-03][F-017] check reports a stray } in the tags list as a front-matter error instead of crashing', async (t) => {
  for (const tags of [['}'], ['a', '}']]) {
    await t.test(`[AC-03][F-017] check refuses tags: [${tags.join(', ')}]`, () => {
      const root = makeRoot();
      write(root, '_drafts/brace-tags.md', validArticle({ tags }));
      const result = checkRoot(root, '_drafts/brace-tags.md');
      expectExit(result, 1);
      assert.match(result.stderr, /_drafts\/brace-tags\.md: front matter line 4: unexpected "\}" in a flow list/);
      assert.doesNotMatch(result.out, /TypeError|\n\s+at /, 'no exception or stack trace');
    });
  }
});

test('[AC-03][F-017] check refuses bare tags YAML reads as null, a boolean, a number or a date, and accepts them quoted', async (t) => {
  const refused = [
    ['null', 'null'],
    ['on', 'a boolean'],
    ['off', 'a boolean'],
    ['0123', 'a number'],
    ['2026', 'a number'],
    ['2026-01-15', 'a date'],
  ];
  for (const [tag, kind] of refused) {
    await t.test(`[AC-03][F-017] check refuses the bare tag ${tag}`, () => {
      const root = makeRoot();
      write(root, '_drafts/typed-tag.md', validArticle({ tags: ['testing', tag] }));
      const result = checkRoot(root, '_drafts/typed-tag.md');
      expectExit(result, 1);
      const message = `front matter line 4: bare ${tag} in a flow list is read by YAML as ${kind}, not text; write "${tag}"`;
      assert.match(result.stderr, new RegExp(escapeRegExp(message)));
    });
  }
  const accepted = [
    ['"null"', '"on"', '"off"', '"0123"', '"2026"'],
    ['"2026-01-15"', 'testing'],
    ['2fa', '3d', '08', '100-days', '1e5'],
    ['y', 'n', 'online', 'yes-no', 'null-safety'],
  ];
  for (const tags of accepted) {
    await t.test(`[AC-03][F-017] check accepts tags: [${tags.join(', ')}]`, () => {
      const root = makeRoot();
      write(root, '_drafts/text-tags.md', validArticle({ tags }));
      expectExit(checkRoot(root, '_drafts/text-tags.md'), 0);
    });
  }
});

test('[AC-03][F-017] check warns about unwrapped Liquid inside code without failing, and not when it is wrapped in raw', () => {
  const root = makeRoot();
  const fence = ['```yaml', 'image: {{ x }}', '```'].join('\n');
  write(root, '_drafts/code-warn.md', validArticle({ body: `A Helm values file:\n\n${fence}` }));
  const unwrapped = checkRoot(root, '_drafts/code-warn.md');
  expectExit(unwrapped, 0);
  assert.notEqual(unwrapped.stderr.trim(), '', 'a warning is printed');
  assert.match(unwrapped.stderr, /raw|liquid/i);

  write(root, '_drafts/code-wrapped.md',
    validArticle({ body: `A Helm values file:\n\n{% raw %}\n${fence}\n{% endraw %}` }));
  const wrapped = checkRoot(root, '_drafts/code-wrapped.md');
  expectExit(wrapped, 0);
  assert.doesNotMatch(wrapped.stderr, /raw|liquid/i, 'no warning once the code is wrapped');
});

test('[AC-03][F-017] check warns about unwrapped Liquid in an inline code span that crosses a line break, and not when it is wrapped in raw', () => {
  const root = makeRoot();
  // kramdown closes the span on the next line of the paragraph; Liquid evaluates it first.
  const span = 'Set `image: {{ .Values.image\n}}` in the chart values.';
  const text = validArticle({ body: `A Helm values file:\n\n${span}` });
  write(root, '_drafts/span-warn.md', text);
  const line = text.split('\n').findIndex((t) => t.includes('.Values.image')) + 1;
  assert.ok(line > 0);
  const unwrapped = checkRoot(root, '_drafts/span-warn.md');
  expectExit(unwrapped, 0);
  assert.match(unwrapped.stderr, /raw|liquid/i);
  assert.match(unwrapped.stderr, new RegExp(`span-warn\\.md:${line}\\b`), `the warning names line ${line}`);

  write(root, '_drafts/span-wrapped.md',
    validArticle({ body: `A Helm values file:\n\n{% raw %}${span}{% endraw %}` }));
  const wrapped = checkRoot(root, '_drafts/span-wrapped.md');
  expectExit(wrapped, 0);
  assert.doesNotMatch(wrapped.stderr, /raw|liquid/i, 'no warning once the span is wrapped');
});

test('[AC-03][F-017] check rejects unsafe markup in prose but not the same markup shown as code', () => {
  const root = makeRoot();
  write(root, '_drafts/prose-script.md', validArticle({ body: 'Intro.\n\n<script>alert(1)</script>' }));
  const script = checkRoot(root, '_drafts/prose-script.md');
  expectExit(script, 1);
  assert.match(script.stderr, /unsafe markup[^\n]*<script>/);

  write(root, '_drafts/prose-handler.md', validArticle({ body: 'Intro.\n\n<img src="/x.png" onerror="alert(1)">' }));
  const handler = checkRoot(root, '_drafts/prose-handler.md');
  expectExit(handler, 1);
  assert.match(handler.stderr, /unsafe markup[^\n]*onerror/, 'the event handler itself is reported');

  write(root, '_drafts/code-script.md',
    validArticle({ body: 'This is what not to write:\n\n```html\n<script>alert(1)</script>\n```' }));
  expectExit(checkRoot(root, '_drafts/code-script.md'), 0);
});

test('[AC-03][F-017] check reports every line of a multi-line tag that holds an event handler or a javascript: URL', async (t) => {
  const cases = [
    {
      name: 'two event handlers',
      slug: 'multi-handlers',
      body: 'Intro.\n\n<span title="t"\n  onclick="a()"\n  onfocus="b()">x</span>',
      marks: ['onclick=', 'onfocus='],
    },
    {
      name: 'two javascript: URLs',
      slug: 'multi-urls',
      body: 'Intro.\n\n<a href="javascript:a()"\n  title="t"\n  data-x="javascript:b()">x</a>',
      marks: ['href=', 'data-x='],
    },
  ];
  for (const { name, slug, body, marks } of cases) {
    await t.test(`[AC-03][F-017] check reports both lines of a tag with ${name}`, () => {
      const root = makeRoot();
      const text = validArticle({ body });
      write(root, `_drafts/${slug}.md`, text);
      const result = checkRoot(root, `_drafts/${slug}.md`);
      expectExit(result, 1);
      for (const mark of marks) {
        const line = text.split('\n').findIndex((l) => l.includes(mark)) + 1;
        assert.ok(line > 0);
        assert.match(result.stderr, new RegExp(`${escapeRegExp(slug)}\\.md:${line}: unsafe markup`),
          `line ${line} (${mark}) is reported`);
      }
    });
  }
});

test('[AC-03][F-017] check rejects external, data:, alt-less and missing images and accepts a local image with alt text', async (t) => {
  const image = (slug, file) => `{{ '/assets/drafts/${slug}/${file}' | relative_url }}`;
  // Slugs share no words with the expected messages, so each pattern can only match the finding itself.
  const cases = [
    {
      name: 'an external image',
      slug: 'remote-figure',
      body: () => '![Alt](https://example.com/x.png)',
      message: /external/i,
    },
    {
      name: 'a data: image',
      slug: 'inline-figure',
      body: () => '![Alt](data:image/png;base64,AAAA)',
      message: /data: images/i,
    },
    {
      name: 'an image without alt text',
      slug: 'unlabelled-figure',
      body: (s) => `![](${image(s, 'figure.png')})`,
      file: true,
      message: /alt text/i,
    },
    {
      name: 'a local image whose file is missing',
      slug: 'absent-figure',
      body: (s) => `![Alt](${image(s, 'missing.png')})`,
      message: /does not exist/i,
    },
  ];
  for (const { name, slug, body, file, message } of cases) {
    await t.test(`[AC-03][F-017] check refuses ${name}`, () => {
      const root = makeRoot();
      if (file) write(root, `assets/drafts/${slug}/figure.png`, PNG);
      write(root, `_drafts/${slug}.md`, validArticle({ body: `Figure:\n\n${body(slug)}` }));
      const result = checkRoot(root, `_drafts/${slug}.md`);
      expectExit(result, 1);
      assert.match(result.stderr, message);
    });
  }
  await t.test('[AC-03][F-017] check accepts a local image with alt text', () => {
    const root = makeRoot();
    write(root, 'assets/drafts/img-ok/figure.png', PNG);
    write(root, '_drafts/img-ok.md',
      validArticle({ body: `Figure:\n\n![A labelled figure](${image('img-ok', 'figure.png')})` }));
    expectExit(checkRoot(root, '_drafts/img-ok.md'), 0);
  });
});

test('[AC-03][F-017] check refuses an external video poster and a CSS image in a style attribute, each on its line', () => {
  const root = makeRoot();
  const cover = validArticle({ body: 'Clip:\n\n<video poster="https://example.com/cover.png"></video>' });
  const tinted = validArticle({ body: 'Block:\n\n<p style="background:url(https://example.com/bg.png)">Text</p>' });
  write(root, '_drafts/clip-cover.md', cover);
  write(root, '_drafts/tinted-block.md', tinted);
  const result = checkRoot(root, '_drafts/clip-cover.md', '_drafts/tinted-block.md');
  expectExit(result, 1);
  const lineOf = (text, mark) => text.split('\n').findIndex((line) => line.includes(mark)) + 1;
  assert.match(result.stderr, new RegExp(escapeRegExp(
    `_drafts/clip-cover.md:${lineOf(cover, '<video')}: <video> poster: external images are not allowed (https://example.com/cover.png)`,
  )));
  assert.match(result.stderr, new RegExp(escapeRegExp(
    `_drafts/tinted-block.md:${lineOf(tinted, '<p style')}: <p> style: CSS images (url(), image-set()) are not allowed`,
  )));
});

test('[AC-03][F-017] check refuses an external or data: href an attribute list gives an SVG <image>, and accepts one in the own folder', () => {
  const root = makeRoot();
  const svg = (href) => `Figure:\n\n<svg markdown="span"><image width="40" height="40"/>{: href="${href}"}</svg>`;
  const remote = validArticle({ body: svg('https://example.com/p.png') });
  const inline = validArticle({ body: svg('data:image/png;base64,eA==') });
  write(root, '_drafts/svg-remote.md', remote);
  write(root, '_drafts/svg-inline.md', inline);
  const result = checkRoot(root, '_drafts/svg-remote.md', '_drafts/svg-inline.md');
  expectExit(result, 1);
  const lineOf = (text) => text.split('\n').findIndex((line) => line.includes('<svg')) + 1;
  assert.match(result.stderr, new RegExp(escapeRegExp(`_drafts/svg-remote.md:${lineOf(remote)}: <image> attribute list on the image: `
    + 'external images are not allowed (https://example.com/p.png)')));
  assert.match(result.stderr, new RegExp(escapeRegExp(`_drafts/svg-inline.md:${lineOf(inline)}: <image> attribute list on the image: `
    + 'data: images are not allowed (data:image/png;base64,eA==)')));

  write(root, 'assets/drafts/svg-local/figure.png', PNG);
  write(root, '_drafts/svg-local.md', validArticle({ body: svg('/assets/drafts/svg-local/figure.png') }));
  expectExit(checkRoot(root, '_drafts/svg-local.md'), 0);
  write(root, '_drafts/svg-absent.md', validArticle({ body: svg('/assets/drafts/svg-absent/figure.png') }));
  const absent = checkRoot(root, '_drafts/svg-absent.md');
  expectExit(absent, 1);
  assert.match(absent.stderr, /<image> attribute list on the image: image \/assets\/drafts\/svg-absent\/figure\.png does not exist/,
    'the own-folder href is checked, not skipped');
});

test('[AC-03][F-017] check validates the image source kramdown renders, not a different one', async (t) => {
  // `figure.png` exists in every case's image folder; `missing.png` never does.
  const cases = [
    {
      name: 'refuses an inline image with an empty destination',
      slug: 'empty-dest',
      body: () => '![Diagram]()',
      message: /image has no source/,
    },
    {
      name: 'refuses an inline image with an empty <> destination',
      slug: 'empty-angle',
      body: () => '![Diagram](<>)',
      message: /image has no source/,
    },
    {
      name: 'refuses an inline image with only a title',
      slug: 'title-only',
      body: () => '![Diagram]( "A caption")',
      message: /image has no source/,
    },
    {
      name: 'refuses an empty destination whose title holds quotes, on the image line',
      slug: 'quoted-title',
      body: () => '![Diagram]( "A "quoted" caption")',
      message: /_drafts\/quoted-title\.md:\d+: image has no source/,
    },
    {
      name: 'refuses an empty destination whose title runs to the last quote before )',
      slug: 'two-titles',
      body: () => '![Diagram]( "x" "title")',
      message: /_drafts\/two-titles\.md:\d+: image has no source/,
    },
    {
      name: 'accepts an empty-looking image split by a blank line, which renders as two paragraphs of text',
      slug: 'split-dest',
      body: () => '![Diagram](\n\n)',
    },
    {
      name: 'accepts alt text split by a blank line, which renders as text',
      slug: 'split-alt',
      body: (s) => `![Dia\n\ngram](/assets/drafts/${s}/missing.png)`,
    },
    {
      name: 'accepts an empty title, which kramdown renders as text',
      slug: 'empty-title',
      body: () => '![Diagram]( "")',
    },
    {
      name: 'refuses a <…> destination that does not directly follow the parenthesis',
      slug: 'spaced-angle',
      body: (s) => `![Diagram]( </assets/drafts/${s}/figure.png> )`,
      message: /page-relative/,
    },
    {
      name: 'accepts a <…> destination directly after the parenthesis',
      slug: 'tight-angle',
      body: (s) => `![Diagram](</assets/drafts/${s}/figure.png>)`,
    },
    {
      name: 'accepts a reference whose last duplicate definition names an existing file',
      slug: 'redefined-ok',
      body: (s) => `![Diagram][pic]\n\n[pic]: /assets/drafts/${s}/missing.png\n[PIC]: /assets/drafts/${s}/figure.png`,
    },
    {
      name: 'refuses a reference whose last duplicate definition names a missing file',
      slug: 'redefined-bad',
      body: (s) => `![Diagram][pic]\n\n[pic]: /assets/drafts/${s}/figure.png\n[pic]: /assets/drafts/${s}/missing.png`,
      message: /missing\.png does not exist/,
    },
    {
      name: 'accepts a reference whose spaced label matches no definition, which renders as text',
      slug: 'spaced-label',
      body: (s) => `![Diagram][ pic ]\n\n[pic]: /assets/drafts/${s}/missing.png`,
    },
    {
      name: 'refuses a reference whose label differs from its definition only by whitespace runs and case',
      slug: 'folded-label',
      body: (s) => `![Diagram][My\tPic]\n\n[my  pic]: /assets/drafts/${s}/missing.png`,
      message: /missing\.png does not exist/,
    },
    {
      name: 'accepts a . segment inside the image folder, which the browser drops',
      slug: 'dot-segment',
      body: (s) => `![Diagram](/assets/drafts/${s}/./figure.png)`,
    },
    {
      name: 'refuses a .. segment that resolves back into the image folder',
      slug: 'dotdot-segment',
      body: (s) => `![Diagram](/assets/drafts/${s}/../${s}/figure.png)`,
      message: /must not contain \.\. segments/,
    },
    {
      name: 'refuses a . segment inside the folder prefix, which publish would not rewrite',
      slug: 'dot-prefix',
      body: (s) => `![Diagram](/assets/drafts/./${s}/figure.png)`,
      message: /must be under/,
    },
  ];
  for (const { name, slug, body, message } of cases) {
    await t.test(`[AC-03][F-017] check ${name}`, () => {
      const root = makeRoot();
      write(root, `assets/drafts/${slug}/figure.png`, PNG);
      write(root, `_drafts/${slug}.md`, validArticle({ body: `Figure:\n\n${body(slug)}` }));
      const result = checkRoot(root, `_drafts/${slug}.md`);
      if (message === undefined) {
        expectExit(result, 0);
      } else {
        expectExit(result, 1);
        assert.match(result.stderr, message);
      }
    });
  }
  await t.test('[AC-03][F-017] guard --staged finds the tracked image behind a . segment', GIT_CASE, () => {
    const repo = makeRepo();
    const postRel = `_posts/${PAST}-dot-guard.md`;
    write(repo, postRel, validArticle({ body: 'Figure:\n\n![Diagram](/assets/blog/dot-guard/./figure.png)' }));
    write(repo, 'assets/blog/dot-guard/figure.png', PNG);
    git(repo, 'add', postRel, 'assets/blog/dot-guard/figure.png');
    expectExit(guardStaged(repo), 0);
  });
});

test('[AC-03][F-017] check refuses a pile-up of unclosed <img> tags too large to read in full', () => {
  const root = makeRoot();
  // Every start ends at the same `>`; reading each one whole would take quadratic time.
  write(root, '_drafts/img-pileup.md', validArticle({ body: `Figure:\n\n${'<img '.repeat(2000)}>` }));
  const result = checkRoot(root, '_drafts/img-pileup.md');
  expectExit(result, 1);
  assert.match(result.stderr, /too many overlapping <img> tags to check/);
});

/* publish <slug>                                                            */

/** The `_posts/` files published under `slug`. */
function postsFor(root, slug) {
  return list(root, '_posts').filter((name) => name.endsWith(`-${slug}.md`));
}

test('[AC-03][F-017] publish moves the draft to _posts/<UTC date>-<slug>.md, moves its images and rewrites their paths', () => {
  const root = makeRoot();
  const draftText = validArticle({
    body: "Architecture overview:\n\n![System diagram]({{ '/assets/drafts/my-slug/figure.png' | relative_url }})",
  });
  write(root, '_drafts/my-slug.md', draftText);
  write(root, 'assets/drafts/my-slug/figure.png', PNG);

  // Read the UTC date on both sides of the run: a run that crosses midnight may use either.
  const zone = offUtcZone();
  const dateBefore = todayUtc();
  const result = cliWith(root, { env: zone }, 'publish', 'my-slug');
  const dateAfter = todayUtc();
  expectExit(result, 0);

  assert.equal(exists(root, '_drafts/my-slug.md'), false, 'the draft is gone');
  const posts = postsFor(root, 'my-slug');
  assert.equal(posts.length, 1, `exactly one post: ${posts.join(', ')}`);
  const date = posts[0].slice(0, 10);
  assert.match(posts[0], /^\d{4}-\d{2}-\d{2}-my-slug\.md$/);
  assert.ok(date === dateBefore || date === dateAfter,
    `post dated ${date}, the UTC date of the run (${dateBefore}/${dateAfter})`);

  assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/my-slug/figure.png')), PNG, 'the image moved intact');
  assert.equal(exists(root, 'assets/drafts/my-slug'), false, 'the draft image folder is gone');

  const postRel = `_posts/${posts[0]}`;
  const postText = read(root, postRel);
  assert.ok(postText.includes('/assets/blog/my-slug/'), 'image paths point at assets/blog/');
  assert.ok(!postText.includes('/assets/drafts/my-slug/'), 'no image path still points at assets/drafts/');
  assert.equal(postText, draftText.split('/assets/drafts/my-slug/').join('/assets/blog/my-slug/'),
    'the image path is the only change');
  expectExit(cliWith(root, { env: offUtcZone() }, 'check', postRel), 0);
});

test('[AC-03][F-017] publish of an article without images creates no image folder', async (t) => {
  await t.test('[AC-03][F-017] publish removes the empty folder made by new', () => {
    const root = makeRoot();
    expectExit(cli(root, 'new', 'plain'), 0);
    write(root, '_drafts/plain.md', validArticle());
    expectExit(cli(root, 'publish', 'plain'), 0);
    assert.equal(postsFor(root, 'plain').length, 1);
    assert.equal(exists(root, 'assets/drafts/plain'), false, 'the empty draft image folder is removed');
    assert.equal(exists(root, 'assets/blog/plain'), false, 'no published image folder is created');
  });
  await t.test('[AC-03][F-017] publish of a draft that never had an image folder', () => {
    const root = makeRoot();
    const draftText = validArticle({ title: 'Never had images' });
    write(root, '_drafts/no-folder.md', draftText);
    expectExit(cli(root, 'publish', 'no-folder'), 0);
    const posts = postsFor(root, 'no-folder');
    assert.equal(posts.length, 1);
    assert.equal(read(root, `_posts/${posts[0]}`), draftText, 'the post is the draft unchanged');
    assert.equal(exists(root, 'assets/blog/no-folder'), false);
    assert.equal(exists(root, 'assets/blog'), false);
  });
});

test('[AC-03][F-017] publish refuses a draft that fails check and moves nothing', () => {
  const root = makeRoot();
  expectExit(cli(root, 'new', 'bad-draft'), 0);
  write(root, 'assets/drafts/bad-draft/figure.png', PNG);
  const result = cli(root, 'publish', 'bad-draft');
  expectExit(result, 1);
  assert.match(result.stderr, /TODO/);
  assert.deepEqual(fs.readFileSync(abs(root, '_drafts/bad-draft.md')), fs.readFileSync(TEMPLATE),
    'the draft stays in _drafts/ unchanged');
  assert.deepEqual(postsFor(root, 'bad-draft'), [], 'no post is written');
  assert.ok(exists(root, 'assets/drafts/bad-draft/figure.png'), 'the image folder is not moved');
  assert.equal(exists(root, 'assets/blog/bad-draft'), false);
});

test('[AC-03][F-017] publish checks the post it would write, so an updated date before the UTC publish date is refused', async (t) => {
  const draftWithImage = (slug, updated) => validArticle({
    updated,
    body: `Figure:\n\n![A labelled figure]({{ '/assets/drafts/${slug}/figure.png' | relative_url }})`,
  });

  await t.test('[AC-03][F-017] publish refuses a draft whose updated date is yesterday (UTC) and moves nothing', () => {
    const root = makeRoot();
    const yesterday = addDaysUtc(-1);
    const draftText = draftWithImage('stale', yesterday);
    write(root, '_drafts/stale.md', draftText);
    write(root, 'assets/drafts/stale/figure.png', PNG);
    expectExit(cli(root, 'check', '_drafts/stale.md'), 0);

    // The prospective post carries the UTC date of the run, on either side of midnight.
    const zone = offUtcZone();
    const dateBefore = todayUtc();
    const result = cliWith(root, { env: zone }, 'publish', 'stale');
    const runDates = [...new Set([dateBefore, todayUtc()])].map(escapeRegExp).join('|');
    expectExit(result, 1);
    assert.match(result.stderr,
      new RegExp(`_posts/(${runDates})-stale\\.md: updated ${escapeRegExp(yesterday)} is earlier than the post date \\1`),
      'the prospective post is reported by its path, dated by the UTC date of the run');
    assert.match(result.stderr, /nothing was moved/);
    assert.deepEqual(fs.readFileSync(abs(root, '_drafts/stale.md')), Buffer.from(draftText),
      'the draft is unchanged');
    assert.deepEqual(postsFor(root, 'stale'), [], 'no post is written');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/drafts/stale/figure.png')), PNG,
      'the image stays in assets/drafts/');
    assert.equal(exists(root, 'assets/blog'), false, 'no published image folder');
  });

  await t.test('[AC-03][F-017] publish accepts a draft whose updated date is today (UTC)', (st) => {
    const root = makeRoot();
    const zone = offUtcZone();
    const dateBefore = todayUtc();
    write(root, '_drafts/fresh.md', draftWithImage('fresh', dateBefore));
    write(root, 'assets/drafts/fresh/figure.png', PNG);
    const result = cliWith(root, { env: zone }, 'publish', 'fresh');
    if (todayUtc() !== dateBefore) {
      st.skip('the run crossed midnight UTC, so "today" changed under it');
      return;
    }
    expectExit(result, 0);
    assert.deepEqual(postsFor(root, 'fresh'), [`${dateBefore}-fresh.md`]);
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/fresh/figure.png')), PNG);
    expectExit(cliWith(root, { env: zone }, 'check', `_posts/${dateBefore}-fresh.md`), 0);
  });
});

/* unpublish <slug>                                                          */

test('[AC-03][F-017] unpublish moves the post and its images back to the drafts folders and rewrites the paths', () => {
  const root = makeRoot();
  const postRel = `_posts/${PAST}-pic.md`;
  const postText = validArticle({
    body: "Diagram:\n\n![Pipeline diagram]({{ '/assets/blog/pic/figure.png' | relative_url }})",
  });
  write(root, postRel, postText);
  write(root, 'assets/blog/pic/figure.png', PNG);

  expectExit(cli(root, 'unpublish', 'pic'), 0);

  assert.equal(exists(root, postRel), false, 'the post is gone');
  assert.equal(exists(root, 'assets/blog/pic'), false, 'the published image folder is gone');
  const draftText = read(root, '_drafts/pic.md');
  assert.ok(draftText.includes('/assets/drafts/pic/'), 'image paths point at assets/drafts/');
  assert.ok(!draftText.includes('/assets/blog/pic/'), 'no image path still points at assets/blog/');
  assert.equal(draftText, postText.split('/assets/blog/pic/').join('/assets/drafts/pic/'),
    'the image path is the only change');
  assert.deepEqual(fs.readFileSync(abs(root, 'assets/drafts/pic/figure.png')), PNG, 'the image moved intact');
  expectExit(cli(root, 'check', '_drafts/pic.md'), 0);
});

/** `cli(root, 'unpublish', slug)` for a refusal, asserting that it moved, wrote and removed nothing in the root. */
function unpublishRefused(root, slug) {
  return unchangedBy(() => treeSnapshot(root), () => cli(root, 'unpublish', slug), `the root ${root}`);
}

/**
 * Asserts that a post from `writePostWithImage` was unpublished: the draft is
 * the post with only its image path rewritten, the image arrived in
 * `assets/drafts/<slug>/`, and neither the post nor its published image folder is left.
 */
function assertUnpublishedWithImage(root, slug, { rel, text }) {
  assert.equal(read(root, `_drafts/${slug}.md`), text.split(`/assets/blog/${slug}/`).join(`/assets/drafts/${slug}/`),
    'the draft is the post with only its image path rewritten');
  assert.deepEqual(fs.readFileSync(abs(root, `assets/drafts/${slug}/figure.png`)), PNG,
    'the image arrived intact in assets/drafts/');
  assert.equal(exists(root, rel), false, 'the post is gone');
  assert.equal(exists(root, `assets/blog/${slug}`), false, 'the published image folder is gone');
}

test('[AC-03][F-017] unpublish refuses while a post_url names the post, and succeeds once the reference is gone', () => {
  const root = makeRoot();
  const target = writePostWithImage(root, 'target');
  const referrerName = `${PAST}-referrer.md`;
  const referrerRel = `_posts/${referrerName}`;
  const referrerText = validArticle({
    title: 'The referrer',
    body: `Background first.\n\nRead [the target]({{ site.baseurl }}{% post_url ${PAST}-target %}) next.`,
  });
  write(root, referrerRel, referrerText);
  const line = referrerText.split('\n').findIndex((text) => text.includes('post_url')) + 1;
  assert.ok(line > 0);

  const refused = unpublishRefused(root, 'target');
  expectExit(refused, 1);
  assert.match(refused.stderr, new RegExp(`${escapeRegExp(referrerName)}[^\\n]*\\b${line}\\b`),
    `the refusal names ${referrerName} and line ${line}`);
  assertStillPost(root, 'target', target);

  write(root, referrerRel, validArticle({ title: 'The referrer', body: 'No links to the target any more.' }));
  expectExit(cli(root, 'unpublish', 'target'), 0);
  assertUnpublishedWithImage(root, 'target', target);
});

test('[AC-03][F-017] unpublish refuses while a post_url and an ordinary link name the post, and succeeds once both are gone', () => {
  const root = makeRoot();
  const target = writePostWithImage(root, 'target');
  const taggedRel = `_posts/${PAST}-tagged.md`;
  const taggedText = validArticle({
    title: 'Tagged referrer',
    body: `Background first.\n\nRead [the target]({{ site.baseurl }}{% post_url ${PAST}-target %}) next.`,
  });
  const linkedRel = `_posts/${PAST}-linked.md`;
  const linkedText = validArticle({
    title: 'Linked referrer',
    body: 'Intro.\n\nSee [the target article](/blog/target/).',
  });
  write(root, taggedRel, taggedText);
  write(root, linkedRel, linkedText);
  const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;
  const taggedAt = new RegExp(`${escapeRegExp(taggedRel)}:${lineOf(taggedText, 'post_url')}: `);
  const linkedAt = new RegExp(`${escapeRegExp(linkedRel)}:${lineOf(linkedText, '/blog/target/')}: `);
  const unmoved = () => {
    assertStillPost(root, 'target', target);
    assert.equal(exists(root, '_drafts'), false, 'nothing is moved to _drafts/');
  };

  const both = unpublishRefused(root, 'target');
  expectExit(both, 1);
  assert.match(both.stderr, /2 references/);
  assert.match(both.stderr, taggedAt, 'the post_url reference is named with its file and line');
  assert.match(both.stderr, linkedAt, 'the ordinary link is named with its file and line');
  unmoved();

  write(root, linkedRel, validArticle({ title: 'Linked referrer', body: 'No link to the target any more.' }));
  const one = unpublishRefused(root, 'target');
  expectExit(one, 1);
  assert.match(one.stderr, taggedAt, 'the remaining post_url still refuses');
  assert.doesNotMatch(one.stderr, new RegExp(escapeRegExp(linkedRel)), 'the removed link is no longer listed');
  unmoved();

  write(root, taggedRel, validArticle({ title: 'Tagged referrer', body: 'No tag for the target any more.' }));
  expectExit(cli(root, 'unpublish', 'target'), 0);
  assertUnpublishedWithImage(root, 'target', target);
});

test('[AC-03][F-017] unpublish refuses while a post_url or link tag written with whitespace control names the post', async (t) => {
  // Liquid strips a closing `-` before `%}`, so these tags all name the post and fail the build once it is gone.
  const forms = [
    `{% post_url ${PAST}-target-%}`,
    `{%-post_url ${PAST}-target-%}`,
    `{%- post_url ${PAST}-target -%}`,
    `{% link _posts/${PAST}-target.md-%}`,
  ];
  for (const form of forms) {
    await t.test(`[AC-03][F-017] unpublish refuses a reference written as ${form}`, () => {
      const root = makeRoot();
      const target = writePostWithImage(root, 'target');
      const referrerName = `${PAST}-referrer.md`;
      const referrerText = validArticle({
        title: 'The referrer',
        body: `Background first.\n\nRead [the target]({{ site.baseurl }}${form}) next.`,
      });
      write(root, `_posts/${referrerName}`, referrerText);
      const line = referrerText.split('\n').findIndex((text) => text.includes(form)) + 1;
      assert.ok(line > 0);

      const result = unpublishRefused(root, 'target');
      expectExit(result, 1);
      assert.match(result.stderr, new RegExp(`${escapeRegExp(referrerName)}[^\\n]*\\b${line}\\b`),
        `the refusal names ${referrerName} and line ${line}`);
      assertStillPost(root, 'target', target);
      assert.equal(exists(root, '_drafts'), false, 'nothing is moved to _drafts/');
    });
  }
});

test('[AC-03][F-017] unpublish refuses while another article links to the post in any URL form', async (t) => {
  const forms = [
    '/blog/target/',
    '{{ site.baseurl }}/blog/target/',
    "{{ '/blog/target/' | relative_url }}",
    '../target/',
    'https://www.cabrillocoast.com/blog/target/',
    'https://randyamiller.github.io/cabrillo-coast/blog/target/',
  ];
  for (const form of forms) {
    await t.test(`[AC-03][F-017] unpublish refuses a link written as ${form}`, () => {
      const root = makeRoot();
      const target = writePostWithImage(root, 'target');
      const referrerRel = `_posts/${PAST}-referrer.md`;
      write(root, referrerRel, validArticle({ title: 'The referrer', body: `See [the target article](${form}).` }));

      const result = unpublishRefused(root, 'target');
      expectExit(result, 1);
      assert.match(result.stderr, new RegExp(escapeRegExp(referrerRel)), 'the refusal names the referring file');
      assertStillPost(root, 'target', target);
      assert.equal(exists(root, '_drafts'), false, 'nothing is moved to _drafts/');
    });
  }
});

test('[AC-03][F-017] unpublish of an image-free post in a fresh clone moves only the post and changes no git state', GIT_CASE, () => {
  const repo = makeRepo();
  const postRel = `_posts/${PAST}-plain.md`;
  write(repo, '_config.yml', SITE_CONFIG);
  write(repo, postRel, validArticle({ title: 'Plain article' }));
  git(repo, 'add', '_config.yml', postRel);
  commit(repo, 'Publish: Plain article');

  const clone = caseDir('clone');
  git(PARENT, 'clone', '-q', repo, clone);
  assert.ok(exists(clone, postRel));
  assert.equal(exists(clone, 'assets'), false, 'git keeps no empty folders, so the clone has no image folder');

  const result = run(['unpublish', 'plain', '--root', clone], { cwd: clone });
  expectExit(result, 0);
  assert.ok(exists(clone, '_drafts/plain.md'), 'the post is back in _drafts/');
  assert.equal(exists(clone, postRel), false, 'the post is gone');
  assert.equal(exists(clone, 'assets/drafts/plain'), false);
  assert.equal(exists(clone, 'assets/blog/plain'), false);
  assert.equal(git(clone, 'diff', '--cached', '--name-only'), '', 'nothing is staged');
  assert.equal(git(clone, 'status', '--porcelain'), `D ${postRel}`,
    'the only change is the unstaged deletion; the git-ignored draft does not show');
});

/* Failures part way: rollback and retry                                     */

/** Writes a valid draft of `slug` with one image in `assets/drafts/<slug>/`; returns the draft text. */
function writeDraftWithImage(root, slug) {
  const text = validArticle({
    body: `Figure:\n\n![A labelled figure]({{ '/assets/drafts/${slug}/figure.png' | relative_url }})`,
  });
  write(root, `_drafts/${slug}.md`, text);
  write(root, `assets/drafts/${slug}/figure.png`, PNG);
  return text;
}

/**
 * Writes a valid post of `slug`, dated `PAST`, with one image in
 * `assets/blog/<slug>/`.
 *
 * @returns {{ rel: string, text: string }} The post's path and text.
 */
function writePostWithImage(root, slug) {
  const rel = `_posts/${PAST}-${slug}.md`;
  const text = validArticle({
    body: `Figure:\n\n![A labelled figure]({{ '/assets/blog/${slug}/figure.png' | relative_url }})`,
  });
  write(root, rel, text);
  write(root, `assets/blog/${slug}/figure.png`, PNG);
  return { rel, text };
}

/** Asserts that a draft from `writeDraftWithImage` is exactly as it was: nothing published, nothing left over. */
function assertStillDraft(root, slug, text) {
  assert.equal(read(root, `_drafts/${slug}.md`), text, 'the draft is unchanged');
  assert.deepEqual(fs.readFileSync(abs(root, `assets/drafts/${slug}/figure.png`)), PNG,
    'the image is in assets/drafts/');
  assert.deepEqual(postsFor(root, slug), [], 'no post is left in _posts/');
  assert.equal(exists(root, `assets/blog/${slug}`), false, 'no published image folder is left');
}

/** Asserts that a post from `writePostWithImage` is exactly as it was: nothing unpublished, nothing left over. */
function assertStillPost(root, slug, { rel, text }) {
  assert.equal(read(root, rel), text, 'the post is unchanged');
  assert.deepEqual(fs.readFileSync(abs(root, `assets/blog/${slug}/figure.png`)), PNG, 'the image is in assets/blog/');
  assert.equal(exists(root, `_drafts/${slug}.md`), false, 'no draft is left in _drafts/');
  assert.equal(exists(root, `assets/drafts/${slug}`), false, 'no draft image folder is left');
}

/** Asserts that `publish <slug>` now succeeds without faults: one post, its image published, the draft gone. */
function assertRetryPublishes(root, slug) {
  expectExit(cli(root, 'publish', slug), 0);
  assert.equal(postsFor(root, slug).length, 1, 'the retry publishes one post');
  assert.deepEqual(fs.readFileSync(abs(root, `assets/blog/${slug}/figure.png`)), PNG, 'the retry moves the image');
  assert.equal(exists(root, `_drafts/${slug}.md`), false, 'the retry removes the draft');
}

/** Asserts that `unpublish <slug>` now succeeds without faults: the draft and its image back, the post gone. */
function assertRetryUnpublishes(root, slug, { rel }) {
  expectExit(cli(root, 'unpublish', slug), 0);
  assert.ok(exists(root, `_drafts/${slug}.md`), 'the retry writes the draft');
  assert.deepEqual(fs.readFileSync(abs(root, `assets/drafts/${slug}/figure.png`)), PNG, 'the retry moves the image');
  assert.equal(exists(root, rel), false, 'the retry removes the post');
}

/** Options of the cases that create symbolic links, which Windows allows only with extra privileges. */
const LINK_CASE = { skip: process.platform === 'win32' ? 'symbolic links need extra privileges on Windows' : false };

/** Creates `rel` in `root` as a symbolic link to `target`, creating its parent folders. */
function link(root, rel, target) {
  fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
  fs.symlinkSync(target, abs(root, rel));
}

/**
 * Runs `cli(root, …args)` and asserts that it is refused with exit 1, naming
 * each path of `named` as a symbolic link and saying nothing was changed,
 * and that it left `root` and every folder of `outside` exactly as they
 * were: nothing was written, moved or removed, in the root or through a
 * link, the slug's lock included.
 */
function refusedThroughLink(root, outside, args, named) {
  const result = unchangedBy(
    () => [root, ...outside].map((dir) => treeSnapshot(dir)),
    () => cli(root, ...args),
    `the root ${root} and the folders its links point to`,
  );
  expectExit(result, 1);
  for (const rel of named) {
    assert.match(result.stderr, new RegExp(`error: ${escapeRegExp(rel)} is a symbolic link; `),
      `the refusal names ${rel} as the link to replace`);
  }
  assert.match(result.stderr, /nothing was changed/);
  return result;
}

test('[AC-03][F-017] new refuses a _drafts or assets folder aliased to a public folder, and writes nothing through it', LINK_CASE, async (t) => {
  for (const [alias, target, publicDir] of [
    ['_drafts', 'blog', 'blog'],
    ['assets/drafts', '../blog', 'blog'],
    ['assets', 'public', 'public'],
  ]) {
    await t.test(`[AC-03][F-017] new refuses ${alias} linked to the tracked ${publicDir}/`, () => {
      const root = makeRoot();
      write(root, `${publicDir}/index.html`, '<p>Public page</p>\n');
      link(root, alias, target);
      refusedThroughLink(root, [], ['new', 'leak'], [alias]);
      assert.deepEqual(list(root, publicDir), ['index.html'], `no draft, image folder or lock lands in ${publicDir}/`);
    });
  }
});

test('[AC-03][F-017] publish and unpublish refuse _drafts, _posts or assets/blog linked outside the root', LINK_CASE, async (t) => {
  for (const alias of ['_drafts', '_posts', 'assets/blog']) {
    await t.test(`[AC-03][F-017] publish refuses ${alias} linked outside the root`, () => {
      const root = makeRoot();
      const outside = caseDir('outside');
      const text = writeDraftWithImage(root, 'escape');
      if (alias === '_drafts') {
        fs.rmSync(abs(root, '_drafts'), { recursive: true });
        write(outside, 'escape.md', text);
      }
      link(root, alias, outside);
      refusedThroughLink(root, [outside], ['publish', 'escape'], [alias]);
      assert.equal(fs.existsSync(path.join(outside, '.escape.lock')), false, 'no lock is written through the link');
    });
    await t.test(`[AC-03][F-017] unpublish refuses ${alias} linked outside the root`, () => {
      const root = makeRoot();
      const outside = caseDir('outside');
      const post = writePostWithImage(root, 'escape');
      if (alias === '_posts') {
        fs.rmSync(abs(root, '_posts'), { recursive: true });
        write(outside, path.posix.basename(post.rel), post.text);
      } else if (alias === 'assets/blog') {
        fs.rmSync(abs(root, 'assets/blog'), { recursive: true });
        write(outside, 'escape/figure.png', PNG);
      }
      link(root, alias, outside);
      refusedThroughLink(root, [outside], ['unpublish', 'escape'], [alias]);
      assert.equal(fs.existsSync(path.join(outside, '.escape.lock')), false, 'no lock is written through the link');
    });
  }
  await t.test('[AC-03][F-017] new refuses _drafts linked outside the root and writes no lock there', () => {
    const root = makeRoot();
    const outside = caseDir('outside');
    link(root, '_drafts', outside);
    refusedThroughLink(root, [outside], ['new', 'escape'], ['_drafts']);
    assert.deepEqual(fs.readdirSync(outside), [], 'no draft or lock is written through the link');
  });
});

test('[AC-03][F-017] new, publish and unpublish refuse a template, draft or post that is a symbolic link', LINK_CASE, async (t) => {
  await t.test('[AC-03][F-017] new refuses a linked _templates/article.md', () => {
    const root = makeRoot();
    const outside = caseDir('outside');
    write(outside, 'article.md', fs.readFileSync(TEMPLATE));
    fs.rmSync(abs(root, '_templates/article.md'));
    link(root, '_templates/article.md', path.join(outside, 'article.md'));
    refusedThroughLink(root, [outside], ['new', 'linked'], ['_templates/article.md']);
  });
  await t.test('[AC-03][F-017] publish refuses a linked _drafts/<slug>.md', () => {
    const root = makeRoot();
    const outside = caseDir('outside');
    write(outside, 'linked.md', validArticle({ title: 'Kept outside the root' }));
    link(root, '_drafts/linked.md', path.join(outside, 'linked.md'));
    refusedThroughLink(root, [outside], ['publish', 'linked'], ['_drafts/linked.md']);
  });
  await t.test('[AC-03][F-017] unpublish refuses a linked _posts/<date>-<slug>.md', () => {
    const root = makeRoot();
    const outside = caseDir('outside');
    write(outside, 'linked.md', validArticle({ title: 'Kept outside the root' }));
    link(root, `_posts/${PAST}-linked.md`, path.join(outside, 'linked.md'));
    refusedThroughLink(root, [outside], ['unpublish', 'linked'], [`_posts/${PAST}-linked.md`]);
  });
});

test('[AC-03][F-017] check and publish refuse an image reached through a symbolic link', LINK_CASE, async (t) => {
  for (const [linked, what] of [
    ['assets/drafts/pic/figure.png', 'image file'],
    ['assets/drafts/pic', 'image folder'],
  ]) {
    await t.test(`[AC-03][F-017] a linked ${what} counts as missing for check and is refused by publish`, () => {
      const root = makeRoot();
      const outside = caseDir('outside');
      const text = writeDraftWithImage(root, 'pic');
      fs.rmSync(abs(root, linked), { recursive: true });
      write(outside, 'figure.png', PNG);
      link(root, linked, what === 'image file' ? path.join(outside, 'figure.png') : outside);
      const checked = checkRoot(root, '_drafts/pic.md');
      expectExit(checked, 1);
      assert.match(checked.stderr, /image \/assets\/drafts\/pic\/figure\.png does not exist/);
      assert.match(checked.stderr, new RegExp(`${escapeRegExp(linked)} is a symbolic link, so the images through it `
        + 'count as missing'), 'check says why an image on disk counts as missing');

      refusedThroughLink(root, [outside], ['publish', 'pic'], [linked]);
      assert.equal(read(root, '_drafts/pic.md'), text, 'the draft stays in _drafts/');
    });
  }
});

test('[AC-03][F-017] check reports a _drafts or _posts folder that is a symbolic link instead of following it', LINK_CASE, async (t) => {
  for (const [folder, rel, namedRel] of [
    ['_drafts', 'outside.md', `_posts/${PAST}-named.md`],
    ['_posts', `${PAST}-outside.md`, '_drafts/named.md'],
  ]) {
    await t.test(`[AC-03][F-017] check refuses a linked ${folder}/`, () => {
      const root = makeRoot();
      const outside = caseDir('outside');
      write(outside, rel, validArticle({ title: 'Kept outside the root' }));
      link(root, folder, outside);
      const listed = checkRoot(root);
      expectExit(listed, 1);
      assert.match(listed.stderr, new RegExp(`error: ${folder} is a symbolic link, which check does not follow`));
      assert.doesNotMatch(listed.stdout, /outside\.md/, 'nothing is checked through the link');

      write(root, namedRel, validArticle({ title: 'Named article' }));
      const named = checkRoot(root, namedRel);
      expectExit(named, 1);
      assert.match(named.stderr, new RegExp(`error: ${folder} is a symbolic link`),
        'a named article is not checked for slug uniqueness against a folder that cannot be listed');
    });
  }
});

test('[AC-03][F-017] check refuses a named path that exists but is not a regular file by saying what it is, and a missing one as no such file', async (t) => {
  /**
   * Asserts that `check <arg>` in `root` is a usage error whose first line is
   * `error: <arg>: <reason>`, followed by the usage block, that it reports
   * nothing as checked and that it leaves the root as it was.
   */
  const refusedAsUsage = (root, arg, reason) => {
    const result = checkRoot(root, arg);
    expectExit(result, 2);
    assert.ok(result.stderr.startsWith(`error: ${arg}: ${reason}\n\nUsage: node scripts/article.mjs `), result.out);
    assert.equal(result.stdout, '', 'nothing is reported as checked');
  };

  await t.test('[AC-03][F-017] check refuses a folder', () => {
    const root = makeRoot();
    write(root, '_drafts/valid.md', validArticle());
    refusedAsUsage(root, '_drafts', 'not a regular file (a directory)');
  });

  await t.test('[AC-03][F-017] check refuses a FIFO without opening it, so the run cannot stall', {
    skip: process.platform === 'win32' ? 'Windows has no FIFOs' : false,
  }, () => {
    const root = makeRoot();
    // Outside the root: checkRoot's snapshot reads every file in the root, and reading a FIFO no one writes to blocks.
    const fifo = path.join(caseDir('fifo'), 'fifo.md');
    spawnOk('mkfifo', [fifo]);
    refusedAsUsage(root, fifo, 'not a regular file (a FIFO)');
    assert.ok(fs.lstatSync(fifo).isFIFO(), 'the FIFO is left as it was');
  });

  await t.test('[AC-03][F-017] check refuses /dev/null, a character device', {
    skip: fs.existsSync('/dev/null') ? false : 'needs /dev/null',
  }, () => {
    refusedAsUsage(makeRoot(), '/dev/null', 'not a regular file (a character device)');
  });

  await t.test('[AC-03][F-017] check refuses a dangling symbolic link and a symbolic-link loop', LINK_CASE, () => {
    const root = makeRoot();
    link(root, '_drafts/dangling.md', 'missing-target.md');
    refusedAsUsage(root, '_drafts/dangling.md', 'not a regular file (a symbolic link that leads to no file)');
    link(root, '_drafts/loop.md', 'loop.md');
    refusedAsUsage(root, '_drafts/loop.md', 'not a regular file (a symbolic link that leads to no file)');
  });

  await t.test('[AC-03][F-017] check still refuses a missing path as no such file', () => {
    refusedAsUsage(makeRoot(), '_drafts/missing.md', 'no such file');
  });
});

test('[AC-03][F-017] the root itself may be a symbolic link, as os.tmpdir() is on macOS', LINK_CASE, () => {
  const root = makeRoot();
  const linkedRoot = path.join(PARENT, `${path.basename(root)}-link`);
  fs.symlinkSync(root, linkedRoot);
  expectExit(run(['new', 'via-link', '--root', linkedRoot], { cwd: root }), 0);
  assert.deepEqual(fs.readFileSync(abs(root, '_drafts/via-link.md')), fs.readFileSync(TEMPLATE));
  write(root, '_drafts/via-link.md', validArticle({ title: 'Through a linked root' }));
  expectExit(run(['publish', 'via-link', '--root', linkedRoot], { cwd: root }), 0);
  assert.equal(postsFor(root, 'via-link').length, 1, 'the post is written in the real root');
});

test('[AC-03][F-017] a failure after a folder became a symbolic link rolls nothing back through the link', LINK_CASE, () => {
  const root = makeRoot();
  const outside = caseDir('outside');
  // A copy of the draft new writes, which a rollback through the link would delete as its own.
  write(outside, 'swap.md', fs.readFileSync(TEMPLATE));
  const out = path.join(root, '..', `${path.basename(root)}-swap.json`);
  // Run as new creates the image folder: the draft is written, _drafts/ becomes a link and assets/ a file.
  const swap = [
    "const fs = require('node:fs');",
    "fs.renameSync('_drafts', 'moved-drafts');",
    `fs.symlinkSync(${JSON.stringify(outside)}, '_drafts');`,
    "fs.writeFileSync('assets', 'a file, not a folder');",
  ].join('\n');
  const result = unchangedBy(
    () => treeSnapshot(outside),
    () => cliWithFaults(root, [{
      fn: 'mkdirSync', path: 'assets/drafts/swap', action: 'run-tool', argv: ['-e', swap], cwd: root, out,
    }], 'new', 'swap'),
    `the folder ${outside} that _drafts/ was linked to`,
  );
  const swapped = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(swapped.status, 0, `the swap ran:\n${swapped.stderr}`);
  expectExit(result, 1);
  assert.match(result.stderr, /new failed: cannot create assets\/drafts\/swap\//);
  assert.match(result.stderr, /rollback skipped: _drafts is a symbolic link; it must be a real folder/);
  assert.match(result.stderr, /not every change could be rolled back; fix these paths by hand/);
  assert.doesNotMatch(result.stderr, /every change was rolled back/);
  assert.deepEqual(fs.readFileSync(abs(root, 'moved-drafts/swap.md')), fs.readFileSync(TEMPLATE),
    'the draft written before the swap is left for repair by hand');
});

test('[AC-03][F-017] a short write leaves no partial file behind, and the command can then be run again', async (t) => {
  const shortWrite = (pathPart) => [{ fn: 'writeSync', path: pathPart, action: 'short-write', code: 'ENOSPC' }];

  await t.test('[AC-03][F-017] new: a short write of the draft leaves no _drafts/<slug>.md', () => {
    const root = makeRoot();
    const failed = cliWithFaults(root, shortWrite('_drafts/short.md'), 'new', 'short');
    expectExit(failed, 1);
    assert.match(failed.stderr, /new failed: cannot write _drafts\/short\.md \(ENOSPC/);
    assert.match(failed.stderr, /every change was rolled back/);
    assert.equal(exists(root, '_drafts/short.md'), false, 'no partial draft is left');
    assert.equal(exists(root, 'assets/drafts/short'), false, 'no image folder is created');

    expectExit(cli(root, 'new', 'short'), 0);
    assert.deepEqual(fs.readFileSync(abs(root, '_drafts/short.md')), fs.readFileSync(TEMPLATE),
      'the retry writes the whole template');
  });

  await t.test('[AC-03][F-017] publish: a short write of the post leaves no partial post', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'short');
    const failed = cliWithFaults(root, shortWrite('_posts/'), 'publish', 'short');
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: cannot write _posts\/\S+-short\.md \(ENOSPC/);
    assert.match(failed.stderr, /every change was rolled back/);
    assert.deepEqual(list(root, '_posts'), [], 'no partial post is left');
    assertStillDraft(root, 'short', text);
    assertRetryPublishes(root, 'short');
  });

  await t.test('[AC-03][F-017] unpublish: a short write of the draft leaves no partial draft', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'short');
    const failed = cliWithFaults(root, shortWrite('_drafts/short.md'), 'unpublish', 'short');
    expectExit(failed, 1);
    assert.match(failed.stderr, /unpublish failed: cannot write _drafts\/short\.md \(ENOSPC/);
    assert.match(failed.stderr, /every change was rolled back/);
    assert.deepEqual(list(root, '_drafts'), [], 'no partial draft is left');
    assertStillPost(root, 'short', post);
    assertRetryUnpublishes(root, 'short', post);
  });
});

test('[AC-03][F-017] a failure removing the source undoes every earlier step, and the command can then be run again', async (t) => {
  // The source is first set aside with a rename, then given a backup name,
  // then the set-aside name is removed: a failure at any step of that commit
  // point is undone, the backup name included.
  const unlinkFault = (pathPart) => [{ fn: 'unlinkSync', path: pathPart, action: 'throw', code: 'EPERM' }];
  const renameFault = (pathPart) => [{ fn: 'renameSync', path: pathPart, action: 'throw', code: 'EPERM' }];

  await t.test('[AC-03][F-017] publish: when the draft cannot be removed, the post goes and the images return', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'stuck');
    const failed = cliWithFaults(root, unlinkFault('_drafts/.stuck.publishing'), 'publish', 'stuck');
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: cannot remove _drafts\/stuck\.md \(EPERM/);
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assertStillDraft(root, 'stuck', text);
    assert.equal(exists(root, '_drafts/.stuck.publishing'), false, 'no set-aside copy is left');
    assert.equal(exists(root, '_drafts/.stuck.publish-backup'), false, 'the backup name made for it is removed');
    assertRetryPublishes(root, 'stuck');
  });

  await t.test('[AC-03][F-017] publish: when the set-aside copy cannot be removed at all, the draft is back and a retry clears the copy', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'stuck');
    const twice = [...unlinkFault('_drafts/.stuck.publishing'), ...unlinkFault('_drafts/.stuck.publishing')];
    const failed = cliWithFaults(root, twice, 'publish', 'stuck');
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: cannot remove _drafts\/stuck\.md \(EPERM/);
    assert.match(failed.stderr, /rollback failed: cannot remove the set-aside copy _drafts\/\.stuck\.publishing \(EPERM/);
    assert.match(failed.stderr, /present: _drafts\/stuck\.md, assets\/drafts\/stuck\/, _drafts\/\.stuck\.publishing/);
    assert.doesNotMatch(failed.stderr, /rolled back and/, 'no completed rollback is claimed');
    assertStillDraft(root, 'stuck', text);
    assert.equal(read(root, '_drafts/.stuck.publishing'), text, 'the leftover is an identical copy');

    const retried = cli(root, 'publish', 'stuck');
    expectExit(retried, 0);
    assert.match(retried.stderr, /removed _drafts\/\.stuck\.publishing, an identical copy of _drafts\/stuck\.md/);
    assert.equal(exists(root, '_drafts/.stuck.publishing'), false);
    assert.equal(postsFor(root, 'stuck').length, 1);
  });

  await t.test('[AC-03][F-017] publish: when the draft cannot be set aside, the post goes and the images return', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'stuck');
    const failed = cliWithFaults(root, renameFault('_drafts/stuck.md'), 'publish', 'stuck');
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: cannot set _drafts\/stuck\.md aside as _drafts\/\.stuck\.publishing \(EPERM/);
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assertStillDraft(root, 'stuck', text);
    assertRetryPublishes(root, 'stuck');
  });

  await t.test('[AC-03][F-017] publish without images: the empty image folder made by new is restored', () => {
    const root = makeRoot();
    expectExit(cli(root, 'new', 'stuck'), 0);
    const text = validArticle({ title: 'No images' });
    write(root, '_drafts/stuck.md', text);
    const failed = cliWithFaults(root, unlinkFault('_drafts/.stuck.publishing'), 'publish', 'stuck');
    expectExit(failed, 1);
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assert.equal(read(root, '_drafts/stuck.md'), text, 'the draft is unchanged');
    assert.deepEqual(postsFor(root, 'stuck'), [], 'no post is left in _posts/');
    assert.ok(fs.statSync(abs(root, 'assets/drafts/stuck')).isDirectory(), 'the empty image folder is back');

    expectExit(cli(root, 'publish', 'stuck'), 0);
    assert.equal(postsFor(root, 'stuck').length, 1);
    assert.equal(exists(root, 'assets/drafts/stuck'), false);
  });

  await t.test('[AC-03][F-017] unpublish: when the post cannot be removed, its images stay published with it', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'stuck');
    const failed = cliWithFaults(root, unlinkFault('_drafts/.stuck.unpublishing'), 'unpublish', 'stuck');
    expectExit(failed, 1);
    assert.match(failed.stderr, new RegExp(`unpublish failed: cannot remove ${escapeRegExp(post.rel)} \\(EPERM`));
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assertStillPost(root, 'stuck', post);
    assert.equal(exists(root, '_drafts/.stuck.unpublishing'), false, 'no set-aside copy is left');
    assert.equal(exists(root, '_drafts/.stuck.unpublish-backup'), false, 'the backup name made for it is removed');
    assertRetryUnpublishes(root, 'stuck', post);
  });

  await t.test('[AC-03][F-017] unpublish: when the post cannot be set aside, its images stay published with it', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'stuck');
    const failed = cliWithFaults(root, renameFault(post.rel), 'unpublish', 'stuck');
    expectExit(failed, 1);
    assert.match(failed.stderr, new RegExp(`unpublish failed: cannot set ${escapeRegExp(post.rel)} aside \\S+ \\S+ \\(EPERM`));
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assertStillPost(root, 'stuck', post);
    assertRetryUnpublishes(root, 'stuck', post);
  });
});

test('[AC-03][F-017] a rollback that fails is reported with the original error and what remains, never as completed', async (t) => {
  await t.test('[AC-03][F-017] publish: the image move fails, and so does removing the new post', () => {
    const root = makeRoot();
    writeDraftWithImage(root, 'tangle');
    const failed = cliWithFaults(root, [
      { fn: 'renameSync', path: 'assets/drafts/tangle', action: 'throw', code: 'EXDEV' },
      { fn: 'unlinkSync', path: '_posts/', action: 'throw', code: 'EACCES' },
    ], 'publish', 'tangle');
    expectExit(failed, 1);
    assert.match(failed.stderr,
      /publish failed: cannot move assets\/drafts\/tangle\/ to assets\/blog\/tangle\/ \(EXDEV/,
      'the original error is reported');
    assert.match(failed.stderr, /rollback failed: cannot remove _posts\/\S+-tangle\.md \(EACCES/,
      'the rollback error is reported');
    assert.match(failed.stderr, /present: _drafts\/tangle\.md, _posts\/\S+-tangle\.md, assets\/drafts\/tangle\//,
      'the files that remain are listed');
    assert.match(failed.stderr, /missing: assets\/blog\/tangle\//);
    assert.doesNotMatch(failed.stderr, /rolled back and/, 'no completed rollback is claimed');
    assert.ok(exists(root, '_drafts/tangle.md'), 'the draft is kept');
    assert.equal(postsFor(root, 'tangle').length, 1, 'the post the rollback could not remove remains, as reported');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/drafts/tangle/figure.png')), PNG, 'the image never moved');
  });

  await t.test('[AC-03][F-017] unpublish: the image move fails, and so does removing the new draft', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'tangle');
    const failed = cliWithFaults(root, [
      { fn: 'renameSync', path: 'assets/blog/tangle', action: 'throw', code: 'EXDEV' },
      { fn: 'unlinkSync', path: '_drafts/', action: 'throw', code: 'EACCES' },
    ], 'unpublish', 'tangle');
    expectExit(failed, 1);
    assert.match(failed.stderr,
      /unpublish failed: cannot move assets\/blog\/tangle\/ to assets\/drafts\/tangle\/ \(EXDEV/,
      'the original error is reported');
    assert.match(failed.stderr, /rollback failed: cannot remove _drafts\/tangle\.md \(EACCES/,
      'the rollback error is reported');
    assert.match(failed.stderr,
      new RegExp(`present: ${escapeRegExp(post.rel)}, _drafts/tangle\\.md, assets/blog/tangle/`),
      'the files that remain are listed');
    assert.match(failed.stderr, /missing: assets\/drafts\/tangle\//);
    assert.doesNotMatch(failed.stderr, /rolled back and/, 'no completed rollback is claimed');
    assert.equal(read(root, post.rel), post.text, 'the live post is untouched');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/tangle/figure.png')), PNG, 'its image never moved');
  });
});

test('[AC-03][F-017] an edit saved while publish or unpublish runs is neither published unchecked nor lost', async (t) => {
  const SCRIPT = '\n<script>alert(1)</script>\n';
  /** Appends `text` to `file` when the tool opens a path containing `opened`, after it read the article. */
  const editWhenOpened = (opened, file, text) => [
    { fn: 'openSync', path: opened, action: 'append-to-file', file, text },
  ];

  await t.test('[AC-03][F-017] publish: a <script> saved into the draft after the check is refused and kept', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'race');
    const faults = editWhenOpened('_posts/', abs(root, '_drafts/race.md'), SCRIPT);
    const failed = cliWithFaults(root, faults, 'publish', 'race');
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: _drafts\/race\.md changed while publishing; your edit is kept/);
    assert.match(failed.stderr, /every change was rolled back/);
    assert.equal(read(root, '_drafts/race.md'), text + SCRIPT, 'the draft holds the edit');
    assert.deepEqual(postsFor(root, 'race'), [], 'nothing unchecked is published');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/drafts/race/figure.png')), PNG,
      'the image is back in assets/drafts/');
    assert.equal(exists(root, 'assets/blog/race'), false);
  });

  await t.test('[AC-03][F-017] publish without images writes the checked bytes, and refuses an edit made after the check', () => {
    const root = makeRoot();
    const checked = Buffer.from(validArticle({
      title: 'Café notes — naïve bytes',
      body: 'Ünïcödé body, kept byte for byte.',
    }));
    write(root, '_drafts/exact.md', checked);
    const faults = editWhenOpened('_posts/', abs(root, '_drafts/exact.md'), SCRIPT);
    const failed = cliWithFaults(root, faults, 'publish', 'exact');
    expectExit(failed, 1);
    assert.match(failed.stderr, /_drafts\/exact\.md changed while publishing; your edit is kept/);
    assert.deepEqual(fs.readFileSync(abs(root, '_drafts/exact.md')), Buffer.concat([checked, Buffer.from(SCRIPT)]),
      'the draft holds the edit');
    assert.deepEqual(postsFor(root, 'exact'), [], 'nothing unchecked is published');

    write(root, '_drafts/exact.md', checked);
    expectExit(cli(root, 'publish', 'exact'), 0);
    const posts = postsFor(root, 'exact');
    assert.equal(posts.length, 1);
    assert.deepEqual(fs.readFileSync(abs(root, `_posts/${posts[0]}`)), checked,
      'the post is exactly the checked bytes');
  });

  await t.test('[AC-03][F-017] unpublish: an edit saved into the post meanwhile keeps the post and its images', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'race');
    const edit = '\nA late correction.\n';
    const failed = cliWithFaults(root, editWhenOpened('_drafts/race.md', abs(root, post.rel), edit), 'unpublish', 'race');
    expectExit(failed, 1);
    assert.match(failed.stderr,
      new RegExp(`${escapeRegExp(post.rel)} changed while unpublishing; your edit is kept`));
    assert.match(failed.stderr, /every change was rolled back/);
    assertStillPost(root, 'race', { rel: post.rel, text: post.text + edit });
  });
});

test('[AC-03][F-017] a save landing at the commit point is never deleted with the source', async (t) => {
  const NEWER = 'A newer save from the editor.\n';
  /** Saves `NEWER` at `file` (by path, as an editor does) when the tool calls `fn` on a path containing `at`. */
  const saveWhen = (fn, at, file) => [{ fn, path: at, action: 'append-to-file', file, text: NEWER }];

  await t.test('[AC-03][F-017] publish: a save after the draft is set aside, before its check, is refused and kept', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'late');
    const failed = cliWithFaults(root,
      saveWhen('readFileSync', '_drafts/.late.publishing', abs(root, '_drafts/late.md')), 'publish', 'late');
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: _drafts\/late\.md was saved again while publishing; your edit is kept/);
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assert.equal(read(root, '_drafts/late.md'), NEWER, 'the newer save is the draft');
    assert.notEqual(read(root, '_drafts/late.md'), text);
    assert.deepEqual(postsFor(root, 'late'), [], 'nothing is published');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/drafts/late/figure.png')), PNG, 'the image is back');
    assert.equal(exists(root, '_drafts/.late.publishing'), false, 'the superseded set-aside copy is removed');
  });

  await t.test('[AC-03][F-017] publish: a save after the check, as the set-aside copy is removed, is kept and reported', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'late');
    const result = cliWithFaults(root,
      saveWhen('unlinkSync', '_drafts/.late.publishing', abs(root, '_drafts/late.md')), 'publish', 'late');
    expectExit(result, 0);
    assert.match(result.stderr, /_drafts\/late\.md was saved again as publishing finished/);
    const posts = postsFor(root, 'late');
    assert.equal(posts.length, 1, 'the checked text is published');
    assert.equal(read(root, `_posts/${posts[0]}`), text.split('/assets/drafts/late/').join('/assets/blog/late/'));
    assert.equal(read(root, '_drafts/late.md'), NEWER, 'the newer save is kept, not deleted');
  });

  await t.test('[AC-03][F-017] unpublish: a save of the post after it is set aside is refused and kept', () => {
    const root = makeRoot();
    writePostWithImage(root, 'late');
    const postRel = `_posts/${PAST}-late.md`;
    const failed = cliWithFaults(root,
      saveWhen('readFileSync', '_drafts/.late.unpublishing', abs(root, postRel)), 'unpublish', 'late');
    expectExit(failed, 1);
    assert.match(failed.stderr,
      new RegExp(`${escapeRegExp(postRel)} was saved again while unpublishing; your edit is kept`));
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assert.equal(read(root, postRel), NEWER, 'the newer save is the post');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/late/figure.png')), PNG, 'its image stays published');
    assert.equal(exists(root, '_drafts/late.md'), false, 'no draft is left');
    assert.equal(exists(root, '_drafts/.late.unpublishing'), false, 'the superseded set-aside copy is removed');
  });
});

test('[AC-03][F-017] a per-slug lock serializes new, publish and unpublish, and a stale lock never blocks a retry', async (t) => {
  const lockRel = (slug) => `_drafts/.${slug}.lock`;

  await t.test('[AC-03][F-017] a competing publish dated the next UTC day is refused while the first one runs', () => {
    const root = makeRoot();
    write(root, '_drafts/race.md', validArticle({ title: 'Race' }));
    const out = path.join(root, '..', `${path.basename(root)}-competitor.json`);
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const competitorArgv = [ARTICLE_MJS, 'publish', 'race', '--root', root];
    // Both runs use the zone (the competitor inherits it), so only the competitor's clock differs: a UTC day ahead.
    const zone = offUtcZone();
    const dateBefore = todayUtc();
    const first = cliWith(root, { env: zone, faults: [{
      fn: 'openSync',
      path: '_posts/',
      action: 'run-tool',
      argv: competitorArgv,
      cwd: root,
      env: { ARTICLE_FAKE_NOW: tomorrow },
      out,
    }] }, 'publish', 'race');
    const dateAfter = todayUtc();
    assert.ok(fs.existsSync(out), `the competing run was started while the first one ran:\n${first.out}`);
    const competitor = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(
      { status: competitor.status, signal: competitor.signal, error: competitor.error },
      { status: 1, signal: null, error: null },
      `the competing run ran to completion and is refused:\n${
        describeSpawn(process.execPath, ['--import', FAULT_PRELOAD_URL, ...competitorArgv], root, competitor)}`,
    );
    assert.match(competitor.stderr,
      new RegExp(`another article\\.mjs run \\(process \\d+ on ${escapeRegExp(os.hostname())}\\) is changing slug race`));
    expectExit(first, 0);
    const posts = postsFor(root, 'race');
    assert.equal(posts.length, 1, 'exactly one post, so the slug is published once');
    assert.ok([dateBefore, dateAfter].includes(posts[0].slice(0, 10)),
      `the first run's post ${posts[0]} carries the UTC date of the run (${dateBefore}/${dateAfter})`);
    assert.equal(exists(root, '_drafts/race.md'), false);
    assert.equal(exists(root, lockRel('race')), false, 'the lock is released');
    expectExit(cliWith(root, { env: zone }, 'check'), 0);
  });

  await t.test('[AC-03][F-017] a lock left by a process that no longer runs is replaced', () => {
    const root = makeRoot();
    write(root, '_drafts/stale.md', validArticle({ title: 'Stale lock' }));
    const gone = spawnOk(process.execPath, ['-e', '']);
    write(root, lockRel('stale'), `${gone.pid} ${os.hostname()}\n`);
    const result = cli(root, 'publish', 'stale');
    expectExit(result, 0);
    assert.match(result.stderr, new RegExp(`replaced the stale lock ${escapeRegExp(lockRel('stale'))}`));
    assert.equal(postsFor(root, 'stale').length, 1);
    assert.equal(exists(root, lockRel('stale')), false, 'the lock is released');
  });

  await t.test('[AC-03][F-017] a lock held by a running process, or one that names no process, refuses and is kept', () => {
    for (const held of [`${process.pid} ${os.hostname()}\n`, 'not a lock record']) {
      const root = makeRoot();
      const text = validArticle({ title: 'Held lock' });
      write(root, '_drafts/held.md', text);
      write(root, lockRel('held'), held);
      for (const args of [['publish', 'held'], ['new', 'held'], ['unpublish', 'held']]) {
        const result = cli(root, ...args);
        expectExit(result, 1);
        assert.match(result.stderr, /another article\.mjs run .*is changing slug held/);
        assert.match(result.stderr, new RegExp(`delete ${escapeRegExp(lockRel('held'))} first`));
      }
      assert.equal(read(root, '_drafts/held.md'), text, 'the draft is untouched');
      assert.deepEqual(postsFor(root, 'held'), [], 'nothing is published');
      assert.equal(read(root, lockRel('held')), held, 'the other run\'s lock is kept');
    }
  });

  await t.test('[AC-03][F-017] a set-aside copy left by an interrupted publish refuses before anything moves', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'left');
    write(root, '_drafts/.left.publishing', 'an earlier copy');
    const result = cli(root, 'publish', 'left');
    expectExit(result, 1);
    assert.match(result.stderr, /_drafts\/\.left\.publishing is left from an interrupted publish/);
    assertStillDraft(root, 'left', text);
    assert.equal(read(root, '_drafts/.left.publishing'), 'an earlier copy', 'it is not overwritten');
  });
});

/* Next steps and --root                                                     */

test('[AC-03][F-017] the next steps start with a quoted cd to --root when the tool runs from another folder, and only then', () => {
  const base = caseDir('elsewhere');
  const root = path.join(base, "it's a $root");
  write(root, '_config.yml', SITE_CONFIG);
  write(root, '_templates/article.md', fs.readFileSync(TEMPLATE));
  const fromBase = (...args) => run([...args, '--root', root], { cwd: base });
  const cdLines = (result) => result.stdout.split('\n').filter((line) => line.startsWith('  cd '));
  /** The folder a printed `cd` line lands in when pasted into a POSIX shell, which must succeed. */
  const landsIn = (line) => spawnOk('sh', ['-c', `${line} && pwd -P`]).stdout.trim();

  const created = fromBase('new', 'away');
  expectExit(created, 0);
  const lines = cdLines(created);
  assert.equal(lines.length, 1, `new prints one cd line:\n${created.stdout}`);
  const [cdLine] = lines;
  assert.match(created.stdout, /Next:\n {2}cd /, 'the cd line comes first');
  assert.equal(landsIn(cdLine), root, 'the quoted cd reaches the root');
  assert.ok(created.stderr.includes(`git -C ${cdLine.slice('  cd '.length)} config core.hooksPath .githooks`),
    `the hooks hint names the root as well:\n${created.stderr}`);

  write(root, '_drafts/away.md', validArticle());
  const published = fromBase('publish', 'away');
  expectExit(published, 0);
  assert.deepEqual(cdLines(published), [cdLine]);
  assert.match(published.stdout, /Next:\n {2}cd /);
  const unpublished = fromBase('unpublish', 'away');
  expectExit(unpublished, 0);
  assert.deepEqual(cdLines(unpublished), [cdLine]);
  assert.match(unpublished.stdout, /Next:\n {2}cd /);

  const createdHere = cli(root, 'new', 'here');
  expectExit(createdHere, 0);
  assert.deepEqual(cdLines(createdHere), [], 'no cd line when run from the root');
  assert.match(createdHere.stderr, /run: git config core\.hooksPath \.githooks/);
  write(root, '_drafts/here.md', validArticle({ title: 'Here' }));
  const publishedHere = cli(root, 'publish', 'here');
  expectExit(publishedHere, 0);
  assert.deepEqual(cdLines(publishedHere), []);
  const unpublishedHere = cli(root, 'unpublish', 'here');
  expectExit(unpublishedHere, 0);
  assert.deepEqual(cdLines(unpublishedHere), []);
});

test('[AC-03][F-017] the printed git add and git rm commands pass each path as one argument and run nothing, even for a post folder named with quotes and $(…)', () => {
  const root = makeRoot();
  const stubDir = caseDir('git-argv');
  const argvFile = path.join(stubDir, 'argv');
  fs.writeFileSync(path.join(stubDir, 'git'), ['#!/bin/sh', `printf '%s\\0' "$@" > ${shQuote(argvFile)}`, ''].join('\n'),
    { mode: 0o755 });
  /** The arguments `git` receives when the one printed staging line (`git add` or `git rm`) of `result` is pasted into a POSIX shell. */
  const pastedArgv = (result) => {
    const lines = result.stdout.split('\n').filter((line) => /^ {2}git (?:add|rm) /.test(line));
    assert.equal(lines.length, 1, `one git add or git rm line:\n${result.stdout}`);
    fs.rmSync(argvFile, { force: true });
    spawnOk('sh', ['-c', lines[0]], { cwd: root, env: { ...ENV, PATH: `${stubDir}${path.delimiter}${ENV.PATH ?? ''}` } });
    return fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
  };

  const created = cli(root, 'new', 'odd');
  expectExit(created, 0);
  assert.ok(created.stdout.includes('  3. node scripts/article.mjs check _drafts/odd.md\n'),
    `an ordinary path is printed as it is:\n${created.stdout}`);
  writeDraftWithImage(root, 'odd');
  const published = cli(root, 'publish', 'odd');
  expectExit(published, 0);
  const [postFile] = postsFor(root, 'odd');
  assert.deepEqual(pastedArgv(published), ['add', '--', `_posts/${postFile}`, 'assets/blog/odd']);

  const folder = `it's "a" \`touch tick\` $(touch marker) \\ folder`;
  const nestedRel = `_posts/${folder}/${postFile}`;
  fs.mkdirSync(abs(root, `_posts/${folder}`));
  fs.renameSync(abs(root, `_posts/${postFile}`), abs(root, nestedRel));
  const unpublished = cli(root, 'unpublish', 'odd');
  expectExit(unpublished, 0);
  assert.deepEqual(pastedArgv(unpublished), ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', nestedRel,
    'assets/blog/odd'], 'the nested post path reaches git as one argument, byte for byte');
  assert.equal(exists(root, 'marker'), false, 'no $(…) in the path ran');
  assert.equal(exists(root, 'tick'), false, 'no backtick command in the path ran');
});

test('[AC-03][F-017] a stale lock is replaced by one run only, under a reclaim token, and a live lock is never removed', async (t) => {
  const lockRel = (slug) => `_drafts/.${slug}.lock`;
  const tokenRel = (slug) => `${lockRel(slug)}.reclaim`;
  const host = escapeRegExp(os.hostname());
  /** A `<pid> <host>` record naming a process of this host that has exited. */
  const goneRecord = () => `${spawnOk(process.execPath, ['-e', '']).pid} ${os.hostname()}\n`;
  /** What a `run-tool` rule wrote to `out`, failing unless that run took place while `first` ran. */
  const ranMeanwhile = (out, first) => {
    assert.ok(fs.existsSync(out), `the competing run was started while the first one ran:\n${first.out}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };

  await t.test('[AC-03][F-017] a publish started inside another one\'s replacement of the stale lock is refused, and that run\'s lock stays live', () => {
    const root = makeRoot();
    write(root, '_drafts/race.md', validArticle({ title: 'Race' }));
    write(root, lockRel('race'), goneRecord());
    const outInside = path.join(root, '..', `${path.basename(root)}-inside.json`);
    const outAfter = path.join(root, '..', `${path.basename(root)}-after.json`);
    const competitor = (out) => ({
      action: 'run-tool', argv: [ARTICLE_MJS, 'publish', 'race', '--root', root], cwd: root, out,
    });
    const first = cliWithFaults(root, [
      // As the first run, holding the token, removes the stale lock.
      { fn: 'unlinkSync', path: lockRel('race'), ...competitor(outInside) },
      // Once the first run holds its own lock and writes the post.
      { fn: 'openSync', path: '_posts/', ...competitor(outAfter) },
    ], 'publish', 'race');

    const inside = ranMeanwhile(outInside, first);
    assert.equal(inside.status, 1, `the run inside the replacement is refused:\n${inside.stderr}`);
    assert.match(inside.stderr, new RegExp(`another article\\.mjs run \\(process \\d+ on ${host}\\) is replacing the stale `
      + `lock ${escapeRegExp(lockRel('race'))}; run publish again once it has finished`));
    assert.match(inside.stderr, new RegExp(`delete ${escapeRegExp(tokenRel('race'))} first; nothing was changed`));
    const after = ranMeanwhile(outAfter, first);
    assert.equal(after.status, 1, `a run while the first one holds its lock is refused:\n${after.stderr}`);
    assert.match(after.stderr, new RegExp(`another article\\.mjs run \\(process \\d+ on ${host}\\) is changing slug race`),
      'the lock the first run took is live');

    expectExit(first, 0);
    assert.match(first.stderr, new RegExp(`replaced the stale lock ${escapeRegExp(lockRel('race'))}`));
    assert.equal(postsFor(root, 'race').length, 1, 'exactly one run published the slug');
    assert.equal(exists(root, '_drafts/race.md'), false);
    assert.equal(exists(root, lockRel('race')), false, 'the lock is released');
    assert.equal(exists(root, tokenRel('race')), false, 'the token is released');
  });

  await t.test('[AC-03][F-017] a run whose stale reading is overtaken by a live lock before it takes the token leaves that lock alone', () => {
    const root = makeRoot();
    const text = validArticle({ title: 'Overtaken' });
    write(root, '_drafts/overtaken.md', text);
    write(root, lockRel('overtaken'), goneRecord());
    const live = `${process.pid} ${os.hostname()}\n`;
    const out = path.join(root, '..', `${path.basename(root)}-overtake.json`);
    const writeLive = `require('node:fs').writeFileSync(${JSON.stringify(abs(root, lockRel('overtaken')))}, ${
      JSON.stringify(live)})`;
    // Another run replaces the stale lock with its own, live one just before this run creates the token.
    const result = cliWithFaults(root, [
      { fn: 'openSync', path: tokenRel('overtaken'), action: 'run-tool', argv: ['-e', writeLive], cwd: root, out },
    ], 'publish', 'overtaken');
    assert.equal(ranMeanwhile(out, result).status, 0, 'the live lock was written');
    expectExit(result, 1);
    assert.match(result.stderr,
      new RegExp(`another article\\.mjs run \\(process ${process.pid} on ${host}\\) is changing slug overtaken`));
    assert.doesNotMatch(result.stderr, /replaced the stale lock/);
    assert.equal(read(root, lockRel('overtaken')), live, 'the live lock is kept');
    assert.equal(exists(root, tokenRel('overtaken')), false, 'the token is released');
    assert.equal(read(root, '_drafts/overtaken.md'), text, 'the draft is untouched');
    assert.deepEqual(postsFor(root, 'overtaken'), [], 'nothing is published');
  });

  await t.test('[AC-03][F-017] a reclaim token left by a stopped run, or held by a running one, refuses until it is deleted by hand', () => {
    const cases = [
      [goneRecord(), new RegExp(`${escapeRegExp(tokenRel('left'))} was left by process \\d+, which stopped while `
        + `replacing the stale lock ${escapeRegExp(lockRel('left'))}`)],
      [`${process.pid} ${os.hostname()}\n`, new RegExp(`another article\\.mjs run \\(process ${process.pid} on ${host}\\) `
        + `is replacing the stale lock ${escapeRegExp(lockRel('left'))}`)],
    ];
    for (const [token, message] of cases) {
      const root = makeRoot();
      const text = validArticle({ title: 'Left token' });
      write(root, '_drafts/left.md', text);
      const stale = goneRecord();
      write(root, lockRel('left'), stale);
      write(root, tokenRel('left'), token);
      const refused = cli(root, 'publish', 'left');
      expectExit(refused, 1);
      assert.match(refused.stderr, message);
      assert.match(refused.stderr, new RegExp(`delete ${escapeRegExp(tokenRel('left'))}`));
      assert.equal(read(root, tokenRel('left')), token, 'the token is never removed automatically');
      assert.equal(read(root, lockRel('left')), stale, 'the stale lock stays while the token is taken');
      assert.equal(read(root, '_drafts/left.md'), text, 'the draft is untouched');
      assert.deepEqual(postsFor(root, 'left'), [], 'nothing is published');

      fs.unlinkSync(abs(root, tokenRel('left')));
      const retried = cli(root, 'publish', 'left');
      expectExit(retried, 0);
      assert.match(retried.stderr, new RegExp(`replaced the stale lock ${escapeRegExp(lockRel('left'))}`));
      assert.equal(postsFor(root, 'left').length, 1, 'the retry publishes');
      assert.equal(exists(root, lockRel('left')), false, 'the lock is released');
      assert.equal(exists(root, tokenRel('left')), false, 'no token is left');
    }
  });

  await t.test('[AC-03][F-017] a stale lock that cannot be removed refuses the run and releases the token', () => {
    const root = makeRoot();
    const text = validArticle({ title: 'Stuck lock' });
    write(root, '_drafts/stuck.md', text);
    const stale = goneRecord();
    write(root, lockRel('stuck'), stale);
    const result = cliWithFaults(root, [{ fn: 'unlinkSync', path: lockRel('stuck'), action: 'throw', code: 'EACCES' }],
      'publish', 'stuck');
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`publish failed: cannot replace the stale lock ${escapeRegExp(lockRel('stuck'))} `
      + `\\(EACCES[^)]*\\); delete ${escapeRegExp(lockRel('stuck'))} by hand, then run publish again; nothing was changed`));
    assert.equal(read(root, lockRel('stuck')), stale, 'the stale lock is kept');
    assert.equal(exists(root, tokenRel('stuck')), false, 'the token is released');
    assert.equal(read(root, '_drafts/stuck.md'), text, 'the draft is untouched');
    assert.deepEqual(postsFor(root, 'stuck'), [], 'nothing is published');
  });
});

test('[AC-03][F-017] publish never deletes an image saved into the empty draft image folder while it is removed', () => {
  const root = makeRoot();
  expectExit(cli(root, 'new', 'arrival'), 0);
  const text = validArticle({ title: 'An image arrives late' });
  write(root, '_drafts/arrival.md', text);
  fs.mkdirSync(abs(root, 'assets/drafts/arrival/raw'));
  const imageRel = 'assets/drafts/arrival/figure.png';
  const LATE = 'image bytes saved as publish removed the empty folders';
  // Saved after the emptiness check, as the deepest empty folder is removed.
  const failed = cliWithFaults(root, [
    { fn: 'rmdirSync', path: 'assets/drafts/arrival/raw', action: 'append-to-file', file: abs(root, imageRel), text: LATE },
  ], 'publish', 'arrival');
  expectExit(failed, 1);
  assert.match(failed.stderr, /publish failed: assets\/drafts\/arrival\/ gained a file while publishing; it is kept/);
  assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
  assert.equal(read(root, imageRel), LATE, 'the image saved meanwhile is kept');
  assert.ok(fs.statSync(abs(root, 'assets/drafts/arrival/raw')).isDirectory(), 'the subfolder already removed is recreated');
  assert.equal(read(root, '_drafts/arrival.md'), text, 'the draft is unchanged');
  assert.deepEqual(postsFor(root, 'arrival'), [], 'nothing is published');
  assert.equal(exists(root, 'assets/blog/arrival'), false, 'no published image folder');

  expectExit(cli(root, 'publish', 'arrival'), 0);
  assert.equal(postsFor(root, 'arrival').length, 1, 'the retry publishes');
  assert.equal(read(root, 'assets/blog/arrival/figure.png'), LATE, 'the retry moves the image with the article');
  assert.equal(exists(root, 'assets/drafts/arrival'), false, 'the draft image folder is gone');
});

test('[AC-03][F-017] publish and unpublish keep the article they retire as a backup, so a write through a file still open is never lost', async (t) => {
  const LATE = '\nA late edit written through a file the editor kept open.\n';
  const backupRel = (slug, command, n = 1) => `_drafts/.${slug}.${command}-backup${n > 1 ? `-${n}` : ''}`;
  /**
   * Opens `rel` for appending before `runTool` runs and writes `LATE` through
   * that descriptor once the tool has exited, as an editor that kept the file
   * open would; returns what `runTool` returned.
   */
  const writeAfterExit = (root, rel, runTool) => {
    const fd = fs.openSync(abs(root, rel), 'a');
    try {
      const result = runTool();
      fs.writeSync(fd, LATE);
      return result;
    } finally {
      fs.closeSync(fd);
    }
  };
  const keptMessage = (sourceRel, keptRel) => new RegExp(`Kept the checked ${escapeRegExp(sourceRel)} as `
    + `${escapeRegExp(keptRel)} \\(git-ignored\\), in case a program still has it open; delete it once you no longer `
    + 'need it\\.');
  const lateMessage = (sourceRel, command, resultRel, keptRel) => new RegExp(`${escapeRegExp(sourceRel)} was written `
    + `to through a file still open as ${command}ing finished: ${escapeRegExp(resultRel)} holds the checked text, `
    + `and that later edit is in ${escapeRegExp(keptRel)};`);

  await t.test('[AC-03][F-017] publish: a write through a descriptor held across the whole run lands in the backup', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'open');
    const result = writeAfterExit(root, '_drafts/open.md', () => cli(root, 'publish', 'open'));
    expectExit(result, 0);
    const [postFile] = postsFor(root, 'open');
    assert.match(result.stdout, keptMessage('_drafts/open.md', backupRel('open', 'publish')));
    assert.equal(read(root, `_posts/${postFile}`), text.split('/assets/drafts/open/').join('/assets/blog/open/'),
      'the post is the checked text');
    assert.equal(read(root, backupRel('open', 'publish')), text + LATE, 'the late write is kept in the backup');
    assert.equal(exists(root, '_drafts/open.md'), false, 'the draft is retired');
    assert.equal(exists(root, '_drafts/.open.publishing'), false, 'no set-aside copy is left');
  });

  await t.test('[AC-03][F-017] unpublish: a write through a descriptor held across the whole run lands in the backup, never under _posts/', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'open');
    const result = writeAfterExit(root, post.rel, () => cli(root, 'unpublish', 'open'));
    expectExit(result, 0);
    assert.match(result.stdout, keptMessage(post.rel, backupRel('open', 'unpublish')));
    assert.equal(read(root, '_drafts/open.md'), post.text.split('/assets/blog/open/').join('/assets/drafts/open/'),
      'the draft is the checked text');
    assert.equal(read(root, backupRel('open', 'unpublish')), post.text + LATE, 'the late write is kept in the backup');
    assert.deepEqual(list(root, '_posts'), [], 'nothing under _posts/ holds the late edit');
    assert.equal(exists(root, '_drafts/.open.unpublishing'), false, 'no set-aside copy is left');
  });

  for (const command of ['publish', 'unpublish']) {
    await t.test(`[AC-03][F-017] ${command}: writes after the check, before and after the backup is named, are kept and reported`, () => {
      const root = makeRoot();
      const source = command === 'publish'
        ? { rel: '_drafts/between.md', text: writeDraftWithImage(root, 'between') }
        : writePostWithImage(root, 'between');
      const asideRel = `_drafts/.between.${command}ing`;
      const result = cliWithFaults(root, [
        { fn: 'linkSync', path: asideRel, action: 'append-to-file', file: abs(root, asideRel), text: LATE },
        { fn: 'unlinkSync', path: asideRel, action: 'append-to-file', file: abs(root, asideRel), text: LATE },
      ], command, 'between');
      expectExit(result, 0);
      const resultRel = command === 'publish' ? `_posts/${postsFor(root, 'between')[0]}` : '_drafts/between.md';
      const checked = command === 'publish'
        ? source.text.split('/assets/drafts/between/').join('/assets/blog/between/')
        : source.text.split('/assets/blog/between/').join('/assets/drafts/between/');
      assert.match(result.stderr, lateMessage(source.rel, command, resultRel, backupRel('between', command)));
      assert.equal(read(root, resultRel), checked, `the ${command}ed file is the checked text`);
      assert.equal(read(root, backupRel('between', command)), source.text + LATE + LATE, 'both late writes are kept');
      assert.equal(exists(root, asideRel), false, 'no set-aside copy is left');
    });
  }

  await t.test('[AC-03][F-017] publish: an earlier backup is never overwritten; the next free number is used', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'again');
    write(root, backupRel('again', 'publish'), 'an earlier backup');
    const result = cli(root, 'publish', 'again');
    expectExit(result, 0);
    assert.match(result.stdout, keptMessage('_drafts/again.md', backupRel('again', 'publish', 2)));
    assert.equal(read(root, backupRel('again', 'publish')), 'an earlier backup', 'nothing is overwritten');
    assert.equal(read(root, backupRel('again', 'publish', 2)), text);
  });

  await t.test('[AC-03][F-017] publish: without hard links the set-aside copy is renamed to the backup and still receives the late write', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'nolink');
    const result = writeAfterExit(root, '_drafts/nolink.md', () => cliWithFaults(root,
      [{ fn: 'linkSync', path: '_drafts/.nolink.publishing', action: 'throw', code: 'EPERM' }], 'publish', 'nolink'));
    expectExit(result, 0);
    assert.match(result.stdout, keptMessage('_drafts/nolink.md', backupRel('nolink', 'publish')));
    assert.equal(read(root, backupRel('nolink', 'publish')), text + LATE, 'the late write is kept in the backup');
    assert.equal(exists(root, '_drafts/.nolink.publishing'), false, 'no set-aside copy is left');
  });

  await t.test('[AC-03][F-017] publish: when no backup can be made, every step is undone and the open file is the draft again', () => {
    const root = makeRoot();
    const text = writeDraftWithImage(root, 'nobackup');
    const failed = writeAfterExit(root, '_drafts/nobackup.md', () => cliWithFaults(root,
      [{ fn: 'linkSync', path: '_drafts/.nobackup.publishing', action: 'throw', code: 'EIO' }], 'publish', 'nobackup'));
    expectExit(failed, 1);
    assert.match(failed.stderr, /publish failed: cannot keep the checked _drafts\/nobackup\.md as a backup \(EIO/);
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assert.deepEqual(postsFor(root, 'nobackup'), [], 'nothing is published');
    assert.equal(read(root, '_drafts/nobackup.md'), text + LATE, 'the restored draft is the file still open');
    assert.deepEqual(list(root, '_drafts'), ['nobackup.md'], 'no backup or set-aside copy is left');
  });

  await t.test('[AC-03][F-017] unpublish: when every backup name is taken, every step is undone and the post is kept', () => {
    const root = makeRoot();
    const post = writePostWithImage(root, 'full');
    for (let n = 1; n <= 99; n += 1) write(root, backupRel('full', 'unpublish', n), `backup ${n}`);
    const failed = writeAfterExit(root, post.rel, () => cli(root, 'unpublish', 'full'));
    expectExit(failed, 1);
    assert.match(failed.stderr, new RegExp(`unpublish failed: cannot keep the checked ${escapeRegExp(post.rel)} as a `
      + 'backup \\(every backup name from _drafts/\\.full\\.unpublish-backup to _drafts/\\.full\\.unpublish-backup-99 '
      + 'is taken; delete the backups you no longer need\\)'));
    assert.match(failed.stderr, /every change was rolled back and nothing was moved/);
    assert.equal(read(root, post.rel), post.text + LATE, 'the restored post is the file still open');
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/full/figure.png')), PNG, 'its image stays published');
    assert.equal(exists(root, '_drafts/full.md'), false, 'no draft is left');
    assert.equal(read(root, backupRel('full', 'unpublish', 99)), 'backup 99', 'no backup is overwritten');
  });
});

/* guard --staged                                                            */

const HOOK_TEXT = '#!/bin/sh\nexec node scripts/article.mjs guard --staged\n';

/** Writes `.githooks/pre-commit` with file mode 0644 and stages it. */
function stageHookWithoutExecBit(repo) {
  write(repo, '.githooks/pre-commit', HOOK_TEXT);
  fs.chmodSync(abs(repo, '.githooks/pre-commit'), 0o644);
  git(repo, 'add', '.githooks/pre-commit');
}

test('[AC-03][F-017] guard --staged refuses every tracked-content and article rule break, naming the path', GIT_CASE, async (t) => {
  // One clock read names the future post wherever it is used, so a run that
  // crosses UTC midnight still expects the file it wrote; two days ahead it is
  // still in the future then.
  const futureRel = `_posts/${addDaysUtc(2)}-future.md`;
  const cases = [
    {
      name: 'a draft added with git add -f',
      offender: '_drafts/x.md',
      setup(repo) {
        write(repo, '_drafts/x.md', validArticle());
        git(repo, 'add', '-f', '_drafts/x.md');
      },
    },
    {
      name: 'a draft image added with git add -f',
      offender: 'assets/drafts/x/fig.png',
      setup(repo) {
        write(repo, 'assets/drafts/x/fig.png', PNG);
        git(repo, 'add', '-f', 'assets/drafts/x/fig.png');
      },
    },
    {
      name: 'a post with a published: key',
      offender: `_posts/${PAST}-pub.md`,
      message: /published/,
      setup(repo) {
        write(repo, `_posts/${PAST}-pub.md`, validArticle({ extra: 'published: false' }));
        git(repo, 'add', `_posts/${PAST}-pub.md`);
      },
    },
    {
      name: 'a future-dated post',
      offender: futureRel,
      setup(repo) {
        write(repo, futureRel, validArticle());
        git(repo, 'add', futureRel);
      },
    },
    {
      name: 'a post with unsafe markup',
      offender: `_posts/${PAST}-unsafe.md`,
      message: /unsafe markup/,
      setup(repo) {
        write(repo, `_posts/${PAST}-unsafe.md`, validArticle({ body: 'Intro.\n\n<script>alert(1)</script>' }));
        git(repo, 'add', `_posts/${PAST}-unsafe.md`);
      },
    },
    {
      name: 'a post with an external video poster',
      offender: `_posts/${PAST}-cover.md`,
      message: /<video> poster: external images are not allowed \(https:\/\/example\.com\/cover\.png\)/,
      setup(repo) {
        write(repo, `_posts/${PAST}-cover.md`, validArticle({ body: 'Clip:\n\n<video poster="https://example.com/cover.png"></video>' }));
        git(repo, 'add', `_posts/${PAST}-cover.md`);
      },
    },
    {
      name: 'a post whose attribute list gives an SVG <image> a data: href',
      offender: `_posts/${PAST}-svg-inline.md`,
      message: /<image> attribute list on the image: data: images are not allowed \(data:image\/png;base64,eA==\)/,
      setup(repo) {
        write(repo, `_posts/${PAST}-svg-inline.md`, validArticle({
          body: 'Figure:\n\n<svg markdown="span"><image width="40" height="40"/>{: href="data:image/png;base64,eA=="}</svg>',
        }));
        git(repo, 'add', `_posts/${PAST}-svg-inline.md`);
      },
    },
    {
      name: 'a hook staged without mode 100755',
      offender: '.githooks/pre-commit',
      message: /100644/,
      setup(repo) {
        stageHookWithoutExecBit(repo);
        assert.equal(indexMode(repo, '.githooks/pre-commit'), '100644', 'staged as a plain file');
      },
    },
    {
      name: 'a new image folder without its post',
      offender: 'assets/blog/ghost',
      setup(repo) {
        write(repo, 'assets/blog/ghost/fig.png', PNG);
        git(repo, 'add', 'assets/blog/ghost/fig.png');
      },
    },
    {
      name: 'a staged deletion of a post whose image folder remains',
      offender: 'assets/blog/gone',
      setup(repo) {
        const postRel = `_posts/${PAST}-gone.md`;
        write(repo, postRel, validArticle({ body: "![Figure]({{ '/assets/blog/gone/fig.png' | relative_url }})" }));
        write(repo, 'assets/blog/gone/fig.png', PNG);
        git(repo, 'add', postRel, 'assets/blog/gone/fig.png');
        commit(repo, 'Publish: gone');
        git(repo, 'rm', '-q', postRel);
      },
    },
    {
      name: 'a future-dated post in a nested _posts/ folder',
      offender: `blog/${futureRel}`,
      message: new RegExp(`^error: ${escapeRegExp(`blog/${futureRel}`)}: articles belong only in the root _posts/ folder; `, 'm'),
      setup(repo) {
        write(repo, `blog/${futureRel}`, validArticle());
        git(repo, 'add', `blog/${futureRel}`);
      },
    },
    {
      name: 'a past-dated post with a published: key in a nested _posts/ folder',
      offender: `blog/_posts/${PAST}-pub.md`,
      message: new RegExp(`^error: ${escapeRegExp(`blog/_posts/${PAST}-pub.md`)}: articles belong only in the root _posts/ folder; `, 'm'),
      setup(repo) {
        write(repo, `blog/_posts/${PAST}-pub.md`, validArticle({ extra: 'published: false' }));
        git(repo, 'add', `blog/_posts/${PAST}-pub.md`);
      },
    },
    {
      name: 'a draft in a nested _drafts/ folder added with git add -f',
      offender: 'blog/_drafts/x.md',
      message: /^error: blog\/_drafts\/x\.md: drafts and draft images must never be tracked /m,
      setup(repo) {
        write(repo, 'blog/_drafts/x.md', validArticle());
        git(repo, 'add', '-f', 'blog/_drafts/x.md');
      },
    },
    {
      name: 'a valid, past-dated post in a folder Jekyll skips, _posts/_hold/',
      offender: `_posts/_hold/${PAST}-held.md`,
      message: new RegExp(`^error: ${escapeRegExp(`_posts/_hold/${PAST}-held.md`)}: folder _hold/ is not allowed in _posts/; `, 'm'),
      setup(repo) {
        write(repo, `_posts/_hold/${PAST}-held.md`, validArticle());
        git(repo, 'add', `_posts/_hold/${PAST}-held.md`);
      },
    },
  ];
  for (const { name, offender, message, setup } of cases) {
    await t.test(`[AC-03][F-017] guard --staged refuses ${name}`, GIT_CASE, () => {
      const repo = makeRepo();
      setup(repo);
      const result = guardStagedUnchanged(repo);
      expectExit(result, 1);
      assert.ok(result.stderr.includes(offender), `stderr names ${offender}:\n${result.stderr}`);
      if (message) assert.match(result.stderr, message);
    });
  }
});

test('[AC-03][F-017] guard --staged accepts a valid post with its image and changes nothing in the repository', GIT_CASE, () => {
  const repo = makeRepo();
  const postRel = `_posts/${PAST}-good.md`;
  write(repo, postRel, validArticle({
    body: "Diagram:\n\n![Deployment diagram]({{ '/assets/blog/good/fig.png' | relative_url }})",
  }));
  write(repo, 'assets/blog/good/fig.png', PNG);
  git(repo, 'add', postRel, 'assets/blog/good/fig.png');

  const statusBefore = git(repo, 'status', '--porcelain');
  const indexBefore = fs.readFileSync(abs(repo, '.git/index'));
  const result = guardStaged(repo);
  const indexAfter = fs.readFileSync(abs(repo, '.git/index'));
  expectExit(result, 0);
  assert.deepEqual(indexAfter, indexBefore, 'guard does not rewrite the index');
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'guard leaves git state unchanged');
});

test('[AC-03][F-017] guard --staged accepts a hook once its index mode is 100755', GIT_CASE, () => {
  const repo = makeRepo();
  stageHookWithoutExecBit(repo);
  git(repo, 'update-index', '--chmod=+x', '.githooks/pre-commit');
  assert.equal(indexMode(repo, '.githooks/pre-commit'), '100755');
  expectExit(guardStaged(repo), 0);
});

test('[AC-03][F-017] the hook-mode remedy guard --staged prints fixes that hook when pasted, even one named with quotes and $(…)', GIT_CASE, () => {
  const repo = makeRepo();
  const hookRel = `.githooks/it's "a" $(touch marker) hook`;
  write(repo, hookRel, HOOK_TEXT);
  fs.chmodSync(abs(repo, hookRel), 0o644);
  git(repo, 'add', '--', hookRel);
  assert.equal(indexMode(repo, hookRel), '100644', 'staged as a plain file');

  const refused = guardStaged(repo);
  expectExit(refused, 1);
  const remedy = /; run (git update-index --chmod=\+x -- .+)$/m.exec(refused.stderr);
  assert.ok(remedy, `the refusal prints a remedy:\n${refused.stderr}`);
  spawnOk('sh', ['-c', remedy[1]], { cwd: repo, env: ENV });
  assert.equal(exists(repo, 'marker'), false, 'no $(…) in the path ran');
  assert.equal(indexMode(repo, hookRel), '100755', 'the remedy reached git as that one path');
  expectExit(guardStaged(repo), 0);
});

test('[AC-03][F-017] guard --staged judges the index, not the working tree: article text, image existence and image folders', GIT_CASE, async (t) => {
  const postRel = `_posts/${PAST}-diverge.md`;
  const imageRel = 'assets/blog/diverge/fig.png';
  const SCRIPT = '<script>alert(1)</script>';
  const unsafeText = validArticle({ body: `Intro.\n\n${SCRIPT}` });
  const safeText = validArticle({ body: 'Plain text with nothing to refuse.' });
  const figureText = validArticle({ body: "![Figure]({{ '/assets/blog/diverge/fig.png' | relative_url }})" });
  const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;
  const orphan = 'assets/blog/diverge/: image folder has no matching _posts/*-diverge.md';
  /** The text of a path as staged: its index blob, not the working-tree file. */
  const stagedText = (repo, rel) => gitQuiet(repo, 'show', `:${rel}`);
  /** The path as `git ls-files` lists it: the path when it is in the index, '' when it is not. */
  const indexed = (repo, rel) => gitQuiet(repo, 'ls-files', '--', rel).trim();
  /** Asserts a refusal reporting exactly the `messages`, each as one `error: ` line, and nothing on stdout. */
  const refused = (result, messages) => {
    expectExit(result, 1);
    assert.deepEqual(result.stderr.split('\n').filter((line) => line.startsWith('error: ')),
      messages.map((message) => `error: ${message}`), `stderr:\n${result.stderr}`);
    assert.match(result.stderr, new RegExp(`guard: commit refused \\(${messages.length} problems?\\)`));
    assert.equal(result.stdout, '');
  };
  /** Asserts an acceptance whose only output is the `line` on stdout. */
  const accepted = (result, line) => {
    expectExit(result, 0);
    assert.equal(result.stdout, `${line}\n`);
    assert.equal(result.stderr, '');
  };

  await t.test('[AC-03][F-017] guard --staged refuses unsafe staged text that is repaired only in the working tree', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, unsafeText);
    git(repo, 'add', postRel);
    write(repo, postRel, safeText);
    assert.equal(stagedText(repo, postRel), unsafeText, 'the index holds the unsafe text');

    refused(guardStagedUnchanged(repo), [`${postRel}:${lineOf(unsafeText, SCRIPT)}: unsafe markup: ${SCRIPT}`]);
    assert.equal(stagedText(repo, postRel), unsafeText, 'the staged blob is unchanged');
    assert.equal(read(repo, postRel), safeText, 'the working-tree repair is unchanged');
  });

  await t.test('[AC-03][F-017] guard --staged accepts valid staged text whose working-tree copy has an unsafe edit', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, safeText);
    git(repo, 'add', postRel);
    write(repo, postRel, unsafeText);
    assert.equal(stagedText(repo, postRel), safeText, 'the index holds the valid text');

    accepted(guardStagedUnchanged(repo), 'guard: staged tree ok (1 changed article checked)');
    assert.equal(stagedText(repo, postRel), safeText, 'the staged blob is unchanged');
    assert.equal(read(repo, postRel), unsafeText, 'the unstaged edit is unchanged');
  });

  await t.test('[AC-03][F-017] guard --staged refuses a staged post whose image exists only in the working tree', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, figureText);
    write(repo, imageRel, PNG);
    git(repo, 'add', postRel);
    assert.equal(indexed(repo, imageRel), '', 'the image is untracked');

    refused(guardStagedUnchanged(repo),
      [`${postRel}:${lineOf(figureText, 'fig.png')}: image /${imageRel} does not exist`]);
    assert.equal(indexed(repo, imageRel), '', 'the image is still untracked');
    assert.deepEqual(fs.readFileSync(abs(repo, imageRel)), PNG, 'the image file is unchanged');
  });

  await t.test('[AC-03][F-017] guard --staged accepts a staged post and image after the image is deleted from the working tree only', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, figureText);
    write(repo, imageRel, PNG);
    git(repo, 'add', postRel, imageRel);
    fs.rmSync(abs(repo, imageRel));

    accepted(guardStagedUnchanged(repo), 'guard: staged tree ok (1 changed article checked)');
    assert.equal(indexed(repo, imageRel), imageRel, 'the image is still staged');
    assert.equal(exists(repo, imageRel), false, 'the image is still absent from the working tree');
  });

  await t.test('[AC-03][F-017] guard --staged refuses a staged image whose post exists only in the working tree, untracked', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, figureText);
    write(repo, imageRel, PNG);
    git(repo, 'add', imageRel);
    assert.equal(indexed(repo, postRel), '', 'the post is untracked');

    refused(guardStagedUnchanged(repo), [orphan]);
    assert.equal(indexed(repo, postRel), '', 'the post is still untracked');
    assert.equal(read(repo, postRel), figureText, 'the post file is unchanged');
  });

  await t.test('[AC-03][F-017] guard --staged refuses a post removed from the index with git rm --cached and kept on disk', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, figureText);
    write(repo, imageRel, PNG);
    git(repo, 'add', postRel, imageRel);
    commit(repo, 'Publish: diverge');
    git(repo, 'rm', '-q', '--cached', postRel);

    refused(guardStagedUnchanged(repo), [orphan]);
    assert.equal(indexed(repo, postRel), '', 'the post is still out of the index');
    assert.equal(read(repo, postRel), figureText, 'the post file is unchanged');
  });

  await t.test('[AC-03][F-017] guard --staged accepts a committed post and image after the post is deleted from the working tree only', GIT_CASE, () => {
    const repo = makeRepo();
    write(repo, postRel, figureText);
    write(repo, imageRel, PNG);
    git(repo, 'add', postRel, imageRel);
    commit(repo, 'Publish: diverge');
    fs.rmSync(abs(repo, postRel));

    accepted(guardStagedUnchanged(repo), 'guard: staged tree ok (0 changed articles checked)');
    assert.equal(stagedText(repo, postRel), figureText, 'the post is still in the index');
    assert.equal(exists(repo, postRel), false, 'the post is still absent from the working tree');
  });
});

/* guard --pre-push                                                          */

test('[AC-03][F-017] guard --pre-push refuses a range in which one commit adds a draft and a later one deletes it', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  write(repo, '_drafts/leak.md', validArticle({ title: 'Not for publication yet' }));
  git(repo, 'add', '-f', '_drafts/leak.md');
  commit(repo, 'Add a draft by mistake');
  git(repo, 'rm', '-q', '_drafts/leak.md');
  commit(repo, 'Remove the draft again');
  assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').includes('_drafts/'), false,
    'the tip itself holds no draft, so only a check of every commit catches it');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  assert.match(result.stderr, /_drafts\/leak\.md/);
});

test('[AC-03][F-017] guard --pre-push refuses a range in which one commit adds a nested blog/_drafts/ draft and a later one deletes it', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'blog/_drafts/leak.md', validArticle({ title: 'Not for publication yet' }));
  git(repo, 'add', '-f', 'blog/_drafts/leak.md');
  commit(repo, 'Add a nested draft by mistake');
  const leakCommit = git(repo, 'rev-parse', 'HEAD').slice(0, 7);
  git(repo, 'rm', '-q', 'blog/_drafts/leak.md');
  commit(repo, 'Remove the nested draft again');
  assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').includes('_drafts/'), false,
    'the tip itself holds no draft, so only a check of every commit catches it');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  assert.match(result.stderr, new RegExp(`^error: ${leakCommit}: blog/_drafts/leak\\.md: drafts and draft images `
    + 'must never be tracked ', 'm'));
  assert.match(result.stderr, /guard: push refused \(1 problem in 1 commit\)/);
});

test('[AC-03][F-017] guard --pre-push refuses a pushed commit holding a future-dated post in a nested blog/_posts/ folder', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const nestedRel = `blog/_posts/${addDaysUtc(2)}-later.md`;
  write(repo, nestedRel, validArticle());
  git(repo, 'add', nestedRel);
  commit(repo, 'Add a post in a nested _posts/ folder');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  assert.match(result.stderr, new RegExp(`^error: [0-9a-f]{7}: ${escapeRegExp(nestedRel)}: articles belong only in `
    + 'the root _posts/ folder; ', 'm'));
});

test('[AC-03][F-017] guard --pre-push refuses a pushed commit holding a future-dated post in the root _posts/ folder', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  // A valid post, image-free, whose only fault is its date: a month ahead, so it is future on either side of midnight.
  const futureDate = addDaysUtc(30);
  const futureRel = `_posts/${futureDate}-later.md`;
  write(repo, futureRel, validArticle());
  git(repo, 'add', futureRel);
  commit(repo, 'Add a future-dated post');
  const futureCommit = git(repo, 'rev-parse', 'HEAD').slice(0, 7);

  const dateBefore = todayUtc();
  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  const runDates = [...new Set([dateBefore, todayUtc()])].map(escapeRegExp).join('|');
  expectExit(result, 1);
  assert.match(result.stderr, new RegExp(`^error: ${futureCommit}: ${escapeRegExp(futureRel)}: dated ${futureDate}, `
    + `after today \\(UTC (${runDates})\\); future-dated posts are not allowed$`, 'm'));
  assert.match(result.stderr, /guard: push refused \(1 problem in 1 commit\)/, 'the date is the only problem');
});

test('[AC-03][F-017] guard --pre-push refuses a range in which one commit gives an SVG <image> an external href through an attribute list and a later one removes it', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-svg-figure.md`;
  write(repo, postRel, validArticle({
    body: 'Figure:\n\n<svg markdown="span"><image width="40" height="40"/>{: href="https://example.com/p.png"}</svg>',
  }));
  git(repo, 'add', postRel);
  commit(repo, 'Publish with an external SVG image');
  const leakCommit = git(repo, 'rev-parse', 'HEAD').slice(0, 7);
  write(repo, postRel, validArticle({ body: 'Figure removed.' }));
  git(repo, 'add', postRel);
  commit(repo, 'Remove the external SVG image');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  assert.match(result.stderr, new RegExp(`^error: ${leakCommit}: ${escapeRegExp(postRel)}:\\d+: <image> attribute list on `
    + 'the image: external images are not allowed \\(https://example\\.com/p\\.png\\)$', 'm'));
  assert.match(result.stderr, /guard: push refused \(1 problem in 1 commit\)/, 'only the commit carrying the image is refused');
});


test('[AC-03][F-017] guard --pre-push refuses a commit that deletes a post but leaves its image folder', GIT_CASE, async (t) => {
  const postRel = `_posts/${PAST}-gone.md`;
  /** A pushed post with an image, then a local commit that deletes only the post. */
  const orphanedRepo = () => {
    const { repo, remote } = makeRemoteRepo((r) => {
      write(r, postRel, validArticle({ body: "![Figure]({{ '/assets/blog/gone/fig.png' | relative_url }})" }));
      write(r, 'assets/blog/gone/fig.png', PNG);
      git(r, 'add', postRel, 'assets/blog/gone/fig.png');
      commit(r, 'Publish: gone');
    });
    const remoteSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rm', '-q', postRel);
    commit(repo, 'Delete the post only');
    return { repo, remote, remoteSha };
  };

  await t.test('[AC-03][F-017] guard --pre-push refuses when the folder is still orphaned at the tip', GIT_CASE, () => {
    const { repo, remote, remoteSha } = orphanedRepo();
    const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 1);
    assert.match(result.stderr, /assets\/blog\/gone/);
  });

  // Every pushed commit becomes public in repository history, so a later
  // commit that removes the folder does not make the orphaning commit acceptable.
  await t.test('[AC-03][F-017] guard --pre-push refuses even when a later commit in the range removes the folder', GIT_CASE, () => {
    const { repo, remote, remoteSha } = orphanedRepo();
    git(repo, 'rm', '-q', '-r', 'assets/blog/gone');
    commit(repo, 'Delete the images too');
    const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 1);
    assert.match(result.stderr, /assets\/blog\/gone/);
  });
});

test('[AC-03][F-017] guard --pre-push checks a new branch against what the remote already holds', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, '_drafts/branch.md', validArticle());
  git(repo, 'add', '-f', '_drafts/branch.md');
  commit(repo, 'Draft on a branch');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/feature', 'refs/heads/feature', '0'.repeat(40));
  expectExit(result, 1);
  assert.match(result.stderr, /_drafts\/branch\.md/);
});

test('[AC-03][F-017] guard --pre-push accepts a valid post', GIT_CASE, () => {
  const { repo } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-shipped.md`;
  write(repo, postRel, validArticle({ title: 'Shipped article' }));
  git(repo, 'add', postRel);
  commit(repo, 'Publish: Shipped article');

  const result = prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 0);
  assert.match(result.stdout, /\b1 commit\b/, 'exactly the one new commit is checked');
});

test('[AC-03][F-017] guard --pre-push accepts an empty push, checking no commit, and changes nothing', GIT_CASE, async (t) => {
  const ZERO = '0'.repeat(40);
  /** Commits a draft added with `git add -f`, which guard refuses in any commit it inspects. */
  const commitDraft = (repo) => {
    write(repo, '_drafts/held.md', validArticle({ title: 'Not for publication' }));
    git(repo, 'add', '-f', '_drafts/held.md');
    commit(repo, 'Add a draft by mistake');
  };
  /** Runs guard --pre-push with `input` on stdin, asserting that it left the repository and its remote unchanged. */
  const pushGuard = ({ repo, remote }, input) => unchangedBy(
    () => ({ repo: repoSnapshot(repo), remote: remoteSnapshot(remote) }),
    () => run(['guard', '--pre-push'], { cwd: repo, input }),
    'the repository and its remote',
  );
  /** Asserts that guard refuses the draft commit once a ref line actually pushes it: the control for each case. */
  const refusesWhenPushed = (repos, localSha, remoteSha) => {
    const control = pushGuard(repos, `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`);
    expectExit(control, 1);
    assert.match(control.stderr, /_drafts\/held\.md/, 'the draft commit is refused when it is in the range');
  };

  await t.test('[AC-03][F-017] guard --pre-push checks 0 commits when the local and remote SHAs are equal', GIT_CASE, () => {
    const repos = makeRemoteRepo(commitDraft);
    const tip = git(repos.repo, 'rev-parse', 'HEAD');
    assert.equal(git(repos.remote, 'rev-parse', 'refs/heads/main'), tip, 'the remote already holds the tip');

    const result = pushGuard(repos, `refs/heads/main ${tip} refs/heads/main ${tip}\n`);
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: ok (0 commits checked)\n');
    assert.equal(result.stderr, '');
    refusesWhenPushed(repos, tip, git(repos.repo, 'rev-parse', 'HEAD~1'));
  });

  for (const input of ['', '\n']) {
    await t.test(`[AC-03][F-017] guard --pre-push given ${JSON.stringify(input)} on stdin checks nothing and prints nothing`, GIT_CASE, () => {
      const repos = makeRemoteRepo();
      const remoteSha = git(repos.repo, 'rev-parse', 'HEAD');
      commitDraft(repos.repo);

      const result = pushGuard(repos, input);
      expectExit(result, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      refusesWhenPushed(repos, git(repos.repo, 'rev-parse', 'HEAD'), remoteSha);
    });
  }

  await t.test('[AC-03][F-017] guard --pre-push checks 0 commits for a branch deletion', GIT_CASE, () => {
    const repos = makeRemoteRepo();
    const remoteSha = git(repos.repo, 'rev-parse', 'HEAD');
    git(repos.repo, 'checkout', '-q', '-b', 'feature');
    commitDraft(repos.repo);
    git(repos.repo, 'push', '-q', '--no-verify', 'origin', 'feature');
    const featureSha = git(repos.repo, 'rev-parse', 'HEAD');

    const result = pushGuard(repos, `(delete) ${ZERO} refs/heads/feature ${featureSha}\n`);
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: ok (0 commits checked)\n');
    assert.equal(result.stderr, '');
    refusesWhenPushed(repos, featureSha, remoteSha);
  });
});

/* guard --pre-push: what the destination already holds                     */

const ZERO_SHA = '0'.repeat(40);

/** Asserts that guard refused the push for the forced draft `_drafts/private.md` in `commitSha`, and for nothing else. */
function refusesPrivateDraft(result, commitSha) {
  expectExit(result, 1);
  assert.match(result.stderr, new RegExp(`^error: ${commitSha.slice(0, 7)}: _drafts/private\\.md: drafts and draft images `
    + 'must never be tracked ', 'm'));
  assert.match(result.stderr, /guard: push refused \(1 problem in 1 commit\)\.\n$/);
}

/** Commits a forced draft `_drafts/private.md` on a new branch `branch` of `repo` and returns the commit. */
function commitPrivateDraft(repo, branch) {
  git(repo, 'checkout', '-q', '-b', branch);
  write(repo, '_drafts/private.md', validArticle({ title: 'Kept off the public remote' }));
  git(repo, 'add', '-f', '_drafts/private.md');
  commit(repo, 'A draft for a private remote');
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * `makeRemoteRepo()` plus a private bare remote `backup` holding a forced
 * draft on `feature`, pushed there with `--no-verify` and fetched back, so
 * `refs/remotes/backup/feature` is the only ref here that holds it and
 * `origin` has never received it.
 *
 * @returns {{ repo: string, remote: string, backup: string, draft: string }}
 */
function privateRemoteRepo() {
  const { repo, remote } = makeRemoteRepo();
  const backup = caseDir('backup.git');
  git(backup, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'backup', backup);
  const draft = commitPrivateDraft(repo, 'feature');
  git(repo, 'push', '-q', '--no-verify', 'backup', 'feature');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'branch', '-q', '-D', 'feature');
  git(repo, 'fetch', '-q', 'backup');
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/backup/feature'), draft, 'the fetched backup ref holds the draft');
  const inOrigin = spawnSync('git', ['cat-file', '-e', `${draft}^{commit}`], { cwd: remote, env: ENV, encoding: 'utf8' });
  assert.equal(inOrigin.status, 128, `origin has never received the draft:\n${inOrigin.stderr}`);
  return { repo, remote, backup, draft };
}

test('[AC-03][F-017] guard --pre-push skips only commits the repository it pushes to advertises holding', GIT_CASE, async (t) => {
  await t.test('[AC-03][F-017] a commit only a private remote holds, pushed to origin as a new branch, is checked and refused', GIT_CASE, () => {
    const { repo, remote, backup, draft } = privateRemoteRepo();
    const result = prePushHook(repo, [remote, backup], ['origin', git(repo, 'remote', 'get-url', 'origin')],
      [['refs/remotes/backup/feature', draft, 'refs/heads/feature', ZERO_SHA]]);
    refusesPrivateDraft(result, draft);
  });

  await t.test('[AC-03][F-017] the same commit pushed to origin as a new tag is refused', GIT_CASE, () => {
    const { repo, remote, backup, draft } = privateRemoteRepo();
    git(repo, 'tag', 'v1', draft);
    const result = prePushHook(repo, [remote, backup], ['origin', git(repo, 'remote', 'get-url', 'origin')],
      [['refs/tags/v1', draft, 'refs/tags/v1', ZERO_SHA]]);
    refusesPrivateDraft(result, draft);
  });

  await t.test('[AC-03][F-017] pushed back to the private remote, which advertises it, the commit it already holds is skipped', GIT_CASE, () => {
    const { repo, remote, backup, draft } = privateRemoteRepo();
    const result = prePushHook(repo, [remote, backup], ['backup', git(repo, 'remote', 'get-url', 'backup')],
      [['refs/remotes/backup/feature', draft, 'refs/heads/copy', ZERO_SHA]]);
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: ok (0 commits checked)\n');
    assert.equal(result.stderr, '');
  });

  await t.test('[AC-03][F-017] a new branch whose commits origin advertises is accepted, checking none', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    const result = prePushHook(repo, [remote], ['origin', git(repo, 'remote', 'get-url', 'origin')],
      [['refs/heads/feature', git(repo, 'rev-parse', 'HEAD'), 'refs/heads/feature', ZERO_SHA]]);
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: ok (0 commits checked)\n');
    assert.equal(result.stderr, '');
  });

  await t.test('[AC-03][F-017] after git remote set-url points the private remote at an empty public repository, its fetched draft is refused as a branch and as a tag', GIT_CASE, () => {
    const { repo, remote, backup, draft } = privateRemoteRepo();
    const published = caseDir('retarget-public.git');
    git(published, 'init', '-q', '--bare');
    git(repo, 'remote', 'set-url', 'backup', published);
    assert.equal(git(repo, 'remote', 'get-url', 'backup'), published, 'backup now fetches from and pushes to the public repository');
    assert.equal(git(repo, 'rev-parse', 'refs/remotes/backup/feature'), draft, 'set-url keeps the tracking ref of the old URL');
    git(repo, 'tag', 'v1', draft);
    for (const [localRef, remoteRef] of [['refs/remotes/backup/feature', 'refs/heads/feature'], ['refs/tags/v1', 'refs/tags/v1']]) {
      const result = prePushHook(repo, [remote, backup, published], ['backup', published], [[localRef, draft, remoteRef, ZERO_SHA]]);
      refusesPrivateDraft(result, draft);
    }
  });

  await t.test('[AC-03][F-017] an insteadOf rule that would send the query for the destination to the private remote proves nothing', GIT_CASE, () => {
    const { repo, remote, backup, draft } = privateRemoteRepo();
    const published = caseDir('rewritten-public.git');
    git(published, 'init', '-q', '--bare');
    git(repo, 'config', `url.${backup}.insteadOf`, published);
    assert.equal(git(repo, 'ls-remote', '--get-url', '--', published), backup, 'a query for the public URL reaches the private remote');
    const result = prePushHook(repo, [remote, backup, published], ['public', published],
      [['refs/remotes/backup/feature', draft, 'refs/heads/feature', ZERO_SHA]]);
    refusesPrivateDraft(result, draft);
  });

  await t.test('[AC-03][F-017] a commit origin holds is skipped for any push to its URL, and checked when git pushes elsewhere, to an unreachable URL or without arguments', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const held = commitPrivateDraft(repo, 'held');
    git(repo, 'push', '-q', '--no-verify', 'origin', 'held');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'held');
    const fetchUrl = git(repo, 'remote', 'get-url', 'origin');
    const pushUrl = caseDir('push-url.git');
    git(pushUrl, 'init', '-q', '--bare');
    git(repo, 'config', 'remote.origin.pushurl', pushUrl);
    assert.equal(git(repo, 'remote', 'get-url', '--push', 'origin'), pushUrl, 'git pushes origin to its push URL');
    const unreachable = path.join(caseDir('unreachable'), 'absent.git');
    const refLines = [['refs/remotes/origin/held', held, 'refs/heads/copy', ZERO_SHA]];

    for (const hookArgs of [['origin', fetchUrl], [fetchUrl, fetchUrl], ['nosuch', fetchUrl]]) {
      const proven = prePushHook(repo, [remote, pushUrl], hookArgs, refLines);
      expectExit(proven, 0);
      assert.equal(proven.stdout, 'guard: ok (0 commits checked)\n', `${JSON.stringify(hookArgs)}: the URL advertises the held commit`);
    }
    for (const hookArgs of [['origin', pushUrl], ['origin', unreachable], []]) {
      const result = prePushHook(repo, [remote, pushUrl], hookArgs, refLines);
      refusesPrivateDraft(result, held);
    }
  });

  await t.test('[AC-03][F-017] a tracking ref inside origin\'s own folder proves nothing origin does not advertise', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const mirror = caseDir('mirror.git');
    git(mirror, 'init', '-q', '--bare');
    // A remote named origin/mirror fetches into refs/remotes/origin/mirror/, inside origin's folder.
    git(repo, 'config', 'remote.origin/mirror.url', mirror);
    git(repo, 'config', 'remote.origin/mirror.fetch', '+refs/heads/*:refs/remotes/origin/mirror/*');
    const draft = commitPrivateDraft(repo, 'feature');
    git(repo, 'push', '-q', '--no-verify', mirror, 'feature');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'feature');
    git(repo, 'fetch', '-q', 'origin/mirror');
    assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/mirror/feature'), draft);

    const result = prePushHook(repo, [remote, mirror], ['origin', git(repo, 'remote', 'get-url', 'origin')],
      [['refs/remotes/origin/mirror/feature', draft, 'refs/heads/feature', ZERO_SHA]]);
    refusesPrivateDraft(result, draft);
  });

  await t.test('[AC-03][F-017] an advertised annotated tag proves the commit it tags; advertised trees, blobs and unknown commits prove nothing', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const held = commitPrivateDraft(repo, 'held');
    git(repo, 'tag', '-a', '-m', 'Held', 'v-held', held);
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    const blob = git(repo, 'rev-parse', 'HEAD:_drafts/private.md');
    git(repo, 'tag', 't-tree', tree);
    git(repo, 'tag', 't-blob', blob);
    git(repo, 'push', '-q', '--no-verify', 'origin', 'v-held', 't-tree', 't-blob');
    const foreign = path.join(caseDir('foreign'), 'clone');
    git(PARENT, 'clone', '-q', remote, foreign);
    write(foreign, 'foreign.txt', 'A commit this clone never fetches.\n');
    git(foreign, 'add', 'foreign.txt');
    commit(foreign, 'Elsewhere');
    git(foreign, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/foreign');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'held');
    const fetchUrl = git(repo, 'remote', 'get-url', 'origin');
    assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), 'refs/heads/foreign\nrefs/heads/main',
      'origin holds the draft commit only through the annotated tag');

    const proven = prePushHook(repo, [remote], ['origin', fetchUrl], [['refs/tags/v-held', held, 'refs/heads/copy', ZERO_SHA]]);
    expectExit(proven, 0);
    assert.equal(proven.stdout, 'guard: ok (0 commits checked)\n');
    assert.equal(proven.stderr, '');

    git(repo, 'checkout', '-q', '-b', 'next', held);
    write(repo, 'notes.txt', 'Built on the held commit.\n');
    git(repo, 'add', 'notes.txt');
    commit(repo, 'On top of the held commit');
    const next = git(repo, 'rev-parse', 'HEAD');
    const result = prePushHook(repo, [remote], ['origin', fetchUrl], [['refs/heads/next', next, 'refs/heads/next', ZERO_SHA]]);
    refusesPrivateDraft(result, next);
  });
});

/* guard --pre-push: refs that point at tags, trees and blobs                */

/**
 * `makeRemoteRepo()` plus the tree and the blob of a forced draft
 * `_drafts/x.md`, stored as `git write-tree` and `git hash-object -w` store
 * them and then unstaged, so no commit holds them.
 *
 * @returns {{ repo: string, remote: string, tree: string, blob: string }}
 */
function draftObjectsRepo() {
  const { repo, remote } = makeRemoteRepo();
  write(repo, '_drafts/x.md', validArticle({ title: 'Not for publication' }));
  git(repo, 'add', '-f', '_drafts/x.md');
  const tree = git(repo, 'write-tree');
  git(repo, 'reset', '-q');
  const blob = git(repo, 'hash-object', '-w', '_drafts/x.md');
  return { repo, remote, tree, blob };
}

/** Runs guard as the hook does for a push of `refLines` to `origin` at its fetch URL. */
function prePushToOrigin({ repo, remote }, refLines) {
  return prePushHook(repo, [remote], ['origin', git(repo, 'remote', 'get-url', 'origin')], refLines);
}

test('[AC-03][F-017] guard --pre-push peels pushed tags, checks a pushed tree as a commit\'s tree and refuses a pushed blob', GIT_CASE, async (t) => {
  await t.test('[AC-03][F-017] a tag pointing at a tree that holds a forced draft is refused, naming the tree', GIT_CASE, () => {
    const repos = draftObjectsRepo();
    git(repos.repo, 'tag', 't-tree', repos.tree);
    const result = prePushToOrigin(repos, [['refs/tags/t-tree', repos.tree, 'refs/tags/t-tree', ZERO_SHA]]);
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`^error: ${repos.tree.slice(0, 7)}: _drafts/x\\.md: drafts and draft images `
      + 'must never be tracked ', 'm'));
    assert.match(result.stderr, /guard: push refused \(1 problem in 1 tree\)\.\n$/);
  });

  await t.test('[AC-03][F-017] a tag pointing at a blob, or an annotated tag of it, is refused, naming the ref', GIT_CASE, () => {
    const repos = draftObjectsRepo();
    git(repos.repo, 'tag', 't-blob', repos.blob);
    git(repos.repo, 'tag', '-a', '-m', 'A tag of a blob', 't-ann-blob', repos.blob);
    const tagObject = git(repos.repo, 'rev-parse', 'refs/tags/t-ann-blob');
    assert.equal(git(repos.repo, 'cat-file', '-t', tagObject), 'tag');
    const blobRefusal = (ref) => new RegExp(`^error: ${repos.blob.slice(0, 7)}: ${escapeRegExp(ref)} points at a blob, `
      + 'which has no path, so guard cannot check it against the content rules; ', 'm');

    for (const [ref, sha] of [['refs/tags/t-blob', repos.blob], ['refs/tags/t-ann-blob', tagObject]]) {
      const result = prePushToOrigin(repos, [[ref, sha, ref, ZERO_SHA]]);
      expectExit(result, 1);
      assert.match(result.stderr, blobRefusal(ref));
      assert.match(result.stderr, /guard: push refused \(1 problem in 1 blob\)\.\n$/);
    }
  });

  await t.test('[AC-03][F-017] an annotated tag of a commit is checked as that commit', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const draft = commitPrivateDraft(repo, 'drafted');
    git(repo, 'tag', '-a', '-m', 'A tag of a draft commit', 'v-draft', draft);
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'shipped');
    const postRel = `_posts/${PAST}-tagged.md`;
    write(repo, postRel, validArticle({ title: 'Tagged article' }));
    git(repo, 'add', postRel);
    commit(repo, 'Publish: Tagged article');
    git(repo, 'tag', '-a', '-m', 'A tag of a valid commit', 'v-ok');
    git(repo, 'checkout', '-q', 'main');
    const tagOf = (name) => git(repo, 'rev-parse', `refs/tags/${name}`);

    refusesPrivateDraft(prePushToOrigin({ repo, remote }, [['refs/tags/v-draft', tagOf('v-draft'), 'refs/tags/v-draft', ZERO_SHA]]), draft);
    const accepted = prePushToOrigin({ repo, remote }, [['refs/tags/v-ok', tagOf('v-ok'), 'refs/tags/v-ok', ZERO_SHA]]);
    expectExit(accepted, 0);
    assert.equal(accepted.stdout, 'guard: ok (1 commit checked)\n', 'only the tagged commit origin lacks is checked');
  });

  await t.test('[AC-03][F-017] a tree of valid content is accepted and named in the summary, with any commit pushed beside it', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const postRel = `_posts/${PAST}-tree.md`;
    write(repo, postRel, validArticle({ title: 'An article in a pushed tree' }));
    git(repo, 'add', postRel);
    const tree = git(repo, 'write-tree');
    git(repo, 'tag', 't-clean', tree);
    commit(repo, 'Publish: An article in a pushed tree');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const treeLine = ['refs/tags/t-clean', tree, 'refs/tags/t-clean', ZERO_SHA];

    const alone = prePushToOrigin({ repo, remote }, [treeLine]);
    expectExit(alone, 0);
    assert.equal(alone.stdout, 'guard: ok (1 tree checked)\n');
    const both = prePushToOrigin({ repo, remote }, [['refs/heads/main', tip, 'refs/heads/main', git(repo, 'rev-parse', 'HEAD~1')], treeLine]);
    expectExit(both, 0);
    assert.equal(both.stdout, 'guard: ok (1 commit and 1 tree checked)\n');
  });

  await t.test('[AC-03][F-017] every article in a pushed tree gets the article checks', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const postRel = `_posts/${PAST}-keyed.md`;
    write(repo, postRel, validArticle({ extra: 'published: true' }));
    git(repo, 'add', postRel);
    const tree = git(repo, 'write-tree');
    git(repo, 'reset', '-q');
    const result = prePushToOrigin({ repo, remote }, [['refs/tags/t-keyed', tree, 'refs/tags/t-keyed', ZERO_SHA]]);
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`^error: ${tree.slice(0, 7)}: ${escapeRegExp(postRel)}: .*published: is not allowed`, 'm'));
    assert.match(result.stderr, /guard: push refused \(1 problem in 1 tree\)\.\n$/);
  });

  await t.test('[AC-03][F-017] a pushed object this clone does not have fails closed', GIT_CASE, () => {
    const repos = makeRemoteRepo();
    const missing = '1'.repeat(40);
    const result = prePushToOrigin(repos, [['refs/tags/gone', missing, 'refs/tags/gone', ZERO_SHA]]);
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`^error: refs/tags/gone ${missing} is not an object in this clone, so it cannot be checked$`, 'm'));
    assert.match(result.stderr, /fail closed/);
  });
});

/* guard and the site configuration                                          */

/**
 * A site configuration for the guard cases holding the real `_config.yml`'s
 * settings that the site-configuration rules read, each harmless, and ending
 * inside its `defaults` list so a case can append an item.
 */
const GUARD_SITE_CONFIG = [
  'timezone: Etc/UTC',
  'permalink: /blog/:title/',
  'future: false',
  'exclude:',
  '  - README.md',
  '  - assets/drafts',
  'defaults:',
  '  - scope:',
  '      path: ""',
  '      type: posts',
  '    values:',
  '      layout: post',
  '',
].join('\n');

/** `GUARD_SITE_CONFIG` plus a `defaults` item scoped to `postRel` whose values are `lines`, as the QA reproduction appended. */
function scopedDefault(postRel, ...lines) {
  return `${GUARD_SITE_CONFIG}  - scope:\n      path: "${postRel}"\n    values:\n${lines.map((line) => `      ${line}\n`).join('')}`;
}

/** The line of `text`, from 1, holding `needle`. */
function configLine(text, needle) {
  return text.split('\n').findIndex((line) => line.includes(needle)) + 1;
}

/** A repository with a valid post at `postRel` and the configuration `config` at `configRel`, both staged. */
function stagedWithConfig(postRel, configRel, config) {
  const repo = makeRepo();
  write(repo, configRel, config);
  write(repo, postRel, validArticle({ title: 'Held article' }));
  git(repo, 'add', configRel, postRel);
  return repo;
}

test('[AC-03][F-017] guard --staged refuses a site configuration that keeps a staged post off the site, and accepts a harmless one', GIT_CASE, async (t) => {
  const postRel = `_posts/${PAST}-held.md`;
  const excluding = GUARD_SITE_CONFIG.replace('  - assets/drafts\n', `  - assets/drafts\n  - ${postRel}\n`);
  const limited = `${GUARD_SITE_CONFIG}limit_posts: 1\n`;
  const cases = [
    {
      name: 'a published: false default',
      config: scopedDefault(postRel, 'published: false'),
      message: (config) => `_config.yml: line ${configLine(config, 'published:')}: defaults set published for the posts in `
        + 'their scope: published: false keeps them off the site while GitHub still shows them; remove published from '
        + 'the defaults values',
    },
    {
      name: 'a future date default',
      config: scopedDefault(postRel, 'date: "2099-01-01 00:00:00 +0000"'),
      message: (config) => `_config.yml: line ${configLine(config, 'date:')}: defaults set date for the posts in their `
        + 'scope: it replaces their filename dates, and one after the build keeps them off the site as future posts '
        + 'while GitHub still shows them; remove date from the defaults values',
    },
    {
      name: 'limit_posts: 1',
      config: limited,
      message: (config) => `_config.yml: line ${configLine(config, 'limit_posts')}: limit_posts must not be set; Jekyll then `
        + 'builds only the newest posts and leaves the rest off the site while GitHub still shows them; remove it',
    },
    {
      name: 'an exclude entry naming the post',
      config: excluding,
      message: (config) => `_config.yml: line ${configLine(config, 'exclude:')}: exclude entry ${JSON.stringify(postRel)} `
        + `keeps ${postRel} off the site while GitHub still shows it; remove the entry or narrow it so it matches no `
        + 'file in _posts/',
    },
  ];
  for (const { name, config, message } of cases) {
    await t.test(`[AC-03][F-017] guard --staged refuses a valid post staged with a _config.yml holding ${name}`, GIT_CASE, () => {
      const result = guardStagedUnchanged(stagedWithConfig(postRel, '_config.yml', config));
      expectExit(result, 1);
      assert.deepEqual(result.stderr.split('\n').filter((line) => line.startsWith('error: ')), [`error: ${message(config)}`],
        `stderr:\n${result.stderr}`);
      assert.match(result.stderr, /guard: commit refused \(1 problem\)/);
    });
  }

  await t.test('[AC-03][F-017] guard --staged refuses a _config.yml that is a symbolic link', { ...GIT_CASE, ...LINK_CASE }, () => {
    const repo = stagedWithConfig(postRel, 'site.yml', GUARD_SITE_CONFIG);
    fs.symlinkSync('site.yml', abs(repo, '_config.yml'));
    git(repo, 'add', '_config.yml');
    assert.equal(indexMode(repo, '_config.yml'), '120000', 'staged as a symbolic link');
    const result = guardStagedUnchanged(repo);
    expectExit(result, 1);
    assert.match(result.stderr, /^error: _config\.yml: Jekyll reads the site configuration from this path, and guard can check it only as a regular file, not a symbolic link; /m);
  });

  await t.test('[AC-03][F-017] guard --staged refuses a folder named _config.yml, which makes Jekyll read no configuration', GIT_CASE, () => {
    const repo = stagedWithConfig(postRel, '_config.yaml', GUARD_SITE_CONFIG);
    write(repo, '_config.yml/site.yml', GUARD_SITE_CONFIG);
    git(repo, 'add', '_config.yml/site.yml');
    const result = guardStagedUnchanged(repo);
    expectExit(result, 1);
    assert.deepEqual(result.stderr.split('\n').filter((line) => line.startsWith('error: ')), ['error: _config.yml: Jekyll '
      + 'reads the site configuration from this path, and guard can check it only as a regular file, not a folder; '
      + 'track the configuration itself here'], `stderr:\n${result.stderr}`);
  });

  await t.test('[AC-03][F-017] guard --staged refuses a hiding _config.yaml, the file Jekyll reads when _config.yml is absent', GIT_CASE, () => {
    const result = guardStagedUnchanged(stagedWithConfig(postRel, '_config.yaml', limited));
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`^error: _config\\.yaml: line ${configLine(limited, 'limit_posts')}: limit_posts must not be set; `, 'm'));
  });

  await t.test('[AC-03][F-017] guard --staged accepts a valid post staged with a harmless author default', GIT_CASE, () => {
    const result = guardStagedUnchanged(stagedWithConfig(postRel, '_config.yml', scopedDefault(postRel, 'author: "Someone Else"')));
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: staged tree ok (1 changed article checked)\n');
    assert.equal(result.stderr, '');
  });
});

test('[AC-03][F-017] guard --pre-push refuses a range in which one commit adds a post with a hiding _config.yml and a later one deletes both', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-held.md`;
  const config = scopedDefault(postRel, 'published: false');
  write(repo, '_config.yml', config);
  write(repo, postRel, validArticle({ title: 'Held article' }));
  git(repo, 'add', '_config.yml', postRel);
  commit(repo, 'Add a post the configuration hides');
  const hidingCommit = git(repo, 'rev-parse', 'HEAD').slice(0, 7);
  git(repo, 'rm', '-q', '_config.yml', postRel);
  commit(repo, 'Remove both again');
  assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').includes('_config.yml'), false,
    'the tip itself holds no configuration, so only a check of every commit catches it');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  assert.match(result.stderr, new RegExp(`^error: ${hidingCommit}: _config\\.yml: line ${configLine(config, 'published:')}: `
    + 'defaults set published for the posts in their scope: published: false keeps them off the site ', 'm'));
  assert.match(result.stderr, /guard: push refused \(1 problem in 1 commit\)/);
});

test('[AC-03][F-017] guard --pre-push accepts a valid post pushed with a harmless _config.yml', GIT_CASE, () => {
  const { repo } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-shipped.md`;
  write(repo, '_config.yml', scopedDefault(postRel, 'author: "Someone Else"'));
  write(repo, postRel, validArticle({ title: 'Shipped article' }));
  git(repo, 'add', '_config.yml', postRel);
  commit(repo, 'Publish: Shipped article');

  const result = prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 0);
  assert.equal(result.stdout, 'guard: ok (1 commit checked)\n');
  assert.equal(result.stderr, '');
});

/* guard --pre-push: a pushed tree gets every rule a commit's tree gets      */

test('[AC-03][F-017] guard --pre-push applies the site-configuration and submodule rules to a pushed tree as to a commit\'s tree', GIT_CASE, async (t) => {
  await t.test('[AC-03][F-017] a tree whose configuration keeps one of its posts off the site is refused, naming the tree', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const postRel = `_posts/${PAST}-held.md`;
    const config = scopedDefault(postRel, 'published: false');
    write(repo, '_config.yml', config);
    write(repo, postRel, validArticle({ title: 'Held article' }));
    git(repo, 'add', '_config.yml', postRel);
    const tree = git(repo, 'write-tree');
    git(repo, 'reset', '-q');
    const result = prePushToOrigin({ repo, remote }, [['refs/tags/t-held', tree, 'refs/tags/t-held', ZERO_SHA]]);
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`^error: ${tree.slice(0, 7)}: _config\\.yml: line `
      + `${configLine(config, 'published:')}: defaults set published for the posts in their scope: `, 'm'));
    assert.match(result.stderr, /guard: push refused \(1 problem in 1 tree\)\.\n$/);
  });

  await t.test('[AC-03][F-017] a tree holding a submodule is refused, naming the tree', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},notes`);
    const tree = git(repo, 'write-tree');
    git(repo, 'reset', '-q');
    const result = prePushToOrigin({ repo, remote }, [['refs/tags/t-subm', tree, 'refs/tags/t-subm', ZERO_SHA]]);
    expectExit(result, 1);
    assert.match(result.stderr, new RegExp(`^error: ${tree.slice(0, 7)}: notes: submodules are not allowed; `, 'm'));
    assert.match(result.stderr, /guard: push refused \(1 problem in 1 tree\)\.\n$/);
  });
});

/* Article analyses reused by blob id                                        */

test('[AC-03][F-017] guard --pre-push checks a recurring article blob in every commit, refusing only the one lacking its image', GIT_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-recurring.md`;
  const imageRel = 'assets/blog/recurring/fig.png';
  const withFigure = validArticle({ body: "![Figure]({{ '/assets/blog/recurring/fig.png' | relative_url }})" });
  const withoutFigure = validArticle({ body: 'This version has no figure.' });
  /** Commits `text` as the post; each version is one blob however often it recurs. */
  const commitPost = (text, message) => {
    write(repo, postRel, text);
    git(repo, 'add', postRel);
    commit(repo, message);
  };
  write(repo, imageRel, PNG);
  git(repo, 'add', imageRel);
  commitPost(withFigure, 'Add the post and its image');
  commitPost(withoutFigure, 'Change the post');
  commitPost(withFigure, 'Restore the post');
  git(repo, 'rm', '-q', imageRel);
  commitPost(withoutFigure, 'Change the post again and delete the image');
  commitPost(withFigure, 'Restore the post without its image');
  const blobAt = (rev) => git(repo, 'rev-parse', `${rev}:${postRel}`);
  assert.equal(blobAt('HEAD~4'), blobAt('HEAD'), 'the first and last commits hold the same blob');
  assert.equal(blobAt('HEAD~2'), blobAt('HEAD'), 'the restoring commit holds it too');
  assert.equal(blobAt('HEAD~3'), blobAt('HEAD~1'), 'the changed version recurs as well');

  const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  const tip = git(repo, 'rev-parse', 'HEAD').slice(0, 7);
  const reported = result.stderr.split('\n').filter((line) => line.startsWith('error: '));
  assert.deepEqual(reported, [`error: ${tip}: ${postRel}:7: image /assets/blog/recurring/fig.png does not exist`],
    'the blob passes in the commits that hold its image and fails only in the one that does not');
  assert.match(result.stderr, /push refused \(1 problem in 1 commit\)/);
});

/**
 * Stages `text` as a regular file at a path given as bytes, through
 * `git update-index -z --index-info`, so a case can use a name that is not
 * valid UTF-8 whatever the filesystem (APFS and NTFS refuse to create one).
 *
 * @param {string} repo The repository.
 * @param {Buffer} pathBytes The repository-relative path, exactly as git stores it.
 * @param {string} text The file's content.
 */
function stageAtBytes(repo, pathBytes, text) {
  const blob = spawnOk('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: ENV, input: text }).stdout.trim();
  spawnOk('git', ['update-index', '-z', '--index-info'], {
    cwd: repo,
    env: ENV,
    input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), pathBytes, Buffer.from([0])]),
  });
}

test('[AC-03][F-017] guard refuses byte-distinct paths that are not valid UTF-8, so neither hides the other', GIT_CASE, async (t) => {
  // Decoded lossily, both names read `_posts/\uFFFD/…-twin.md`, and the valid
  // twin's blob would be checked in place of the one holding `published:`.
  const twinPath = (byte) => Buffer.concat([
    Buffer.from('_posts/'), Buffer.from([byte]), Buffer.from(`/${PAST}-twin.md`),
  ]);
  const stageTwins = (repo) => {
    stageAtBytes(repo, twinPath(0x80), validArticle({ extra: 'published: false' }));
    stageAtBytes(repo, twinPath(0x81), validArticle());
  };
  const refusal = new RegExp(`^error: the git record "[^"\\n]*\\\\t_posts/\\\\200/${PAST}-twin\\.md" `
    + 'is not valid UTF-8; .*rename it to a valid UTF-8 name$', 'm');

  await t.test('[AC-03][F-017] guard --staged refuses the staged twins, naming the first as git quotes it', GIT_CASE, () => {
    const repo = makeRepo();
    stageTwins(repo);
    const result = guardStagedUnchanged(repo);
    expectExit(result, 1);
    assert.match(result.stderr, refusal);
    assert.match(result.stderr, /refuses \(fail closed\)/);
    assert.equal(result.stdout, '');
  });

  await t.test('[AC-03][F-017] guard --pre-push refuses a pushed commit holding the twins', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const remoteSha = git(repo, 'rev-parse', 'HEAD');
    stageTwins(repo);
    commit(repo, 'Add byte-distinct twins');
    const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 1);
    assert.match(result.stderr, refusal);
    assert.equal(result.stdout, '');
  });
});

test('[AC-03][F-017] guard reads valid UTF-8 paths exactly: a non-ASCII post folder and a name led by a byte-order mark', GIT_CASE, async (t) => {
  const postRel = `_posts/café/${PAST}-ok.md`;
  // Not an article: with its byte-order mark dropped it would read as one.
  const markedRel = `\uFEFF_posts/${PAST}-ok.md`;
  const stageBoth = (repo) => {
    write(repo, postRel, validArticle());
    write(repo, markedRel, 'Notes kept outside the posts.\n');
    git(repo, 'add', postRel, markedRel);
  };

  await t.test('[AC-03][F-017] guard --staged accepts them, checking the one article', GIT_CASE, () => {
    const repo = makeRepo();
    stageBoth(repo);
    const result = guardStagedUnchanged(repo);
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: staged tree ok (1 changed article checked)\n');
  });

  await t.test('[AC-03][F-017] guard --pre-push accepts a commit adding them', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const remoteSha = git(repo, 'rev-parse', 'HEAD');
    stageBoth(repo);
    commit(repo, 'Publish: ok');
    const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 0);
    assert.equal(result.stdout, 'guard: ok (1 commit checked)\n');
  });
});

/**
 * Stages a symbolic link to `target` at `rel` through `git update-index
 * --cacheinfo`, recording it as `git add` would, without creating it on disk
 * (where symbolic links can need privileges or `core.symlinks` is off).
 */
function stageSymlink(repo, rel, target) {
  const blob = spawnOk('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: ENV, input: target }).stdout.trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},${rel}`);
}

/** Stages a submodule (gitlink) at `rel` pointing at the repository's own `HEAD` commit. */
function stageGitlink(repo, rel) {
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${git(repo, 'rev-parse', 'HEAD')},${rel}`);
}

/**
 * The `error: ` lines of a guard run without that prefix and, given the
 * commit's short id `short`, without the `<short>: ` that `guard --pre-push` adds.
 */
function guardErrors(result, short = '') {
  return result.stderr.split('\n').filter((line) => line.startsWith('error: '))
    .map((line) => line.slice('error: '.length))
    .map((line) => (short !== '' && line.startsWith(`${short}: `) ? line.slice(short.length + 2) : line));
}

test('[AC-03][F-017] guard checks an article path that changes type and refuses one that is not a regular file anywhere in the tree', GIT_CASE, async (t) => {
  const rel = `_posts/${PAST}-typed.md`;
  const hidden = validArticle({ extra: 'published: false' });
  const writeHidden = (repo) => {
    write(repo, rel, hidden);
    git(repo, 'add', rel);
  };
  const writeValid = (repo) => {
    write(repo, rel, validArticle());
    git(repo, 'add', rel);
  };
  const publishedKey = new RegExp(`^${escapeRegExp(rel)}: published: `);
  const isLink = new RegExp(`^${escapeRegExp(rel)}: a symbolic link cannot be an article$`);
  const isSubmodule = new RegExp(`^${escapeRegExp(rel)}: a submodule cannot be an article$`);
  // `before` is committed (and, for guard --pre-push, already on the remote);
  // `change` is what the commit or push being judged adds. Each case is
  // refused with exactly the one error `expect` matches.
  const cases = [
    {
      name: 'a symbolic link that becomes a regular file holding published: false',
      before: (repo) => stageSymlink(repo, rel, 'elsewhere.md'),
      change: writeHidden,
      expect: publishedKey,
    },
    {
      name: 'a submodule that becomes a regular file holding published: false',
      before: (repo) => stageGitlink(repo, rel),
      change: writeHidden,
      expect: publishedKey,
    },
    {
      name: 'a regular file that becomes a symbolic link',
      before: writeValid,
      change: (repo) => stageSymlink(repo, rel, 'elsewhere.md'),
      expect: isLink,
    },
    {
      name: 'a regular file that becomes a submodule',
      before: writeValid,
      change: (repo) => stageGitlink(repo, rel),
      expect: isSubmodule,
    },
    {
      name: 'an unchanged symbolic link article beside a valid new post',
      before: (repo) => stageSymlink(repo, rel, 'elsewhere.md'),
      change: (repo) => {
        write(repo, `_posts/${PAST}-fresh.md`, validArticle({ title: 'Fresh' }));
        git(repo, 'add', `_posts/${PAST}-fresh.md`);
      },
      expect: isLink,
    },
  ];

  for (const { name, before, change, expect } of cases) {
    await t.test(`[AC-03][F-017] guard --staged refuses ${name}`, GIT_CASE, () => {
      const repo = makeRepo();
      before(repo);
      commit(repo, 'Before');
      change(repo);
      const result = guardStagedUnchanged(repo);
      expectExit(result, 1);
      const errors = guardErrors(result);
      assert.equal(errors.length, 1, `exactly one error:\n${result.stderr}`);
      assert.match(errors[0], expect);
    });

    await t.test(`[AC-03][F-017] guard --pre-push refuses ${name}`, GIT_CASE, () => {
      const { repo, remote } = makeRemoteRepo((r) => {
        before(r);
        commit(r, 'Before');
      });
      const remoteSha = git(repo, 'rev-parse', 'HEAD');
      change(repo);
      commit(repo, 'Change');
      const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
      expectExit(result, 1);
      const errors = guardErrors(result, git(repo, 'rev-parse', 'HEAD').slice(0, 7));
      assert.equal(errors.length, 1, `exactly one error:\n${result.stderr}`);
      assert.match(errors[0], expect);
    });
  }

  await t.test('[AC-03][F-017] guard accepts a symbolic link outside the article folders', GIT_CASE, () => {
    const { repo, remote } = makeRemoteRepo();
    const remoteSha = git(repo, 'rev-parse', 'HEAD');
    stageSymlink(repo, 'notes/latest.md', '../README.md');
    expectExit(guardStagedUnchanged(repo), 0);
    commit(repo, 'Link the notes');
    expectExit(prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha), 0);
  });
});

/** guard's refusal of `rel` as a tracked draft or draft image. */
function draftError(rel) {
  return `${rel}: drafts and draft images must never be tracked (git rm --cached; they belong only in your working copy)`;
}

/** guard's refusal of `rel`, whose leading folder `folder` spells `canonical` (`_posts` or `assets/blog`) in another letter case. */
function caseVariantError(rel, folder, canonical) {
  return `${rel}: folder ${folder}/ must be named exactly ${canonical}/; a case-insensitive file system such as macOS's `
    + 'treats them as one folder, but the Pages build and these checks do not';
}

/** guard's refusal of an entry at exactly `rel` (`_posts` or `assets/blog`), which must be a real folder. */
function realFolderError(rel) {
  return `${rel}: must be a real folder; a file, symbolic link or submodule here supplies content the checks never read`;
}

/** guard's refusal of `rel`, a path in a `_posts` folder below the repository root. */
function nestedPostsError(rel) {
  return `${rel}: articles belong only in the root _posts/ folder; Jekyll can read a nested _posts/ folder as posts, `
    + 'but the article checks cover only the root one';
}

/**
 * Runs each case's `stage(repo)` in a new repository and asserts that guard
 * refuses it with exactly the errors `expect` lists, in order: from the index
 * with `guard --staged`, and once committed with `guard --pre-push`. Both
 * runs must leave the repository (and the remote) exactly as they were.
 */
async function assertGuardRefusesInBothModes(t, cases) {
  for (const { name, stage, expect } of cases) {
    await t.test(`[AC-03][F-017] guard --staged refuses ${name}`, GIT_CASE, () => {
      const repo = makeRepo();
      stage(repo);
      const result = guardStagedUnchanged(repo);
      expectExit(result, 1);
      assert.deepEqual(guardErrors(result), expect, `stderr:\n${result.stderr}`);
    });

    await t.test(`[AC-03][F-017] guard --pre-push refuses ${name}`, GIT_CASE, () => {
      const { repo, remote } = makeRemoteRepo();
      const remoteSha = git(repo, 'rev-parse', 'HEAD');
      stage(repo);
      commit(repo, 'Change');
      const result = prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha);
      expectExit(result, 1);
      assert.deepEqual(guardErrors(result, git(repo, 'rev-parse', 'HEAD').slice(0, 7)), expect, `stderr:\n${result.stderr}`);
    });
  }
}

test('[AC-03][F-017] guard refuses drafts and post folders in another letter case, and entries at the reserved folder paths', GIT_CASE, async (t) => {
  /** Writes `rel` and stages it with `git add -f`, past any ignore pattern. */
  const forceAdd = (rel, content) => (repo) => {
    write(repo, rel, content);
    git(repo, 'add', '-f', '--', rel);
  };
  await assertGuardRefusesInBothModes(t, [
    {
      name: 'a draft in _Drafts/ added with git add -f',
      stage: forceAdd('_Drafts/my-post.md', validArticle()),
      expect: [draftError('_Drafts/my-post.md')],
    },
    {
      name: 'a draft image in assets/Drafts/ added with git add -f',
      stage: forceAdd('assets/Drafts/my-post/fig.png', PNG),
      expect: [draftError('assets/Drafts/my-post/fig.png')],
    },
    {
      name: 'a draft in a nested blog/_DRAFTS/ folder',
      stage: forceAdd('blog/_DRAFTS/x.md', validArticle()),
      expect: [draftError('blog/_DRAFTS/x.md')],
    },
    {
      name: 'a future-dated post in _Posts/',
      stage: forceAdd('_Posts/2099-01-01-x.md', validArticle()),
      expect: [caseVariantError('_Posts/2099-01-01-x.md', '_Posts', '_posts')],
    },
    {
      name: 'an image in assets/Blog/ without its post',
      stage: forceAdd('assets/Blog/ghost/fig.png', PNG),
      expect: [caseVariantError('assets/Blog/ghost/fig.png', 'assets/Blog', 'assets/blog')],
    },
    {
      name: 'a symbolic link at _drafts',
      stage: (repo) => stageSymlink(repo, '_drafts', '_hold'),
      expect: [draftError('_drafts')],
    },
    {
      name: 'a symbolic link at assets/drafts naming a local folder',
      stage: (repo) => stageSymlink(repo, 'assets/drafts', '/home/author/Dropbox/blog-drafts/img'),
      expect: [draftError('assets/drafts')],
    },
    {
      name: 'a symbolic link at _posts',
      stage: (repo) => stageSymlink(repo, '_posts', '_hold'),
      expect: [realFolderError('_posts')],
    },
    {
      name: 'a symbolic link at assets/blog',
      stage: (repo) => stageSymlink(repo, 'assets/blog', '../elsewhere'),
      expect: [realFolderError('assets/blog')],
    },
  ]);
});

/** guard's refusal of a submodule (gitlink) at `rel`, refused wherever it sits. */
function submoduleError(rel) {
  return `${rel}: submodules are not allowed; GitHub Pages builds a submodule's files into the site, where they would `
    + 'skip every check';
}

test('[AC-03][F-017] guard refuses a submodule anywhere, also by the folder rule of its path', GIT_CASE, async (t) => {
  await assertGuardRefusesInBothModes(t, [
    { name: 'a submodule at _posts', stage: (repo) => stageGitlink(repo, '_posts'), expect: [submoduleError('_posts'), realFolderError('_posts')] },
    {
      name: 'a submodule at a nested blog/_posts',
      stage: (repo) => stageGitlink(repo, 'blog/_posts'),
      expect: [submoduleError('blog/_posts'), nestedPostsError('blog/_posts')],
    },
    { name: 'a submodule at _drafts', stage: (repo) => stageGitlink(repo, '_drafts'), expect: [submoduleError('_drafts'), draftError('_drafts')] },
    {
      name: 'a submodule at assets/blog',
      stage: (repo) => stageGitlink(repo, 'assets/blog'),
      expect: [submoduleError('assets/blog'), realFolderError('assets/blog')],
    },
    { name: 'a submodule at notes, outside every content folder', stage: (repo) => stageGitlink(repo, 'notes'), expect: [submoduleError('notes')] },
  ]);
});

/** The repository's own `.gitignore`, which ignores a `_drafts` or `assets/drafts` link rather than staging it. */
const REPO_GITIGNORE = fs.readFileSync(path.join(ROOT, '.gitignore'));

/** guard's refusal of `rel`, a file in `target/`, the folder the link `linkRel` makes a folder of `kind`. */
function linkedDraftError(rel, linkRel, target, kind = 'drafts') {
  return `${rel}: drafts and draft images must never be tracked; ${linkRel} is a symbolic link to ${target}/, so the `
    + `files there are ${kind} (git rm --cached, or replace ${linkRel} with a real, git-ignored folder)`;
}

test('[AC-03][F-017] guard refuses the files of a repository folder that a _drafts or assets/drafts link turns into drafts', { ...GIT_CASE, ...LINK_CASE }, async (t) => {
  /**
   * Writes `files`, creates each link of `links` as [link, target], and
   * stages everything with the repository's `.gitignore` and `git add -A`,
   * as an author would: the ignored link stays out, its target's files go in.
   */
  const addAll = (files, links) => (repo) => {
    write(repo, '.gitignore', REPO_GITIGNORE);
    for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
    for (const [rel, target] of links) link(repo, rel, target);
    git(repo, 'add', '-A');
    for (const [rel] of links) assert.equal(git(repo, 'ls-files', '--', rel), '', `${rel} is git-ignored, not staged`);
  };
  const draft = validArticle({ title: 'Not for publication yet' });
  await assertGuardRefusesInBothModes(t, [
    {
      name: 'a draft in _hold/ while _drafts links to _hold',
      stage: addAll({ '_hold/my-post.md': draft }, [['_drafts', '_hold']]),
      expect: [linkedDraftError('_hold/my-post.md', '_drafts', '_hold')],
    },
    {
      name: 'a draft in _hold/ while a nested blog/_drafts links to ../_hold',
      stage: addAll({ 'blog/index.html': '<p>Blog</p>\n', '_hold/my-post.md': draft }, [['blog/_drafts', '../_hold']]),
      expect: [linkedDraftError('_hold/my-post.md', 'blog/_drafts', '_hold')],
    },
    {
      name: 'a draft in Hold/ while _Drafts, in another letter case, links to Hold',
      stage: addAll({ 'Hold/notes/my-post.md': draft }, [['_Drafts', 'Hold']]),
      expect: [linkedDraftError('Hold/notes/my-post.md', '_Drafts', 'Hold')],
    },
    {
      name: 'a draft image in imgs/ while assets/drafts links to ../imgs',
      stage: addAll({ 'assets/hero.png': PNG, 'imgs/my-post/fig.png': PNG }, [['assets/drafts', '../imgs']]),
      expect: [linkedDraftError('imgs/my-post/fig.png', 'assets/drafts', 'imgs', 'draft images')],
    },
    {
      name: 'any commit while _drafts links to the top folder itself, refused once by the link',
      stage: addAll({ [`_posts/${PAST}-fine.md`]: validArticle() }, [['_drafts', '.']]),
      expect: ["_drafts: a symbolic link to the repository's top folder makes every file in it one of your drafts, "
        + 'which must never be tracked; replace _drafts with a real, git-ignored folder'],
    },
  ]);

  const outside = caseDir('outside-drafts');
  write(outside, 'private.md', draft);
  const accepted = [
    { name: 'a _drafts link to a folder outside the repository', links: [['_drafts', outside]] },
    { name: 'a dangling _drafts link', links: [['_drafts', '_missing']] },
    { name: 'an assets/drafts link to a folder outside the repository', links: [['assets/drafts', outside]] },
  ];
  for (const { name, links } of accepted) {
    await t.test(`[AC-03][F-017] guard --staged and --pre-push accept a valid post beside ${name}`, GIT_CASE, () => {
      const { repo, remote } = makeRemoteRepo();
      const remoteSha = git(repo, 'rev-parse', 'HEAD');
      addAll({ [`_posts/${PAST}-fine.md`]: validArticle() }, links)(repo);
      expectExit(guardStagedUnchanged(repo), 0);
      commit(repo, 'Publish: fine');
      expectExit(prePushUnchanged({ repo, remote }, 'refs/heads/main', 'refs/heads/main', remoteSha), 0);
    });
  }

  // Listing a folder for links fails: EACCES must refuse (fail closed); ENOENT, a folder gone from disk, is skipped.
  const folder = `${path.sep}notes-q7`;
  for (const [code, status] of [['EACCES', 1], ['ENOENT', 0]]) {
    await t.test(`[AC-03][F-017] guard --staged and --pre-push exit ${status} when listing a checked folder for links fails with ${code}`, GIT_CASE, () => {
      const { repo, remote } = makeRemoteRepo();
      const remoteSha = git(repo, 'rev-parse', 'HEAD');
      write(repo, 'notes-q7/readme.md', 'Notes.\n');
      git(repo, 'add', 'notes-q7/readme.md');
      const faults = JSON.stringify([{ fn: 'readdirSync', path: folder, action: 'throw', code }]);
      const faulty = { nodeArgs: ['--import', FAULT_PRELOAD_URL], env: { ARTICLE_FAULTS: faults } };
      const denied = new RegExp(`^error: EACCES: injected fault, readdirSync '.*${escapeRegExp(folder)}'$`, 'm');
      const staged = unchangedBy(() => repoSnapshot(repo), () => run(['guard', '--staged'], { cwd: repo, ...faulty }),
        'the repository');
      expectExit(staged, status);
      if (status === 1) assert.match(staged.stderr, denied);
      commit(repo, 'Add notes');
      const input = `refs/heads/main ${git(repo, 'rev-parse', 'HEAD')} refs/heads/main ${remoteSha}\n`;
      const pushed = unchangedBy(
        () => ({ repo: repoSnapshot(repo), remote: remoteSnapshot(remote) }),
        () => run(['guard', '--pre-push'], { cwd: repo, input, ...faulty }),
        'the repository and its remote',
      );
      expectExit(pushed, status);
      if (status === 1) assert.match(pushed.stderr, denied);
    });
  }
});

test('[AC-03][F-017] checkTrackedContent reuses a cached analysis per id across trees and redoes it for changed text', async () => {
  const { checkTrackedContent } = await import(new URL('../../scripts/lib/articles.mjs', import.meta.url));
  const today = todayUtc();
  const postPath = `_posts/${PAST}-cached.md`;
  const copyPath = `_posts/${PAST}-cached-copy.md`;
  // The template's closing placeholder line, an image and unsafe markup: a finding from each analysis.
  const placeholder = fs.readFileSync(TEMPLATE, 'utf8').trimEnd().split('\n').pop();
  const text = validArticle({
    body: `![Figure](/assets/blog/cached/fig.png)\n\n${placeholder}\n\n<script>alert(1)</script>`,
  });
  const withImage = [postPath, 'assets/blog/cached/fig.png'];
  const withoutImage = [postPath];
  const check = (paths, articles, cache) => checkTrackedContent({ paths, articles, todayUtc: today, cache });
  const plain = (...paths) => paths.map((p) => ({ path: p, text }));

  const cache = new Map();
  const first = check(withImage, [{ path: postPath, text, id: 'blob-a' }], cache);
  assert.equal(cache.size, 1);
  const entry = cache.get('blob-a');
  const second = check(withoutImage, [{ path: postPath, text, id: 'blob-a' }], cache);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('blob-a'), entry, 'the same id and text reuse the stored analysis');
  assert.deepEqual(first, check(withImage, plain(postPath)), 'a reused analysis reports what a fresh one does');
  assert.deepEqual(second, check(withoutImage, plain(postPath)));
  const missing = `${postPath}:7: image /assets/blog/cached/fig.png does not exist`;
  assert.equal(first.includes(missing), false, 'the image exists in the first tree');
  assert.equal(second.includes(missing), true, 'existence is checked against the tree of each call');
  assert.ok(second.some((e) => e.startsWith(`${postPath}:9: body still contains`)), 'placeholder line reported');
  assert.ok(second.some((e) => e.startsWith(`${postPath}:11: unsafe markup`)), 'unsafe markup reported');

  // One blob at two paths shares the analysis; each path keeps its own filename and folder rules.
  const shared = [{ path: postPath, text, id: 'blob-a' }, { path: copyPath, text, id: 'blob-a' }];
  const both = check([...withImage, copyPath], shared, cache);
  assert.equal(cache.get('blob-a'), entry);
  assert.deepEqual(both, check([...withImage, copyPath], plain(postPath, copyPath)));
  assert.ok(both.some((e) => e.startsWith(`${copyPath}:7: `)), "the copy's image is outside the copy's own folder");

  // Different text under a known id is analysed afresh and replaces the entry.
  const edited = validArticle({ body: 'Edited body.' });
  assert.deepEqual(check(withoutImage, [{ path: postPath, text: edited, id: 'blob-a' }], cache), []);
  assert.equal(cache.size, 1);
  assert.notEqual(cache.get('blob-a'), entry, 'the entry for the old text is replaced');

  // A cache value checkTrackedContent did not make is never trusted.
  const forged = new Map([['blob-b', {
    text, data: {}, body: '', parseErrors: [], bodyStartLine: 1, unsafe: [],
    bodyAnalysis: { lineAt: () => 1, todoLines: [], images: [] },
  }]]);
  assert.deepEqual(check(withoutImage, [{ path: postPath, text, id: 'blob-b' }], forged), second);

  assert.throws(() => check(withoutImage, [], {}), { name: 'TypeError', message: /cache must be a Map/ });
  for (const id of ['', 42]) {
    assert.throws(() => check(withoutImage, [{ path: postPath, text, id }]),
      { name: 'TypeError', message: /must be a non-empty string/ });
  }
});

/* guard when git itself does not answer                                     */

/** The shim is a POSIX shell script, which Windows cannot run as `git`. */
const SHIM_CASE = { ...GIT_CASE, skip: process.platform === 'win32' ? 'the git shim needs a POSIX shell' : false };

let realGitPath;

/** Absolute path of the git on `ENV`'s PATH, resolved once, before any shim stands in front of it. */
function realGit() {
  if (realGitPath === undefined) {
    const result = spawnOk('sh', ['-c', 'command -v git'], { env: ENV });
    const found = result.stdout.trim();
    assert.ok(path.isAbsolute(found), `command -v git found no git on PATH: ${JSON.stringify(result.stdout)}`);
    realGitPath = found;
  }
  return realGitPath;
}

/** Quotes text as one POSIX shell word. */
function shQuote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * A stand-in `git` first on PATH: a POSIX shell script that appends its
 * arguments to a log, one call per line, and kills itself with SIGKILL when
 * they start with `killPrefix`, as a git ended by a signal would end;
 * otherwise it runs the real git.
 *
 * @returns {{ env: NodeJS.ProcessEnv, calls: () => string[] }} The tool's
 *   environment, and the logged argument lines so far.
 */
function gitShim(killPrefix) {
  const dir = caseDir('git-shim');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shQuote(log)}`,
    `case "$*" in ${shQuote(killPrefix)}*) kill -9 $$ ;; esac`,
    `exec ${shQuote(realGit())} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    env: { ...ENV, PATH: `${dir}${path.delimiter}${ENV.PATH ?? ''}` },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []),
  };
}

test('[AC-03][F-017] guard --staged refuses (fail closed) when git is killed by a signal', SHIM_CASE, () => {
  const repo = makeRepo();
  const postRel = `_posts/${PAST}-staged.md`;
  write(repo, postRel, validArticle({ title: 'Staged article' }));
  git(repo, 'add', postRel);
  expectExit(guardStaged(repo), 0);

  const shim = gitShim('diff --cached');
  const result = unchangedBy(() => repoSnapshot(repo), () => run(['guard', '--staged'], { cwd: repo, env: shim.env }),
    'the repository');
  expectExit(result, 1);
  assert.match(result.stderr, /git diff --cached [^\n]*failed: was killed by SIGKILL/,
    'the refusal names the git command and the signal');
  assert.match(result.stderr, /fail closed/);
  const calls = shim.calls();
  assert.equal(calls.filter((call) => call.startsWith('diff --cached')).length, 1, `calls:\n${calls.join('\n')}`);
  assert.ok(calls.at(-1).startsWith('diff --cached'),
    `no git command runs after the killed one, so its missing answer steers nothing:\n${calls.join('\n')}`);
});

test('[AC-03][F-017] guard --pre-push refuses (fail closed) when the probe for the remote tip is killed, without widening the range', SHIM_CASE, () => {
  const { repo, remote } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-pushed.md`;
  write(repo, postRel, validArticle({ title: 'Pushed article' }));
  git(repo, 'add', postRel);
  commit(repo, 'Publish: Pushed article');
  expectExit(prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha), 0);

  const shim = gitShim('cat-file -e');
  const localSha = git(repo, 'rev-parse', 'HEAD');
  const result = unchangedBy(
    () => ({ repo: repoSnapshot(repo), remote: remoteSnapshot(remote) }),
    () => run(['guard', '--pre-push'], {
      cwd: repo,
      env: shim.env,
      input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
    }),
    'the repository and its remote',
  );
  expectExit(result, 1);
  assert.match(result.stderr,
    new RegExp(`git cat-file -e ${escapeRegExp(`${remoteSha}^{commit}`)} failed: was killed by SIGKILL`),
    'the refusal names the probe and the signal');
  assert.match(result.stderr, /fail closed/);
  const calls = shim.calls();
  assert.ok(calls.some((call) => call.startsWith('cat-file -e')), `the probe ran:\n${calls.join('\n')}`);
  assert.equal(calls.some((call) => call.startsWith('rev-list')), false,
    `a killed probe is not read as an unknown remote tip, so no range is listed:\n${calls.join('\n')}`);
});

/* Articles that are not valid UTF-8                                         */

/**
 * A valid article (`validArticle(fields)`) with the bytes `bad` in place of
 * its one `@`, and where `bad` starts: the byte offset and file line the
 * tool reports.
 *
 * @returns {{ bytes: Buffer, offset: number, line: number }}
 */
function articleWithBytes(fields, bad) {
  const text = validArticle(fields);
  const at = text.indexOf('@');
  assert.ok(at !== -1 && text.indexOf('@', at + 1) === -1, 'one @ marks where the bytes go');
  const before = Buffer.from(text.slice(0, at), 'utf8');
  return {
    bytes: Buffer.concat([before, bad, Buffer.from(text.slice(at + 1), 'utf8')]),
    offset: before.length,
    line: text.slice(0, at).split('\n').length,
  };
}

/** Articles saved in another encoding than UTF-8, which the Pages build silently leaves out of the site. */
const NOT_UTF8_ARTICLES = [
  ['Latin-1 (\\xe9)', () => articleWithBytes({ title: 'Notes from the caf@' }, Buffer.from([0xe9]))],
  ['Windows-1252 quotes (\\x93, \\x94)',
    () => articleWithBytes({ summary: 'A @ summary.' }, Buffer.concat([Buffer.from([0x93]), Buffer.from('quoted'), Buffer.from([0x94])]))],
  ['UTF-16 (\\xff\\xfe)',
    () => ({ bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(validArticle(), 'utf16le')]), offset: 0, line: 1 })],
  ['a cut-short sequence (\\xc3\\x28)', () => articleWithBytes({ body: 'Broken @ sequence.' }, Buffer.from([0xc3, 0x28]))],
];

/** The error the tool reports for `rel` when its first invalid UTF-8 sequence starts at `offset`, on `line`. */
function notUtf8Error(rel, { offset, line }) {
  return `${rel}: not valid UTF-8 (byte offset ${offset}, line ${line}); save the file as UTF-8`;
}

test('[AC-03][F-017] check and publish refuse an article that is not valid UTF-8, naming its first invalid byte, and move nothing', async (t) => {
  for (const [what, make] of NOT_UTF8_ARTICLES) {
    await t.test(`[AC-03][F-017] check and publish refuse ${what}`, () => {
      const root = makeRoot();
      const article = make();
      const draftRel = '_drafts/encoded.md';
      write(root, draftRel, article.bytes);
      write(root, 'assets/drafts/encoded/figure.png', PNG);
      const error = notUtf8Error(draftRel, article);

      for (const files of [[draftRel], []]) {
        const checked = checkRoot(root, ...files);
        expectExit(checked, 1);
        assert.ok(checked.stderr.includes(`error: ${error}\n`), `check ${files.join(' ')} names the byte:\n${checked.out}`);
        assert.doesNotMatch(checked.stdout, /^ok /m, 'the draft is not reported ok');
      }

      const published = unchangedBy(() => treeSnapshot(root), () => cli(root, 'publish', 'encoded'), `the root ${root}`);
      expectExit(published, 1);
      assert.ok(published.stderr.includes(`error: ${error}\n`), `publish names the byte:\n${published.out}`);
      assert.match(published.stderr, /publish refused \(1 problem\); nothing was moved/);
      assert.deepEqual(postsFor(root, 'encoded'), [], 'nothing is published');
    });
  }

  await t.test('[AC-03][F-017] check refuses a post that is not valid UTF-8', () => {
    const root = makeRoot();
    const [, make] = NOT_UTF8_ARTICLES[1];
    const article = make();
    const postRel = `_posts/${PAST}-cp1252.md`;
    write(root, postRel, article.bytes);
    const checked = checkRoot(root);
    expectExit(checked, 1);
    assert.ok(checked.stderr.includes(`error: ${notUtf8Error(postRel, article)}\n`), checked.out);
  });
});

test('[AC-03][F-017] a UTF-8 article with a byte-order mark, CRLF line ends and a NUL byte still passes check and publish', () => {
  const root = makeRoot();
  const text = validArticle({ title: 'Café notes', summary: 'A “quoted” summary.', body: 'Body with a NUL \u0000 byte.' });
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8')]);
  write(root, '_drafts/bom-crlf.md', bytes);
  expectExit(checkRoot(root, '_drafts/bom-crlf.md'), 0);
  expectExit(cli(root, 'publish', 'bom-crlf'), 0);
  const [postFile] = postsFor(root, 'bom-crlf');
  assert.deepEqual(fs.readFileSync(abs(root, `_posts/${postFile}`)), bytes, 'the post holds the draft\'s exact bytes');
  expectExit(checkRoot(root, `_posts/${postFile}`), 0);
});

test('[AC-03][F-017] guard --staged and guard --pre-push refuse an article that is not valid UTF-8, naming its path', GIT_CASE, async (t) => {
  const postRel = `_posts/${PAST}-encoded.md`;
  for (const [what, make] of NOT_UTF8_ARTICLES) {
    await t.test(`[AC-03][F-017] guard --staged refuses a staged post in ${what}`, () => {
      const repo = makeRepo();
      const article = make();
      write(repo, postRel, article.bytes);
      git(repo, 'add', postRel);
      const result = guardStagedUnchanged(repo);
      expectExit(result, 1);
      assert.deepEqual(guardErrors(result), [notUtf8Error(postRel, article)], result.out);
      assert.match(result.stderr, /guard: commit refused \(1 problem\)/);
      assert.doesNotMatch(result.stderr, /could not complete/, 'an ordinary refusal, not a git failure');
    });
  }

  await t.test('[AC-03][F-017] guard --pre-push refuses a commit that adds a post that is not valid UTF-8', () => {
    const repos = makeRemoteRepo();
    const remoteSha = git(repos.repo, 'rev-parse', 'HEAD');
    const [, make] = NOT_UTF8_ARTICLES[0];
    const article = make();
    write(repos.repo, postRel, article.bytes);
    git(repos.repo, 'add', postRel);
    commit(repos.repo, 'Publish: encoded');
    const short = git(repos.repo, 'rev-parse', 'HEAD').slice(0, 7);
    // A later commit that fixes the encoding does not clear the commit that holds the bad bytes.
    write(repos.repo, postRel, validArticle());
    git(repos.repo, 'add', postRel);
    commit(repos.repo, 'Fix encoding');
    const result = prePushUnchanged(repos, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 1);
    assert.ok(result.stderr.includes(`error: ${short}: ${notUtf8Error(postRel, article)}\n`), result.out);
    assert.match(result.stderr, /guard: push refused \(1 problem in 1 commit\)/);
    assert.doesNotMatch(result.stderr, /could not complete/, 'an ordinary refusal, not a git failure');
  });
});

/* Repeat publish                                                            */

test('[AC-03][F-017] publish run again for a published slug names the post, the update procedure and unpublish, not new', () => {
  const root = makeRoot();
  writeDraftWithImage(root, 'repeat');
  expectExit(cli(root, 'publish', 'repeat'), 0);
  const [postFile] = postsFor(root, 'repeat');
  const postRel = `_posts/${postFile}`;

  const again = unchangedBy(() => treeSnapshot(root), () => cli(root, 'publish', 'repeat'), `the root ${root}`);
  expectExit(again, 1);
  assert.ok(again.stderr.includes(`error: slug repeat is already published as ${postRel} and _drafts/repeat.md does `
    + 'not exist; to update the article, edit the post, set updated: YYYY-MM-DD'), again.out);
  assert.ok(again.stderr.includes('to take it down, run: node scripts/article.mjs unpublish repeat\n'), again.out);
  assert.doesNotMatch(again.out, /article\.mjs new/, 'no pointer to new, which refuses a published slug');

  expectExit(cli(root, 'unpublish', 'repeat'), 0);
  assert.ok(exists(root, '_drafts/repeat.md'), 'the unpublish it names succeeds');

  const unwritten = cli(root, 'publish', 'never-written');
  expectExit(unwritten, 1);
  assert.ok(unwritten.stderr.includes('error: _drafts/never-written.md does not exist; start a draft with: '
    + 'node scripts/article.mjs new never-written\n'), `with no post either, the hint to start a draft stays:\n${unwritten.out}`);
});

/* The staging line unpublish prints                                         */

/** `makeRepo()` with a committed `_config.yml`, so it is a site root for new, check, publish and unpublish. */
function makeSiteRepo() {
  const repo = makeRepo();
  write(repo, '_config.yml', SITE_CONFIG);
  git(repo, 'add', '_config.yml');
  commit(repo, 'Site configuration');
  return repo;
}

test('[AC-03][F-017] the git rm line unpublish prints succeeds whether or not the post was ever committed', GIT_CASE, async (t) => {
  /** Pastes the one printed `git rm` line of `result` into a POSIX shell in `repo`; it must succeed. */
  const pasteGitRm = (repo, result) => {
    const lines = result.stdout.split('\n').filter((line) => line.startsWith('  git rm '));
    assert.equal(lines.length, 1, `one git rm line:\n${result.stdout}`);
    spawnOk('sh', ['-c', lines[0]], { cwd: repo, env: ENV });
  };

  await t.test('[AC-03][F-017] a post published but never committed: the line succeeds and stages nothing', () => {
    const repo = makeSiteRepo();
    writeDraftWithImage(repo, 'uncommitted');
    expectExit(cli(repo, 'publish', 'uncommitted'), 0);
    const unpublished = cli(repo, 'unpublish', 'uncommitted');
    expectExit(unpublished, 0);
    assert.ok(unpublished.stdout.includes('If the post was never committed, there is nothing to commit: skip the commit '
      + 'and the push.\n'), unpublished.stdout);
    pasteGitRm(repo, unpublished);
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '', 'nothing is staged');
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '',
      'nothing to commit: the draft and its images are git-ignored');
  });

  await t.test('[AC-03][F-017] a committed post with images: the line stages exactly their deletion', () => {
    const repo = makeSiteRepo();
    const post = writePostWithImage(repo, 'committed');
    git(repo, 'add', post.rel, 'assets/blog/committed');
    commit(repo, 'Publish: committed');
    const unpublished = cli(repo, 'unpublish', 'committed');
    expectExit(unpublished, 0);
    pasteGitRm(repo, unpublished);
    assert.deepEqual(git(repo, 'diff', '--cached', '--name-status').split('\n').sort(),
      [`D\t${post.rel}`, 'D\tassets/blog/committed/figure.png'].sort(), 'the post and its image are staged as deleted');
    commit(repo, 'Unpublish: committed');
    assert.equal(git(repo, 'ls-files', '--', '_posts', 'assets/blog'), '', 'once committed, nothing of the article is tracked');
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '', 'nothing is left to commit');
  });
});

/* Output streams that fail                                                  */

/**
 * Runs a tool command in a temporary root as `cli` does, with its stdout a
 * pipe whose reading end this process closes at once, as `| head -1` does
 * after its line, so every write the tool makes to stdout fails with EPIPE.
 *
 * @returns {Promise<{ status: number | null, signal: string | null, stderr: string }>}
 */
function cliStdoutClosed(root, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ARTICLE_MJS, ...args, '--root', root], {
      cwd: root,
      env: ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stderr });
    });
  });
}

test('[AC-03][F-017] publish and unpublish exit 0 without a stack trace when stdout is a closed pipe, and check keeps its own exit code', async () => {
  const root = makeRoot();
  writeDraftWithImage(root, 'piped');
  const noCrash = (result, what) => {
    assert.equal(result.signal, null, `${what} ended by itself:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error' event|^\s+at /m, `${what} printed no stack trace`);
  };

  const published = await cliStdoutClosed(root, 'publish', 'piped');
  noCrash(published, 'publish');
  assert.equal(published.status, 0, `publish completed, so it exits 0:\n${published.stderr}`);
  assert.equal(postsFor(root, 'piped').length, 1, 'the post was written');
  assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/piped/figure.png')), PNG, 'the image was moved');

  const unpublished = await cliStdoutClosed(root, 'unpublish', 'piped');
  noCrash(unpublished, 'unpublish');
  assert.equal(unpublished.status, 0, `unpublish completed, so it exits 0:\n${unpublished.stderr}`);
  assert.ok(exists(root, '_drafts/piped.md'), 'the post is a draft again');
  assert.deepEqual(postsFor(root, 'piped'), [], 'the post is gone');

  write(root, '_drafts/untitled.md', validArticle({ title: '' }));
  const checked = await cliStdoutClosed(root, 'check', '_drafts/untitled.md');
  noCrash(checked, 'check');
  assert.equal(checked.status, 1, `a failed check still exits 1:\n${checked.stderr}`);
});

test('[AC-03][F-017] a write failure other than a closed pipe fails the command with a message naming the stream', { skip: fs.existsSync('/dev/full') ? false : 'needs /dev/full' }, () => {
  const root = makeRoot();
  write(root, '_drafts/full.md', validArticle());
  const fd = fs.openSync('/dev/full', 'w');
  try {
    const result = spawnSync(process.execPath, [ARTICLE_MJS, 'check', '--root', root], {
      cwd: root,
      env: ENV,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 1, `output that could not be written fails the command:\n${result.stderr}`);
    assert.match(result.stderr, /^error: cannot write to standard output \(ENOSPC[^)]*\); output was lost$/m);
    assert.doesNotMatch(result.stderr, /^\s+at /m, 'no stack trace');
  } finally {
    fs.closeSync(fd);
  }
});

/* Terminal control characters in output                                    */

/**
 * A character a terminal acts on instead of showing, as the tool must never
 * write it: a C0 control other than TAB and the LF that ends each line, DEL,
 * or a C1 control.
 */
const RAW_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** Options of the cases whose file names hold control characters, which Windows does not allow. */
const CONTROL_NAME_CASE = {
  skip: process.platform === 'win32' ? 'Windows file names cannot hold control characters' : false,
};

/**
 * Asserts that a tool run wrote no raw terminal control character to stdout
 * or stderr, and that each of `visible` (text holding the escapes the tool
 * writes, such as `\u001b`) appears in its output. Failure messages show the
 * output JSON-quoted, so the test runner's own terminal is not driven by it.
 */
function assertNeutralized(result, ...visible) {
  const raw = RAW_CONTROL_RE.exec(result.out);
  assert.equal(raw, null,
    `the raw character ${JSON.stringify(raw?.[0])} reached the output: ${JSON.stringify(result.out)}`);
  for (const text of visible) {
    assert.ok(result.out.includes(text), `${JSON.stringify(text)} is printed: ${JSON.stringify(result.out)}`);
  }
}

test('[AC-03][F-017] check and unpublish escape control characters from file names and article text, so each message is one terminal line', async (t) => {
  await t.test('[AC-03][F-017] check escapes the OSC, BEL and CSI sequences in a draft and a post name', CONTROL_NAME_CASE, () => {
    const root = makeRoot();
    write(root, '_drafts/x\u001b]0;QA9E-TITLE\u0007\u001b[2J.md', validArticle());
    write(root, '_posts/2026-01-01-y\u001b[31m.md', validArticle());
    const result = checkRoot(root);
    expectExit(result, 1);
    assertNeutralized(result,
      'error: _drafts/x\\u001b]0;QA9E-TITLE\\u0007\\u001b[2J.md: ',
      '(got "x\\u001b]0;QA9E-TITLE\\u0007\\u001b[2J")',
      'error: _posts/2026-01-01-y\\u001b[31m.md: ');
  });

  await t.test('[AC-03][F-017] unpublish keeps its refusal line and escapes a reference line that would erase it', () => {
    const root = makeRoot();
    const target = writePostWithImage(root, 'target');
    const refRel = `_posts/${PAST}-ref.md`;
    const refText = validArticle({
      title: 'The referrer',
      body: 'See [it](/blog/target/) \u001b[1A\u001b[2KHIDDEN\u001b]0;QA9E\u0007 here.',
    });
    write(root, refRel, refText);
    const line = refText.split('\n').findIndex((text) => text.includes('/blog/target/')) + 1;
    assert.ok(line > 0);
    const result = unpublishRefused(root, 'target');
    expectExit(result, 1);
    assertNeutralized(result, `error: unpublish refused: 1 reference to ${target.rel} remains:\n`
      + `  ${refRel}:${line}: See [it](/blog/target/) \\u001b[1A\\u001b[2KHIDDEN\\u001b]0;QA9E\\u0007 here.\n`);
  });

  await t.test('[AC-03][F-017] check escapes a CSI sequence in the unsafe-markup excerpt', () => {
    const root = makeRoot();
    write(root, '_drafts/esc-markup.md', validArticle({ body: '<script>x</script>\u001b[2K' }));
    const result = checkRoot(root, '_drafts/esc-markup.md');
    expectExit(result, 1);
    assertNeutralized(result, 'unsafe markup "<script>x</script>\\u001b[2K"');
  });

  await t.test('[AC-03][F-017] check escapes a C1 CSI, a CR and an LF in a draft name, which cannot forge a line', CONTROL_NAME_CASE, () => {
    const root = makeRoot();
    write(root, '_drafts/csi\u009b2Jcr\rlf\nok forged.md', validArticle());
    const result = checkRoot(root);
    expectExit(result, 1);
    assertNeutralized(result, 'error: _drafts/csi\\u009b2Jcr\\rlf\\nok forged.md: ');
    assert.doesNotMatch(result.out, /^ok forged/m, 'the name holds no line of its own');
  });
});

test('[AC-03][F-017] guard --staged escapes a control character in the name of a draft added with git add -f', { ...GIT_CASE, ...CONTROL_NAME_CASE }, () => {
  const repo = makeRepo();
  const draftRel = '_drafts/x\u001b]0;QA9E\u0007.md';
  write(repo, draftRel, validArticle());
  git(repo, 'add', '-f', draftRel);
  const result = guardStagedUnchanged(repo);
  expectExit(result, 1);
  assertNeutralized(result, '_drafts/x\\u001b]0;QA9E\\u0007.md', 'guard: commit refused (');
});

test('[AC-03][F-017] git stderr of two lines is reported with the second indented and escaped, and guard still fails closed', SHIM_CASE, () => {
  const repo = makeRepo();
  const dir = caseDir('git-two-lines');
  const log = path.join(dir, 'calls.log');
  const second = '\u001b[2Kerror: forged second line\u001b]0;QA9E\u0007';
  // The stand-in fails the first call guard makes, finding the repository root, as a git that cannot answer it would.
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shQuote(log)}`,
    `case "$*" in 'rev-parse --show-toplevel') printf '%s\\n%s\\n' 'fatal: first line' ${shQuote(second)} >&2; `
      + 'exit 128 ;; esac',
    `exec ${shQuote(realGit())} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { PATH: `${dir}${path.delimiter}${ENV.PATH ?? ''}` };
  const result = unchangedBy(() => repoSnapshot(repo), () => run(['guard', '--staged'], { cwd: repo, env }),
    'the repository');
  expectExit(result, 1);
  assert.equal(result.stderr, [
    'error: git rev-parse --show-toplevel failed: fatal: first line',
    '  \\u001b[2Kerror: forged second line\\u001b]0;QA9E\\u0007',
    'error: guard could not complete its checks, so it refuses (fail closed)',
    '',
  ].join('\n'), `JSON-quoted output: ${JSON.stringify(result.out)}`);
  assertNeutralized(result);
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter((call) => call !== '');
  assert.deepEqual(calls, ['rev-parse --show-toplevel'], 'the failing call is the first and only one guard makes');
});

test('[AC-03][F-017] scripts/article.mjs writes to stdout and stderr in one place, function emit', () => {
  const source = fs.readFileSync(ARTICLE_MJS, 'utf8');
  const writes = [...source.matchAll(/\.write\(/g)];
  assert.equal(writes.length, 1, `exactly one .write( call, found at offsets ${writes.map((w) => w.index).join(', ')}`);
  const start = source.indexOf('\nfunction emit(');
  assert.notEqual(start, -1, 'function emit exists');
  const end = source.indexOf('\n}\n', start);
  assert.ok(writes[0].index > start && writes[0].index < end, 'the one .write( call is inside function emit');
});

test('[AC-03][F-017] --help prints the usage block on stdout ending with its last line, and a usage error prints it after one blank line', () => {
  const root = makeRoot();
  const help = cli(root, '--help');
  expectExit(help, 0);
  assert.equal(help.stderr, '');
  assert.ok(help.stdout.startsWith('Usage: node scripts/article.mjs'), help.stdout);
  assert.ok(help.stdout.endsWith('Exit codes: 0 success, 1 validation failure, 2 usage error.\n'), help.stdout);
  assert.ok(!help.stdout.endsWith('\n\n'), 'no blank line follows the block');

  const refused = cli(root, 'frobnicate');
  expectExit(refused, 2);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, `error: unknown command "frobnicate"\n\n${help.stdout}`,
    'the usage error, one blank line, then the same block');
});

/* The site root                                                             */

test('[AC-03][F-017] new, check, publish and unpublish refuse a root without _config.yml with exit 2 and change nothing; guard still runs from a subfolder', GIT_CASE, async (t) => {
  /** A site repository with a draft and its image, a committed post with its image, and a blog/ subfolder. */
  const siteWithBlogFolder = () => {
    const repo = makeSiteRepo();
    write(repo, '_templates/article.md', fs.readFileSync(TEMPLATE));
    writeDraftWithImage(repo, 'waiting');
    const post = writePostWithImage(repo, 'live');
    write(repo, 'blog/index.html', '<p>Blog</p>\n');
    git(repo, 'add', post.rel, 'assets/blog/live', 'blog/index.html');
    commit(repo, 'Publish: live');
    return { repo, sub: path.join(repo, 'blog') };
  };
  /** Asserts that every command in `runs` was refused as a usage error with `error`, leaving `repo` as it was. */
  const refusedEverywhere = (repo, runs, error) => {
    for (const [args, options] of runs) {
      const result = unchangedBy(() => repoSnapshot(repo), () => run(args, options), 'the repository');
      expectExit(result, 2);
      assert.ok(result.stderr.startsWith(`error: ${error}\n`), `${args.join(' ')}:\n${result.out}`);
      assert.match(result.stderr, /Usage:/, 'the usage block follows');
      assert.equal(result.stdout, '', `${args.join(' ')} reports nothing as created, checked or moved`);
    }
  };

  await t.test('[AC-03][F-017] from a subfolder without --root, naming the folder above that holds _config.yml', () => {
    const { repo, sub } = siteWithBlogFolder();
    refusedEverywhere(repo, [
      [['new', 'subfolder-test'], { cwd: sub }],
      [['check'], { cwd: sub }],
      [['check', '../_drafts/waiting.md'], { cwd: sub }],
      [['publish', 'waiting'], { cwd: sub }],
      [['unpublish', 'live'], { cwd: sub }],
    ], `${sub} is not the site root (it has no _config.yml); run the command from the repository root (${repo} holds `
      + '_config.yml) or pass --root <dir>');
  });

  await t.test('[AC-03][F-017] with --root naming a folder without _config.yml', () => {
    const { repo, sub } = siteWithBlogFolder();
    refusedEverywhere(repo, [
      [['new', 'subfolder-test', '--root', sub], { cwd: repo }],
      [['check', '--root', sub], { cwd: repo }],
      [['check', '_drafts/waiting.md', '--root', sub], { cwd: repo }],
      [['publish', 'waiting', '--root', sub], { cwd: repo }],
      [['unpublish', 'live', '--root', sub], { cwd: repo }],
    ], `--root ${sub} is not the site root (it has no _config.yml); pass the repository root (${repo} holds _config.yml)`);
  });

  await t.test('[AC-03][F-017] in a folder with no site root above it, without a hint', () => {
    const dir = caseDir('no-site');
    const ancestors = [];
    for (let up = path.dirname(dir); up !== path.dirname(up); up = path.dirname(up)) ancestors.push(up);
    const above = [...ancestors, path.parse(dir).root].find((up) => fs.existsSync(path.join(up, '_config.yml')));
    const hint = above === undefined ? '' : ` (${above} holds _config.yml)`;
    for (const args of [['check'], ['new', 'nowhere']]) {
      const result = unchangedBy(() => treeSnapshot(dir), () => run(args, { cwd: dir }), `the folder ${dir}`);
      expectExit(result, 2);
      assert.ok(result.stderr.startsWith(`error: ${dir} is not the site root (it has no _config.yml); run the command `
        + `from the repository root${hint} or pass --root <dir>\n`), result.out);
    }
  });

  await t.test('[AC-03][F-017] guard --staged run from the subfolder checks the whole repository', () => {
    const { repo, sub } = siteWithBlogFolder();
    const postRel = `_posts/${PAST}-staged.md`;
    write(repo, postRel, validArticle({ title: 'Staged from a subfolder' }));
    git(repo, 'add', postRel);
    const accepted = unchangedBy(() => repoSnapshot(repo), () => run(['guard', '--staged'], { cwd: sub }), 'the repository');
    expectExit(accepted, 0);
    git(repo, 'add', '-f', '_drafts/waiting.md');
    const refused = unchangedBy(() => repoSnapshot(repo), () => run(['guard', '--staged'], { cwd: sub }), 'the repository');
    expectExit(refused, 1);
    assert.match(refused.stderr, /_drafts\/waiting\.md/, 'a draft staged outside the subfolder is refused');
  });
});

test('[AC-03][F-017] every command refuses a --root too long for the filesystem, or a link loop, as a usage error (exit 2) and writes nothing', async (t) => {
  /** Every command, so none reaches its own folder handling with a root that cannot be a folder. */
  const commands = [
    ['new', 'okslug'], ['check'], ['publish', 'okslug'], ['unpublish', 'okslug'], ['guard', '--staged'], ['guard', '--pre-push'],
  ];
  /**
   * Asserts that each command, run with `rootArgs` from the site root `cwd`, is refused with
   * `--root <resolved> is not a directory` and the usage block, leaving `cwd` as it was: a run
   * that fell back to its working folder would write there.
   */
  const refusedAsNotAFolder = (cwd, rootArgs, resolved) => {
    for (const args of commands) {
      const result = unchangedBy(() => treeSnapshot(cwd), () => run([...args, ...rootArgs], { cwd }), `the folder ${cwd}`);
      expectExit(result, 2);
      assert.ok(result.stderr.startsWith(`error: --root ${resolved} is not a directory\n`),
        `${args.join(' ')}: a usage error naming the resolved root, not a system error:\n${result.out.slice(0, 2000)}`);
      assert.match(result.stderr, /\nUsage: /, `${args.join(' ')}: the usage block follows`);
      assert.doesNotMatch(result.stderr, /ENAMETOOLONG|ELOOP/, `${args.join(' ')}: no raw error code`);
      assert.equal(result.stdout, '', `${args.join(' ')} reports nothing as created, checked or moved`);
    }
  };

  await t.test('[AC-03][F-017] a --root whose last folder name is 300 characters long', () => {
    const cwd = makeRoot();
    const root = path.join(PARENT, 'b'.repeat(300));
    refusedAsNotAFolder(cwd, ['--root', root], root);
  });

  await t.test('[AC-03][F-017] a --root= path 5,000 characters long', () => {
    const cwd = makeRoot();
    const root = path.join(PARENT, 'a'.repeat(5000));
    refusedAsNotAFolder(cwd, [`--root=${root}`], root);
  });

  await t.test('[AC-03][F-017] a --root that is a symbolic-link loop', LINK_CASE, () => {
    const cwd = makeRoot();
    link(cwd, 'loop-a', 'loop-b');
    link(cwd, 'loop-b', 'loop-a');
    const root = path.join(cwd, 'loop-a');
    refusedAsNotAFolder(cwd, ['--root', root], root);
  });
});
