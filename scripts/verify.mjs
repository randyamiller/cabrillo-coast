#!/usr/bin/env node
/* Cabrillo Coast LLC — verification entry point (Node built-ins and relative modules only) */
/**
 * Runs every automated blog check in one fixed order and stops at the first
 * failure. Authors run it before pushing, and the blog-checks workflow runs
 * the same script, so a local pass means what a CI pass means.
 *
 *   node scripts/verify.mjs [--base <ref>] [--keep-fixtures]
 *
 * After a Playwright Chromium preflight, which fails rather than skips, the
 * steps run from the repository root with inherited output:
 *   1. bundle exec jekyll build: the real site into `_site/`.
 *   2. node --test "tests/**\/*.test.mjs": every suite, SITE_URL from `_config.yml`'s url.
 *   3. node tests/fixtures/build-fixture-site.mjs <tmp>: the fixture builds.
 *   4. node --test "tests/static/built-*.test.mjs": the built-output suites on the project fixture.
 *   5. node tests/visual/run-visual.mjs --base <ref>: the visual comparison, against
 *      `--base`, else `@{upstream}`, else `HEAD`.
 *
 * Environment: JEKYLL_ENV and the caller's SITE_DIR, SITE_BASEURL, SITE_URL
 * and FIXTURE_DIR reach no child (git queries, the browser preflight and all
 * five steps); everything else, VISUAL_CHANGE_INTENDED included, is kept.
 * JEKYLL_ENV is removed because a local production build without a Pages API
 * token derives the wrong base path (/pages/randyamiller/cabrillo-coast).
 *
 * Exit status: 0 when every step passed; otherwise the first failing step's
 * status (1 when it was killed, exceeded its deadline or could not start);
 * 1 when `_config.yml` names no usable url, the browser preflight fails, a
 * git query gives no answer, the fixture folder cannot be created, or every
 * step passed but that folder cannot be removed; 2 for a usage error or a
 * base that does not resolve. The fixture folder (`cabrillo-verify-*` under
 * `os.tmpdir()`) is removed whatever the outcome, unless `--keep-fixtures`
 * keeps it after a failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { preflightPlaywright } from "../tests/visual/lib/preflight.mjs";
import { DEADLINES, describeResult, formatDuration, runSync } from "./lib/subprocess.mjs";

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Repository root, from this file's location, so the script works from any directory. */
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const USAGE = "Usage: node scripts/verify.mjs [--base <ref>] [--keep-fixtures]";
const LOG_PREFIX = "verify:";

/** Removed from every child's environment; the reason is printed when one was set. */
const JEKYLL_ENV = "JEKYLL_ENV";

/**
 * Read by the built-output suites; removed so no caller's value reaches a
 * step. Step 2 sets SITE_URL from `_config.yml`, and step 4 sets all four.
 */
const SUITE_VARIABLES = Object.freeze(["SITE_DIR", "SITE_BASEURL", "SITE_URL", "FIXTURE_DIR"]);

/*
 * Project-path deployment reproduced by the fixture builder's `project`
 * variant. These equal `PROJECT_BASEURL` and `PROJECT_URL` in
 * tests/fixtures/build-fixture-site.mjs; they are restated rather than
 * imported because this entry point never imports the fixture builder it
 * runs as step 3. A mismatch fails step 4, whose canonical-link checks
 * compare against them.
 */
const PROJECT_BASEURL = "/cabrillo-coast";
const PROJECT_URL = "https://randyamiller.github.io";

/** Prefix of the temporary fixture folder created before step 3. */
const FIXTURE_PREFIX = "cabrillo-verify-";

/** Jekyll configuration whose top-level `url` names the real site's deployment host. */
const CONFIG_FILE = "_config.yml";

/** The top-level `url:` key at column 0, followed by whitespace or the end of the line. */
const URL_KEY = /^url:(?=\s|$)(.*)$/;

/** A full commit id: SHA-1 (40) or SHA-256 (64) hexadecimal digits. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Characters that never need shell quoting in a printed command. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const BUNDLE_MISSING = "bundle not found — install Ruby 3.3.4 and run bundle install";

/**
 * @typedef {object} StepContext
 * @property {string} base        Base revision passed to the visual comparison.
 * @property {string} fixtureDir  Temporary fixture folder ("" until step 3 creates it).
 * @property {string} siteUrl     Deployment host from `_config.yml`'s `url`, step 2's SITE_URL.
 */

