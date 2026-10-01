#!/usr/bin/env node
/* Cabrillo Coast LLC — verification entry point (Node built-ins only) */
/**
 * Runs every automated blog check in one fixed order and stops at the first
 * failure (AAP 0.5.7). Authors run it before pushing, and the blog-checks
 * workflow runs the same script, so a local pass means what a CI pass means.
 *
 *   node scripts/verify.mjs [--base <ref>]
 *
 * Steps, each run from the repository root with inherited output:
 *   1. bundle exec jekyll build
 *        The real site into `_site/`, empty base path, in the deployment mode
 *        that `_config.yml` and `CNAME` describe.
 *   2. SITE_URL=<_config.yml url> node --test "tests/**\/*.test.mjs"
 *        Static and unit suites, plus the built-output suites against `_site/`
 *        on the host `_config.yml`'s `url` names: the custom domain
 *        (https://www.cabrillocoast.com) while `CNAME` exists, and
 *        https://randyamiller.github.io after the move to the project path.
 *   3. node tests/fixtures/build-fixture-site.mjs <tmp>
 *        Project, preview and empty fixture builds into a fresh temporary
 *        folder (`cabrillo-verify-*` under `os.tmpdir()`).
 *   4. SITE_DIR=<tmp>/project/cabrillo-coast SITE_BASEURL=/cabrillo-coast
 *      SITE_URL=https://randyamiller.github.io FIXTURE_DIR=<tmp>
 *      node --test "tests/static/built-*.test.mjs"
 *        The built-output suites again, in project-path mode with the
 *        fixture-only cases enabled.
 *   5. node tests/visual/run-visual.mjs --base <ref>
 *        The visual comparison against the base revision (AC-16). Skipping it
 *        for a base without `_layouts/post.html` is run-visual's decision.
 *
 * Base revision: `--base <ref>` is passed to step 5 unchanged. Without it the
 * branch's upstream (`@{upstream}`, what is already pushed) is used, or `HEAD`
 * when there is none, so everything not yet pushed is compared. The default
 * is pinned to its commit id when the run starts, so the base printed here is
 * the base step 5 compares against. Every base is checked before step 1, so a
 * mistyped revision fails in seconds rather than after the builds.
 *
 * Environment: the steps inherit the caller's environment except
 *   - JEKYLL_ENV, always removed: a local production build without a Pages API
 *     token derives the wrong base path (/pages/randyamiller/cabrillo-coast);
 *   - SITE_DIR, SITE_BASEURL, SITE_URL and FIXTURE_DIR, removed so steps 1 and
 *     2 test the real `_site/` as `_config.yml` configures it: step 2 sets
 *     SITE_URL from that file's `url`, and step 4 sets its own values.
 * VISUAL_CHANGE_INTENDED is kept, so `VISUAL_CHANGE_INTENDED=1` reaches step 5.
 *
 * Preflight: a missing Playwright install, or a Chromium that cannot start,
 * is a failure before step 1, never a skip, so no check is silently left out
 * locally that CI would run. It runs first so authors are not kept waiting
 * for the builds. It launches and closes Chromium with the visual project's
 * own selection (headless, no channel), which starts Playwright's
 * `chromium-headless-shell` build, so it passes exactly when step 5 can start
 * its browser, whichever of Playwright's two Chromium builds is installed.
 *
 * Deadlines: every git query and every step runs under a finite deadline
 * from `DEADLINES` in scripts/lib/subprocess.mjs, and is killed with SIGKILL
 * when it expires, so the run always ends. The preflight launch is bounded
 * by Playwright's launch timeout, set to `PREFLIGHT_LAUNCH_MS` (1 min).
 * Each step's deadline exceeds the deadlines of the tools it runs inside
 * (the fixture builder's git, tar and Jekyll runs, the visual runner's
 * builds and Playwright runs), so a stuck tool is stopped and reported by
 * its own step first. Only a git that exited by itself gives an answer: a
 * killed or timed-out `@{upstream}` probe is a failure, never "no
 * upstream", and a killed `--base` probe is a failure, never an
 * unresolvable revision.
 *
 * Exit status:
 *   0  every step passed (the fixture folder has been removed);
 *   N  the exit status of the first step that failed; 1 when that step was
 *      killed by a signal, exceeded its deadline or could not be started (the
 *      fixture folder, when it exists, is kept and its path printed for
 *      inspection);
 *   1  `_config.yml` cannot be read or names no http or https `url`,
 *      Playwright is missing or its Chromium cannot start, git cannot be
 *      run or a git query was killed or exceeded its deadline, the fixture
 *      folder cannot be created, or every step passed but the fixture folder
 *      cannot be removed (its path is printed);
 *   2  usage error, or the base revision does not resolve to a commit.
 * An interrupt (Ctrl-C) reaches the foreground step and this script alike;
 * no handler is installed (Playwright's, which closes the preflight browser,
 * is removed with that browser), so the run ends at once with the shell's
 * usual 130.
 *
 * Consumers: `.github/workflows/blog-checks.yml` runs
 * `node scripts/verify.mjs --base <base>`; `scripts/article.mjs` prints
 * `node scripts/verify.mjs` as the step after `publish`.
 * tests/unit/verify.test.mjs imports `main` and `preflightPlaywright` and
 * runs them with injected processes, environment, folders and browser
 * module, so the step sequence and every refusal are tested without a build.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEADLINES, describeResult, formatDuration, runSync } from "./lib/subprocess.mjs";

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Repository root, from this file's location, so the script works from any directory. */
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const USAGE = "Usage: node scripts/verify.mjs [--base <ref>]";
const LOG_PREFIX = "verify:";

