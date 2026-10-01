/* Cabrillo Coast LLC — tests for the article publishing tool (node:test, Node built-ins only) */
/**
 * AC-03 (F-017): `scripts/article.mjs` new, check, publish, unpublish and
 * guard, each run as a child process exactly as an author or a git hook runs
 * it.
 *
 *   - new, check, publish and unpublish run in temporary roots: plain folders
 *     holding a copy of `_templates/article.md`, addressed with `--root` and
 *     used as the working directory.
 *   - guard --staged runs in temporary git repositories with the case's files
 *     staged; guard --pre-push additionally pushes to a local bare repository
 *     and receives on standard input the ref line git would pass the hook.
 *   - failures part way through new, publish and unpublish use fault
 *     injection: a `node --import` preload, written into the parent folder at
 *     run time, makes chosen `node:fs` calls fail, write short or edit a file
 *     mid-command, so rollback and retry are exercised without depending on
 *     file permissions (the suite may run as root).
 *   - two guard cases put a stand-in git first on PATH that kills itself with
 *     SIGKILL on one command, so guard must refuse instead of reading the
 *     missing answer as "no".
 *
 * Everything is written below one parent folder in `os.tmpdir()`, removed
 * after the run, so nothing is written inside this repository.
 *
 * Git isolation: every git call, and every tool run (the tool spawns git
 * itself), gets `ENV`. It replaces the system and global configuration with
 * an empty file, so no developer hook, `core.hooksPath`, template folder,
 * signing or LFS filter can influence a case, and it drops the variables a
 * git hook exports (`GIT_DIR`, `GIT_INDEX_FILE`, …) that would otherwise
 * redirect the temporary repositories to the repository running the tests.
 * Setup commits and pushes use `--no-verify`.
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

/* ------------------------------------------------------------------------ */
/* Paths and isolation                                                       */
/* ------------------------------------------------------------------------ */

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

const ENV = { ...process.env };
for (const name of Object.keys(ENV)) {
  if (GIT_REDIRECT_VARS.has(name) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete ENV[name];
}
Object.assign(ENV, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: GIT_CONFIG_FILE,
  HOME: FAKE_HOME,
  XDG_CONFIG_HOME: FAKE_HOME,
  GIT_AUTHOR_NAME: 'Article Test',
  GIT_COMMITTER_NAME: 'Article Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  // A temporary root that is not a repository never discovers an enclosing one.
  GIT_CEILING_DIRECTORIES: PARENT,
});

/** Time limit for cases that create repositories, clone or push. */
const GIT_CASE = { timeout: 60000 };

/** Bytes of a stand-in image; the tool only checks that the file exists and moves it. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/* ------------------------------------------------------------------------ */
/* Process helpers                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Runs `node [nodeArgs…] scripts/article.mjs <args>` with `ENV` plus `env`
 * (a case that puts a stand-in git on PATH passes that PATH in `env`).
 * Standard input is always given (empty by default) so `guard` never waits
 * on an open terminal.
 *
 * @returns {{ status: number, stdout: string, stderr: string, out: string }}
 */
function run(args, { cwd, input = '', nodeArgs = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, ARTICLE_MJS, ...args], {
    cwd,
    input,
    env: { ...ENV, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: result.stdout + result.stderr };
}

/** Runs a tool command in a temporary root: `--root <root>`, with the root as the working directory. */
function cli(root, ...args) {
  return run([...args, '--root', root], { cwd: root });
}

/** Asserts the exit code, showing the tool's output when it differs. */
function expectExit(result, code) {
  assert.equal(result.status, code, `expected exit code ${code}, got ${result.status}; output:\n${result.out}`);
}

/** Runs git with `ENV`; throws with git's stderr on failure and returns the trimmed stdout. */
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}) in ${cwd}:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/** A setup commit; hooks never run for it. */
function commit(repo, message) {
  git(repo, 'commit', '-q', '--no-verify', '-m', message);
}

/** The index mode (`100644`, `100755`, …) of a staged path. */
function indexMode(repo, rel) {
  return git(repo, 'ls-files', '-s', '--', rel).split(' ')[0];
}