/**
 * @typedef {object} Step
 * @property {"bundle" | "node"} program  Shown in logs; `node` runs as `Io.execPath` (`process.execPath`).
 * @property {(ctx: StepContext) => string[]} args
 * @property {(ctx: StepContext) => Record<string, string>} [env]  Variables added to the base environment.
 * @property {number} deadlineMs  How long the step may run, from `DEADLINES`.
 * @property {boolean} [createsFixture]  The fixture folder is created just before this step.
 */

/**
 * What the run reads and starts processes through: the real process for the
 * command line, fakes in tests/unit/verify.test.mjs.
 * @typedef {object} Io
 * @property {NodeJS.ProcessEnv} env  The sanitized child environment (`buildBaseEnv`), never the caller's.
 * @property {string} root  Repository root: where git and every step run.
 * @property {typeof runSync} run  Runs one child process to its end and returns its `ProcessResult`.
 * @property {string} execPath  The Node executable that `node` steps run as.
 */

/**
 * The five steps, in their only order. Steps are never added, dropped,
 * reordered or skipped here; skip rules belong to the step that owns them.
 * Glob patterns are plain arguments: `node --test` expands them itself, and
 * no step runs through a shell. Each deadline is the one `DEADLINES` gives
 * that kind of run, so it covers every deadline the step applies inside.
 * @type {ReadonlyArray<Step>}
 */
const STEPS = Object.freeze([
  { program: "bundle", args: () => ["exec", "jekyll", "build"], deadlineMs: DEADLINES.jekyllBuild },
  {
    program: "node",
    args: () => ["--test", "tests/**/*.test.mjs"],
    env: (ctx) => ({ SITE_URL: ctx.siteUrl }),
    deadlineMs: DEADLINES.testRun,
  },
  {
    program: "node",
    args: (ctx) => ["tests/fixtures/build-fixture-site.mjs", ctx.fixtureDir],
    deadlineMs: DEADLINES.fixtureBuild,
    createsFixture: true,
  },
  {
    program: "node",
    args: () => ["--test", "tests/static/built-*.test.mjs"],
    deadlineMs: DEADLINES.testRun,
    env: (ctx) => ({
      SITE_DIR: path.join(ctx.fixtureDir, "project", "cabrillo-coast"),
      SITE_BASEURL: PROJECT_BASEURL,
      SITE_URL: PROJECT_URL,
      FIXTURE_DIR: ctx.fixtureDir,
    }),
  },
  {
    program: "node",
    args: (ctx) => ["tests/visual/run-visual.mjs", "--base", ctx.base],
    deadlineMs: DEADLINES.visualRun,
  },
]);

/* ------------------------------------------------------------------------ */
/* Output helpers                                                            */
/* ------------------------------------------------------------------------ */

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message) {
  console.error(`${LOG_PREFIX} ${message}`);
}