/** Removed from every step's environment; the reason is printed when one was set. */
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
 * imported because this entry point loads only Node built-ins and the
 * built-in-only scripts/lib/subprocess.mjs, never the code its steps test.
 * A mismatch fails step 4, whose canonical-link checks compare against them.
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

/**
 * How long the preflight's Chromium launch may take, passed to Playwright as
 * the launch `timeout`. A cold start takes a few seconds; a launch still
 * pending after a minute cannot serve the visual comparison either.
 */
const PREFLIGHT_LAUNCH_MS = 60_000;

const PLAYWRIGHT_MISSING = "Playwright is not installed. Run: npm ci && npx playwright install chromium";
const CHROMIUM_MISSING =
  "Playwright Chromium is missing or cannot start. Run: npx playwright install chromium " +
  "(in CI: npx playwright install --with-deps chromium)";
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
 * @property {NodeJS.ProcessEnv} env  The caller's environment.
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

/** Prints one progress line on stdout. */
function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Prints one diagnostic line on stderr. */
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

/** Seconds since `started`, for the pass line of a step. */
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
    "  --base <ref>  Base revision for the visual comparison (step 5), passed on unchanged.",
    "                Default: @{upstream} (what is already pushed), or HEAD without one.",
    "  -h, --help    Show this help.",
    "",
    "Environment:",
    "  VISUAL_CHANGE_INTENDED=1  Passed to step 5: declared visual differences are reported, not failed.",
    `  ${JEKYLL_ENV}, ${SUITE_VARIABLES.join(", ")} are removed before any step runs.`,
    "",
    `Deadlines: steps 1-${STEPS.length} may run ${STEPS.map((step) => formatDuration(step.deadlineMs)).join(", ")};`,
    `each git query ${formatDuration(DEADLINES.gitQuery)}. A step past its deadline is killed and fails.`,
    "",
    "Exit status: 0 when every check passed and the fixture folder was removed; otherwise the",
    "failing step's status (1 when it was killed, exceeded its deadline or could not start); 1 when",
    "_config.yml names no http or https url, Playwright Chromium is missing or cannot start, a git",
    "query was killed or timed out, or the fixture folder cannot be removed; 2 for a usage error or a",
    "base revision that does not resolve.",
  ].join("\n");
}

/* ------------------------------------------------------------------------ */
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Parses the arguments after the script path. `--base=<ref>` is accepted as
 * well, matching tests/visual/run-visual.mjs. A value starting with `-` is a
 * missing value, never a revision, so an option can never be read as a base.
 * @param {string[]} argv
 * @returns {{ help: boolean, base?: string, error?: string }}
 */