/* ------------------------------------------------------------------------ */
/* Fault injection                                                           */
/* ------------------------------------------------------------------------ */

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
 *     `{ status, stdout, stderr }` to `out` as JSON, then make the call: a
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
  fs.writeFileSync(rule.out, JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }));
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

/* ------------------------------------------------------------------------ */
/* Dates, text and files                                                     */
/* ------------------------------------------------------------------------ */

/** Today's date in UTC as `YYYY-MM-DD`, the clock the tool dates posts by. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** The UTC date `days` days from now (negative for the past) as `YYYY-MM-DD`. */
function addDaysUtc(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Filename date of existing posts: well in the past whenever the suite runs. */
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
 * An article that passes every schema rule as a draft and as a post: quoted
 * `title` and `summary`, a flow list of kebab-case `tags`, an optional
 * `updated` date and any `extra` front-matter lines, then a non-empty body.
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

/** True when anything exists at the path. */
function exists(root, rel) {
  return fs.existsSync(abs(root, rel));
}

/** The file's text. */
function read(root, rel) {
  return fs.readFileSync(abs(root, rel), 'utf8');
}

/** Names of the entries of a folder, or `[]` when it does not exist. */
function list(root, rel) {
  return exists(root, rel) ? fs.readdirSync(abs(root, rel)).sort() : [];
}

/* ------------------------------------------------------------------------ */
/* Case folders                                                              */
/* ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ */
/* Usage                                                                     */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] usage errors exit 2: no command, an unknown command, publish without a slug', () => {
  const root = makeRoot();
  for (const args of [[], ['frobnicate'], ['publish']]) {
    const result = cli(root, ...args);
    expectExit(result, 2);
    assert.match(result.stderr, /Usage:/, `usage block for ${JSON.stringify(args)}`);
  }
  assert.deepEqual(list(root, '.'), ['_templates'], 'a usage error writes nothing');
});

/* ------------------------------------------------------------------------ */
/* new <slug>                                                                */
/* ------------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------------ */
/* check [files…]                                                            */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] check rejects the untouched template and accepts a valid draft', () => {
  const root = makeRoot();
  expectExit(cli(root, 'new', 'fresh-template'), 0);
  const fresh = cli(root, 'check', '_drafts/fresh-template.md');
  expectExit(fresh, 1);
  assert.match(fresh.stderr, /TODO/, 'leftover TODO: markers are reported');
  assert.match(fresh.stderr, /tags/, 'the empty tags list is reported');

  write(root, '_drafts/valid-draft.md', validArticle());
  expectExit(cli(root, 'check', '_drafts/valid-draft.md'), 0);
});

test('[AC-03][F-017] check applies the schema to posts: an updated date is accepted, a published: key is not', () => {
  const root = makeRoot();
  write(root, `_posts/${PAST}-revised.md`, validArticle({ updated: todayUtc() }));
  expectExit(cli(root, 'check', `_posts/${PAST}-revised.md`), 0);

  write(root, `_posts/${PAST}-hidden.md`, validArticle({ extra: 'published: false' }));
  const hidden = cli(root, 'check', `_posts/${PAST}-hidden.md`);
  expectExit(hidden, 1);
  assert.match(hidden.stderr, /published/);
});

test('[AC-03][F-017] check reports a stray } in the tags list as a front-matter error instead of crashing', async (t) => {
  for (const tags of [['}'], ['a', '}']]) {
    await t.test(`[AC-03][F-017] check refuses tags: [${tags.join(', ')}]`, () => {
      const root = makeRoot();
      write(root, '_drafts/brace-tags.md', validArticle({ tags }));
      const result = cli(root, 'check', '_drafts/brace-tags.md');
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
      const result = cli(root, 'check', '_drafts/typed-tag.md');
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
      expectExit(cli(root, 'check', '_drafts/text-tags.md'), 0);
    });
  }
});