/** Message of a thrown value, whatever its type. */
function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/** One argument as a POSIX shell would need it, so printed commands can be pasted. */
function shellQuote(arg) {
  return SHELL_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The command line of a step as a log line: added variables first, then the
 * program and its arguments, quoted for a POSIX shell.
 * @param {Step} step
 * @param {StepContext} ctx
 * @param {(arg: string) => string} [quote]
 */
function describeStep(step, ctx, quote = shellQuote) {
  const added = step.env ? Object.entries(step.env(ctx)).map(([name, value]) => `${name}=${quote(value)}`) : [];
  return [...added, step.program, ...step.args(ctx).map(quote)].join(" ");
}

function elapsed(started) {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

/** Help text; the step list comes from `STEPS`, so it cannot drift from what runs. */
function helpText() {
  const placeholders = { base: "<ref>", fixtureDir: "<tmp>", siteUrl: `<${CONFIG_FILE} url>` };
  const lines = STEPS.map((step, i) => `  ${i + 1}. ${describeStep(step, placeholders, (arg) => arg)}`);
  return [
    USAGE,
    "",
    "Runs every blog check from the repository root and stops at the first failure:",
    ...lines,
    "",
    "Options:",
    "  --base <ref>     Base revision for the visual comparison (step 5), passed on unchanged.",
    "                   Default: @{upstream} (what is already pushed), or HEAD without one.",
    "  --keep-fixtures  After a failure, keep the fixture builds (step 3) for inspection.",
    "  -h, --help       Show this help.",
    "",
    "Environment:",
    "  VISUAL_CHANGE_INTENDED=1  Passed to step 5: declared visual differences are reported, not failed.",
    `  ${JEKYLL_ENV}, ${SUITE_VARIABLES.join(", ")} are removed from git, the browser preflight and every step.`,
    "",
    `Deadlines: steps 1-${STEPS.length} may run ${STEPS.map((step) => formatDuration(step.deadlineMs)).join(", ")};`,
    `each git query ${formatDuration(DEADLINES.gitQuery)}. A step past its deadline is killed and fails.`,
    "",
    "Exit status: 0 when every check passed and the fixture folder was removed; otherwise the",
    "failing step's status (1 when it was killed, exceeded its deadline or could not start); 1 when",
    "_config.yml names no http or https url, Playwright Chromium is missing, cannot start or could",
    "not be closed, a git query was killed or timed out, or every step passed but the fixture folder",
    "cannot be removed; 2 for a usage error or a base revision that does not resolve. The fixture",
    "folder is removed whatever the outcome, unless --keep-fixtures keeps it after a failure.",
  ].join("\n");
}

/* ------------------------------------------------------------------------ */
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Parses the arguments after the script path. `--base=<ref>` is accepted as
 * well, matching tests/visual/run-visual.mjs. A value starting with `-` is a
 * missing value, never a revision, so an option can never be read as a base.
 * `--keep-fixtures` takes no value.
 * @param {string[]} argv
 * @returns {{ help: boolean, keepFixtures: boolean, base?: string, error?: string }}
 */
export function parseCliArgs(argv) {
  const parsed = { help: false, keepFixtures: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--keep-fixtures") {
      parsed.keepFixtures = true;
      continue;
    }
    let value;
    if (arg === "--base") {
      const next = argv[i + 1];
      value = next === undefined || next.startsWith("-") ? "" : next;
      if (value !== "") i += 1;
    } else if (arg.startsWith("--base=")) {
      value = arg.slice("--base=".length);
    } else {
      return { ...parsed, error: `unknown argument ${arg}` };
    }
    if (value.trim() === "") return { ...parsed, error: "--base needs a revision" };
    // Two different bases cannot both be what the caller meant.
    if (parsed.base !== undefined) return { ...parsed, error: "--base given more than once" };
    parsed.base = value;
  }
  return parsed;
}

/* ------------------------------------------------------------------------ */
/* Base revision                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Read-only git command in the repository, with captured output and the
 * `DEADLINES.gitQuery` deadline. Arguments are an array and never pass
 * through a shell; `GIT_OPTIONAL_LOCKS=0` keeps git from writing even an
 * opportunistic index refresh.
 * @param {Io} io
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }} the outcome
 *   of a git that exited by itself, zero or not.
 * @throws {Error} when git cannot be started, is killed by a signal, exceeds
 *   its deadline or overflows its capture limit: none of these is an answer.
 */
function git(io, args) {
  const result = io.run("git", args, {
    cwd: io.root,
    env: { ...io.env, GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: DEADLINES.gitQuery,
  });
  if (result.error) {
    const reason = result.error.code === "ENOENT" ? "git not found on PATH — install Git" : errorMessage(result.error);
    throw new Error(`git could not be started: ${reason}`);
  }
  if (!result.completed) {
    const stderr = result.stderr.trim();
    throw new Error(`git ${args.join(" ")} ${describeResult(result)}${stderr === "" ? "" : `: ${stderr}`}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Full commit id of a revision, or null when git answered that it does not
 * name a commit. A value starting with `-` is refused before git sees it.
 * @param {Io} io
 * @param {string} ref
 * @returns {string | null}
 * @throws {Error} when git gives no answer (see `git`).
 */
function resolveCommit(io, ref) {
  if (ref.startsWith("-")) return null;
  const result = git(io, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.status === 0 && COMMIT_ID.test(sha) ? sha : null;
}

/**
 * The base revision for step 5 and the line that reports it.
 *   - An explicit `--base` is passed on unchanged, after checking it resolves.
 *   - Otherwise `@{upstream}` when the branch has one, else `HEAD`, pinned to
 *     the commit id resolved now.
 * The fallback to `HEAD` and the "does not resolve" error both rest on git's
 * own answer. A git query that was killed or timed out throws instead, so a
 * probe that never finished cannot make the run compare unpushed changes
 * against themselves, or report a valid `--base` as mistyped.
 * @param {Io} io
 * @param {string | undefined} explicit
 * @returns {{ ref: string, label: string } | { error: string }}
 * @throws {Error} when a git query gives no answer; `main` exits 1.
 */
function chooseBase(io, explicit) {
  if (explicit !== undefined) {
    const sha = resolveCommit(io, explicit);
    if (sha === null) return { error: `base revision "${explicit}" does not resolve to a commit` };
    return { ref: explicit, label: `${explicit} (${sha.slice(0, 7)})` };
  }
  const upstream = resolveCommit(io, "@{upstream}");
  if (upstream !== null) return { ref: upstream, label: `@{upstream} (${upstream.slice(0, 7)})` };
  const head = resolveCommit(io, "HEAD");
  if (head === null) return { error: "HEAD does not resolve to a commit; commit something or pass --base <ref>" };
  return { ref: head, label: `HEAD (${head.slice(0, 7)}, no upstream)` };
}

/* ------------------------------------------------------------------------ */
/* Environment                                                               */
/* ------------------------------------------------------------------------ */

/**
 * The environment every child starts from (git queries, the browser preflight
 * and every step): a copy of the caller's, minus `JEKYLL_ENV` and the
 * built-output suites' variables. Everything else, including
 * `VISUAL_CHANGE_INTENDED`, is kept.
 * @param {NodeJS.ProcessEnv} source
 * @returns {{ env: NodeJS.ProcessEnv, removed: Array<[string, string]> }}
 */
export function buildBaseEnv(source) {
  const env = { ...source };
  const removed = [];
  for (const name of [JEKYLL_ENV, ...SUITE_VARIABLES]) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      removed.push([name, String(env[name])]);
      delete env[name];
    }
  }
  return { env, removed };
}

/** Prints why each removed variable was ignored. */
function reportRemoved(removed) {
  for (const [name, value] of removed) {
    if (name === JEKYLL_ENV) {
      log(
        `notice: ${name}=${value} is ignored — a local production build without a Pages API token ` +
          "derives the wrong base path (/pages/randyamiller/cabrillo-coast)",
      );
    } else {
      log(
        `notice: ${name}=${value} is ignored — steps 1 and 2 test _site as ${CONFIG_FILE} configures it ` +
          `(step 2 sets SITE_URL from its url); step 4 sets its own`,
      );
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Deployment host                                                           */
/* ------------------------------------------------------------------------ */

/**
 * One YAML scalar, read as tests/static/blog-content.test.mjs reads it: a
 * double-quoted string loses its quotes and backslash escapes, a
 * single-quoted one its quotes with `''` read as `'` (a comment after the
 * closing quote is dropped either way), and a plain value loses any trailing
 * ` # comment`.
 * @param {string} raw
 * @returns {string}
 */
export function yamlScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m) return m[1].replace(/\\(.)/g, "$1");
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(text);
    if (m) return m[1].replace(/''/g, "'");
  }
  // The comment starts at the first `#` that follows whitespace and has no line
  // break after it. One forward pass finds it, so a long whitespace run costs
  // linear time however the value ends.
  let cut = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") cut = -1;
    else if (cut === -1 && i > 0 && ch === "#" && /\s/.test(text[i - 1])) cut = i;
  }
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * The deployment host named by the top-level `url` of `_config.yml`, which
 * step 2 passes to the built-output suites as SITE_URL, so the real `_site/`
 * is checked on the host its canonical links name: the custom domain while
 * `CNAME` exists, the github.io host once the site moves to the project path.
 * Read without a YAML library, like the configuration checks in
 * tests/static/blog-content.test.mjs: only a `url:` key at column 0 counts,
 * and when it is written twice the last value wins, as in Ruby's YAML parser.
 * @param {string} text Contents of `_config.yml`.
 * @returns {{ url: string } | { error: string }}
 */
export function configuredSiteUrl(text) {
  let raw;
  for (const line of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = URL_KEY.exec(line);
    if (match) raw = match[1];
  }
  const url = raw === undefined ? "" : yamlScalar(raw);
  if (url === "") return { error: `${CONFIG_FILE} sets no url` };
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return { error: `${CONFIG_FILE} url "${url}" is not an http or https URL` };
  }
  return { url };
}

