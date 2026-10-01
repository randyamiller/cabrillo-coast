#!/usr/bin/env node
/* Cabrillo Coast LLC — fixture site builder for the blog checks (Node built-ins only) */
/**
 * Builds the blog from a staged copy of the site source plus the fixture
 * articles and synthetic private content, in the three variants that the
 * built-output suites, the visual comparison and the browser acceptance pass
 * read.
 *
 *   node tests/fixtures/build-fixture-site.mjs <outDir> [--ref <rev>] [--fixtures-only]
 *
 *   <outDir>         Output folder. It must not exist yet or be empty, and it
 *                    must lie outside the repository (see `assertOutsideRepo`).
 *   --ref <rev>      Take the site source from that commit (`git archive`)
 *                    instead of the working tree. The fixture articles always
 *                    come from the working tree, so both sides of the visual
 *                    comparison hold the same articles.
 *   --fixtures-only  Leave the repository's real `_posts/` out, so only the
 *                    fixture articles are built (the visual comparison uses
 *                    this, so publishing an article cannot change a screenshot).
 *
 * Consumers:
 *   - `scripts/verify.mjs` builds `<tmp>` and re-runs the `built-*` suites with
 *     `SITE_DIR=<tmp>/project/cabrillo-coast`, `SITE_BASEURL=/cabrillo-coast`,
 *     `SITE_URL=https://randyamiller.github.io` and `FIXTURE_DIR=<tmp>`;
 *   - `tests/static/built-pages.test.mjs` and `built-search-index.test.mjs`
 *     import the constants below and read `preview/`, `empty/` and `src/`;
 *   - `tests/visual/run-visual.mjs` calls `buildFixtureSite` for the base
 *     revision and the working tree and serves `<outDir>/project/`.
 *
 * Output layout under <outDir>:
 *   src/                     Staged source: the allow-listed site files, the
 *                            fixture posts, a synthetic draft and its image, a
 *                            post dated one year ahead and `_config.project.yml`.
 *                            Complete and servable for the browser acceptance
 *                            pass (`jekyll serve --source <outDir>/src --drafts …`).
 *   project-src/             `src/` without `CNAME` (project-path deployment).
 *   project/cabrillo-coast/  Build of `project-src/` at base path /cabrillo-coast
 *                            with `url` set to the github.io host.
 *   preview/                 `--drafts` build of `src/` with `_config.preview.yml`,
 *                            empty base path, `CNAME` kept.
 *   empty-src/               `src/` without `_posts/`.
 *   empty/                   Zero-article build (launch state).
 *
 * Exit codes: 0 when all three variants are built, 1 for a copy or build
 * failure, 2 for a usage error. On failure `<outDir>` is left in place for
 * inspection; its owner removes it.
 *
 * Nothing here is published: `_config.yml` excludes `tests/`, and the
 * synthetic draft, its image and the future-dated post are written only into
 * `<outDir>`, never into the repository. Every Jekyll build runs with
 * `JEKYLL_ENV` removed: a local production build derives the wrong base path
 * (`/pages/randyamiller/cabrillo-coast`), so the project base path is passed
 * with `--baseurl` in place of the Pages API.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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
 * The fixture articles every build must contain. `file` is the basename
 * inside `tests/fixtures/posts/`; `slug` is the URL segment under `/blog/`.
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

/** Prints one progress line. */
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
 * passed as an array and never through a shell.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @throws {Error} exit code 1 when the command cannot start or exits non-zero.
 */