test('[AC-03][F-017] check warns about unwrapped Liquid inside code without failing, and not when it is wrapped in raw', () => {
  const root = makeRoot();
  const fence = ['```yaml', 'image: {{ x }}', '```'].join('\n');
  write(root, '_drafts/code-warn.md', validArticle({ body: `A Helm values file:\n\n${fence}` }));
  const unwrapped = cli(root, 'check', '_drafts/code-warn.md');
  expectExit(unwrapped, 0);
  assert.notEqual(unwrapped.stderr.trim(), '', 'a warning is printed');
  assert.match(unwrapped.stderr, /raw|liquid/i);

  write(root, '_drafts/code-wrapped.md',
    validArticle({ body: `A Helm values file:\n\n{% raw %}\n${fence}\n{% endraw %}` }));
  const wrapped = cli(root, 'check', '_drafts/code-wrapped.md');
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
  const unwrapped = cli(root, 'check', '_drafts/span-warn.md');
  expectExit(unwrapped, 0);
  assert.match(unwrapped.stderr, /raw|liquid/i);
  assert.match(unwrapped.stderr, new RegExp(`span-warn\\.md:${line}\\b`), `the warning names line ${line}`);

  write(root, '_drafts/span-wrapped.md',
    validArticle({ body: `A Helm values file:\n\n{% raw %}${span}{% endraw %}` }));
  const wrapped = cli(root, 'check', '_drafts/span-wrapped.md');
  expectExit(wrapped, 0);
  assert.doesNotMatch(wrapped.stderr, /raw|liquid/i, 'no warning once the span is wrapped');
});

test('[AC-03][F-017] check rejects unsafe markup in prose but not the same markup shown as code', () => {
  const root = makeRoot();
  write(root, '_drafts/prose-script.md', validArticle({ body: 'Intro.\n\n<script>alert(1)</script>' }));
  const script = cli(root, 'check', '_drafts/prose-script.md');
  expectExit(script, 1);
  assert.match(script.stderr, /unsafe markup[^\n]*<script>/);

  write(root, '_drafts/prose-handler.md', validArticle({ body: 'Intro.\n\n<img src="/x.png" onerror="alert(1)">' }));
  const handler = cli(root, 'check', '_drafts/prose-handler.md');
  expectExit(handler, 1);
  assert.match(handler.stderr, /unsafe markup[^\n]*onerror/, 'the event handler itself is reported');

  write(root, '_drafts/code-script.md',
    validArticle({ body: 'This is what not to write:\n\n```html\n<script>alert(1)</script>\n```' }));
  expectExit(cli(root, 'check', '_drafts/code-script.md'), 0);
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
      const result = cli(root, 'check', `_drafts/${slug}.md`);
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
      const result = cli(root, 'check', `_drafts/${slug}.md`);
      expectExit(result, 1);
      assert.match(result.stderr, message);
    });
  }
  await t.test('[AC-03][F-017] check accepts a local image with alt text', () => {
    const root = makeRoot();
    write(root, 'assets/drafts/img-ok/figure.png', PNG);
    write(root, '_drafts/img-ok.md',
      validArticle({ body: `Figure:\n\n![A labelled figure](${image('img-ok', 'figure.png')})` }));
    expectExit(cli(root, 'check', '_drafts/img-ok.md'), 0);
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
      const result = cli(root, 'check', `_drafts/${slug}.md`);
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
  const result = cli(root, 'check', '_drafts/img-pileup.md');
  expectExit(result, 1);
  assert.match(result.stderr, /too many overlapping <img> tags to check/);
});

/* ------------------------------------------------------------------------ */
/* publish <slug>                                                            */
/* ------------------------------------------------------------------------ */

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
  /** A valid draft with one image, `updated` set to `updated`. */
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

/* ------------------------------------------------------------------------ */
/* unpublish <slug>                                                          */
/* ------------------------------------------------------------------------ */

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

