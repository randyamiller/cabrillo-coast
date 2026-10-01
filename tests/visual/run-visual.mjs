#!/usr/bin/env node
/* Cabrillo Coast LLC — blog visual comparison runner (Node built-ins only) */
/**
 * Repeatable visual regression of the blog (AC-16, F-018 public viewing).
 *
 *   node tests/visual/run-visual.mjs [--base <ref>]
 *
 * Builds the project fixture site twice with `tests/fixtures/build-fixture-site.mjs`,
 * once from the base revision (`git archive <base>`) and once from the working
 * tree, both holding only the working tree's fixture articles. It serves each
 * build on 127.0.0.1 with the site mounted at `/cabrillo-coast/` and runs
 * `tests/visual/blog-visual.spec.mjs` through Playwright Test twice:
 *   1. `--update-snapshots=all` against the base build, which writes the 12
 *      baseline screenshots into a temporary directory;
 *   2. `--update-snapshots=none` against the working-tree build, which
 *      compares every screenshot with its baseline pixel for pixel.
 * Both sides are rendered by the same Chromium build on the same machine in
 * one run, so no baseline image is ever committed.
 *
 * Base revision: `--base <ref>`, or the branch's upstream (`@{upstream}`,
 * what is already pushed), or `HEAD` when there is no upstream.
 *
 * Outcomes and exit codes:
 *   0  The 12 screenshots are identical; or the base has no
 *      `_layouts/post.html` (the comparison is skipped with a notice); or the
 *      pages differ and the change is declared intended, either with
 *      `VISUAL_CHANGE_INTENDED=1` or with a `Visual-Change: intended` trailer
 *      in any commit message in `<base>..HEAD` (a pull request's merge commit
 *      included). Declared differences are still reported.
 *   1  The pages differ and the change is not declared; or a build, the
 *      pre-flight page check, the baseline run or the comparison run failed
 *      for any reason other than a screenshot difference. Such failures are
 *      never accepted as an intended change.
 *   2  Usage error, or the base revision cannot be resolved.
 *   130 / 143  Interrupted by SIGINT / SIGTERM.
 *
 * Output: the temporary workspace (`blog-visual-*` under `os.tmpdir()`) is
 * always removed. The Playwright report (`tests/visual/report/`) and test
 * artefacts (`tests/visual/test-results/`, with actual, expected and diff
 * images) are left in place for inspection and for the blog-checks workflow,
 * which uploads the report when verification fails. Both are git-ignored.
 *
 * Consumer: `scripts/verify.mjs` runs this as its last step, with inherited
 * output, `VISUAL_CHANGE_INTENDED` passed through and `JEKYLL_ENV` removed,
 * after it has already reported a missing Playwright Chromium.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildFixtureSite } from "../fixtures/build-fixture-site.mjs";

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Repository root, from this file's location; `process.cwd()` is never used for repository paths. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Playwright Test's command line, run with this Node binary (no shell, no npx). */
const CLI = path.join(REPO, "node_modules", "@playwright", "test", "cli.js");
const CONFIG = path.join(REPO, "tests", "visual", "playwright.config.mjs");

/** Written by the Playwright config; reported to the author, uploaded by CI. */
const REPORT_DIR = "tests/visual/report";
const TEST_RESULTS = path.join(REPO, "tests", "visual", "test-results");

/** Listing and one article × 3 widths × 2 colour schemes (blog-visual.spec.mjs). */
const EXPECTED_SCREENSHOTS = 12;

/** The builder writes `<side>/project/cabrillo-coast/`; the server root is `<side>/project`. */
const MOUNT = "/cabrillo-coast";

/** Pages the spec screenshots; each must answer 200 before Playwright runs. */
const PREFLIGHT_PAGES = Object.freeze(["/blog/", "/blog/fixture-code-and-tables/"]);

/** Files each build must contain, relative to `<side>/project`. */
const REQUIRED_OUTPUTS = Object.freeze([
  "cabrillo-coast/blog/index.html",
  "cabrillo-coast/blog/fixture-code-and-tables/index.html",
]);

/** The skip rule: a base without the article layout predates the blog. */
const BASE_LAYOUT = "_layouts/post.html";

/*
 * Commit-message trailer that declares an intended visual change. `[ \t]`
 * rather than `\s`, so the key and value must sit on one line as a git
 * trailer does; a trailing `\r` is tolerated for messages written on Windows.
 */