function run(cmd, args, options = {}) {
  console.log(`$ ${[cmd, ...args].join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.error) throw fail(spawnErrorMessage(cmd, result.error), 1);
  if (result.status !== 0) {
    const how = result.signal ? `was killed by ${result.signal}` : `exited with status ${result.status}`;
    throw fail(`${cmd} ${how}: ${[cmd, ...args].join(" ")}`, 1);
  }
}

/**
 * Runs a command whose output is parsed, capturing stdout and stderr.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 * @throws {Error} exit code 1 when the command cannot start.
 */
function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw fail(spawnErrorMessage(cmd, result.error), 1);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Read-only git plumbing in the repository. */
function git(args) {
  return capture("git", args, { cwd: REPO_ROOT });
}

/** True when `p` exists and is a directory. */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
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
 * Refuses an output folder inside the repository. Beyond the plan's
 * contract, deliberately: a nested output would be copied into the real
 * `_site` by `bundle exec jekyll build` (its name is not in `exclude`) and
 * offered to `git add -A`, carrying the synthetic draft and Gemfile copies
 * with it. Every consumer passes a folder under `os.tmpdir()`.
 */
function assertOutsideRepo(outDir) {
  if (isWithin(canonicalPath(outDir), canonicalPath(REPO_ROOT))) {
    throw fail(`${outDir} is inside the repository; use a folder outside it, such as one under the system temp directory`, 2);
  }
}

/** Refuses an output folder that is a file or already has entries. */
function assertEmptyOrAbsent(outDir) {
  let stat;
  try {
    stat = fs.statSync(outDir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw fail(`cannot inspect ${outDir}: ${err.message}`, 1);
  }
  if (!stat.isDirectory() || fs.readdirSync(outDir).length > 0) {
    throw fail(`${outDir} exists and is not empty`, 2);
  }
}

/**
 * Resolves `--ref` to a commit id. Values starting with `-` are refused
 * before git sees them, so a revision can never be read as a git option.
 * @returns {string} the full commit id.
 */
function resolveRevision(ref) {
  if (ref.startsWith("-")) throw fail(`cannot resolve --ref ${ref}`, 2);
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || sha === "") throw fail(`cannot resolve --ref ${ref}`, 2);
  return sha;
}

/** True when `relativePath` (file or folder) exists at commit `sha`. */
function existsAtRevision(sha, relativePath) {
  return git(["cat-file", "-e", `${sha}:${relativePath}`]).status === 0;
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
 * `CNAME`, …) are skipped.
 */
function stageWorkingTree(srcDir, paths) {
  for (const rel of paths) {
    const from = path.join(REPO_ROOT, ...rel.split("/"));
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(srcDir, ...rel.split("/")), { recursive: true, filter: keepInStage });
  }
}

/**
 * Extracts the allow-listed paths that exist at commit `sha` with
 * `git archive`, then removes any `assets/drafts/` the revision carries.
 */
function stageRevision(outDir, srcDir, sha, paths) {
  const tarPath = path.join(outDir, "ref.tar");
  try {
    run("git", ["archive", "--format=tar", "-o", tarPath, sha, "--", ...paths], { cwd: REPO_ROOT });
    run("tar", ["-xf", tarPath, "-C", srcDir]);
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
  fs.rmSync(path.join(srcDir, ...DRAFT_IMAGES_DIR.split("/")), { recursive: true, force: true });
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
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_POSTS_DIR, ...rel.split("/")), dest, fs.constants.COPYFILE_EXCL);
  }
  return fixtures.length;
}

/** Writes a new UTF-8 file, refusing to overwrite one. */
function writeNewFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
  writeNewFile(path.join(srcDir, "_drafts", `${DRAFT_SLUG}.md`), draft);
  writeNewFile(path.join(srcDir, ...DRAFT_IMAGE.split("/")), DRAFT_IMAGE_SVG);

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
  writeNewFile(path.join(srcDir, POSTS_DIR, futureFile), future);
  return futureFile;
}

/* ------------------------------------------------------------------------ */
/* Builds                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Environment for every Jekyll build: the caller's, minus `JEKYLL_ENV`, plus
 * `BUNDLE_GEMFILE` naming the repository Gemfile so the installed bundle
 * (including CI's `vendor/bundle` configured beside it) is reused.
 */
function jekyllEnv() {
  const env = { ...process.env };
  delete env.JEKYLL_ENV;
  env.BUNDLE_GEMFILE = GEMFILE;
  return env;
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
  run("bundle", args, { cwd: source, env: jekyllEnv() });
  const missing = BUILD_OUTPUTS.filter((rel) => !fs.existsSync(path.join(destination, ...rel.split("/"))));
  if (missing.length > 0) {
    throw fail(`jekyll build into ${destination} produced no ${missing.join(" and no ")}`, 1);
  }
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
 * @param {string} options.outDir Output folder: absent, or an empty folder, outside the repository.
 * @param {string} [options.ref] Revision to take the site source from; the working tree when omitted.
 * @param {boolean} [options.fixturesOnly=false] Leave the real `_posts/` out of the staged source.
 * @returns {Promise<Readonly<{ src: string, project: string, preview: string, empty: string }>>}
 *   Absolute paths of the staged source and the three built sites (`project` is the site
 *   folder `<outDir>/project/cabrillo-coast`).
 * @throws {Error} with `exitCode` 2 for a usage error, 1 for a copy or build failure.
 */
export async function buildFixtureSite({ outDir, ref, fixturesOnly = false } = {}) {
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

  try {
    fs.mkdirSync(src, { recursive: true });

    // 1. Stage the allow-listed site source.
    if (sha !== null) {
      log(`staging the site source of ${sha.slice(0, 12)} into ${src}${fixturesOnly ? " (fixtures only)" : ""}`);
      stageRevision(out, src, sha, revisionPaths);
    } else {
      log(`staging the working-tree site source into ${src}${fixturesOnly ? " (fixtures only)" : ""}`);
      stageWorkingTree(src, paths);
    }

    // 2. Fixture articles and synthetic private content, in the staging copy only.
    const fixtureCount = stageFixtures(src);
    const futureFile = writeSyntheticContent(src);
    log(`added ${fixtureCount} fixture articles, a synthetic draft with its image and _posts/${futureFile}`);

    // 3. Project overlay: the github.io host for canonical and og:url.
    writeNewFile(path.join(src, PROJECT_OVERLAY), `url: "${PROJECT_URL}"\n`);

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
  } catch (err) {
    if (err && typeof err.exitCode === "number") throw err;
    throw fail(`fixture build failed: ${err && err.message ? err.message : String(err)}`, 1);
  }

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
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

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
    console.log(USAGE);
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

