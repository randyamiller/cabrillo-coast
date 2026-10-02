#!/usr/bin/env node
/* Cabrillo Coast LLC — fixture site builder for the blog checks (Node built-ins only) */
/**
 * Builds the blog from a staged copy of the site source plus the fixture
 * articles and synthetic private content, in three variants.
 *
 *   node tests/fixtures/build-fixture-site.mjs <outDir> [--ref <rev>] [--fixtures-only]
 *
 *   <outDir>         Output folder: absent or empty, and outside the repository.
 *                    Once every check has passed, the run claims it by
 *                    creating `<outDir>/src` exclusively, so of several runs
 *                    into one folder only the first proceeds.
 *   --ref <rev>      Take the site source from that commit (`git archive`)
 *                    instead of the working tree. The fixture articles always
 *                    come from the working tree.
 *   --fixtures-only  Leave the repository's real `_posts/` out, so only the
 *                    fixture articles are built.
 *   -h, --help       Print the full help and exit 0.
 *
 * Output layout under <outDir>:
 *   src/                     Staged source: the allow-listed site files, the
 *                            fixture posts, a synthetic draft and its image, a
 *                            post dated one year ahead and `_config.project.yml`.
 *                            No real draft image: `assets/drafts/` is filtered
 *                            from the working tree and excluded from the archive.
 *   project-src/             `src/` without `CNAME` (project-path deployment).
 *   project/cabrillo-coast/  Build of `project-src/` at base path /cabrillo-coast
 *                            with `url` set to the github.io host.
 *   preview/                 `--drafts` build of `src/` with `_config.preview.yml`,
 *                            empty base path, `CNAME` kept.
 *   empty-src/               `src/` without `_posts/`.
 *   empty/                   Zero-article build (launch state).
 *
 * Exit codes: 0 when all three variants are built; 1 for a copy, staging or
 * build failure, including a git, tar or Jekyll run that failed, was killed,
 * exceeded its deadline or could not be started; 2 for a usage error,
 * including a `--ref` that names no commit and an `<outDir>` that is not a
 * folder, is not empty or was claimed by another run first. A run refused
 * with 2 writes nothing. On failure `<outDir>` is left in place for
 * inspection; its owner removes it.
 *
 * Nothing here is published: `_config.yml` excludes `tests/`, and the
 * synthetic draft, its image and the future-dated post are written only into
 * `<outDir>`, never into the repository. Every child (git, tar and Jekyll)
 * runs with `JEKYLL_ENV` removed: a local production build derives the wrong
 * base path, so the project base path is passed with `--baseurl` in place of
 * the Pages API.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { DEADLINES, describeResult, formatDuration, runSync } from "../../scripts/lib/subprocess.mjs";

/* ------------------------------------------------------------------------ */
/* Public constants (imported by the built-output suites)                    */
/* ------------------------------------------------------------------------ */

/** Slug of the synthetic draft; it must appear only in the preview build. */
export const DRAFT_SLUG = "fixture-private-draft";

/** Unique text in the synthetic draft's body; never in a normal build. */
export const DRAFT_MARKER = "FIXTURE-PRIVATE-DRAFT-MARKER-7f3c9a1e";

/** The synthetic draft's image, relative to the site source (no leading slash). */
export const DRAFT_IMAGE = `assets/drafts/${DRAFT_SLUG}/figure.svg`;

/** Slug of the synthetic post dated one year ahead; `future: false` keeps it out of every build. */
export const FUTURE_SLUG = "fixture-future-post";

/** Unique text in the future-dated post's body; never in any build. */
export const FUTURE_MARKER = "FIXTURE-FUTURE-POST-MARKER-2b8d4e6f";

/**
 * The fixture articles the staged source and the project and preview builds
 * contain; the empty variant deliberately contains none. `file` is the
 * basename inside `tests/fixtures/posts/`; `slug` is the URL segment under
 * `/blog/`.
 */
export const FIXTURE_POSTS = Object.freeze([
  Object.freeze({ file: "2026-01-15-fixture-code-and-tables.md", slug: "fixture-code-and-tables" }),
  Object.freeze({ file: "2026-02-01-fixture-escaping-and-liquid.md", slug: "fixture-escaping-and-liquid" }),
]);

/** Base path of the project-path deployment (repository name on github.io). */
export const PROJECT_BASEURL = "/cabrillo-coast";

/** Host of the project-path deployment, written to `_config.project.yml` as `url`. */
export const PROJECT_URL = "https://randyamiller.github.io";

/* ------------------------------------------------------------------------ */
/* Internal constants                                                        */
/* ------------------------------------------------------------------------ */

/** Repository root, from this file's location; `process.cwd()` is never used for repository paths. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_POSTS_DIR = path.join(REPO_ROOT, "tests", "fixtures", "posts");
/** Every build uses the repository's bundle, wherever the staged copy lives. */
const GEMFILE = path.join(REPO_ROOT, "Gemfile");

