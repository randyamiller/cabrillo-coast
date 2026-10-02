/* Cabrillo Coast LLC — regression proof of the fixture builder's source provenance and draft privacy (AC-16, AC-02) */
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
 *     and one that names no commit exits 2;
 *   - `--help` and `-h` print the usage line, then the options, the
 *     `<outDir>` rules, the output folders, the environment, the deadlines,
 *     the exit codes and an example, and write nothing;
 *   - a file as `<outDir>`, or a path below one, exits 2 as "not a folder",
 *     and a folder with entries exits 2 as "not empty", each writing nothing;
 *   - a run whose `<outDir>` another run claims while its `--ref` checks run
 *     (a `git` wrapper creates `<outDir>/src` on `rev-parse`) exits 2 and
 *     writes and removes nothing, and of four simultaneous runs into one
 *     folder exactly one builds a complete stage while the others exit 2.
 *
 * A second repository's HEAD tracks a draft image beside an article image,
 * and `git` and `tar` wrappers first on PATH log the `JEKYLL_ENV` each child
 * receives and the members of the archive before running the real commands.
 * With `JEKYLL_ENV=production` in the caller's environment it proves that
 *   - no git, tar or Jekyll child of either staging mode receives it;
 *   - the archive of the revision, both stages and every build hold no real
 *     draft image, and the archive and both stages keep the article image;
 *   - an extraction that fails exits 1, removes the archive and leaves no
 *     draft image in the stage;
 *   - a draft image that reaches the stage regardless is removed and stops
 *     the build with exit 1 before any fixture or synthetic file is added.
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