test('[AC-03][F-017] unpublish refuses while a post_url names the post, and succeeds once the reference is gone', () => {
  const root = makeRoot();
  const targetRel = `_posts/${PAST}-target.md`;
  const referrerName = `${PAST}-referrer.md`;
  const referrerRel = `_posts/${referrerName}`;
  write(root, targetRel, validArticle({ title: 'The target' }));
  const referrerText = validArticle({
    title: 'The referrer',
    body: `Background first.\n\nRead [the target]({{ site.baseurl }}{% post_url ${PAST}-target %}) next.`,
  });
  write(root, referrerRel, referrerText);
  const line = referrerText.split('\n').findIndex((text) => text.includes('post_url')) + 1;
  assert.ok(line > 0);

  const refused = cli(root, 'unpublish', 'target');
  expectExit(refused, 1);
  assert.match(refused.stderr, new RegExp(`${escapeRegExp(referrerName)}[^\\n]*\\b${line}\\b`),
    `the refusal names ${referrerName} and line ${line}`);
  assert.ok(exists(root, targetRel), 'the post stays in _posts/');
  assert.equal(exists(root, '_drafts/target.md'), false, 'no draft is written');

  write(root, referrerRel, validArticle({ title: 'The referrer', body: 'No links to the target any more.' }));
  expectExit(cli(root, 'unpublish', 'target'), 0);
  assert.ok(exists(root, '_drafts/target.md'), 'the post is back in _drafts/');
  assert.equal(exists(root, targetRel), false);
});