/* ------------------------------------------------------------------------ */
/* Steps                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Runs one step from the repository root with inherited output and reports
 * its outcome as an exit code: the child's own non-zero status, or 1 when it
 * was killed by a signal, exceeded its deadline or could not be started.
 *
 * The step runs synchronously (`spawnSync` through `runSync`) under its
 * deadline and is killed with SIGKILL when the deadline expires: a blocked
 * caller cannot escalate later, and a step that handled a gentler signal
 * could otherwise keep the run from ending. The tools a step runs carry
 * shorter deadlines of their own, so they are normally stopped, and the step
 * fails, long before this one expires.
 * @param {Io} io
 * @param {Step} step
 * @param {number} number 1-based step number.
 * @param {StepContext} ctx
 * @returns {number} 0 when the step passed.
 */
function runStep(io, step, number, ctx) {
  const command = describeStep(step, ctx);
  console.log(`\n==> [${number}/${STEPS.length}] ${command}`);

  const executable = step.program === "node" ? io.execPath : step.program;
  const env = { ...io.env, ...(step.env ? step.env(ctx) : {}) };
  const started = Date.now();
  const result = io.run(executable, step.args(ctx), {
    cwd: io.root,
    stdio: "inherit",
    env,
    timeoutMs: step.deadlineMs,
  });

  let code = 0;
  if (result.error) {
    const hint =
      result.error.code === "ENOENT" && step.program === "bundle"
        ? BUNDLE_MISSING
        : `${step.program} could not be started: ${errorMessage(result.error)}`;
    warn(hint);
    code = 1;
  } else if (result.timedOut) {
    warn(`step ${number} exceeded its ${formatDuration(step.deadlineMs)} deadline: ${step.program} ${describeResult(result)}`);
    code = 1;
  } else if (result.signal) {
    warn(`${step.program} was killed by ${result.signal}`);
    code = 1;
  } else if (result.status !== 0) {
    code = typeof result.status === "number" ? result.status : 1;
  }

  if (code === 0) {
    console.log(`--> [${number}/${STEPS.length}] passed in ${elapsed(started)}`);
    return 0;
  }
  warn(`step ${number} failed (${command})`);
  return code;
}