import { DEADLINES, formatDuration } from '../../scripts/lib/subprocess.mjs';
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
 * bundle first on PATH, preceded by `bin` when given. The stand-in logs to
 * `bundleLog`; `env` adds variables.
 * @param {string[]} args
 * @param {{ bin?: string, bundleLog?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function runBuilder(args, { bin, bundleLog = BUNDLE_LOG, env = {} } = {}) {
  const PATH = [...(bin === undefined ? [] : [bin]), BIN, sandbox.env.PATH ?? ''].join(path.delimiter);
  return runNode([path.join(REPO, 'tests', 'fixtures', 'build-fixture-site.mjs'), ...args], {
    cwd: REPO,
    env: { ...sandbox.env, ...env, PATH, FAKE_BUNDLE_LOG: bundleLog },
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

/* ------------------------------------------------------------------------ */
/* Help                                                                      */
/* ------------------------------------------------------------------------ */

describe('[AC-16][F-018] build-fixture-site.mjs --help documents its command line', { concurrency: 4 }, () => {
  test('[AC-16][F-018] --help and -h print the full help on stdout, write nothing and exit 0', BUILD_CASE, async () => {
    const out = path.join(sandbox.parent, 'out-help');
    const phrases = [
      // Options.
      '--ref <rev>',
      'git archive',
      'the fixture articles always come from the working tree',
      '--fixtures-only',
      '-h, --help',
      // <outDir> rules.
      'absent or an empty folder',
      'outside the repository',
      'with no comma in its absolute path',
      'the run claims it by',
      'creating <outDir>/src exclusively',
      // Environment and deadlines.
      'JEKYLL_ENV is removed from every git, tar and Jekyll child',
      'BUNDLE_GEMFILE set to the repository Gemfile',
      `each Jekyll build ${formatDuration(DEADLINES.jekyllBuild)}`,
      `git archive ${formatDuration(DEADLINES.gitArchive)}`,
      `tar extraction ${formatDuration(DEADLINES.tarExtract)}`,
      `each git query ${formatDuration(DEADLINES.gitQuery)}`,
      // Exit codes and an example.
      'Exit status: 0 when all three variants are built',
      '1 for a copy, staging or build failure',
      '2 for a usage error',
      'On failure <outDir> is left in place',
      'node tests/fixtures/build-fixture-site.mjs "$(mktemp -d)"',
    ];
    for (const flag of ['--help', '-h']) {
      const result = await runBuilder([flag, out]);
      expectExit(result, 0);
      assert.equal(result.stderr, '', `${flag} writes nothing on stderr`);
      assert.equal(result.stdout.split('\n')[0], USAGE, `${flag} prints the usage line first`);
      for (const phrase of phrases) {
        assert.ok(result.stdout.includes(phrase), `${flag} mentions ${JSON.stringify(phrase)}:\n${result.stdout}`);
      }
      for (const dir of ['src/', 'project-src/', 'project/cabrillo-coast/', 'preview/', 'empty-src/', 'empty/']) {
        assert.match(result.stdout, new RegExp(`^  ${escapeRegExp(dir)} +\\S`, 'm'), `${flag} describes the output folder ${dir}`);
      }
      assert.ok(!fs.existsSync(out), `${flag} wrote nothing, not even the <outDir> it was given`);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Output folder                                                             */
/* ------------------------------------------------------------------------ */

/** Asserts a refusal with exit 2: `message` as the builder's error line, then the usage line. */
function expectRefused(result, message) {
  expectExit(result, 2);
  assert.match(result.stderr, new RegExp(`^${escapeRegExp(`build-fixture-site: ${message}`)}$`, 'm'));
  assert.ok(result.stderr.split('\n').includes(USAGE), result.stderr);
}

/**
 * Writes a `git` wrapper into `<sandbox>/<name>/` and returns that folder, to
 * put first on PATH. On `git rev-parse`, the first query of the `--ref`
 * checks, it creates `$FAKE_CLAIM_DIR/src/competitor-marker` as a concurrent
 * run claiming the same `<outDir>` would, then runs the real git.
 */
function installClaimingGit(name) {
  const bin = sandbox.folder(name);
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      ': "${FAKE_CLAIM_DIR:?FAKE_CLAIM_DIR is not set}"',
      'if [ "$1" = rev-parse ]; then',
      `  mkdir -p "$FAKE_CLAIM_DIR/src" && printf '%s\\n' competitor > "$FAKE_CLAIM_DIR/src/competitor-marker" || exit 95`,
      'fi',
      `exec ${shQuote(commandPath('git'))} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

describe('[AC-16][F-018] build-fixture-site.mjs refuses an output folder it cannot use or claim', { concurrency: 4 }, () => {
  test('[AC-16][F-018] a file as <outDir> exits 2 as not a folder, and so does a path below it; the file is untouched', BUILD_CASE, async () => {
    const parent = sandbox.folder('out-file');
    const file = path.join(parent, 'afile');
    fs.writeFileSync(file, '');
    const written = fs.statSync(file);
    const bundleLog = path.join(sandbox.folder('logs-out-file'), 'bundle.log');
    const below = path.join(file, 'out');
    expectRefused(await runBuilder([file, '--fixtures-only'], { bundleLog }), `${file} exists and is not a folder`);
    expectRefused(await runBuilder([below, '--fixtures-only'], { bundleLog }), `a parent of ${below} is not a folder`);
    assert.deepEqual(fs.readdirSync(parent), ['afile'], 'nothing was written beside the file');
    const now = fs.statSync(file);
    assert.ok(now.isFile(), 'the file is still a file');
    assert.equal(now.size, 0, 'the file is still empty');
    assert.equal(now.mtimeMs, written.mtimeMs, 'the file was not written');
    assert.deepEqual(readJsonLines(bundleLog), [], 'nothing was built');
  });

  test('[AC-16][F-018] a folder that has entries still exits 2 as not empty and is left as it was', BUILD_CASE, async () => {
    const out = sandbox.folder('out-not-empty');
    fs.writeFileSync(path.join(out, 'keep.txt'), 'kept\n');
    const bundleLog = path.join(sandbox.folder('logs-out-not-empty'), 'bundle.log');
    expectRefused(await runBuilder([out, '--fixtures-only'], { bundleLog }), `${out} exists and is not empty`);
    assert.deepEqual(fs.readdirSync(out), ['keep.txt'], 'nothing was added');
    assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'kept\n', 'its entry is untouched');
    assert.deepEqual(readJsonLines(bundleLog), [], 'nothing was built');
  });

  test('[AC-16][F-018] a run whose <outDir> another run claims during its --ref checks exits 2 and writes and removes nothing', BUILD_CASE, async () => {
    const out = path.join(sandbox.parent, 'out-claimed');
    const src = path.join(out, 'src');
    const bundleLog = path.join(sandbox.folder('logs-claimed'), 'bundle.log');
    assert.ok(!fs.existsSync(out), 'the folder is absent when the run starts, so its empty-folder check passes');
    const result = await runBuilder([out, '--ref', BASE, '--fixtures-only'], {
      bin: installClaimingGit('bin-git-claims'),
      bundleLog,
      env: { FAKE_CLAIM_DIR: out },
    });
    expectRefused(result, `${out} is already in use by another run (${src} exists); give each run an empty folder of its own`);
    assert.ok(!result.stdout.includes('staging'), `nothing was staged:\n${result.stdout}`);
    assert.deepEqual(fs.readdirSync(out), ['src'], 'no archive or other entry was written beside the other run\'s src/');
    assert.deepEqual(fs.readdirSync(src), ['competitor-marker'], 'nothing was written into the other run\'s src/');
    assert.equal(fs.readFileSync(path.join(src, 'competitor-marker'), 'utf8'), 'competitor\n', 'and nothing in it was changed');
    assert.deepEqual(readJsonLines(bundleLog), [], 'nothing was built');
  });

  // `--ref` runs, because their git checks keep all four past the empty-folder check before any claims the
  // folder; a working-tree run claims it within a millisecond of that check, so most overlaps would not race.
  test('[AC-16][F-018] of four simultaneous --ref runs into one absent <outDir>, exactly one builds a complete stage and the others exit 2', BUILD_CASE, async () => {
    const out = path.join(sandbox.parent, 'out-concurrent');
    const src = path.join(out, 'src');
    const bundleLog = path.join(sandbox.folder('logs-concurrent'), 'bundle.log');
    const runs = await Promise.all([0, 1, 2, 3].map(() => runBuilder([out, '--ref', BASE, '--fixtures-only'], { bundleLog })));
    const outputs = runs.map((run, i) => `--- run ${i} (exit ${run.status}):\n${run.out}`).join('\n');
    assert.deepEqual(runs.map((run) => run.status).sort(), [0, 2, 2, 2], outputs);
    const refusal = new RegExp(
      `^build-fixture-site: (?:${escapeRegExp(`${out} is already in use by another run (${src} exists); give each run an empty folder of its own`)}|${escapeRegExp(`${out} exists and is not empty`)})$`,
      'm',
    );
    for (const run of runs.filter(({ status }) => status === 2)) assert.match(run.stderr, refusal, outputs);

    const files = listFiles(src);
    for (const rel of [DRAFT_IMAGE, `_drafts/${DRAFT_SLUG}.md`, ...FIXTURE_POST_FILES.map((file) => `_posts/${file}`)]) {
      assert.ok(files.includes(rel), `the winner's stage holds ${rel}: ${files.join(', ')}`);
    }
    assert.deepEqual(fs.readdirSync(out).sort(), ['empty', 'empty-src', 'preview', 'project', 'project-src', 'src'], 'only the winner wrote below the folder');
    const builds = readJsonLines(bundleLog);
    assert.deepEqual(
      builds.map((build) => path.relative(out, build.destination)).sort(),
      ['empty', 'preview', path.join('project', 'cabrillo-coast')],
      'three builds, all the winner\'s',
    );
    const preview = builds.find((build) => build.destination === path.join(out, 'preview'));
    assert.ok(preview.files.includes(DRAFT_IMAGE), 'the preview build saw the synthetic draft image');
  });
});

/* ------------------------------------------------------------------------ */
/* Draft privacy and child environments                                      */
/* ------------------------------------------------------------------------ */

/** A published article's image, committed beside the tracked draft image. */
const ARTICLE_IMAGE_REL = 'assets/blog/real-article/figure.svg';

/*
 * A repository whose HEAD tracks a draft image (force-added by the harness)
 * and an article image, so the archive of a revision holds both unless the
 * builder leaves `assets/drafts/` out of it.
 */
const PRIVACY_REPO = path.join(sandbox.parent, 'privacy-repo');
createSiteRepo(sandbox.env, PRIVACY_REPO, { message: 'Add the blog' });
write(PRIVACY_REPO, ARTICLE_IMAGE_REL, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n');
const PRIVACY_HEAD = commitAll(sandbox.env, PRIVACY_REPO, 'Add an article image');

/** Quotes text as one POSIX shell word. */
function shQuote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Absolute path of the executable `name` on the sandbox's PATH. */
function commandPath(name) {
  for (const dir of (sandbox.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    const stat = fs.statSync(candidate, { throwIfNoEntry: false });
    if (stat !== undefined && stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
  }
  throw new Error(`${name} is not on PATH`);
}

/**
 * Writes `git` and `tar` wrappers into `<sandbox>/<name>/` and returns that
 * folder, to put first on PATH. Each appends `<JEKYLL_ENV state>\t<args>` to
 * `FAKE_GIT_LOG` or `FAKE_TAR_LOG` (the state is `unset`, or `set:` and the
 * value) and runs the real command. Before extracting, the tar wrapper writes
 * `tar -tf` of the archive to `FAKE_TAR_MEMBERS`. `tarMode` `fail` extracts
 * and then exits 1, as an extraction that fails part-way would; `inject`
 * extracts and then plants a draft image in the extraction folder.
 * @param {string} name
 * @param {{ tarMode?: 'pass' | 'fail' | 'inject' }} [options]
 */
function installChildWrappers(name, { tarMode = 'pass' } = {}) {
  const bin = sandbox.folder(name);
  const realGit = shQuote(commandPath('git'));
  const realTar = shQuote(commandPath('tar'));
  const state = '"${JEKYLL_ENV+set:}${JEKYLL_ENV-unset}"';
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      ': "${FAKE_GIT_LOG:?FAKE_GIT_LOG is not set}"',
      `printf '%s\\t%s\\n' ${state} "$*" >> "$FAKE_GIT_LOG"`,
      `exec ${realGit} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const extract = {
    pass: [`exec ${realTar} "$@"`],
    fail: [`${realTar} "$@" || exit 98`, 'exit 1'],
    inject: [
      `${realTar} "$@" || exit 98`,
      '[ "$3" = "-C" ] || exit 97',
      'mkdir -p "$4/assets/drafts/injected" && printf leak > "$4/assets/drafts/injected/leak.png"',
    ],
  }[tarMode];
  fs.writeFileSync(
    path.join(bin, 'tar'),
    [
      '#!/bin/sh',
      ': "${FAKE_TAR_LOG:?FAKE_TAR_LOG is not set}" "${FAKE_TAR_MEMBERS:?FAKE_TAR_MEMBERS is not set}"',
      `printf '%s\\t%s\\n' ${state} "$*" >> "$FAKE_TAR_LOG"`,
      '[ "$1" = "-xf" ] || exit 96',
      `${realTar} -tf "$2" > "$FAKE_TAR_MEMBERS" || exit 99`,
      ...extract,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

const PASS_BIN = installChildWrappers('bin-children');
const FAILING_TAR_BIN = installChildWrappers('bin-tar-fails', { tarMode: 'fail' });
const INJECTING_TAR_BIN = installChildWrappers('bin-tar-injects', { tarMode: 'inject' });

/**
 * Runs the privacy repository's copy of the builder with
 * `JEKYLL_ENV=production` in its environment and `bin`, then the stand-in
 * bundle, first on PATH. Every child logs into `<sandbox>/logs-<name>/`.
 */
async function runPrivacyBuilder(name, args, bin) {
  const logs = sandbox.folder(`logs-${name}`);
  const files = {
    git: path.join(logs, 'git.log'),
    tar: path.join(logs, 'tar.log'),
    members: path.join(logs, 'tar-members.txt'),
    bundle: path.join(logs, 'bundle.log'),
  };
  const result = await runNode([path.join(PRIVACY_REPO, 'tests', 'fixtures', 'build-fixture-site.mjs'), ...args], {
    cwd: PRIVACY_REPO,
    env: {
      ...sandbox.env,
      JEKYLL_ENV: 'production',
      PATH: [bin, BIN, sandbox.env.PATH ?? ''].join(path.delimiter),
      FAKE_GIT_LOG: files.git,
      FAKE_TAR_LOG: files.tar,
      FAKE_TAR_MEMBERS: files.members,
      FAKE_BUNDLE_LOG: files.bundle,
    },
    timeoutMs: 60000,
  });
  return { ...result, logs: files };
}

/** The non-empty lines of a log file, or none when it was never written. */
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

/** The wrapper log entries of `file` as `{ env, args }`. */
function readChildLog(file) {
  return readLines(file).map((line) => {
    const tab = line.indexOf('\t');
    return { env: line.slice(0, tab), args: line.slice(tab + 1) };
  });
}

/** True when the POSIX path `rel` (a folder may end in `/`) is `assets/drafts` or lies below it. */
function isDraftImagePath(rel) {
  const trimmed = rel.replace(/\/+$/, '');
  return trimmed === 'assets/drafts' || trimmed.startsWith('assets/drafts/');
}

describe('[AC-02][F-017] build-fixture-site.mjs keeps tracked draft images out of the archive and JEKYLL_ENV out of every child', { concurrency: 4 }, () => {
  const refOut = path.join(sandbox.parent, 'out-privacy-ref');
  const workOut = path.join(sandbox.parent, 'out-privacy-work');
  const failOut = path.join(sandbox.parent, 'out-privacy-tar-fails');
  const injectOut = path.join(sandbox.parent, 'out-privacy-tar-injects');
  let refRun;
  let workRun;
  let failRun;
  let injectRun;

  before(async () => {
    [refRun, workRun, failRun, injectRun] = await Promise.all([
      runPrivacyBuilder('ref', [refOut, '--ref', PRIVACY_HEAD, '--fixtures-only'], PASS_BIN),
      runPrivacyBuilder('work', [workOut, '--fixtures-only'], PASS_BIN),
      runPrivacyBuilder('tar-fails', [failOut, '--ref', PRIVACY_HEAD, '--fixtures-only'], FAILING_TAR_BIN),
      runPrivacyBuilder('tar-injects', [injectOut, '--ref', PRIVACY_HEAD, '--fixtures-only'], INJECTING_TAR_BIN),
    ]);
  });

  test('[AC-02][F-017] the revision tracks a draft image and an article image', () => {
    assert.equal(git(sandbox.env, PRIVACY_REPO, 'ls-tree', '-r', '--name-only', PRIVACY_HEAD, '--', 'assets'), [ARTICLE_IMAGE_REL, DRAFT_IMAGE_REL].sort().join('\n'));
    assert.ok(exists(PRIVACY_REPO, DRAFT_IMAGE_REL), 'the working tree holds the draft image too');
  });

  test('[AC-16][F-018] with JEKYLL_ENV=production in the caller\'s environment, no git, tar or Jekyll child receives it', BUILD_CASE, () => {
    expectExit(refRun, 0);
    expectExit(workRun, 0);
    const gitRuns = readChildLog(refRun.logs.git);
    const subcommands = new Set(gitRuns.map(({ args }) => args.split(' ').find((arg) => !arg.startsWith('-'))));
    for (const subcommand of ['rev-parse', 'ls-tree', 'archive']) {
      assert.ok(subcommands.has(subcommand), `git ${subcommand} ran: ${[...subcommands].join(', ')}`);
    }
    const tarRuns = readChildLog(refRun.logs.tar);
    assert.equal(tarRuns.length, 1, 'one tar extraction');
    for (const run of [refRun, workRun]) {
      for (const child of [...readChildLog(run.logs.git), ...readChildLog(run.logs.tar)]) {
        assert.equal(child.env, 'unset', `JEKYLL_ENV reached ${child.args}`);
      }
      const builds = readJsonLines(run.logs.bundle);
      assert.equal(builds.length, 3, 'three Jekyll builds');
      for (const build of builds) assert.equal(build.jekyllEnv, null, `JEKYLL_ENV reached the build of ${build.source}`);
    }
  });

  test('[AC-02][F-017] the archive of a revision leaves the tracked draft image out and keeps the rest of assets/', BUILD_CASE, () => {
    expectExit(refRun, 0);
    const members = readLines(refRun.logs.members);
    assert.ok(members.includes(ARTICLE_IMAGE_REL), `the archive holds the article image: ${members.join(', ')}`);
    assert.deepEqual(members.filter(isDraftImagePath), [], 'the archive holds nothing under assets/drafts/');
    assert.ok(!exists(refOut, 'ref.tar'), 'the archive is removed once extracted');
  });

  test('[AC-02][F-017] neither stage nor any build holds the real draft image; both keep the article image', BUILD_CASE, () => {
    expectExit(refRun, 0);
    expectExit(workRun, 0);
    for (const [run, out] of [[refRun, refOut], [workRun, workOut]]) {
      const src = path.join(out, 'src');
      const files = listFiles(src);
      assert.deepEqual(files.filter(isDraftImagePath), [DRAFT_IMAGE], `${src}: only the synthetic draft image`);
      assert.ok(files.includes(ARTICLE_IMAGE_REL), `${src} keeps the article image`);
      for (const build of readJsonLines(run.logs.bundle)) {
        assert.ok(!build.files.includes(DRAFT_IMAGE_REL), `the build of ${build.source} saw no real draft image`);
      }
    }
  });

  test('[AC-02][F-017] an extraction that fails exits 1, removes the archive and leaves no draft image in the stage', BUILD_CASE, () => {
    expectExit(failRun, 1);
    const src = path.join(failOut, 'src');
    assert.match(failRun.stderr, new RegExp(`^${escapeRegExp(`build-fixture-site: tar exited with status 1: tar -xf ${path.join(failOut, 'ref.tar')} -C ${src}`)}$`, 'm'));
    assert.ok(!exists(failOut, 'ref.tar'), 'the archive is removed after the failed extraction');
    const members = readLines(failRun.logs.members);
    assert.ok(members.includes(ARTICLE_IMAGE_REL), `the archive was complete: ${members.join(', ')}`);
    assert.deepEqual(members.filter(isDraftImagePath), [], 'the archive held nothing under assets/drafts/');
    const files = listFiles(src);
    assert.ok(files.includes(ARTICLE_IMAGE_REL), `the extraction ran before failing: ${files.join(', ')}`);
    assert.deepEqual(files.filter(isDraftImagePath), [], `${src} holds nothing under assets/drafts/`);
    assert.deepEqual(readJsonLines(failRun.logs.bundle), [], 'nothing was built');
  });

  test('[AC-02][F-017] a draft image found in the stage is removed and stops the build with exit 1 before anything is added', BUILD_CASE, () => {
    expectExit(injectRun, 1);
    const src = path.join(injectOut, 'src');
    assert.match(
      injectRun.stderr,
      new RegExp(`^${escapeRegExp(`build-fixture-site: the staged source held assets/drafts/, which staging must leave out; it was removed from ${src} and nothing was built`)}$`, 'm'),
    );
    assert.ok(!exists(injectOut, 'ref.tar'), 'the archive is removed');
    const files = listFiles(src);
    assert.ok(files.includes(ARTICLE_IMAGE_REL), `the extraction ran: ${files.join(', ')}`);
    assert.ok(!exists(src, 'assets/drafts'), `${src} holds no assets/drafts/`);
    assert.deepEqual(files.filter((file) => file.startsWith('_drafts/') || file.startsWith('_posts/')), [], 'no fixture or synthetic file was added');
    assert.deepEqual(readJsonLines(injectRun.logs.bundle), [], 'nothing was built');
  });
});