const USAGE = "Usage: node tests/fixtures/build-fixture-site.mjs <outDir> [--ref <rev>] [--fixtures-only]";
const LOG_PREFIX = "build-fixture-site:";

/**
 * Site-source allow-list (repository-relative POSIX paths). Only these are
 * staged, so drafts, draft images, build output, dependencies, tests, scripts,
 * the README, npm manifests and dot-folders can never reach a fixture build:
 * `_drafts/`, `_site/`, `.jekyll-cache/`, `vendor/` and `node_modules/` are
 * simply not on the list, and `assets/drafts/` is filtered out of `assets/`.
 */
const STAGED_FILES = Object.freeze([
  "index.html",
  "styles.css",
  "main.js",
  "favicon.svg",
  "CNAME",
  "_config.yml",
  "_config.preview.yml",
  "Gemfile",
  "Gemfile.lock",
]);
const POSTS_DIR = "_posts";
const STAGED_FOLDERS = Object.freeze(["_layouts", "_includes", "blog", POSTS_DIR, "assets"]);

/** Paths without which the staged source cannot build the blog. */
const REQUIRED_PATHS = Object.freeze(["_config.yml", "_config.preview.yml", "_layouts/post.html"]);

/** Git-ignored draft images; never staged from the working tree or a revision. */
const DRAFT_IMAGES_DIR = "assets/drafts";

/** Overlay that sets the github.io host for the project variant; underscore-prefixed, so never output. */
const PROJECT_OVERLAY = "_config.project.yml";

/** Jekyll post filenames: `YYYY-MM-DD-<slug>.<ext>`. */
const POST_FILENAME_RE = /^\d{4}-\d{2}-\d{2}-(.+)\.[^.]+$/;

/** Files every successful build must contain. */
const BUILD_OUTPUTS = Object.freeze(["index.html", "blog/index.html"]);

const DRAFT_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">' +
  '<rect width="120" height="60" fill="#0d3b4f"/></svg>\n';

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Creates an `Error` carrying the exit code the CLI reports: 2 for a usage
 * error, 1 for a copy or build failure.
 * @param {string} message
 * @param {1 | 2} exitCode
 * @returns {Error & { exitCode: number }}
 */
function fail(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Repository-relative or folder-relative path in POSIX form. */
function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

/** Human-readable reason a child process could not be started. */
function spawnErrorMessage(cmd, error) {
  if (error && error.code === "ENOENT") {
    if (cmd === "bundle") return "bundle not found: install Ruby 3.3.4 and run `bundle install` (see README)";
    return `${cmd} not found: install it and make sure it is on PATH`;
  }
  return `${cmd} could not be started: ${error && error.message ? error.message : String(error)}`;
}

/**
 * Runs a command with inherited output, printing it first. Arguments are
 * passed as an array and never through a shell. The command is killed when
 * its deadline expires.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} options
 * @param {number} timeoutMs Deadline from `DEADLINES`.
 * @throws {Error} exit code 1 when the command cannot start, is killed,
 *   exceeds its deadline or exits non-zero.
 */
function run(cmd, args, options, timeoutMs) {
  const line = [cmd, ...args].join(" ");
  console.log(`$ ${line}`);
  const result = runSync(cmd, args, { ...options, stdio: "inherit", timeoutMs });
  if (result.error) throw fail(spawnErrorMessage(cmd, result.error), 1);
  if (!result.ok) throw fail(`${cmd} ${describeResult(result)}: ${line}`, 1);
}

/**
 * Runs a command whose output is parsed, capturing stdout and stderr. Only a
 * command that exited by itself returns: its status, zero or not, is the
 * command's answer, for the caller to read.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} options
 * @param {number} timeoutMs Deadline from `DEADLINES`.
 * @returns {{ status: number, stdout: string, stderr: string }}
 * @throws {Error} exit code 1 when the command cannot start, is killed,
 *   exceeds its deadline or overflows its capture limit.
 */
function capture(cmd, args, options, timeoutMs) {
  const result = runSync(cmd, args, { ...options, timeoutMs });
  if (result.error) throw fail(spawnErrorMessage(cmd, result.error), 1);
  if (!result.completed) {
    const stderr = result.stderr.trim();
    throw fail(`${[cmd, ...args].join(" ")} ${describeResult(result)}${stderr === "" ? "" : `: ${stderr}`}`, 1);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Base environment of every child (git, tar and Jekyll): a copy of the
 * caller's without `JEKYLL_ENV`. A local production build derives the wrong
 * base path (`/pages/randyamiller/cabrillo-coast`) and no other child has a
 * use for the variable, so none receives it. `process.env` is never changed.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.JEKYLL_ENV;
  return env;
}

/**
 * Environment of every git command: `childEnv()` with `GIT_OPTIONAL_LOCKS=0`
 * so a read-only command never writes even an opportunistic index refresh.
 */
function gitEnv() {
  return { ...childEnv(), GIT_OPTIONAL_LOCKS: "0" };
}

/** Read-only git plumbing in the repository, with the `DEADLINES.gitQuery` deadline. */
function git(args) {
  return capture("git", args, { cwd: REPO_ROOT, env: gitEnv() }, DEADLINES.gitQuery);
}

/**
 * True when `p` exists and is a directory. Only absence (ENOENT, ENOTDIR)
 * reads as false; any other failure (EACCES, EIO, …) is thrown.
 * @throws {Error} exit code 1 when `p` cannot be inspected.
 */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    throw fail(`cannot inspect ${p}: ${err.message}`, 1);
  }
}

