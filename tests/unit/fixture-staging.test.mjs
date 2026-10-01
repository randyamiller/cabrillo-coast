/* Cabrillo Coast LLC — regression proof of the fixture builder's source provenance (AC-16, F-018) */
/**
 * The visual comparison (AC-16) is only meaningful while its baseline is
 * built from the base revision and its comparison from the working tree.
 * `tests/fixtures/build-fixture-site.mjs` stages that source: with `--ref` it
 * extracts the allow-listed site files of the commit with `git archive`
 * (`stageRevision`), without it it copies them from the working tree
 * (`stageWorkingTree`); both then add the working tree's fixture articles
 * and the synthetic private content. A builder that staged the working tree
 * for `--ref` would make the comparison compare the change with itself, and
 * every positive output check would still pass.
 *
 * This suite runs the REAL builder CLI, copied into a temporary git
 * repository it takes as its own from its location, whose working tree
 * differs from its base commit in every way that matters: another
 * `styles.css`, an untracked allow-listed file, a committed file deleted,
 * and an edited fixture article. A stand-in `bundle` first on PATH replaces
 * Jekyll (tests/unit/lib/visual-gate-harness.mjs). It proves that
 *   - `--ref <base> --fixtures-only` stages the base commit's bytes: its
 *     stylesheet and the deleted file, and not the untracked one;
 *   - `--fixtures-only` alone stages the working tree's bytes, the untracked
 *     file included and the deleted one not;
 *   - both stages hold the working tree's edited fixture articles byte for
 *     byte, plus the synthetic future-dated post, and neither holds the real
 *     post, the real draft or the draft image the base commit carries;
 *   - both stages hold the synthetic draft, which exists only there;
 *   - a `--ref` without `_layouts/post.html` exits 1 ("predates the blog")
 *     and one that names no commit exits 2.
 *
 * Runs with `node --test tests/unit/fixture-staging.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"` (Node 22 or later, git, tar and a
 * POSIX shell). No Jekyll, browser or network is used. Git is isolated as in
 * tests/unit/article-cli.test.mjs, and everything is written below one
 * folder in `os.tmpdir()`, removed afterwards.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DRAFT_IMAGE, DRAFT_MARKER, DRAFT_SLUG, FIXTURE_POSTS, FUTURE_SLUG } from '../fixtures/build-fixture-site.mjs';
import {
  BASE_STYLES,
  DELETED_REL,
  DRAFT_IMAGE_REL,
  FIXTURE_EDIT,
  FIXTURE_POST_FILES,
  REAL_DRAFT_REL,
  REAL_POST_REL,
  ROOT,
  UNTRACKED_REL,
  WORK_STYLES,
  changeWorkingTree,
  commitAll,
  commitBlogSource,
  createSandbox,
  createSiteRepo,
  git,
  installFakeBundle,
  read,
  readJsonLines,
  runNode,
  write,
} from './lib/visual-gate-harness.mjs';

/* ------------------------------------------------------------------------ */
/* Repository under test                                                     */
/* ------------------------------------------------------------------------ */

const sandbox = createSandbox('fixture-staging-');
after(() => sandbox.cleanup());
const BIN = installFakeBundle(sandbox.parent);
const BUNDLE_LOG = path.join(sandbox.parent, 'bundle.log');
const REPO = path.join(sandbox.parent, 'repo');

/** Time limit of one builder case. */
const BUILD_CASE = { timeout: 90000 };

/** The builder's usage line. */
const USAGE = 'Usage: node tests/fixtures/build-fixture-site.mjs <outDir> [--ref <rev>] [--fixtures-only]';

/*
 * History: a home-page-only commit, then one with the configuration but no
 * article layout, then the blog (the base); the working tree then changes.
 */
const PRE_BLOG = createSiteRepo(sandbox.env, REPO, { preBlog: true, message: 'Home page only' });
write(REPO, '_config.yml', 'title: Visual gate fixture\nfuture: false\n');
write(REPO, '_config.preview.yml', 'title: Visual gate fixture\nfuture: false\n');
const CONFIG_ONLY = commitAll(sandbox.env, REPO, 'Add the Jekyll configuration');
const BASE = commitBlogSource(sandbox.env, REPO, 'Add the blog');
changeWorkingTree(REPO);

/**
 * Runs the repository's copy of the builder with `args` and the stand-in
 * bundle first on PATH.
 */