test('[AC-03][F-017] unpublish refuses while a post_url and an ordinary link name the post, and succeeds once both are gone', () => {
  const root = makeRoot();
  const targetRel = `_posts/${PAST}-target.md`;
  const targetText = validArticle({ title: 'The target' });
  write(root, targetRel, targetText);
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
  /** Asserts that nothing moved: the post is unchanged and no draft exists. */
  const unmoved = () => {
    assert.equal(read(root, targetRel), targetText, 'the post stays in _posts/ unchanged');
    assert.equal(exists(root, '_drafts'), false, 'nothing is moved to _drafts/');
  };

  const both = cli(root, 'unpublish', 'target');
  expectExit(both, 1);
  assert.match(both.stderr, /2 references/);
  assert.match(both.stderr, taggedAt, 'the post_url reference is named with its file and line');
  assert.match(both.stderr, linkedAt, 'the ordinary link is named with its file and line');
  unmoved();

  write(root, linkedRel, validArticle({ title: 'Linked referrer', body: 'No link to the target any more.' }));
  const one = cli(root, 'unpublish', 'target');
  expectExit(one, 1);
  assert.match(one.stderr, taggedAt, 'the remaining post_url still refuses');
  assert.doesNotMatch(one.stderr, new RegExp(escapeRegExp(linkedRel)), 'the removed link is no longer listed');
  unmoved();

  write(root, taggedRel, validArticle({ title: 'Tagged referrer', body: 'No tag for the target any more.' }));
  expectExit(cli(root, 'unpublish', 'target'), 0);
  assert.equal(read(root, '_drafts/target.md'), targetText, 'the draft is the post unchanged');
  assert.equal(exists(root, targetRel), false, 'the post is gone');
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
      const targetRel = `_posts/${PAST}-target.md`;
      const referrerName = `${PAST}-referrer.md`;
      const targetText = validArticle({ title: 'The target' });
      write(root, targetRel, targetText);
      const referrerText = validArticle({
        title: 'The referrer',
        body: `Background first.\n\nRead [the target]({{ site.baseurl }}${form}) next.`,
      });
      write(root, `_posts/${referrerName}`, referrerText);
      const line = referrerText.split('\n').findIndex((text) => text.includes(form)) + 1;
      assert.ok(line > 0);

      const result = cli(root, 'unpublish', 'target');
      expectExit(result, 1);
      assert.match(result.stderr, new RegExp(`${escapeRegExp(referrerName)}[^\\n]*\\b${line}\\b`),
        `the refusal names ${referrerName} and line ${line}`);
      assert.equal(read(root, targetRel), targetText, 'the post stays in _posts/ unchanged');
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
      const targetRel = `_posts/${PAST}-target.md`;
      const referrerRel = `_posts/${PAST}-referrer.md`;
      const targetText = validArticle({ title: 'The target' });
      write(root, targetRel, targetText);
      write(root, referrerRel, validArticle({ title: 'The referrer', body: `See [the target article](${form}).` }));

      const result = cli(root, 'unpublish', 'target');
      expectExit(result, 1);
      assert.match(result.stderr, new RegExp(escapeRegExp(referrerRel)), 'the refusal names the referring file');
      assert.equal(read(root, targetRel), targetText, 'the post stays in _posts/ unchanged');
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

/* ------------------------------------------------------------------------ */
/* Failures part way: rollback and retry                                     */
/* ------------------------------------------------------------------------ */

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
  // The source is first set aside with a rename, then the set-aside copy is
  // removed: a failure at either half of that commit point is undone.
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
    const first = cliWithFaults(root, [{
      fn: 'openSync',
      path: '_posts/',
      action: 'run-tool',
      argv: [ARTICLE_MJS, 'publish', 'race', '--root', root],
      cwd: root,
      env: { ARTICLE_FAKE_NOW: tomorrow },
      out,
    }], 'publish', 'race');
    const competitor = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(competitor.status, 1, `the competing run is refused:\n${competitor.stderr}`);
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
    const gone = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(gone.status, 0);
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

/* ------------------------------------------------------------------------ */
/* Next steps and --root                                                     */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] the next steps start with a quoted cd to --root when the tool runs from another folder, and only then', () => {
  const base = caseDir('elsewhere');
  const root = path.join(base, "it's a $root");
  write(root, '_templates/article.md', fs.readFileSync(TEMPLATE));
  const fromBase = (...args) => run([...args, '--root', root], { cwd: base });
  const cdLines = (result) => result.stdout.split('\n').filter((line) => line.startsWith('  cd '));
  /** The folder a printed `cd` line lands in when pasted into a POSIX shell. */
  const landsIn = (line) => {
    const shell = spawnSync('sh', ['-c', `${line} && pwd -P`], { encoding: 'utf8', timeout: 30000 });
    if (shell.error) throw shell.error;
    return shell.stdout.trim();
  };

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

/* ------------------------------------------------------------------------ */
/* guard --staged                                                            */
/* ------------------------------------------------------------------------ */

const HOOK_TEXT = '#!/bin/sh\nexec node scripts/article.mjs guard --staged\n';

/** Writes `.githooks/pre-commit` with file mode 0644 and stages it. */
function stageHookWithoutExecBit(repo) {
  write(repo, '.githooks/pre-commit', HOOK_TEXT);
  fs.chmodSync(abs(repo, '.githooks/pre-commit'), 0o644);
  git(repo, 'add', '.githooks/pre-commit');
}

test('[AC-03][F-017] guard --staged refuses every tracked-content and article rule break, naming the path', GIT_CASE, async (t) => {
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
      offender: `_posts/${addDaysUtc(2)}-future.md`,
      setup(repo) {
        write(repo, `_posts/${addDaysUtc(2)}-future.md`, validArticle());
        git(repo, 'add', '_posts');
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
  ];
  for (const { name, offender, message, setup } of cases) {
    await t.test(`[AC-03][F-017] guard --staged refuses ${name}`, GIT_CASE, () => {
      const repo = makeRepo();
      setup(repo);
      const result = guardStaged(repo);
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

/* ------------------------------------------------------------------------ */
/* guard --pre-push                                                          */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] guard --pre-push refuses a range in which one commit adds a draft and a later one deletes it', GIT_CASE, () => {
  const { repo } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  write(repo, '_drafts/leak.md', validArticle({ title: 'Not for publication yet' }));
  git(repo, 'add', '-f', '_drafts/leak.md');
  commit(repo, 'Add a draft by mistake');
  git(repo, 'rm', '-q', '_drafts/leak.md');
  commit(repo, 'Remove the draft again');
  assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').includes('_drafts/'), false,
    'the tip itself holds no draft, so only a check of every commit catches it');

  const result = prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  assert.match(result.stderr, /_drafts\/leak\.md/);
});

test('[AC-03][F-017] guard --pre-push refuses a commit that deletes a post but leaves its image folder', GIT_CASE, async (t) => {
  const postRel = `_posts/${PAST}-gone.md`;
  /** A pushed post with an image, then a local commit that deletes only the post. */
  const orphanedRepo = () => {
    const { repo } = makeRemoteRepo((r) => {
      write(r, postRel, validArticle({ body: "![Figure]({{ '/assets/blog/gone/fig.png' | relative_url }})" }));
      write(r, 'assets/blog/gone/fig.png', PNG);
      git(r, 'add', postRel, 'assets/blog/gone/fig.png');
      commit(r, 'Publish: gone');
    });
    const remoteSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rm', '-q', postRel);
    commit(repo, 'Delete the post only');
    return { repo, remoteSha };
  };

  await t.test('[AC-03][F-017] guard --pre-push refuses when the folder is still orphaned at the tip', GIT_CASE, () => {
    const { repo, remoteSha } = orphanedRepo();
    const result = prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 1);
    assert.match(result.stderr, /assets\/blog\/gone/);
  });

  // Every pushed commit is published, so a later commit that removes the
  // folder does not make the orphaning commit acceptable.
  await t.test('[AC-03][F-017] guard --pre-push refuses even when a later commit in the range removes the folder', GIT_CASE, () => {
    const { repo, remoteSha } = orphanedRepo();
    git(repo, 'rm', '-q', '-r', 'assets/blog/gone');
    commit(repo, 'Delete the images too');
    const result = prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha);
    expectExit(result, 1);
    assert.match(result.stderr, /assets\/blog\/gone/);
  });
});