const INTENDED_TRAILER = /^Visual-Change:[ \t]*intended[ \t\r]*$/im;

/** A full commit id: SHA-1 (40) or SHA-256 (64) hexadecimal digits. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Exit codes after a signal, by shell convention (128 + signal number). */
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** How long an interrupted Playwright child gets to exit before SIGKILL. */
const CHILD_STOP_GRACE_MS = 5000;

const USAGE = "Usage: node tests/visual/run-visual.mjs [--base <ref>]";
const LOG_PREFIX = "run-visual:";

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/* ------------------------------------------------------------------------ */
/* Session state shared with the signal handlers and cleanup                 */
/* ------------------------------------------------------------------------ */

/**
 * Everything cleanup must release. `stopping` holds the signal name once an
 * interrupt has begun, so the main flow parks instead of racing the handler
 * to `process.exit`.
 */
const session = {
  /** @type {string | null} */
  tmp: null,
  /** @type {http.Server[]} */
  servers: [],
  /** @type {import("node:child_process").ChildProcess | null} */
  child: null,
  /** @type {string | null} */
  stopping: null,
};

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Prints one progress line. */
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

/**
 * Read-only git command in the repository. Arguments are an array and never
 * pass through a shell.
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 * @throws {Error} when git cannot be started at all.
 */