/**
 * Absolute path with symlinks resolved in its longest existing prefix, so a
 * path that does not exist yet still compares correctly (macOS `/var` →
 * `/private/var`).
 */
function canonicalPath(p) {
  const tail = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is `parent` or lies inside it. */
function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * `fs.lstatSync(p)`, or null when nothing is at `p` (ENOENT, or ENOTDIR when
 * a parent is a file). Any other failure (EACCES, EIO, …) is an operational
 * error and is never taken for absence.
 * @returns {fs.Stats | null}
 * @throws {Error} exit code 1 when `p` cannot be inspected.
 */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw fail(`cannot inspect ${p}: ${err.message}`, 1);
  }
}

/**
 * Containment rule for the staged source: before anything is written into
 * `dir` or removed below it, every folder from `root` (exclusive) down to
 * `dir` (inclusive) that already exists must be a real folder. Staging copies
 * symbolic links as links and never follows them (following one could pull
 * real draft images into the stage), so a symlinked `_posts/` or `assets/`
 * from the working tree or a revision would otherwise send a fixture copy, a
 * synthetic file or the `assets/drafts/` removal to wherever the link points,
 * outside `<outDir>`. The first missing folder ends the check: `mkdirSync`
 * creates it and everything below it as real folders.
 * @param {string} root The staged source folder this run created.
 * @param {string} dir The folder about to be written into or removed below.
 * @throws {Error} exit code 1 when `dir` lies outside `root`, or when a folder
 *   on the way is a symbolic link, is not a folder or cannot be inspected.
 */
function assertRealFolders(root, dir) {
  if (!isWithin(dir, root)) throw fail(`refusing to write to ${dir}: it lies outside ${root}`, 1);
  let current = root;
  for (const segment of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (stat === null) return;
    const rel = toPosix(path.relative(root, current));
    if (stat.isSymbolicLink()) {
      throw fail(
        `refusing to write or remove below ${current}: it is a symbolic link, which could lead outside ${root}; make ${rel} a real folder in the site source`,
        1,
      );
    }
    if (!stat.isDirectory()) {
      throw fail(`refusing to write below ${current}: it is not a folder; make ${rel} a folder in the site source`, 1);
    }
  }
}

/** Every file under `dir`, as POSIX paths relative to `dir`, sorted. */
function listFiles(dir) {
  if (!isDirectory(dir)) return [];
  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(toPosix(path.relative(dir, full)));
    }
  };
  walk(dir);
  return files.sort();
}

/** Slug of a post file (`YYYY-MM-DD-<slug>.<ext>`), or null when the name is not a post name. */
function postSlug(relativePath) {
  const match = POST_FILENAME_RE.exec(path.posix.basename(relativePath));
  return match ? match[1] : null;
}

/**
 * The current UTC date one year ahead, as `YYYY-MM-DD`. 29 February becomes
 * 28 February, because the following year is never a leap year.
 * @param {Date} [now]
 */
