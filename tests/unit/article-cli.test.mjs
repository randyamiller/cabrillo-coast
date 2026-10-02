/* Cabrillo Coast LLC — tests for the article publishing tool (node:test, Node built-ins only) */
/**
 * AC-03 (F-017): `scripts/article.mjs` new, check, publish, unpublish and
 * guard, each run as a child process exactly as an author or a git hook runs
 * it.
 *
 * new, check, publish and unpublish run in temporary roots holding a copy of
 * `_templates/article.md`, addressed with `--root`. guard runs in temporary
 * git repositories, and --pre-push pushes to a local bare repository. All of
 * it is written below one folder in `os.tmpdir()`, removed after the run.
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
import { spawnSync } from 'node:child_process';

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
after(() => fs.rmSync(PARENT, { recursive: true, force: true }));

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
  return run([...args, '--root', root], {
    cwd: root,
    nodeArgs: ['--import', FAULT_PRELOAD_URL],
    env: { ARTICLE_FAULTS: JSON.stringify(faults) },
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

/** A temporary root (not a git repository) holding a copy of the repository's article template. */
function makeRoot() {
  const root = caseDir('root');
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
  assert.deepEqual(list(root, '.'), ['_templates'], 'a usage error writes nothing');
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
  const dateBefore = todayUtc();
  const result = cli(root, 'publish', 'my-slug');
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
  expectExit(cli(root, 'check', postRel), 0);
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
    const draftText = draftWithImage('stale', addDaysUtc(-1));
    write(root, '_drafts/stale.md', draftText);
    write(root, 'assets/drafts/stale/figure.png', PNG);
    expectExit(cli(root, 'check', '_drafts/stale.md'), 0);

    const result = cli(root, 'publish', 'stale');
    expectExit(result, 1);
    assert.match(result.stderr,
      /_posts\/\d{4}-\d{2}-\d{2}-stale\.md: updated \d{4}-\d{2}-\d{2} is earlier than the post date/,
      'the prospective post is reported by its path');
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
    const dateBefore = todayUtc();
    write(root, '_drafts/fresh.md', draftWithImage('fresh', dateBefore));
    write(root, 'assets/drafts/fresh/figure.png', PNG);
    const result = cli(root, 'publish', 'fresh');
    if (todayUtc() !== dateBefore) {
      st.skip('the run crossed midnight UTC, so "today" changed under it');
      return;
    }
    expectExit(result, 0);
    assert.deepEqual(postsFor(root, 'fresh'), [`${dateBefore}-fresh.md`]);
    assert.deepEqual(fs.readFileSync(abs(root, 'assets/blog/fresh/figure.png')), PNG);
    expectExit(cli(root, 'check', `_posts/${dateBefore}-fresh.md`), 0);
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
  write(repo, postRel, validArticle({ title: 'Plain article' }));
  git(repo, 'add', postRel);
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
    const first = cliWithFaults(root, [{
      fn: 'openSync',
      path: '_posts/',
      action: 'run-tool',
      argv: competitorArgv,
      cwd: root,
      env: { ARTICLE_FAKE_NOW: tomorrow },
      out,
    }], 'publish', 'race');
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
    assert.equal(postsFor(root, 'race').length, 1, 'exactly one post, so the slug is published once');
    assert.equal(exists(root, '_drafts/race.md'), false);
    assert.equal(exists(root, lockRel('race')), false, 'the lock is released');
    expectExit(cli(root, 'check'), 0);
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

test('[AC-03][F-017] the printed git add commands pass each path as one argument and run nothing, even for a post folder named with quotes and $(…)', () => {
  const root = makeRoot();
  const stubDir = caseDir('git-argv');
  const argvFile = path.join(stubDir, 'argv');
  fs.writeFileSync(path.join(stubDir, 'git'), ['#!/bin/sh', `printf '%s\\0' "$@" > ${shQuote(argvFile)}`, ''].join('\n'),
    { mode: 0o755 });
  /** The arguments `git` receives when the one printed `git add` line of `result` is pasted into a POSIX shell. */
  const pastedArgv = (result) => {
    const lines = result.stdout.split('\n').filter((line) => line.startsWith('  git add '));
    assert.equal(lines.length, 1, `one git add line:\n${result.stdout}`);
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
  assert.deepEqual(pastedArgv(unpublished), ['add', '-A', '--', nestedRel, 'assets/blog/odd'],
    'the nested post path reaches git as one argument, byte for byte');
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