function git(args) {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    const reason = result.error.code === "ENOENT" ? "git not found on PATH" : errorMessage(result.error);
    throw new Error(`${LOG_PREFIX} git could not be started: ${reason}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Lets the event loop run once, so a signal that arrived while a synchronous
 * child (a Jekyll build) blocked the loop is handled now. Once an interrupt
 * is in progress the caller is parked for good: the signal handler owns the
 * exit code and the cleanup from then on.
 */
async function checkpoint() {
  await new Promise((resolve) => setImmediate(resolve));
  if (session.stopping !== null) await new Promise(() => {});
}

/** Number of files under `dir` (recursively) whose name satisfies `predicate`; 0 when `dir` is absent. */
function countFiles(dir, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return 0;
    throw err;
  }
  let count = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full, predicate);
    else if (entry.isFile() && predicate(entry.name)) count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------------ */
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Parses the arguments after the script path.
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
      // A following option is a missing value, never a revision.
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
/* Base revision and declared intent                                         */
/* ------------------------------------------------------------------------ */

/** The default base: what is already pushed, or `HEAD` when the branch has no upstream. */
function defaultBase() {
  return git(["rev-parse", "--verify", "-q", "@{upstream}"]).status === 0 ? "@{upstream}" : "HEAD";
}

/**
 * Resolves a revision to its full commit id. A value starting with `-` is
 * refused before git sees it, so a revision can never be read as an option.
 * @returns {string | null} the commit id, or null when it does not resolve to a commit.
 */
function resolveCommit(ref) {
  if (ref.startsWith("-")) return null;
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.status === 0 && COMMIT_ID.test(sha) ? sha : null;
}

/**
 * Where an intended visual change was declared, or null when it was not.
 * @param {string} sha Base commit id.
 * @returns {string | null}
 */
function declaredIntent(sha) {
  if (process.env.VISUAL_CHANGE_INTENDED === "1") return "VISUAL_CHANGE_INTENDED=1";
  const messages = git(["log", "--format=%B", `${sha}..HEAD`]);
  if (messages.status !== 0) {
    // Fail safe: without the commit messages no trailer can be credited.
    warn(`cannot read the commit messages in ${sha.slice(0, 12)}..HEAD (${messages.stderr.trim()}); no trailer counted`);
    return null;
  }
  return INTENDED_TRAILER.test(messages.stdout) ? `a "Visual-Change: intended" trailer in ${sha.slice(0, 12)}..HEAD` : null;
}

/* ------------------------------------------------------------------------ */
/* Static server                                                             */
/* ------------------------------------------------------------------------ */

/** True when `child` is `root` or lies inside it (both absolute). */
function isInside(child, root) {
  return child === root || child.startsWith(root + path.sep);
}

/** Sends a short plain-text response (headers only for HEAD). */
function sendText(req, res, status, text, headers = {}) {
  const body = `${text}\n`;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** `fs.promises.stat`, or null when nothing exists at `p`. */
async function statOrNull(p) {
  try {
    return await fs.promises.stat(p);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * Serves one request from `root`, a canonical absolute folder. Only files
 * inside `root` are ever read: `..` segments and NUL bytes are refused after
 * decoding, the joined path and its real path (symlinks resolved) must both
 * stay inside `root`, and no directory is ever listed.
 */
async function handleRequest(root, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(req, res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  let url;
  let pathname;
  try {
    url = new URL(req.url, "http://127.0.0.1");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding (URIError) or an unparsable request target.
    sendText(req, res, 400, "Bad request");
    return;
  }
  if (pathname.includes("\0") || pathname.split(/[\\/]/).includes("..")) {
    sendText(req, res, 403, "Forbidden");
    return;
  }

  let target = path.join(root, pathname);
  if (!isInside(target, root)) {
    sendText(req, res, 403, "Forbidden");
    return;
  }

  let stat = await statOrNull(target);
  if (stat !== null && stat.isDirectory()) {
    if (!url.pathname.endsWith("/")) {
      // As GitHub Pages does, so page-relative links resolve against the folder.
      // One leading slash only: the Location can never name another host.
      const location = `/${url.pathname.replace(/^\/+/, "")}/${url.search}`;
      sendText(req, res, 301, "Moved permanently", { Location: location });
      return;
    }
    target = path.join(target, "index.html");
    stat = await statOrNull(target);
  }
  if (stat === null || !stat.isFile()) {
    sendText(req, res, 404, "Not found");
    return;
  }
  if (!isInside(await fs.promises.realpath(target), root)) {
    sendText(req, res, 403, "Forbidden");
    return;
  }

  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(target).toLowerCase()] ?? DEFAULT_CONTENT_TYPE,
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(target);
  stream.on("error", (err) => {
    warn(`cannot read ${target}: ${errorMessage(err)}`);
    res.destroy(err);
  });
  stream.pipe(res);
}

/**
 * Starts a static file server for `root` on 127.0.0.1 at a free port and
 * registers it for cleanup. Responses other than 2xx and 3xx are logged on
 * stderr, so a missing asset shows up beside the Playwright output.
 *
 * @example
 *   const { server, port } = await startServer("/tmp/blog-visual-x/base/project", "base");
 *   // http://127.0.0.1:<port>/cabrillo-coast/blog/
 *
 * @param {string} root Folder to serve.
 * @param {string} [label] Name used in log lines.
 * @returns {Promise<{ server: http.Server, port: number }>}
 */
export function startServer(root, label = "site") {
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.on("finish", () => {
        if (res.statusCode >= 400) warn(`[${label}] ${res.statusCode} ${req.method} ${req.url}`);
      });
      handleRequest(canonicalRoot, req, res).catch((err) => {
        warn(`[${label}] ${req.method} ${req.url} failed: ${errorMessage(err)}`);
        if (res.headersSent) res.destroy(err);
        else sendText(req, res, 500, "Internal server error");
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", (err) => warn(`[${label}] server error: ${errorMessage(err)}`));
      session.servers.push(server);
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * Confirms that both screenshotted pages answer 200 before Playwright runs,
 * so a page missing from a build fails as a build failure and can never be
 * accepted as an intended visual difference.
 * @returns {Promise<string | null>} the first problem found, or null.
 */
async function preflight(port) {
  for (const page of PREFLIGHT_PAGES) {
    const url = `http://127.0.0.1:${port}${MOUNT}${page}`;
    try {
      const response = await fetch(url, { redirect: "manual" });
      // Drain the body so the keep-alive connection is released.
      await response.arrayBuffer();
      if (response.status !== 200) return `${url} answered ${response.status}`;
    } catch (err) {
      return `${url} could not be fetched: ${errorMessage(err)}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Playwright                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Runs the spec through Playwright Test against one served build and
 * resolves when the child closes. `spawn`, never `spawnSync`: the static
 * servers live in this process's event loop and must keep answering while
 * the browser loads pages.
 *
 * @param {"all" | "none"} mode `all` writes the baseline; `none` only compares,
 *   so a missing baseline fails instead of being written.
 * @param {number} port Port of the server to screenshot.
 * @param {string} baselineDir Folder the config writes and reads baselines in.
 * @returns {Promise<{ code: number | null, signal: string | null }>}
 */
function runPlaywright(mode, port, baselineDir) {
  const env = {
    ...process.env,
    VISUAL_BASE_URL: `http://127.0.0.1:${port}${MOUNT}`,
    VISUAL_BASELINE_DIR: baselineDir,
  };
  delete env.JEKYLL_ENV;
  const args = [CLI, "test", "--config", CONFIG, `--update-snapshots=${mode}`];
  const shown = args.map((a) => (path.isAbsolute(a) ? path.relative(REPO, a) : a)).join(" ");
  log(`$ VISUAL_BASE_URL=${env.VISUAL_BASE_URL} node ${shown}`);

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: "inherit", env });
    session.child = child;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      session.child = null;
      // While an interrupt is in progress the signal handler owns the exit.
      if (session.stopping === null) resolve(outcome);
    };
    child.once("error", (err) => {
      warn(`Playwright could not be started: ${errorMessage(err)}`);
      finish({ code: 1, signal: null });
    });
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