/**
 * Disposes of the fixture folder once the steps are over, whatever their
 * outcome: it is removed, unless `--keep-fixtures` keeps it after a failure.
 * @param {string} dir
 * @param {{ failed: boolean, keep: boolean, remove: (dir: string) => void }} options
 *   `failed` covers a failing step and a thrown exception alike.
 * @returns {boolean} false only when every step passed but the folder could not be removed.
 */
function disposeFixtures(dir, { failed, keep, remove }) {
  if (failed && keep) {
    warn(`fixture builds kept for inspection in ${dir}`);
    return true;
  }
  try {
    remove(dir);
  } catch (err) {
    // Exit 0 promises that nothing is left behind, so after a pass a folder
    // that cannot be removed fails the run; after a failure the step's status stands.
    const subject = failed ? "the fixture folder" : "every step passed, but the fixture folder";
    warn(`${subject} ${dir} could not be removed: ${errorMessage(err)}; remove it by hand`);
    return failed;
  }
  if (failed) warn("fixture builds removed; run again with --keep-fixtures to keep them for inspection");
  return true;
}

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The whole verification. The command line passes no collaborators, so the
 * real environment, repository, processes and browser are used;
 * tests/unit/verify.test.mjs passes fakes to observe each step without
 * running it.
 * @param {string[]} argv Arguments after the script path.
 * @param {object} [collaborators]
 * @param {NodeJS.ProcessEnv} [collaborators.env]  Caller's environment; `process.env` by default.
 * @param {string} [collaborators.root]  Repository root; this checkout by default.
 * @param {typeof runSync} [collaborators.run]  Runs git and every step; `runSync` by default.
 * @param {(options: { env: NodeJS.ProcessEnv, report: (message: string) => void }) => Promise<string | null>}
 *   [collaborators.preflight]  Browser check, given the sanitized environment and a notice printer;
 *   `preflightPlaywright` by default.
 * @param {string} [collaborators.tmpdir]  Parent of the fixture folder; `os.tmpdir()` by default.
 * @param {string} [collaborators.execPath]  Node executable of `node` steps; `process.execPath` by default.
 * @param {(dir: string) => void} [collaborators.remove]  Removes the fixture folder; a recursive,
 *   forced `fs.rmSync` by default.
 * @returns {Promise<number>} The exit code.
 * @throws {*} whatever a collaborator throws, once the fixture folder has been disposed of.
 */