test('[AC-03][F-017] guard --pre-push checks a new branch against what the remote already holds', GIT_CASE, () => {
  const { repo } = makeRemoteRepo();
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, '_drafts/branch.md', validArticle());
  git(repo, 'add', '-f', '_drafts/branch.md');
  commit(repo, 'Draft on a branch');

  const result = prePush(repo, 'refs/heads/feature', 'refs/heads/feature', '0'.repeat(40));
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

/* ------------------------------------------------------------------------ */
/* Article analyses reused by blob id                                        */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] guard --pre-push checks a recurring article blob in every commit, refusing only the one lacking its image', GIT_CASE, () => {
  const { repo } = makeRemoteRepo();
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

  const result = prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha);
  expectExit(result, 1);
  const tip = git(repo, 'rev-parse', 'HEAD').slice(0, 7);
  const reported = result.stderr.split('\n').filter((line) => line.startsWith('error: '));
  assert.deepEqual(reported, [`error: ${tip}: ${postRel}:7: image /assets/blog/recurring/fig.png does not exist`],
    'the blob passes in the commits that hold its image and fails only in the one that does not');
  assert.match(result.stderr, /push refused \(1 problem in 1 commit\)/);
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

/* ------------------------------------------------------------------------ */
/* guard when git itself does not answer                                     */
/* ------------------------------------------------------------------------ */

/** The shim is a POSIX shell script, which Windows cannot run as `git`. */
const SHIM_CASE = { ...GIT_CASE, skip: process.platform === 'win32' ? 'the git shim needs a POSIX shell' : false };

let realGitPath;

/** Absolute path of the git on `ENV`'s PATH, resolved once, before any shim stands in front of it. */
function realGit() {
  if (realGitPath === undefined) {
    const result = spawnSync('sh', ['-c', 'command -v git'], { env: ENV, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
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
  const result = run(['guard', '--staged'], { cwd: repo, env: shim.env });
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
  const { repo } = makeRemoteRepo();
  const remoteSha = git(repo, 'rev-parse', 'HEAD');
  const postRel = `_posts/${PAST}-pushed.md`;
  write(repo, postRel, validArticle({ title: 'Pushed article' }));
  git(repo, 'add', postRel);
  commit(repo, 'Publish: Pushed article');
  expectExit(prePush(repo, 'refs/heads/main', 'refs/heads/main', remoteSha), 0);

  const shim = gitShim('cat-file -e');
  const localSha = git(repo, 'rev-parse', 'HEAD');
  const result = run(['guard', '--pre-push'], {
    cwd: repo,
    env: shim.env,
    input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
  });
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