/* ------------------------------------------------------------------------ */
/* Cleanup and signals                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Closes every server (dropping kept-alive connections) and removes the
 * temporary workspace. Safe to call more than once.
 */
function cleanup() {
  for (const server of session.servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
  if (session.tmp !== null) {
    const tmp = session.tmp;
    session.tmp = null;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      warn(`could not remove ${tmp}: ${errorMessage(err)}`);
    }
  }
}

/** Resolves true once `child` has exited, or false after `ms`. */
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Stops a running Playwright child (it may already have the signal from the
 * terminal's process group), cleans up and exits 130 or 143. A second signal
 * during the grace period kills the child at once.
 */
async function onSignal(signal) {
  const code = SIGNAL_EXIT[signal];
  const child = session.child;
  if (session.stopping !== null) {
    if (child !== null) child.kill("SIGKILL");
    cleanup();
    process.exit(code);
  }
  session.stopping = signal;
  warn(`received ${signal}; stopping`);
  if (child !== null) {
    child.kill(signal);
    if (!(await waitForExit(child, CHILD_STOP_GRACE_MS))) {
      child.kill("SIGKILL");
      await waitForExit(child, CHILD_STOP_GRACE_MS);
    }
  }
  cleanup();
  process.exit(code);
}

/** Installs the SIGINT and SIGTERM handlers for the lifetime of the run. */
function installSignalHandlers() {
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    process.on(signal, () => {
      onSignal(signal).catch((err) => {
        warn(`cleanup after ${signal} failed: ${errorMessage(err)}`);
        process.exit(SIGNAL_EXIT[signal]);
      });
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Steps                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Builds one side with the fixture builder and confirms both screenshotted
 * pages exist. Every failure is a build failure, never a visual difference.
 * @param {string} outDir
 * @param {string} [ref] Base commit id; the working tree when omitted.
 * @returns {Promise<string | null>} the problem found, or null when the build is complete.
 */
async function buildSide(outDir, ref) {
  try {
    await buildFixtureSite(ref === undefined ? { outDir, fixturesOnly: true } : { outDir, ref, fixturesOnly: true });
  } catch (err) {
    await checkpoint();
    return errorMessage(err);
  }
  await checkpoint();
  const project = path.join(outDir, "project");
  const missing = REQUIRED_OUTPUTS.filter((rel) => !fs.existsSync(path.join(project, ...rel.split("/"))));
  return missing.length === 0 ? null : `the build produced no ${missing.join(" and no ")}`;
}

/** Prints how to inspect the report, on stdout or (for a failure) on stderr. */
function printReportHint(print = console.log) {
  print(`Report: ${REPORT_DIR}/index.html (open with: npx playwright show-report ${REPORT_DIR})`);
}

/**
 * The whole comparison.
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
    console.log(USAGE);
    return 0;
  }

  // 1. Resolve the base revision.
  const ref = args.base ?? defaultBase();
  const sha = resolveCommit(ref);
  if (sha === null) {
    console.error(`Cannot resolve base revision "${ref}"`);
    return 2;
  }
  const short = sha.slice(0, 12);
  log(`base ${ref} is ${sha}`);

  // 2. A base without the article layout predates the blog: nothing to compare with.
  if (git(["cat-file", "-e", `${sha}:${BASE_LAYOUT}`]).status !== 0) {
    console.log(`Visual comparison skipped: base ${sha} has no ${BASE_LAYOUT}`);
    return 0;
  }

  // 3. Declared intent, read before the slow work so it is printed up front.
  const intent = declaredIntent(sha);
  if (intent !== null) log(`intended visual change declared by ${intent}`);

  // Preconditions, checked before the slow builds.
  if (!fs.existsSync(CLI)) {
    console.error("@playwright/test is not installed: run npm ci");
    return 1;
  }
  if (!fs.existsSync(CONFIG)) {
    console.error(`Visual comparison failed: ${path.relative(REPO, CONFIG)} is missing`);
    return 1;
  }

  session.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-visual-"));
  try {
    installSignalHandlers();
    const tmp = session.tmp;
    const baselineDir = path.join(tmp, "baseline");

    // 4. Build both sides, the base first.
    const sides = [
      { name: "base", outDir: path.join(tmp, "base"), ref: sha, title: `base ${short}` },
      { name: "working-tree", outDir: path.join(tmp, "work"), ref: undefined, title: "the working tree" },
    ];
    for (const side of sides) {
      log(`Building ${side.title}…`);
      const problem = await buildSide(side.outDir, side.ref);
      if (problem !== null) {
        console.error(`Visual comparison failed: ${side.name} build failed`);
        warn(problem);
        return 1;
      }
    }

    // 5. Serve both builds and check the screenshotted pages answer.
    const ports = {};
    for (const side of sides) {
      const { port } = await startServer(path.join(side.outDir, "project"), side.name);
      log(`serving ${side.title} at http://127.0.0.1:${port}${MOUNT}/`);
      const problem = await preflight(port);
      await checkpoint();
      if (problem !== null) {
        console.error(`Visual comparison failed: ${side.name} build failed`);
        warn(problem);
        return 1;
      }
      ports[side.name] = port;
    }

    // 6. Baseline from the base build.
    fs.mkdirSync(baselineDir, { recursive: true });
    log(`recording the baseline from base ${short}…`);
    const baseline = await runPlaywright("all", ports.base, baselineDir);
    const recorded = countFiles(baselineDir, (name) => name.endsWith(".png"));
    if (baseline.code !== 0 || recorded < EXPECTED_SCREENSHOTS) {
      console.error(`Visual comparison failed: baseline run did not produce ${EXPECTED_SCREENSHOTS} screenshots`);
      warn(`baseline run ${baseline.signal ? `was killed by ${baseline.signal}` : `exited ${baseline.code}`}, ${recorded} screenshots recorded`);
      return 1;
    }

    // 7. Compare the working tree against it.
    log("comparing the working tree with the baseline…");
    const compare = await runPlaywright("none", ports["working-tree"], baselineDir);

    // 8. Outcome.
    if (compare.code === 0) {
      console.log(`Visual comparison passed: ${EXPECTED_SCREENSHOTS} screenshots identical`);
      return 0;
    }

    /*
     * Only a captured screenshot that differs from its baseline is a visual
     * difference: Playwright writes `<name>-actual.png` for each one. A run
     * that failed without one (killed, crashed, a page error) is a failure
     * whatever was declared, so it can never pass as an intended change.
     */
    const differing = countFiles(TEST_RESULTS, (name) => name.endsWith("-actual.png"));
    if (compare.signal !== null || differing === 0) {
      const how = compare.signal ? `was killed by ${compare.signal}` : `exited ${compare.code}`;
      console.error(`Visual comparison failed: the working-tree run ${how} without a screenshot difference`);
      printReportHint(console.error);
      return 1;
    }
    if (intent !== null) {
      console.log(
        `Visual comparison: ${differing} of ${EXPECTED_SCREENSHOTS} screenshots differ from base ${short}; ` +
          `the differences are reported and accepted as intended (${intent})`,
      );
      printReportHint();
      return 0;
    }
    console.error(`Visual comparison failed: blog pages differ from base ${short}`);
    console.error(`${differing} of ${EXPECTED_SCREENSHOTS} screenshots differ.`);
    printReportHint(console.error);
    console.error(
      "If the change is intended, add a `Visual-Change: intended` trailer to a commit message " +
        "in the pushed range, or set VISUAL_CHANGE_INTENDED=1.",
    );
    return 1;
  } finally {
    cleanup();
  }
}

/**
 * True when this file is the program Node was started with, so importing it
 * (for example to exercise `startServer`) runs nothing.
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
  // process.exit, not exitCode: kept-alive fetch connections must not hold the run open.
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      cleanup();
      process.exit(1);
    },
  );
}