export function parseCliArgs(argv) {
  const parsed = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
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
 * The environment every step starts from: the caller's, minus `JEKYLL_ENV`
 * and the built-output suites' variables. Everything else, including
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
function yamlScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m) return m[1].replace(/\\(.)/g, "$1");
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(text);
    if (m) return m[1].replace(/''/g, "'");
  }
  return text.replace(/\s+#.*$/, "").trim();
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
/* Playwright preflight                                                      */
/* ------------------------------------------------------------------------ */

/** First non-blank line of a message, trimmed; Playwright follows it with a boxed install hint. */
function firstLine(text) {
  return (
    String(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

/**
 * Confirms the visual comparison can run before any slow step starts, by
 * launching and closing the browser it uses. A missing install or browser
 * fails verification rather than skipping step 5, so a local pass means the
 * same as a CI pass.
 *
 * The probe launches exactly what tests/visual/playwright.config.mjs
 * launches: browserName chromium, no channel, no executable path, and
 * Playwright Test's default `headless: true`. Playwright starts its
 * `chromium-headless-shell` build for that, not the full Chromium that
 * `chromium.executablePath()` names, so only a launch tells whether step 5
 * can start its browser: with just the shell installed the comparison runs,
 * and with just full Chromium it cannot. The launch also checks the host
 * libraries Chromium needs. tests/unit/verify.test.mjs holds the visual
 * project to this launch configuration.
 * @param {object} [options]
 * @param {() => Promise<object>} [options.load]  Loads `@playwright/test`; tests pass a fake module.
 * @param {number} [options.timeoutMs]  Launch timeout; `PREFLIGHT_LAUNCH_MS` by default.
 * @returns {Promise<string | null>} the failure message, or null when ready.
 */
export async function preflightPlaywright(options = {}) {
  // Resolved from this file's location, so the repository's node_modules is used from any directory.
  const { load = () => import("@playwright/test"), timeoutMs = PREFLIGHT_LAUNCH_MS } = options;
  let playwright;
  try {
    playwright = await load();
  } catch (err) {
    const notFound = err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND");
    return notFound ? PLAYWRIGHT_MISSING : `${PLAYWRIGHT_MISSING}\n(${errorMessage(err)})`;
  }
  const chromium = playwright && (playwright.chromium ?? (playwright.default && playwright.default.chromium));
  if (!chromium || typeof chromium.launch !== "function") return PLAYWRIGHT_MISSING;
  let browser;
  try {
    // The visual project's selection (no channel, headless), so this starts chromium-headless-shell as step 5 does.
    browser = await chromium.launch({ headless: true, timeout: timeoutMs });
  } catch (err) {
    const reason = firstLine(errorMessage(err));
    return reason === "" ? CHROMIUM_MISSING : `${CHROMIUM_MISSING}\n(${reason})`;
  }
  try {
    await browser.close();
  } catch {
    // The browser started, which is all the probe asks; a failed close does not make it missing.
  }
  return null;
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
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {number} 0 when the step passed.
 */
function runStep(io, step, number, ctx, baseEnv) {
  const command = describeStep(step, ctx);
  console.log(`\n==> [${number}/${STEPS.length}] ${command}`);

  const executable = step.program === "node" ? io.execPath : step.program;
  const env = { ...baseEnv, ...(step.env ? step.env(ctx) : {}) };
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
  if (ctx.fixtureDir !== "") warn(`fixture builds kept for inspection in ${ctx.fixtureDir}`);
  return code;
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
 * @param {() => Promise<string | null>} [collaborators.preflight]  Browser check; `preflightPlaywright` by default.
 * @param {string} [collaborators.tmpdir]  Parent of the fixture folder; `os.tmpdir()` by default.
 * @param {string} [collaborators.execPath]  Node executable of `node` steps; `process.execPath` by default.
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv, collaborators = {}) {
  const {
    env = process.env,
    root = ROOT,
    run = runSync,
    preflight = preflightPlaywright,
    tmpdir = os.tmpdir(),
    execPath = process.execPath,
  } = collaborators;
  /** @type {Io} */
  const io = { env, root, run, execPath };

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

  // Environment hygiene.
  const { env: baseEnv, removed } = buildBaseEnv(env);
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
  const missing = await preflight();
  if (missing !== null) {
    warn(missing);
    return 1;
  }

  /** @type {StepContext} */
  const ctx = { base: base.ref, fixtureDir: "", siteUrl: site.url };
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    if (step.createsFixture) {
      try {
        ctx.fixtureDir = fs.mkdtempSync(path.join(tmpdir, FIXTURE_PREFIX));
      } catch (err) {
        warn(`cannot create the fixture folder under ${tmpdir}: ${errorMessage(err)}`);
        return 1;
      }
    }
    const code = runStep(io, step, i + 1, ctx, baseEnv);
    if (code !== 0) return code;
  }

  if (ctx.fixtureDir !== "") {
    try {
      fs.rmSync(ctx.fixtureDir, { recursive: true, force: true });
    } catch (err) {
      // Exit 0 promises that nothing is left behind, so a folder that cannot be
      // removed fails the run even though every step passed.
      warn(
        `every step passed, but the fixture folder ${ctx.fixtureDir} could not be removed: ` +
          `${errorMessage(err)}; remove it by hand`,
      );
      return 1;
    }
  }
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