export async function main(argv, collaborators = {}) {
  const {
    env = process.env,
    root = ROOT,
    run = runSync,
    preflight = preflightPlaywright,
    tmpdir = os.tmpdir(),
    execPath = process.execPath,
    remove = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  } = collaborators;

  const args = parseCliArgs(argv);
  if (args.error !== undefined) {
    warn(args.error);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }

  // Sanitized before any child starts, so git, the browser preflight and every step get the same environment.
  const { env: baseEnv, removed } = buildBaseEnv(env);
  /** @type {Io} */
  const io = { env: baseEnv, root, run, execPath };

  // Base revision, checked now so a bad value fails before the slow steps.
  let base;
  try {
    base = chooseBase(io, args.base);
  } catch (err) {
    warn(errorMessage(err));
    return 1;
  }
  if ("error" in base) {
    warn(base.error);
    console.error(USAGE);
    return 2;
  }
  log(`repository: ${root}`);
  log(`base: ${base.label}`);

  reportRemoved(removed);
  if (baseEnv.VISUAL_CHANGE_INTENDED !== undefined) {
    log(`VISUAL_CHANGE_INTENDED=${baseEnv.VISUAL_CHANGE_INTENDED} is passed to step 5`);
  }

  // Deployment host of the real site, read before any step so a bad value costs no build time.
  const configPath = path.join(root, CONFIG_FILE);
  let configText;
  try {
    configText = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    warn(`cannot read ${configPath}: ${errorMessage(err)}`);
    return 1;
  }
  const site = configuredSiteUrl(configText);
  if ("error" in site) {
    warn(`cannot set step 2's SITE_URL: ${site.error}`);
    return 1;
  }
  log(`deployment host: ${site.url} (${CONFIG_FILE} url, step 2 SITE_URL)`);

  // Playwright Chromium preflight: a failure, never a skip.
  const missing = await preflight({ env: io.env, report: warn });
  if (missing !== null) {
    warn(missing);
    return 1;
  }

  /** @type {StepContext} */
  const ctx = { base: base.ref, fixtureDir: "", siteUrl: site.url };
  let code = 0;
  let finished = false;
  try {
    for (let i = 0; i < STEPS.length; i += 1) {
      const step = STEPS[i];
      if (step.createsFixture) {
        try {
          ctx.fixtureDir = fs.mkdtempSync(path.join(tmpdir, FIXTURE_PREFIX));
        } catch (err) {
          warn(`cannot create the fixture folder under ${tmpdir}: ${errorMessage(err)}`);
          code = 1;
          break;
        }
      }
      code = runStep(io, step, i + 1, ctx);
      if (code !== 0) break;
    }
    finished = true;
  } finally {
    // Runs on a pass, a failed step and a thrown exception alike; an exception still propagates.
    if (ctx.fixtureDir !== "") {
      const failed = !finished || code !== 0;
      if (!disposeFixtures(ctx.fixtureDir, { failed, keep: args.keepFixtures, remove })) code = 1;
    }
  }
  if (code !== 0) return code;
  log("all checks passed");
  return 0;
}

/**
 * True when this file is the program Node was started with, so importing it
 * (for example to exercise `parseCliArgs` or `main`) runs nothing. Node
 * resolves the main module to its real path, so `argv[1]` is compared after
 * `realpathSync`.
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