function oneYearAheadUtc(now = new Date()) {
  const month = now.getUTCMonth() + 1;
  const day = month === 2 && now.getUTCDate() === 29 ? 28 : now.getUTCDate();
  const pad = (n, width) => String(n).padStart(width, "0");
  return `${pad(now.getUTCFullYear() + 1, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/* ------------------------------------------------------------------------ */
/* Pre-flight checks (nothing is written until all of them pass)             */
/* ------------------------------------------------------------------------ */

/** The allow-list for this build; `_posts/` is left out when only fixtures are wanted. */
function stagedPaths(fixturesOnly) {
  const folders = fixturesOnly ? STAGED_FOLDERS.filter((folder) => folder !== POSTS_DIR) : STAGED_FOLDERS;
  return [...STAGED_FILES, ...folders];
}

/**
 * Refuses an output folder inside the repository: a nested output would be
 * copied into the real `_site` by `bundle exec jekyll build` (its name is not
 * in `exclude`) and offered to `git add -A`, carrying the synthetic draft and
 * Gemfile copies with it. Every consumer passes a folder under `os.tmpdir()`.
 */
function assertOutsideRepo(outDir) {
  if (isWithin(canonicalPath(outDir), canonicalPath(REPO_ROOT))) {
    throw fail(`${outDir} is inside the repository; use a folder outside it, such as one under the system temp directory`, 2);
  }
}

/**
 * Refuses an output folder that is not a folder, lies below something that
 * is not a folder, or already has entries.
 * @throws {Error} exit code 2 for each of those; exit code 1 when `outDir`
 *   cannot be inspected.
 */
function assertEmptyOrAbsent(outDir) {
  let stat;
  try {
    stat = fs.statSync(outDir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    if (err.code === "ENOTDIR") throw fail(`a parent of ${outDir} is not a folder`, 2);
    throw fail(`cannot inspect ${outDir}: ${err.message}`, 1);
  }
  if (!stat.isDirectory()) throw fail(`${outDir} exists and is not a folder`, 2);
  if (fs.readdirSync(outDir).length > 0) throw fail(`${outDir} exists and is not empty`, 2);
}

/**
 * Claims `outDir` for this run once every pre-flight check has passed and
 * before anything else is written: `outDir` is created when absent, then
 * `srcDir` inside it without `recursive`, which fails when it already
 * exists. Of several runs into one folder exactly one gets past this, however
 * their checks interleave; the others write and remove nothing below it.
 * @param {string} outDir Absolute output folder.
 * @param {string} srcDir `<outDir>/src`.
 * @throws {Error} exit code 2 when `srcDir` already exists (another run
 *   claimed `outDir` first), or when `outDir` or a folder above it is not a
 *   folder; exit code 1 when either folder cannot be created otherwise.
 */
function claimOutDir(outDir, srcDir) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    if (err.code === "EEXIST") throw fail(`${outDir} exists and is not a folder`, 2);
    if (err.code === "ENOTDIR") throw fail(`a parent of ${outDir} is not a folder`, 2);
    throw fail(`cannot create ${outDir}: ${err.message}`, 1);
  }
  try {
    fs.mkdirSync(srcDir);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw fail(`${outDir} is already in use by another run (${srcDir} exists); give each run an empty folder of its own`, 2);
    }
    if (err.code === "ENOTDIR") throw fail(`a parent of ${srcDir} is not a folder`, 2);
    throw fail(`cannot create ${srcDir}: ${err.message}`, 1);
  }
}

/**
 * Resolves `--ref` to a commit id. Values starting with `-` are refused
 * before git sees them, so a revision can never be read as a git option.
 * @returns {string} the full commit id.
 * @throws {Error} exit code 2 when git answers that `ref` names no commit;
 *   exit code 1 when git gives no answer (killed, timed out, not started).
 */
function resolveRevision(ref) {
  if (ref.startsWith("-")) throw fail(`cannot resolve --ref ${ref}`, 2);
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || sha === "") throw fail(`cannot resolve --ref ${ref}`, 2);
  return sha;
}

/**
 * True when `relativePath` (file or folder) exists at commit `sha`, false
 * when git confirms it does not.
 *
 * `git ls-tree -z --full-tree <sha> -- <path>` lists the entry itself, a
 * folder as its own tree entry, and exits 0 with no output when the path is
 * absent, so absence is an answer rather than an error. A bad or unreadable
 * object exits non-zero, which is a failure, never absence: otherwise a
 * damaged object would drop an existing optional path or report a required
 * one missing. One path per call, because several paths make ls-tree list
 * the contents of the folders among them. `--literal-pathspecs` keeps every
 * character of the path literal.
 * @param {string} sha Full commit id.
 * @param {string} relativePath Repository-relative POSIX path, no trailing slash.
 * @returns {boolean}
 * @throws {Error} exit code 1 when git does not answer or exits non-zero.
 */
function existsAtRevision(sha, relativePath) {
  const result = git(["--literal-pathspecs", "ls-tree", "-z", "--full-tree", sha, "--", relativePath]);
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw fail(
      `cannot tell whether ${relativePath} exists at ${sha.slice(0, 12)}: ` +
        `git ls-tree exited with status ${result.status}${stderr === "" ? "" : `: ${stderr}`}`,
      1,
    );
  }
  // Records are `<mode> <type> <object>\t<path>`, each ended by NUL.
  return result.stdout.split("\0").some((record) => {
    const tab = record.indexOf("\t");
    return tab !== -1 && record.slice(tab + 1) === relativePath;
  });
}

/* ------------------------------------------------------------------------ */
/* Staging                                                                   */
/* ------------------------------------------------------------------------ */

/** `fs.cpSync` filter: drops `assets/drafts` and everything below it. */
function keepInStage(sourcePath) {
  const rel = toPosix(path.relative(REPO_ROOT, sourcePath));
  return rel !== DRAFT_IMAGES_DIR && !rel.startsWith(`${DRAFT_IMAGES_DIR}/`);
}

/**
 * Copies the allow-listed paths from the working tree, so new files are
 * included before their first commit. Missing optional paths (`_posts/`,
 * `CNAME`, …) are skipped; a path that cannot be inspected stops the build.
 */
function stageWorkingTree(srcDir, paths) {
  for (const rel of paths) {
    const from = path.join(REPO_ROOT, ...rel.split("/"));
    if (lstatOrNull(from) === null) continue;
    fs.cpSync(from, path.join(srcDir, ...rel.split("/")), { recursive: true, filter: keepInStage });
  }
}

/**
 * Extracts the allow-listed paths that exist at commit `sha` with
 * `git archive`. The archive's pathspecs exclude `assets/drafts/`, so a draft
 * image the revision tracks never reaches `ref.tar` or the staged source,
 * not even when the extraction fails or is interrupted.
 */
function stageRevision(outDir, srcDir, sha, paths) {
  const tarPath = path.join(outDir, "ref.tar");
  // `--no-literal-pathspecs` keeps the exclude magic in force when the caller exports
  // GIT_LITERAL_PATHSPECS; `literal` matches the excluded folder name character for character.
  const excludeDraftImages = `:(exclude,literal)${DRAFT_IMAGES_DIR}`;
  try {
    run(
      "git",
      ["--no-literal-pathspecs", "archive", "--format=tar", "-o", tarPath, sha, "--", ...paths, excludeDraftImages],
      { cwd: REPO_ROOT, env: gitEnv() },
      DEADLINES.gitArchive,
    );
    run("tar", ["-xf", tarPath, "-C", srcDir], { env: childEnv() }, DEADLINES.tarExtract);
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}

/**
 * Fails closed when the freshly staged source holds `assets/drafts`, before
 * any fixture or synthetic file is added. Both staging modes leave it out
 * (the working-tree copy filters it, the revision archive excludes it), so
 * finding it means that control failed. It is removed before the failure is
 * reported, so no draft image stays in `<outDir>`.
 * @throws {Error} exit code 1 when `assets/drafts` was staged, or when
 *   `assets/` is not a real folder or cannot be inspected.
 */
function assertNoDraftImages(srcDir) {
  const draftImages = path.join(srcDir, ...DRAFT_IMAGES_DIR.split("/"));
  // A symlinked `assets/` would aim the probe and the removal at the real `drafts/` inside the folder it
  // points to; a symlinked `assets/drafts` itself is only unlinked by `rmSync`, never followed.
  assertRealFolders(srcDir, path.dirname(draftImages));
  if (lstatOrNull(draftImages) === null) return;
  try {
    fs.rmSync(draftImages, { recursive: true, force: true });
  } catch (err) {
    throw fail(
      `the staged source holds ${DRAFT_IMAGES_DIR}/, which staging must leave out, and removing it failed: ${err.message}; delete ${draftImages}`,
      1,
    );
  }
  throw fail(
    `the staged source held ${DRAFT_IMAGES_DIR}/, which staging must leave out; it was removed from ${srcDir} and nothing was built`,
    1,
  );
}

/**
 * Copies every fixture article from the working tree's `tests/fixtures/posts/`
 * into the staged `_posts/`, after refusing any slug that would collide with
 * a staged real post, the synthetic content or another fixture.
 */
function stageFixtures(srcDir) {
  const missing = FIXTURE_POSTS.filter(({ file }) => !fs.existsSync(path.join(FIXTURE_POSTS_DIR, file)));
  if (missing.length > 0) {
    const names = missing.map(({ file }) => `tests/fixtures/posts/${file}`).join(", ");
    throw fail(`missing fixture article ${names}`, 1);
  }

  const postsDir = path.join(srcDir, POSTS_DIR);
  // Before the folder is created or listed: a symlinked staged `_posts/` would take the fixtures elsewhere.
  assertRealFolders(srcDir, postsDir);
  fs.mkdirSync(postsDir, { recursive: true });

  const reserved = new Map([
    [DRAFT_SLUG, "the synthetic draft"],
    [FUTURE_SLUG, "the synthetic future-dated post"],
  ]);
  const realPosts = new Map();
  for (const rel of listFiles(postsDir)) {
    const slug = postSlug(rel);
    if (slug === null) continue;
    if (reserved.has(slug)) {
      throw fail(`real post _posts/${rel} uses the slug of ${reserved.get(slug)}; rename the post`, 1);
    }
    realPosts.set(slug, rel);
  }

  const fixtures = listFiles(FIXTURE_POSTS_DIR).filter((rel) => rel.endsWith(".md"));
  const fixtureSlugs = new Map();
  for (const rel of fixtures) {
    const slug = postSlug(rel);
    if (slug === null) throw fail(`fixture tests/fixtures/posts/${rel} is not named YYYY-MM-DD-<slug>.md`, 1);
    if (reserved.has(slug)) throw fail(`fixture tests/fixtures/posts/${rel} uses the slug of ${reserved.get(slug)}`, 1);
    if (fixtureSlugs.has(slug)) {
      throw fail(`fixtures tests/fixtures/posts/${fixtureSlugs.get(slug)} and ${rel} share the slug ${slug}`, 1);
    }
    if (realPosts.has(slug)) {
      throw fail(
        `real post _posts/${realPosts.get(slug)} uses the fixture slug ${slug}; rename the post or build with --fixtures-only`,
        1,
      );
    }
    if (fs.existsSync(path.join(postsDir, ...rel.split("/")))) {
      throw fail(`fixture ${rel} already exists in the staged _posts/`, 1);
    }
    fixtureSlugs.set(slug, rel);
  }

  for (const rel of fixtures) {
    const dest = path.join(postsDir, ...rel.split("/"));
    // COPYFILE_EXCL refuses a symbolic link at `dest` itself; its folders are checked here.
    assertRealFolders(srcDir, path.dirname(dest));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_POSTS_DIR, ...rel.split("/")), dest, fs.constants.COPYFILE_EXCL);
  }
  return fixtures.length;
}

/**
 * Writes a new UTF-8 file below the staged source `root`, refusing to
 * overwrite one. Its folders must be real (`assertRealFolders`), and the `wx`
 * flag also refuses a symbolic link standing at the file's own path.
 */
function writeNewFile(root, filePath, text) {
  const dir = path.dirname(filePath);
  assertRealFolders(root, dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, text, { encoding: "utf8", flag: "wx" });
}

/**
 * Writes the synthetic draft, its image and the future-dated post into the
 * staging copy only. The draft passes the article schema in
 * `scripts/lib/articles.mjs` (quoted title and summary, a flow-list tag, an
 * image with alt text in its own draft folder); the post is valid apart from
 * its date. Their slugs and markers appear nowhere else.
 * @returns {string} the future post's filename.
 */
function writeSyntheticContent(srcDir) {
  const draft = [
    "---",
    'title: "Fixture: private draft"',
    'summary: "Synthetic draft that must never appear in a normal build."',
    "tags: [fixture]",
    "---",
    "",
    `This draft carries the marker ${DRAFT_MARKER} and must only render in the preview build.`,
    "",
    `![Draft figure]({{ '/${DRAFT_IMAGE}' | relative_url }})`,
    "",
  ].join("\n");
  writeNewFile(srcDir, path.join(srcDir, "_drafts", `${DRAFT_SLUG}.md`), draft);
  writeNewFile(srcDir, path.join(srcDir, ...DRAFT_IMAGE.split("/")), DRAFT_IMAGE_SVG);

  const futureFile = `${oneYearAheadUtc()}-${FUTURE_SLUG}.md`;
  const future = [
    "---",
    'title: "Fixture: future-dated post"',
    'summary: "Synthetic post dated one year ahead that future: false keeps out of every build."',
    "tags: [fixture]",
    "---",
    "",
    `This post carries the marker ${FUTURE_MARKER} and must never be built.`,
    "",
  ].join("\n");
  writeNewFile(srcDir, path.join(srcDir, POSTS_DIR, futureFile), future);
  return futureFile;
}

/* ------------------------------------------------------------------------ */
/* Builds                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Environment for every Jekyll build: `childEnv()` plus `BUNDLE_GEMFILE`
 * naming the repository Gemfile so the installed bundle (including CI's
 * `vendor/bundle` configured beside it) is reused.
 */
function jekyllEnv() {
  return { ...childEnv(), BUNDLE_GEMFILE: GEMFILE };
}

/**
 * Runs `bundle exec jekyll build` for one variant and confirms its home page
 * and blog listing exist. `--future` is never passed.
 * @param {{ source: string, destination: string, configs: string[], extra?: string[] }} variant
 */
function jekyllBuild({ source, destination, configs, extra = [] }) {
  const args = [
    "exec",
    "jekyll",
    "build",
    "--source",
    source,
    "--destination",
    destination,
    "--config",
    configs.map((name) => path.join(source, name)).join(","),
    ...extra,
  ];
  run("bundle", args, { cwd: source, env: jekyllEnv() }, DEADLINES.jekyllBuild);
  const missing = BUILD_OUTPUTS.filter((rel) => !fs.existsSync(path.join(destination, ...rel.split("/"))));
  if (missing.length > 0) {
    throw fail(`jekyll build into ${destination} produced no ${missing.join(" and no ")}`, 1);
  }
}

/**
 * The whole run behind `buildFixtureSite`: option checks, pre-flight checks,
 * the claim of `<outDir>`, staging and the three builds. Its errors are
 * normalized by that wrapper.
 * @param {{ outDir?: string, ref?: string | null, fixturesOnly?: boolean }} options
 * @returns {Readonly<{ src: string, project: string, preview: string, empty: string }>}
 */
function stageAndBuild({ outDir, ref, fixturesOnly = false } = {}) {
  if (typeof outDir !== "string" || outDir.trim() === "") throw fail("outDir must be a non-empty path", 2);
  if (ref !== undefined && ref !== null && (typeof ref !== "string" || ref.trim() === "")) {
    throw fail("--ref needs a revision", 2);
  }
  if (typeof fixturesOnly !== "boolean") throw fail("fixturesOnly must be true or false", 2);

  const out = path.resolve(outDir);
  // Jekyll splits --config on commas, so the absolute overlay paths built from <outDir> must hold none.
  if (out.includes(",")) throw fail(`${out} contains a comma, which Jekyll's --config list cannot carry`, 2);
  assertOutsideRepo(out);
  assertEmptyOrAbsent(out);

  const paths = stagedPaths(fixturesOnly);
  let sha = null;
  let revisionPaths = [];
  if (typeof ref === "string") {
    sha = resolveRevision(ref);
    const missing = REQUIRED_PATHS.filter((rel) => !existsAtRevision(sha, rel));
    if (missing.length > 0) throw fail(`revision ${sha} has no ${missing.join(", ")}; it predates the blog`, 1);
    revisionPaths = paths.filter((rel) => existsAtRevision(sha, rel));
  } else {
    const missing = REQUIRED_PATHS.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, ...rel.split("/"))));
    if (missing.length > 0) throw fail(`the working tree has no ${missing.join(", ")}; the blog source is incomplete`, 1);
  }

  const src = path.join(out, "src");
  const projectSrc = path.join(out, "project-src");
  const project = path.join(out, "project", PROJECT_BASEURL.replace(/^\/+/, ""));
  const preview = path.join(out, "preview");
  const emptySrc = path.join(out, "empty-src");
  const empty = path.join(out, "empty");

  // After every pre-flight check, so a refused run leaves no folder; before any write, so a run that loses
  // the claim to a concurrent one shares nothing with it.
  claimOutDir(out, src);

  // 1. Stage the allow-listed site source, which must hold no draft image before anything is added.
  if (sha !== null) {
    log(`staging the site source of ${sha.slice(0, 12)} into ${src}${fixturesOnly ? " (fixtures only)" : ""}`);
    stageRevision(out, src, sha, revisionPaths);
  } else {
    log(`staging the working-tree site source into ${src}${fixturesOnly ? " (fixtures only)" : ""}`);
    stageWorkingTree(src, paths);
  }
  assertNoDraftImages(src);

  // 2. Fixture articles and synthetic private content, in the staging copy only.
  const fixtureCount = stageFixtures(src);
  const futureFile = writeSyntheticContent(src);
  log(`added ${fixtureCount} fixture articles, a synthetic draft with its image and _posts/${futureFile}`);

  // 3. Project overlay: the github.io host for canonical and og:url.
  writeNewFile(src, path.join(src, PROJECT_OVERLAY), `url: "${PROJECT_URL}"\n`);

  // 4. project: the project-path deployment, CNAME removed, base path from the command line.
  log(`building the project variant into ${project}`);
  fs.cpSync(src, projectSrc, { recursive: true });
  fs.rmSync(path.join(projectSrc, "CNAME"), { force: true });
  jekyllBuild({
    source: projectSrc,
    destination: project,
    configs: ["_config.yml", PROJECT_OVERLAY],
    extra: ["--baseurl", PROJECT_BASEURL],
  });

  // 5. preview: drafts and their images, as the author's local preview renders them.
  log(`building the preview variant into ${preview}`);
  jekyllBuild({
    source: src,
    destination: preview,
    configs: ["_config.yml", "_config.preview.yml"],
    extra: ["--drafts"],
  });

  // 6. empty: no _posts/ at all, the launch state.
  log(`building the empty variant into ${empty}`);
  fs.cpSync(src, emptySrc, { recursive: true, filter: (p) => path.relative(src, p) !== POSTS_DIR });
  jekyllBuild({ source: emptySrc, destination: empty, configs: ["_config.yml"] });

  log("fixture sites built:");
  for (const [name, dir] of [
    ["src", src],
    ["project-src", projectSrc],
    ["project", project],
    ["preview", preview],
    ["empty-src", emptySrc],
    ["empty", empty],
  ]) {
    console.log(`  ${name.padEnd(12)} ${dir}`);
  }
  return Object.freeze({ src, project, preview, empty });
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Stages the site source and builds the project, preview and empty variants.
 *
 * @example
 *   const { project } = await buildFixtureSite({ outDir: path.join(os.tmpdir(), "fx") });
 *   // project === "<tmp>/fx/project/cabrillo-coast"; serve "<tmp>/fx/project" for /cabrillo-coast/
 *
 * @param {object} options
 * @param {string} options.outDir Output folder: absent, or an empty folder, outside the repository,
 *   with no comma in its absolute path. Once every check has passed, the run claims it by creating
 *   `<outDir>/src` exclusively; a concurrent run into the same folder is refused.
 * @param {string} [options.ref] Revision to take the site source from; the working tree when omitted.
 * @param {boolean} [options.fixturesOnly=false] Leave the real `_posts/` out of the staged source.
 * @returns {Promise<Readonly<{ src: string, project: string, preview: string, empty: string }>>}
 *   Absolute paths of the staged source and the three built sites (`project` is the site
 *   folder `<outDir>/project/cabrillo-coast`).
 * @throws {Error} with `exitCode` 2 for a usage error, including an `outDir` that is not a folder,
 *   is not empty or was claimed by another run first, with nothing written; 1 for a copy or build
 *   failure.
 */
