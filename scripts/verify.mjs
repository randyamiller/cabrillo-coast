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
 *        The real site into `_site/`, custom-domain mode, empty base path.
 *   2. node --test "tests/**\/*.test.mjs"
 *        Static and unit suites, plus the built-output suites against `_site/`
 *        with their defaults (SITE_URL https://www.cabrillocoast.com).
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
 *     2 test the real `_site/` with the suites' defaults; step 4 sets its own.
 * VISUAL_CHANGE_INTENDED is kept, so `VISUAL_CHANGE_INTENDED=1` reaches step 5.
 *
 * Preflight: a missing Playwright install or Chromium build is a failure
 * before step 1, never a skip, so no check is silently left out locally that
 * CI would run. It runs first so authors are not kept waiting for the builds.
 *
 * Exit status:
 *   0  every step passed (the fixture folder has been removed);
 *   N  the exit status of the first step that failed; 1 when that step was
 *      killed by a signal or could not be started (the fixture folder, when
 *      it exists, is kept and its path printed for inspection);
 *   1  Playwright or its Chromium is missing, git cannot be run, or the
 *      fixture folder cannot be created;
 *   2  usage error, or the base revision does not resolve to a commit.
 * An interrupt (Ctrl-C) reaches the foreground step and this script alike;
 * no handler is installed, so the run ends at once with the shell's usual 130.
 *
 * Consumers: `.github/workflows/blog-checks.yml` runs
 * `node scripts/verify.mjs --base <base>`; `scripts/article.mjs` prints
 * `node scripts/verify.mjs` as the step after `publish`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Repository root, from this file's location, so the script works from any directory. */
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const USAGE = "Usage: node scripts/verify.mjs [--base <ref>]";
const LOG_PREFIX = "verify:";

/** Removed from every step's environment; the reason is printed when one was set. */
const JEKYLL_ENV = "JEKYLL_ENV";

/** Read by the built-output suites; removed so steps 1 and 2 use the suites' defaults. */
const SUITE_VARIABLES = Object.freeze(["SITE_DIR", "SITE_BASEURL", "SITE_URL", "FIXTURE_DIR"]);

/*
 * Project-path deployment reproduced by the fixture builder's `project`
 * variant. These equal `PROJECT_BASEURL` and `PROJECT_URL` in
 * tests/fixtures/build-fixture-site.mjs; they are restated rather than
 * imported because this entry point loads Node built-ins only. A mismatch
 * fails step 4, whose canonical-link checks compare against them.
 */
const PROJECT_BASEURL = "/cabrillo-coast";
const PROJECT_URL = "https://randyamiller.github.io";

/** Prefix of the temporary fixture folder created before step 3. */
const FIXTURE_PREFIX = "cabrillo-verify-";

/** A full commit id: SHA-1 (40) or SHA-256 (64) hexadecimal digits. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Characters that never need shell quoting in a printed command. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const PLAYWRIGHT_MISSING = "Playwright is not installed. Run: npm ci && npx playwright install chromium";
const CHROMIUM_MISSING =
  "Playwright Chromium is missing. Run: npx playwright install chromium " +
  "(in CI: npx playwright install --with-deps chromium)";
const BUNDLE_MISSING = "bundle not found — install Ruby 3.3.4 and run bundle install";

/**
 * @typedef {object} StepContext
 * @property {string} base        Base revision passed to the visual comparison.
 * @property {string} fixtureDir  Temporary fixture folder ("" until step 3 creates it).
 */

/**
 * @typedef {object} Step
 * @property {"bundle" | "node"} program  Shown in logs; `node` runs as `process.execPath`.
 * @property {(ctx: StepContext) => string[]} args
 * @property {(ctx: StepContext) => Record<string, string>} [env]  Variables added to the base environment.
 * @property {boolean} [createsFixture]  The fixture folder is created just before this step.
 */

/**
 * The five steps, in their only order. Steps are never added, dropped,
 * reordered or skipped here; skip rules belong to the step that owns them.
 * Glob patterns are plain arguments: `node --test` expands them itself, and
 * no step runs through a shell.
 * @type {ReadonlyArray<Step>}
 */
const STEPS = Object.freeze([
  { program: "bundle", args: () => ["exec", "jekyll", "build"] },
  { program: "node", args: () => ["--test", "tests/**/*.test.mjs"] },
  {
    program: "node",
    args: (ctx) => ["tests/fixtures/build-fixture-site.mjs", ctx.fixtureDir],
    createsFixture: true,
  },
  {
    program: "node",
    args: () => ["--test", "tests/static/built-*.test.mjs"],
    env: (ctx) => ({
      SITE_DIR: path.join(ctx.fixtureDir, "project", "cabrillo-coast"),
      SITE_BASEURL: PROJECT_BASEURL,
      SITE_URL: PROJECT_URL,
      FIXTURE_DIR: ctx.fixtureDir,
    }),
  },
  { program: "node", args: (ctx) => ["tests/visual/run-visual.mjs", "--base", ctx.base] },
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
  const placeholders = { base: "<ref>", fixtureDir: "<tmp>" };
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
    "Exit status: 0 when every check passed; otherwise the failing step's status (1 when it was",
    "killed or could not start); 1 when Playwright Chromium is missing; 2 for a usage error or a",
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
 * Read-only git command in the repository, with captured output. Arguments
 * are an array and never pass through a shell; `GIT_OPTIONAL_LOCKS=0` keeps
 * git from writing even an opportunistic index refresh.
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 * @throws {Error} when git cannot be started at all.
 */
function git(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) {
    const reason = result.error.code === "ENOENT" ? "git not found on PATH — install Git" : errorMessage(result.error);
    throw new Error(`git could not be started: ${reason}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Full commit id of a revision, or null when it does not name a commit. A
 * value starting with `-` is refused before git sees it.
 * @param {string} ref
 * @returns {string | null}
 */
function resolveCommit(ref) {
  if (ref.startsWith("-")) return null;
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.status === 0 && COMMIT_ID.test(sha) ? sha : null;
}

/**
 * The base revision for step 5 and the line that reports it.
 *   - An explicit `--base` is passed on unchanged, after checking it resolves.
 *   - Otherwise `@{upstream}` when the branch has one, else `HEAD`, pinned to
 *     the commit id resolved now.
 * @param {string | undefined} explicit
 * @returns {{ ref: string, label: string } | { error: string }}
 */
function chooseBase(explicit) {
  if (explicit !== undefined) {
    const sha = resolveCommit(explicit);
    if (sha === null) return { error: `base revision "${explicit}" does not resolve to a commit` };
    return { ref: explicit, label: `${explicit} (${sha.slice(0, 7)})` };
  }
  const upstream = resolveCommit("@{upstream}");
  if (upstream !== null) return { ref: upstream, label: `@{upstream} (${upstream.slice(0, 7)})` };
  const head = resolveCommit("HEAD");
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
      log(`notice: ${name}=${value} is ignored — steps 1 and 2 test _site with the suites' defaults; step 4 sets its own`);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Playwright preflight                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Confirms the visual comparison can run before any slow step starts. A
 * missing install or browser fails verification rather than skipping step 5,
 * so a local pass means the same as a CI pass.
 * @returns {Promise<string | null>} the failure message, or null when ready.
 */
async function preflightPlaywright() {
  let playwright;
  try {
    // Resolved from this file's location, so the repository's node_modules is used from any directory.
    playwright = await import("@playwright/test");
  } catch (err) {
    const notFound = err && (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND");
    return notFound ? PLAYWRIGHT_MISSING : `${PLAYWRIGHT_MISSING}\n(${errorMessage(err)})`;
  }
  const chromium = playwright.chromium ?? (playwright.default && playwright.default.chromium);
  if (!chromium || typeof chromium.executablePath !== "function") return PLAYWRIGHT_MISSING;
  let executable = "";
  try {
    executable = chromium.executablePath();
  } catch {
    executable = "";
  }
  return executable && fs.existsSync(executable) ? null : CHROMIUM_MISSING;
}

/* ------------------------------------------------------------------------ */
/* Steps                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Runs one step from the repository root with inherited output and reports
 * its outcome as an exit code: the child's own non-zero status, or 1 when it
 * was killed by a signal or could not be started.
 * @param {Step} step
 * @param {number} number 1-based step number.
 * @param {StepContext} ctx
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {number} 0 when the step passed.
 */
function runStep(step, number, ctx, baseEnv) {
  const command = describeStep(step, ctx);
  console.log(`\n==> [${number}/${STEPS.length}] ${command}`);

  const executable = step.program === "node" ? process.execPath : step.program;
  const env = { ...baseEnv, ...(step.env ? step.env(ctx) : {}) };
  const started = Date.now();
  const result = spawnSync(executable, step.args(ctx), { cwd: ROOT, stdio: "inherit", env });

  let code = 0;
  if (result.error) {
    const hint =
      result.error.code === "ENOENT" && step.program === "bundle"
        ? BUNDLE_MISSING
        : `${step.program} could not be started: ${errorMessage(result.error)}`;
    warn(hint);
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
 * The whole verification.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<number>} The exit code.
 */
async function main(argv) {
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
    base = chooseBase(args.base);
  } catch (err) {
    warn(errorMessage(err));
    return 1;
  }
  if ("error" in base) {
    warn(base.error);
    console.error(USAGE);
    return 2;
  }
  log(`repository: ${ROOT}`);
  log(`base: ${base.label}`);

  // Environment hygiene.
  const { env: baseEnv, removed } = buildBaseEnv(process.env);
  reportRemoved(removed);
  if (baseEnv.VISUAL_CHANGE_INTENDED !== undefined) {
    log(`VISUAL_CHANGE_INTENDED=${baseEnv.VISUAL_CHANGE_INTENDED} is passed to step 5`);
  }

  // Playwright Chromium preflight: a failure, never a skip.
  const missing = await preflightPlaywright();
  if (missing !== null) {
    warn(missing);
    return 1;
  }

  /** @type {StepContext} */
  const ctx = { base: base.ref, fixtureDir: "" };
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    if (step.createsFixture) {
      try {
        ctx.fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
      } catch (err) {
        warn(`cannot create the fixture folder under ${os.tmpdir()}: ${errorMessage(err)}`);
        return 1;
      }
    }
    const code = runStep(step, i + 1, ctx, baseEnv);
    if (code !== 0) return code;
  }

  if (ctx.fixtureDir !== "") {
    try {
      fs.rmSync(ctx.fixtureDir, { recursive: true, force: true });
    } catch (err) {
      // Every check passed; a leftover temporary folder does not change that.
      warn(`could not remove ${ctx.fixtureDir}: ${errorMessage(err)}`);
    }
  }
  log("all checks passed");
  return 0;
}

/**
 * True when this file is the program Node was started with, so importing it
 * (for example to exercise `parseCliArgs`) runs nothing. Node resolves the
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
