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
import { fileURLToPath } from 'node:url';
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
 * Runs `node scripts/article.mjs <args>` with `ENV`. Standard input is always
 * given (empty by default) so `guard` never waits on an open terminal.
 *
 * @returns {{ status: number, stdout: string, stderr: string, out: string }}
 */
function run(args, { cwd, input = '' } = {}) {
  const result = spawnSync(process.execPath, [ARTICLE_MJS, ...args], {
    cwd,
    input,
    env: ENV,
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