export async function buildFixtureSite(options = {}) {
  try {
    return stageAndBuild(options ?? {});
  } catch (err) {
    // The one normalization boundary, pre-flight checks included: tagged errors keep their exit code
    // (usage errors stay 2), and anything else (EACCES, EIO, ELOOP, …) is a copy or build failure.
    if (err && typeof err.exitCode === "number") throw err;
    throw fail(`fixture build failed: ${err && err.message ? err.message : String(err)}`, 1);
  }
}

/* ------------------------------------------------------------------------ */
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

/** Help text; the paths, base path and deadlines come from the constants the run uses, so they cannot drift. */
function helpText() {
  const project = `project/${PROJECT_BASEURL.replace(/^\/+/, "")}/`;
  return [
    USAGE,
    "",
    "Stages an allow-listed copy of the site source with the fixture articles and synthetic private",
    "content, and builds the project, preview and empty variants of the blog from it.",
    "",
    "Arguments:",
    "  <outDir>         Output folder, relative to the current directory: absent or an empty folder,",
    "                   outside the repository, with no comma in its absolute path (Jekyll splits",
    "                   --config on commas). Once every check has passed, the run claims it by",
    "                   creating <outDir>/src exclusively, so a second run into the same folder is",
    "                   refused.",
    "",
    "Options:",
    "  --ref <rev>      Take the site source from that commit with git archive instead of the",
    "                   working tree; the fixture articles always come from the working tree. A",
    `                   revision that lacks ${REQUIRED_PATHS.slice(0, -1).join(", ")} or ${REQUIRED_PATHS.at(-1)}`,
    "                   predates the blog (exit 1); one that names no commit or starts with '-' is",
    "                   refused (exit 2).",
    "  --fixtures-only  Leave the repository's real _posts/ out, so only the fixture articles are built.",
    "  -h, --help       Show this help.",
    "",
    "Output under <outDir>:",
    "  src/                     Staged source: the allow-listed site files, the fixture posts, a",
    "                           synthetic draft and its image, a post dated one year ahead and",
    `                           ${PROJECT_OVERLAY}; never a real draft or draft image.`,
    "  project-src/             src/ without CNAME (project-path deployment).",
    `  ${project.padEnd(24)} Build of project-src/ at base path ${PROJECT_BASEURL}, with url`,
    `                           ${PROJECT_URL}.`,
    "  preview/                 --drafts build of src/ with _config.preview.yml: empty base path,",
    "                           CNAME kept.",
    "  empty-src/               src/ without _posts/.",
    "  empty/                   Zero-article build (launch state).",
    "",
    "Environment:",
    "  JEKYLL_ENV is removed from every git, tar and Jekyll child: a local production build derives",
    "  the wrong base path, so the project base path is passed with --baseurl instead. Each build runs",
    "  bundle exec jekyll build with BUNDLE_GEMFILE set to the repository Gemfile. bundle must be on",
    "  PATH, and git and tar as well for --ref.",
    "",
    `Deadlines: each Jekyll build ${formatDuration(DEADLINES.jekyllBuild)}, git archive ${formatDuration(DEADLINES.gitArchive)}, ` +
      `tar extraction ${formatDuration(DEADLINES.tarExtract)}, each git query ${formatDuration(DEADLINES.gitQuery)}.`,
    "A child past its deadline is killed and the run exits 1.",
    "",
    "Exit status: 0 when all three variants are built; 1 for a copy, staging or build failure,",
    "including a git, tar or Jekyll run that failed, was killed, exceeded its deadline or could not",
    "be started; 2 for a usage error, including a --ref that names no commit and an <outDir> that is",
    "inside the repository, holds a comma, is not a folder, is not empty or was claimed by another",
    "run first. A run refused with 2 writes nothing. On failure <outDir> is left in place for",
    "inspection; its owner removes it.",
    "",
    "Examples:",
    '  node tests/fixtures/build-fixture-site.mjs "$(mktemp -d)"',
    '  node tests/fixtures/build-fixture-site.mjs "$(mktemp -d)" --ref origin/main --fixtures-only',
  ].join("\n");
}

/**
 * Parses the command line and runs the builder.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<number>} The exit code.
 */
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        ref: { type: "string" },
        "fixtures-only": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(helpText());
    return 0;
  }
  if (positionals.length !== 1) {
    console.error(`${LOG_PREFIX} ${positionals.length === 0 ? "missing <outDir>" : "expected exactly one <outDir>"}`);
    console.error(USAGE);
    return 2;
  }

  try {
    await buildFixtureSite({
      // The argument is relative to the caller's directory: the only use of the working directory.
      outDir: path.resolve(positionals[0]),
      ref: values.ref,
      fixturesOnly: values["fixtures-only"] === true,
    });
    return 0;
  } catch (err) {
    // Expected failures carry an exit code and a complete message; anything else is a defect, shown with its stack.
    const expected = err && typeof err.exitCode === "number";
    console.error(`${LOG_PREFIX} ${expected ? err.message : (err && err.stack) || String(err)}`);
    if (expected && err.exitCode === 2) console.error(USAGE);
    return expected ? err.exitCode : 1;
  }
}

/**
 * True when this file is the program Node was started with. Node resolves the
 * main module to its real path, so `argv[1]` is compared after `realpathSync`.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // process.exitCode rather than process.exit(), so buffered output is flushed.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