function runBuilder(args) {
  return runNode([path.join(REPO, 'tests', 'fixtures', 'build-fixture-site.mjs'), ...args], {
    cwd: REPO,
    env: { ...sandbox.env, PATH: `${BIN}${path.delimiter}${sandbox.env.PATH ?? ''}`, FAKE_BUNDLE_LOG: BUNDLE_LOG },
    timeoutMs: 60000,
  });
}

/** Asserts the exit code, showing the builder's output when it differs. */
function expectExit(result, code) {
  assert.equal(result.status, code, `expected exit code ${code}, got ${result.status} (signal ${result.signal}); output:\n${result.out}`);
}

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

/** `text` with every regular-expression metacharacter escaped. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `rel` exists below `root`. */
function exists(root, rel) {
  return fs.existsSync(path.join(root, ...rel.split('/')));
}

/** Bytes of `rel` below `root`. */
function bytes(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')));
}

/* ------------------------------------------------------------------------ */
/* Tests                                                                     */
/* ------------------------------------------------------------------------ */

describe('[AC-16][F-018] build-fixture-site.mjs stages the base from git and the working tree from disk', { concurrency: 4 }, () => {
  const refOut = path.join(sandbox.parent, 'out-ref');
  const workOut = path.join(sandbox.parent, 'out-work');
  const refSrc = path.join(refOut, 'src');
  const workSrc = path.join(workOut, 'src');
  let refRun;
  let workRun;

  before(async () => {
    [refRun, workRun] = await Promise.all([
      runBuilder([refOut, '--ref', BASE, '--fixtures-only']),
      runBuilder([workOut, '--fixtures-only']),
    ]);
  });

  test('[AC-16][F-018] the history and working tree differ as the provenance cases need', () => {
    assert.equal(git(sandbox.env, REPO, 'show', `${BASE}:styles.css`), BASE_STYLES.trimEnd());
    assert.equal(read(REPO, 'styles.css'), WORK_STYLES);
    assert.equal(git(sandbox.env, REPO, 'status', '--porcelain', '--', UNTRACKED_REL), `?? ${UNTRACKED_REL}`);
    assert.equal(git(sandbox.env, REPO, 'status', '--porcelain', '--', DELETED_REL), `D ${DELETED_REL}`);
    const fixtureRel = `tests/fixtures/posts/${FIXTURE_POST_FILES[0]}`;
    assert.equal(read(REPO, fixtureRel), `${read(ROOT, fixtureRel)}${FIXTURE_EDIT}`, 'the fixture article was edited after the base commit');
    assert.equal(git(sandbox.env, REPO, 'ls-files', '--', DRAFT_IMAGE_REL), DRAFT_IMAGE_REL, 'the base commit carries a draft image');
    assert.equal(git(sandbox.env, REPO, 'ls-files', '--', REAL_POST_REL), REAL_POST_REL, 'the base commit carries a real post');
    assert.ok(exists(REPO, REAL_DRAFT_REL), 'the working tree holds a real draft');
    assert.deepEqual(FIXTURE_POSTS.map((post) => post.file), FIXTURE_POST_FILES, 'the harness copies the fixtures the builder requires');
  });

  test('[AC-16][F-018] --ref stages the base commit\'s source and the working-tree build stages the working tree\'s', BUILD_CASE, () => {
    expectExit(refRun, 0);
    expectExit(workRun, 0);
    assert.ok(
      refRun.stdout.split('\n').includes(`build-fixture-site: staging the site source of ${BASE.slice(0, 12)} into ${refSrc} (fixtures only)`),
      refRun.stdout,
    );
    assert.ok(
      workRun.stdout.split('\n').includes(`build-fixture-site: staging the working-tree site source into ${workSrc} (fixtures only)`),
      workRun.stdout,
    );

    assert.equal(read(refSrc, 'styles.css'), BASE_STYLES, 'the --ref stage holds the base commit\'s styles.css');
    assert.deepEqual(bytes(refSrc, 'styles.css'), Buffer.from(`${git(sandbox.env, REPO, 'show', `${BASE}:styles.css`)}\n`));
    assert.deepEqual(bytes(workSrc, 'styles.css'), bytes(REPO, 'styles.css'), 'the working-tree stage holds the uncommitted styles.css');

    assert.ok(exists(refSrc, DELETED_REL), 'a file deleted from the working tree is still in the --ref stage');
    assert.ok(!exists(workSrc, DELETED_REL), 'and not in the working-tree stage');
    assert.ok(exists(workSrc, UNTRACKED_REL), 'an untracked allow-listed file is in the working-tree stage');
    assert.ok(!exists(refSrc, UNTRACKED_REL), 'and not in the --ref stage');
    assert.ok(!exists(refOut, 'ref.tar'), 'the archive is removed once extracted');

    // The builds saw what was staged: the --ref builds the base styles, the others the working tree's.
    const builds = readJsonLines(BUNDLE_LOG);
    const refBuilds = builds.filter((build) => build.source.startsWith(`${refOut}${path.sep}`));
    const workBuilds = builds.filter((build) => build.source.startsWith(`${workOut}${path.sep}`));
    assert.equal(refBuilds.length, 3);
    assert.equal(workBuilds.length, 3);
    for (const build of refBuilds) assert.equal(build.styles, BASE_STYLES, build.source);
    for (const build of workBuilds) assert.equal(build.styles, WORK_STYLES, build.source);
  });

  test('[AC-16][F-018] both stages hold the working tree\'s fixture articles byte for byte and the future-dated post, and no real post', BUILD_CASE, () => {
    expectExit(refRun, 0);
    expectExit(workRun, 0);
    for (const src of [refSrc, workSrc]) {
      const posts = fs.readdirSync(path.join(src, '_posts')).sort();
      const future = posts.filter((name) => !FIXTURE_POST_FILES.includes(name));
      assert.equal(future.length, 1, `${src}/_posts holds the fixtures and one more post: ${posts.join(', ')}`);
      assert.match(future[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${FUTURE_SLUG}\\.md$`));
      for (const file of FIXTURE_POST_FILES) {
        assert.deepEqual(bytes(src, `_posts/${file}`), bytes(REPO, `tests/fixtures/posts/${file}`), `${src}/_posts/${file} is the working tree's`);
      }
      assert.ok(!exists(src, REAL_POST_REL), `${src} leaves the real post out (--fixtures-only)`);
    }
    assert.deepEqual(fs.readdirSync(path.join(refSrc, '_posts')).sort(), fs.readdirSync(path.join(workSrc, '_posts')).sort());
  });

  test('[AC-16][F-018] neither stage holds a real draft or draft image; both hold the synthetic draft, which exists only there', BUILD_CASE, () => {
    expectExit(refRun, 0);
    expectExit(workRun, 0);
    for (const src of [refSrc, workSrc]) {
      const files = listFiles(src);
      assert.deepEqual(files.filter((file) => file.startsWith('assets/drafts/')), [DRAFT_IMAGE], `${src}: only the synthetic draft image`);
      assert.deepEqual(files.filter((file) => file.startsWith('_drafts/')), [`_drafts/${DRAFT_SLUG}.md`], `${src}: only the synthetic draft`);
      assert.ok(!files.includes(DRAFT_IMAGE_REL), `${src} holds no real draft image`);
      assert.ok(!files.includes(REAL_DRAFT_REL), `${src} holds no real draft`);
      assert.ok(read(src, `_drafts/${DRAFT_SLUG}.md`).includes(DRAFT_MARKER));
    }
    assert.ok(!exists(REPO, `_drafts/${DRAFT_SLUG}.md`), 'the synthetic draft is written to the stage only');
    assert.ok(!exists(REPO, DRAFT_IMAGE), 'and so is its image');
  });
});

describe('[AC-16][F-018] build-fixture-site.mjs refuses a --ref it cannot build', { concurrency: 4 }, () => {
  test('[AC-16][F-018] a --ref without the blog source exits 1: it predates the blog', BUILD_CASE, async () => {
    for (const [sha, missing] of [
      [PRE_BLOG, '_config.yml, _config.preview.yml, _layouts/post.html'],
      [CONFIG_ONLY, '_layouts/post.html'],
    ]) {
      const out = path.join(sandbox.parent, `out-${sha.slice(0, 12)}`);
      const result = await runBuilder([out, '--ref', sha, '--fixtures-only']);
      expectExit(result, 1);
      assert.match(result.stderr, new RegExp(`^${escapeRegExp(`build-fixture-site: revision ${sha} has no ${missing}; it predates the blog`)}$`, 'm'));
      assert.ok(!fs.existsSync(out), 'nothing was staged');
    }
  });

  test('[AC-16][F-018] a --ref that names no commit exits 2', BUILD_CASE, async () => {
    const out = path.join(sandbox.parent, 'out-unresolvable');
    const result = await runBuilder([out, '--ref', 'no-such-revision', '--fixtures-only']);
    expectExit(result, 2);
    assert.match(result.stderr, /^build-fixture-site: cannot resolve --ref no-such-revision$/m);
    assert.ok(result.stderr.split('\n').includes(USAGE), result.stderr);
    assert.ok(!fs.existsSync(out), 'nothing was staged');
  });
});
