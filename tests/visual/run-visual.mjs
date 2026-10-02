#!/usr/bin/env node
/* Cabrillo Coast LLC — blog visual comparison runner (Node built-ins only) */
/**
 * Repeatable visual regression of the blog (AC-16, F-018 public viewing).
 *
 *   node tests/visual/run-visual.mjs [--base <ref>]
 *
 * Builds the project fixture site twice with
 * `tests/fixtures/build-fixture-site.mjs`, from the base revision
 * (`git archive <base>`) and from the working tree, both with the working
 * tree's fixture articles, and serves each on 127.0.0.1 at `/cabrillo-coast/`.
 * Playwright Test runs `tests/visual/blog-visual.spec.mjs` twice: with
 * `--update-snapshots=all` against the base, writing the baseline into a
 * temporary directory, then with `--update-snapshots=none` against the
 * working tree, comparing every screenshot with it. Both sides render in the
 * same browser on the same machine, so no baseline is ever committed.
 *
 * Base: `--base <ref>`, else the upstream (`@{upstream}`, what is already
 * pushed), else `HEAD` when git answers there is none.
 *
 * Intent: a difference passes when `VISUAL_CHANGE_INTENDED=1` is set or a
 * commit message in `<base>..HEAD`, a merge commit included, has a
 * `Visual-Change: intended` trailer. Declared differences are still
 * reported; operational failures are never accepted as intended.
 *
 * Exit codes: 0 identical, skipped because git confirms the base has no
 * `_layouts/post.html`, or different as declared; 1 an undeclared difference
 * or an operational failure (a build, a Playwright run, git giving no answer,
 * a workspace that cannot be removed); 2 a usage error or a base that names
 * no commit; 130 / 143 interrupted by SIGINT / SIGTERM.
 *
 * Output: the `blog-visual-*` workspace under `os.tmpdir()` is removed every
 * run. `tests/visual/report/` and `tests/visual/test-results/` are kept for
 * inspection, both git-ignored; CI uploads the report when verification fails.
 *
 * `scripts/verify.mjs` runs this as its last step. `JEKYLL_ENV` is removed
 * from every git and Playwright child this runner starts (`gitEnv`,
 * `playwrightEnv`); the fixture builder sets the environment of its own.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEADLINES, describeResult, formatDuration, runSync, spawnSupervised } from "../../scripts/lib/subprocess.mjs";
import { buildFixtureSite } from "../fixtures/build-fixture-site.mjs";
import { STRICT_MISMATCH } from "./lib/pixels.mjs";

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

/** Playwright Test's exit code for an interrupted, incomplete run. */
const PLAYWRIGHT_INTERRUPTED = 130;

/** Colour sequences in Playwright's error messages. */
const ANSI_SEQUENCE = /\u001b\[[0-9;]*m/g;

/*
 * The first line of every Playwright matcher failure once its colour
 * sequences are stripped:
 * `Error: expect(<receiver>)[.<promise>][.not].<matcher>(<expectation>) failed`.
 * It names the matcher but not why it failed. The reason follows in the next
 * paragraph: `Locator:`, `Expected:`, `Received:` or `Timeout: <n>ms` lines,
 * then the matcher's own message (a pixel count, "Failed to take two
 * consecutive stable screenshots.").
 */
const MATCHER_HEADER = /^Error: expect\([^()\n]*\)(?:\.\w+)*\.\w+\([^()\n]*\) failed$/;

/*
 * A `toHaveScreenshot` failure that is solely a screenshot difference: the
 * matcher header followed directly by the size difference, the pixel-count
 * difference, or both, ending the line. A timed-out matcher puts a
 * `Timeout: <n>ms` line in between, and every other failure ("Failed to take
 * two consecutive stable screenshots.", a missing snapshot, a page or
 * assertion error) reads differently, so none of those match. The spec's
 * second, zero-tolerance layer fails with its own message, which
 * STRICT_MISMATCH (from lib/pixels.mjs) recognises in the same way; a
 * strict comparison that could not decode an image matches neither.
 */
const SCREENSHOT_MISMATCH = new RegExp(
  "^Error: expect\\(page\\)\\.toHaveScreenshot\\(expected\\) failed\\n\\n  " +
    "(?:Expected an image \\d+px by \\d+px, received \\d+px by \\d+px\\. " +
    "(?:\\d+ pixels \\(ratio \\d+(?:\\.\\d+)? of all image pixels\\) are different\\.)?" +
    "|\\d+ pixels \\(ratio \\d+(?:\\.\\d+)? of all image pixels\\) are different\\.)" +
    "(?:\\n|$)",
);

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
 * Key and value of the commit-message trailer that declares an intended
 * visual change, in lower case, as the bytes `createTrailerScanner` compares.
 */
const TRAILER_KEY = Buffer.from("visual-change:", "latin1");
const TRAILER_VALUE = Buffer.from("intended", "latin1");

/** Most of `git log`'s standard error a warning quotes; the rest is cut. */
const GIT_LOG_STDERR_LIMIT = 4096;

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

/** Error codes that only mean a file's transfer was cut short: the client went away, or cleanup stopped it. */
const CLIENT_ABORTS = Object.freeze(["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"]);

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
  /** File streams the servers are still sending. @type {Set<fs.ReadStream>} */
  streams: new Set(),
  /** @type {import("node:child_process").ChildProcess | null} */
  child: null,
  /** @type {string | null} */
  stopping: null,
};

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
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

/**
 * Environment of every git command, the queries and the streamed log alike:
 * the caller's, with `GIT_OPTIONAL_LOCKS=0` so a read-only command never
 * writes even an opportunistic index refresh, and without `JEKYLL_ENV`. A
 * local production build without a Pages API token derives the wrong base
 * path, so no child of this runner inherits that variable; `playwrightEnv`
 * removes it from Playwright's environment too. `process.env` is not modified.
 * @returns {Record<string, string | undefined>} a new environment object.
 */
export function gitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.JEKYLL_ENV;
  return env;
}

/**
 * Read-only git command in the repository, with captured output and the
 * `DEADLINES.gitQuery` deadline. Arguments are an array and never pass
 * through a shell.
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }} the outcome
 *   of a git that exited by itself, zero or not.
 * @throws {Error} when git cannot be started, is killed by a signal, exceeds
 *   its deadline or overflows its capture limit: none of these is an answer.
 */
function git(args) {
  const result = runSync("git", args, { cwd: REPO, env: gitEnv(), timeoutMs: DEADLINES.gitQuery });
  if (result.error) {
    const reason = result.error.code === "ENOENT" ? "git not found on PATH" : errorMessage(result.error);
    throw new Error(`git could not be started: ${reason}`);
  }
  if (!result.completed) {
    const stderr = result.stderr.trim();
    throw new Error(`git ${args.join(" ")} ${describeResult(result)}${stderr === "" ? "" : `: ${stderr}`}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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

/**
 * The default base: what is already pushed, or `HEAD` when git answers that
 * the branch has no upstream.
 * @throws {Error} when git gives no answer (see `git`), so a probe that never
 *   finished cannot make the run compare unpushed changes against themselves.
 */
function defaultBase() {
  return git(["rev-parse", "--verify", "-q", "@{upstream}"]).status === 0 ? "@{upstream}" : "HEAD";
}

/**
 * Resolves a revision to its full commit id. A value starting with `-` is
 * refused before git sees it, so a revision can never be read as an option.
 * @returns {string | null} the commit id, or null when git answers that it
 *   does not resolve to a commit.
 * @throws {Error} when git gives no answer (see `git`).
 */
function resolveCommit(ref) {
  if (ref.startsWith("-")) return null;
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.status === 0 && COMMIT_ID.test(sha) ? sha : null;
}

/**
 * True when the base commit has `_layouts/post.html`, false when git
 * confirms it has not: the only evidence the skip rule accepts.
 *
 * `git ls-tree -z --full-tree <sha> -- <path>` lists the entry when it
 * exists and exits 0 with no output when it does not, so absence is an
 * answer rather than an error. A bad or unreadable object exits non-zero,
 * which is a failure: it must never skip a base that has the layout.
 * @param {string} sha Base commit id.
 * @returns {boolean}
 * @throws {Error} when git gives no answer or exits non-zero.
 */
function baseHasLayout(sha) {
  const args = ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", sha, "--", BASE_LAYOUT];
  const result = git(args);
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `cannot tell whether base ${sha} has ${BASE_LAYOUT}: git ${args.join(" ")} exited with status ` +
        `${result.status}${stderr === "" ? "" : `: ${stderr}`}`,
    );
  }
  // Records are `<mode> <type> <object>\t<path>`, each ended by NUL.
  return result.stdout.split("\0").some((record) => {
    const tab = record.indexOf("\t");
    return tab !== -1 && record.slice(tab + 1) === BASE_LAYOUT;
  });
}

/**
 * Recognises the trailer that declares an intended visual change in a
 * stream of commit-message bytes, fed chunk by chunk, in constant memory.
 *
 * A line counts when it is exactly
 *   `Visual-Change:` [ \t]* `intended` [ \t]*
 * with the key and value in any ASCII letter case. Space and tab only, not
 * any white space, so the key and value sit on one line as a git trailer's
 * do. A line ends at LF, at CR (so CRLF line ends from Windows count), at
 * U+2028 or U+2029 (bytes E2 80 A8 and E2 80 A9), or at the end of the
 * stream, which `end()` marks. Any other byte, a non-ASCII one included,
 * means the line cannot match. These are exactly the lines that
 * `/^Visual-Change:[ \t]*intended[ \t\r]*$/im` matches in the UTF-8 text:
 * its `m` flag ends lines at the same four characters, and without the `u`
 * flag its `i` flag folds ASCII letters only. Bytes are never decoded or
 * kept, and a chunk may end anywhere, inside the trailer or a line end too.
 *
 * @example
 *   const scanner = createTrailerScanner();
 *   stream.on("data", (chunk) => { if (scanner.push(chunk)) stop(); });
 *   // once the stream has ended in full:
 *   const declared = scanner.found || scanner.end();
 *
 * @returns {{ push(chunk: Uint8Array): boolean, end(): boolean, readonly found: boolean }}
 *   `push` scans the next bytes and `end` marks the end of the stream; each
 *   returns whether a trailer line has been found, which then stays true.
 *   `push` after `end` is a programming error and throws.
 */
export function createTrailerScanner() {
  const LF = 0x0a;
  const CR = 0x0d;
  const SPACE = 0x20;
  const TAB = 0x09;
  const LS_PS_LEAD = 0xe2;
  const LS_PS_MIDDLE = 0x80;
  const LS_LAST = 0xa8;
  const PS_LAST = 0xa9;

  // Where the current line stands: inside the key, in the blanks after it,
  // inside the value, in the blanks after the value, or past matching.
  const KEY = 0;
  const GAP = 1;
  const VALUE = 2;
  const TAIL = 3;
  const DEAD = 4;

  let phase = KEY;
  /** Bytes of the key or the value matched so far. */
  let index = 0;
  /** Bytes of a possible U+2028 or U+2029 seen so far: 0, 1 (E2) or 2 (E2 80). */
  let pending = 0;
  let found = false;
  let ended = false;

  const endLine = () => {
    if (phase === TAIL) found = true;
    phase = KEY;
    index = 0;
  };

  // One byte that ends no line.
  const step = (byte) => {
    const folded = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    if (phase === KEY) {
      if (folded !== TRAILER_KEY[index]) {
        phase = DEAD;
        return;
      }
      index += 1;
      if (index === TRAILER_KEY.length) phase = GAP;
    } else if (phase === GAP) {
      if (byte === SPACE || byte === TAB) return;
      if (folded === TRAILER_VALUE[0]) {
        phase = VALUE;
        index = 1;
      } else {
        phase = DEAD;
      }
    } else if (phase === VALUE) {
      if (folded !== TRAILER_VALUE[index]) {
        phase = DEAD;
        return;
      }
      index += 1;
      if (index === TRAILER_VALUE.length) phase = TAIL;
    } else if (phase === TAIL && byte !== SPACE && byte !== TAB) {
      phase = DEAD;
    }
  };

  const feed = (byte) => {
    if (pending === 1) {
      if (byte === LS_PS_MIDDLE) {
        pending = 2;
        return;
      }
      // E2 not followed by 80 is an ordinary non-ASCII character.
      pending = 0;
      phase = DEAD;
    } else if (pending === 2) {
      pending = 0;
      if (byte === LS_LAST || byte === PS_LAST) {
        endLine();
        return;
      }
      phase = DEAD;
    }
    if (byte === LF || byte === CR) endLine();
    else if (byte === LS_PS_LEAD) pending = 1;
    else step(byte);
  };

  return {
    push(chunk) {
      if (ended) throw new Error("createTrailerScanner: push() after end()");
      for (let i = 0; i < chunk.length && !found; i += 1) feed(chunk[i]);
      return found;
    },
    end() {
      if (!ended) {
        ended = true;
        // The last line counts without a line end; an unfinished E2 or E2 80
        // is an ordinary character, which leaves the line unmatched.
        if (!found && pending === 0 && phase === TAIL) found = true;
      }
      return found;
    },
    get found() {
      return found;
    },
  };
}

/**
 * Where an intended visual change was declared, or null when it was not.
 *
 * `git log --format=%B <base>..HEAD` is streamed through
 * `createTrailerScanner`, so a range of any size is read in constant memory,
 * and git is stopped at the first trailer; that stop is a finished scan, and
 * the trailer counts because its bytes were git's own output.
 *
 * A log that gave no answer is an operational failure and throws, whatever
 * it printed: its `DEADLINES.gitLog` deadline expired, it was left running
 * after SIGKILL, it was killed by a signal this runner did not send, or it
 * could not start. Otherwise a trailer recognised in git's own output before
 * it exited or was stopped completes the scan and is credited, whatever the
 * exit status; a last line without a line end counts only after git exited
 * 0. A git that exited by itself with an error status and printed no
 * recognised trailer did answer; that fails safe, with a warning and no
 * trailer credited.
 * @param {string} sha Base commit id.
 * @returns {Promise<string | null>}
 * @throws {Error} when the log gave no answer; `main` exits 1.
 */
async function declaredIntent(sha) {
  if (process.env.VISUAL_CHANGE_INTENDED === "1") return "VISUAL_CHANGE_INTENDED=1";
  const range = `${sha.slice(0, 12)}..HEAD`;
  const run = spawnSupervised("git", ["log", "--format=%B", `${sha}..HEAD`], {
    cwd: REPO,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: DEADLINES.gitLog,
  });
  const scanner = createTrailerScanner();
  const stderrParts = [];
  let stderrBytes = 0;
  let stderrCut = false;
  // A null child was refused by the operating system; `done` already carries why.
  if (run.child !== null) {
    run.child.stdout.on("data", (chunk) => {
      if (!scanner.found && scanner.push(chunk)) run.stop();
    });
    run.child.stderr.on("data", (chunk) => {
      const room = GIT_LOG_STDERR_LIMIT - stderrBytes;
      if (chunk.length > room) stderrCut = true;
      if (room <= 0) return;
      const part = chunk.subarray(0, room);
      stderrParts.push(part);
      stderrBytes += part.length;
    });
  }
  const result = await run.done;
  const stderr = Buffer.concat(stderrParts).toString("utf8").trim();
  const detail = stderr === "" ? "" : `: ${stderr}${stderrCut ? " […]" : ""}`;
  // `stop()` after a trailer is the only ending without an exit status that is a finished scan.
  const scanFinished = result.completed || (result.stopped && scanner.found);
  if (!scanFinished || result.abandoned) {
    throw new Error(`git log --format=%B ${range} ${describeResult(result)}${detail}`);
  }
  // `end()` only after a complete read: the last bytes of a log cut short are not the end of a line.
  if (scanner.found || (result.ok && scanner.end())) return `a "Visual-Change: intended" trailer in ${range}`;
  if (result.ok) return null;
  // Fail safe: git answered with an error and no trailer was recognised, so none is credited.
  warn(`cannot read the commit messages in ${range} (git log ${describeResult(result)}${detail}); no trailer counted`);
  return null;
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
  // pipeline, not pipe: a response closed early destroys the file stream and
  // releases its descriptor, and a read error destroys the response.
  const stream = fs.createReadStream(target);
  session.streams.add(stream);
  stream.once("close", () => session.streams.delete(stream));
  pipeline(stream, res, (err) => {
    if (err && !CLIENT_ABORTS.includes(err.code)) warn(`cannot send ${target}: ${errorMessage(err)}`);
  });
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
 * accepted as an intended visual difference. Each request, its body
 * included, has the `DEADLINES.httpRequest` deadline.
 * @returns {Promise<string | null>} the first problem found, or null.
 */
async function preflight(port) {
  for (const page of PREFLIGHT_PAGES) {
    const url = `http://127.0.0.1:${port}${MOUNT}${page}`;
    try {
      // The signal also aborts the body read below.
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(DEADLINES.httpRequest) });
      // Drain the body so the keep-alive connection is released.
      await response.arrayBuffer();
      if (response.status !== 200) return `${url} answered ${response.status}`;
    } catch (err) {
      if (err && err.name === "TimeoutError") {
        return `${url} did not answer within ${formatDuration(DEADLINES.httpRequest)}`;
      }
      return `${url} could not be fetched: ${errorMessage(err)}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Playwright                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Environment of a Playwright run: `baseEnv` with the inputs of the config
 * and the spec set, and every variable Playwright would prefer to the
 * config's reporter settings neutralised. The HTML report then always goes
 * to the config's folder, `tests/visual/report/` (REPORT_DIR), which the
 * printed hints name and the blog-checks workflow uploads; it is never
 * opened, and no reporter is added. `JEKYLL_ENV` is removed as well, as in
 * `gitEnv`: every build outside GitHub Pages is a development build, because
 * a production build without a Pages API token derives the wrong base path.
 * Every other variable passes through unchanged, and `baseEnv` is not
 * modified.
 *
 * @example
 *   const env = playwrightEnv(process.env, {
 *     baseUrl: "http://127.0.0.1:41234/cabrillo-coast",
 *     baselineDir: "/tmp/blog-visual-x/baseline",
 *     resultsFile: "/tmp/blog-visual-x/compare-results.json",
 *   });
 *
 * @param {Record<string, string | undefined>} baseEnv Usually `process.env`.
 * @param {{ baseUrl: string, baselineDir: string, resultsFile?: string }} inputs
 *   `VISUAL_BASE_URL`, `VISUAL_BASELINE_DIR` and `VISUAL_RESULTS_FILE`; an
 *   omitted results file is passed as an empty value, which writes no JSON
 *   report.
 * @returns {Record<string, string | undefined>} a new environment object.
 */
export function playwrightEnv(baseEnv, { baseUrl, baselineDir, resultsFile }) {
  const env = {
    ...baseEnv,
    VISUAL_BASE_URL: baseUrl,
    VISUAL_BASELINE_DIR: baselineDir,
    VISUAL_RESULTS_FILE: resultsFile ?? "",
  };
  delete env.JEKYLL_ENV;
  // Playwright prefers this variable to the config's outputFile; an inherited
  // value would send the results somewhere this runner never reads.
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  // The HTML reporter takes its folder from PLAYWRIGHT_HTML_OUTPUT_DIR, then
  // from PLAYWRIGHT_HTML_REPORT, before the config's outputFolder, which is
  // REPORT_DIR. Both are removed rather than forced to that folder: with
  // either set, Playwright treats the folder as its default and prints its
  // "show-report" hint without the folder, a command that finds no report.
  delete env.PLAYWRIGHT_HTML_OUTPUT_DIR;
  delete env.PLAYWRIGHT_HTML_REPORT;
  // It takes its open policy from PLAYWRIGHT_HTML_OPEN, then from
  // PW_TEST_HTML_REPORT_OPEN, before the config's `open: "never"`; an
  // inherited "always" would start a report server that holds the run open.
  env.PLAYWRIGHT_HTML_OPEN = "never";
  delete env.PW_TEST_HTML_REPORT_OPEN;
  // A base URL for attachments makes the report link its screenshots there
  // instead of inside the report folder, so the uploaded report would show
  // none of them.
  delete env.PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL;
  // PW_TEST_REPORTER adds one more reporter to the config's list, whose
  // output this runner neither expects nor directs: a json one prints the
  // whole report into the run's output, an html one builds the report twice.
  delete env.PW_TEST_REPORTER;
  return env;
}

/**
 * Runs the spec through Playwright Test against one served build. Supervised
 * and asynchronous, never `spawnSync`: the static servers live in this
 * process's event loop and must keep answering while the browser loads
 * pages. At `DEADLINES.playwrightRun` the child is sent SIGTERM, then
 * SIGKILL, and is given up on if it still runs, so a stalled run cannot keep
 * the servers and the workspace alive.
 *
 * The promise resolves once, in one of three ways: when the child closed
 * before its deadline, with its exit code or the signal that ended it; when
 * Playwright could not be started, with code 1 after a warning; or when the
 * deadline ended the run, a child still running that was given up on
 * included, with `timedOut` true. While an interrupt is in progress it never
 * resolves: the signal handler owns the exit code and the cleanup.
 *
 * @param {"all" | "none"} mode `all` writes the baseline; `none` only compares,
 *   so a missing baseline fails instead of being written.
 * @param {number} port Port of the server to screenshot.
 * @param {string} baselineDir Folder the config writes and reads baselines in.
 * @param {string} [resultsFile] Where the config's JSON reporter writes the
 *   run's results; without it no JSON report is written.
 * @returns {Promise<{ code: number | null, signal: string | null, timedOut: boolean }>}
 *   the child's exit code and signal, or code 1 when it could not be started;
 *   `timedOut` is true when the deadline ended the run, and its code and
 *   signal then say nothing about the screenshots.
 */
function runPlaywright(mode, port, baselineDir, resultsFile) {
  const env = playwrightEnv(process.env, { baseUrl: `http://127.0.0.1:${port}${MOUNT}`, baselineDir, resultsFile });
  const args = [CLI, "test", "--config", CONFIG, `--update-snapshots=${mode}`];
  const shown = args.map((a) => (path.isAbsolute(a) ? path.relative(REPO, a) : a)).join(" ");
  log(`$ VISUAL_BASE_URL=${env.VISUAL_BASE_URL} node ${shown}`);

  return new Promise((resolve) => {
    let settled = false;
    const run = spawnSupervised(process.execPath, args, {
      cwd: REPO,
      stdio: "inherit",
      env,
      timeoutMs: DEADLINES.playwrightRun,
    });
    // Null when the operating system refused to create the process; `done` then carries the error.
    session.child = run.child;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      session.child = null;
      // While an interrupt is in progress the signal handler owns the exit.
      if (session.stopping === null) resolve(outcome);
    };
    run.done.then((result) => {
      if (result.error) {
        warn(`Playwright could not be started: ${errorMessage(result.error)}`);
        finish({ code: 1, signal: null, timedOut: false });
        return;
      }
      const timedOut = result.timedOut || result.abandoned;
      if (timedOut) warn(`Playwright ${describeResult(result)}`);
      finish({ code: result.status, signal: result.signal, timedOut });
    });
  });
}

/* ------------------------------------------------------------------------ */
/* Comparison results                                                        */
/* ------------------------------------------------------------------------ */

/**
 * One line summing up an error message, without colour sequences: its first
 * line, or "(no message)" when there is none. When that line is only a
 * Playwright matcher header (MATCHER_HEADER), the first paragraph after it
 * follows: its non-blank lines up to the next blank line or `Call log:`, each
 * trimmed, joined with "; ". A header with nothing after it stands alone.
 *
 * @example
 *   errorSummary("Error: expect(page).toHaveScreenshot(expected) failed\n\nTimeout: 5000ms\n" +
 *     "  Failed to take two consecutive stable screenshots.\n\nCall log:\n…");
 *   // "Error: expect(page).toHaveScreenshot(expected) failed — Timeout: 5000ms; Failed to take two consecutive stable screenshots."
 *
 * @param {unknown} message An error's `message` from Playwright's JSON report.
 * @returns {string}
 */
function errorSummary(message) {
  const text = typeof message === "string" ? message.replace(ANSI_SEQUENCE, "").trim() : "";
  if (text === "") return "(no message)";
  const [header, ...rest] = text.split("\n");
  if (!MATCHER_HEADER.test(header)) return header;
  const reason = [];
  for (const line of rest) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (reason.length > 0) break;
      continue;
    }
    if (trimmed.startsWith("Call log:")) break;
    reason.push(trimmed);
  }
  return reason.length === 0 ? header : `${header} — ${reason.join("; ")}`;
}

/**
 * True when `message` is solely a screenshot size or pixel difference, found
 * by `toHaveScreenshot` (SCREENSHOT_MISMATCH) or by the spec's zero-tolerance
 * comparison (STRICT_MISMATCH).
 */
function isScreenshotMismatch(message) {
  if (typeof message !== "string") return false;
  const text = message.replace(ANSI_SEQUENCE, "");
  return SCREENSHOT_MISMATCH.test(text) || STRICT_MISMATCH.test(text);
}

/** True when a result attached the captured screenshot (`<name>-actual.png`). */
function hasActualImage(result) {
  const attachments = Array.isArray(result.attachments) ? result.attachments : [];
  return attachments.some((attachment) => typeof attachment?.name === "string" && attachment.name.endsWith("-actual.png"));
}

/**
 * Every test of a JSON report's suites, nested suites included, with the
 * title of the spec it belongs to.
 * @param {unknown} suites
 * @param {{ title: string, test: any }[]} [cases] Accumulator for the recursion.
 * @returns {{ title: string, test: any }[]}
 */
function collectCases(suites, cases = []) {
  for (const suite of Array.isArray(suites) ? suites : []) {
    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      const title = typeof spec?.title === "string" && spec.title !== "" ? spec.title : "(untitled case)";
      for (const test of Array.isArray(spec?.tests) ? spec.tests : []) cases.push({ title, test });
    }
    collectCases(suite?.suites, cases);
  }
  return cases;
}

/**
 * Sorts the comparison run's results, read from Playwright's JSON report,
 * into screenshot mismatches and every other kind of failure. It reads
 * nothing but `report`.
 *
 * A failed result is a mismatch when it has at least one error, every error
 * is solely a screenshot size or pixel difference (a `toHaveScreenshot`
 * failure, or the spec's zero-tolerance comparison failing with
 * `strictMismatchMessage`), and it attached its `<name>-actual.png`. Each of
 * these is a problem instead: a report
 * without a `suites` or an `errors` list, a run-level error, fewer than
 * EXPECTED_SCREENSHOTS cases, a case with no result, a result neither passed
 * nor failed (timed out, interrupted, skipped), and a failed result with no
 * error, any other error or no actual image.
 *
 * @example
 *   const { mismatched, problems } = classifyComparison(JSON.parse(fs.readFileSync(resultsFile, "utf8")));
 *   // A declared change is accepted only when problems is empty and mismatched is not.
 *
 * @param {unknown} report Parsed Playwright JSON report of the comparison run.
 * @returns {{ mismatched: string[], problems: string[] }} the titles of the
 *   mismatched cases, and one line per problem naming the case and summing up
 *   its message (`errorSummary`): the first line, followed for a Playwright
 *   matcher failure by the reason after its header, such as
 *   `Error: expect(page).toHaveScreenshot(expected) failed — Timeout: 5000ms; Failed to take two consecutive stable screenshots.`
 */
export function classifyComparison(report) {
  const mismatched = [];
  const problems = [];
  if (report === null || typeof report !== "object" || !Array.isArray(report.suites) || !Array.isArray(report.errors)) {
    problems.push("the results are not a Playwright JSON report");
    return { mismatched, problems };
  }
  for (const error of report.errors) problems.push(`the run reported an error: ${errorSummary(error?.message)}`);

  const cases = collectCases(report.suites);
  if (cases.length < EXPECTED_SCREENSHOTS) {
    problems.push(`only ${cases.length} of ${EXPECTED_SCREENSHOTS} cases were reported`);
  }
  for (const { title, test } of cases) {
    const results = Array.isArray(test?.results) ? test.results : [];
    if (results.length === 0) {
      problems.push(`${title}: did not run`);
      continue;
    }
    for (const result of results) {
      const status = result?.status;
      if (status === "passed") continue;
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      if (status !== "failed") {
        const detail = errors.length > 0 ? `: ${errorSummary(errors[0]?.message)}` : "";
        problems.push(`${title}: ${typeof status === "string" ? status : "no status"}${detail}`);
        continue;
      }
      const other = errors.find((error) => !isScreenshotMismatch(error?.message));
      if (errors.length === 0) problems.push(`${title}: failed without an error message`);
      else if (other !== undefined) problems.push(`${title}: ${errorSummary(other?.message)}`);
      else if (!hasActualImage(result)) problems.push(`${title}: failed without an actual screenshot (*-actual.png)`);
      else if (!mismatched.includes(title)) mismatched.push(title);
    }
  }
  return { mismatched, problems };
}

/* ------------------------------------------------------------------------ */
/* Cleanup and signals                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Closes every server (dropping kept-alive connections), releases any file
 * stream still being sent and removes the temporary workspace. Safe to call
 * more than once: `session.tmp` is cleared only once the workspace is gone,
 * so a later call retries a failed removal.
 * @returns {boolean} true when no temporary workspace remains.
 */
function cleanup() {
  for (const server of session.servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
  for (const stream of session.streams) stream.destroy();
  session.streams.clear();
  if (session.tmp === null) return true;
  try {
    fs.rmSync(session.tmp, { recursive: true, force: true });
  } catch (err) {
    warn(`could not remove ${session.tmp}: ${errorMessage(err)}`);
    return false;
  }
  session.tmp = null;
  return true;
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
 * terminal's process group), cleans up and exits 130 or 143, also when the
 * workspace cannot be removed (cleanup names it). A second signal during the
 * grace period kills the child at once.
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
 * Each child the builder runs (git, tar, every Jekyll build) has its own
 * deadline from `DEADLINES`.
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

  // Steps 1 to 3 rest on git's own answers. A git that could not start, was
  // killed or timed out gives none, and fails the run: it must never pass as
  // "no upstream", an unresolvable base or a base without the layout.
  let sha;
  let intent;
  try {
    // 1. Resolve the base revision.
    const ref = args.base ?? defaultBase();
    sha = resolveCommit(ref);
    if (sha === null) {
      console.error(`Cannot resolve base revision "${ref}"`);
      return 2;
    }
    log(`base ${ref} is ${sha}`);

    // 2. A base without the article layout predates the blog: nothing to compare with.
    if (!baseHasLayout(sha)) {
      console.log(`Visual comparison skipped: base ${sha} has no ${BASE_LAYOUT}`);
      return 0;
    }

    // 3. Declared intent, read before the slow work so it is printed up front.
    intent = await declaredIntent(sha);
    if (intent !== null) log(`intended visual change declared by ${intent}`);
  } catch (err) {
    console.error(`Visual comparison failed: ${errorMessage(err)}`);
    return 1;
  }
  const short = sha.slice(0, 12);

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
    if (baseline.timedOut) {
      console.error(
        `Visual comparison failed: the baseline run exceeded its ${formatDuration(DEADLINES.playwrightRun)} deadline`,
      );
      printReportHint(console.error);
      return 1;
    }
    const recorded = countFiles(baselineDir, (name) => name.endsWith(".png"));
    if (baseline.code !== 0 || recorded < EXPECTED_SCREENSHOTS) {
      console.error(`Visual comparison failed: baseline run did not produce ${EXPECTED_SCREENSHOTS} screenshots`);
      warn(`baseline run ${baseline.signal ? `was killed by ${baseline.signal}` : `exited ${baseline.code}`}, ${recorded} screenshots recorded`);
      return 1;
    }

    // 7. Compare the working tree against it.
    log("comparing the working tree with the baseline…");
    const resultsFile = path.join(tmp, "compare-results.json");
    const compare = await runPlaywright("none", ports["working-tree"], baselineDir, resultsFile);
    // A run its deadline ended is never a screenshot difference, so it can never be accepted as intended.
    if (compare.timedOut) {
      console.error(
        `Visual comparison failed: the comparison run exceeded its ${formatDuration(DEADLINES.playwrightRun)} deadline`,
      );
      printReportHint(console.error);
      return 1;
    }

    // 8. Outcome.
    if (compare.code === 0) {
      console.log(`Visual comparison passed: ${EXPECTED_SCREENSHOTS} screenshots identical`);
      return 0;
    }

    /*
     * Only a screenshot difference can be declared intended, and only one
     * this run proves case by case. Playwright must have exited 1 by itself:
     * 130 is an interrupted run with cases left unrun, and a signal or any
     * other code is abnormal. At least one `<name>-actual.png` must have been
     * written. The run's JSON results must then list every case, each passed
     * or failed solely on a screenshot size or pixel difference (from
     * `toHaveScreenshot` or the spec's zero-tolerance comparison) with its
     * actual image attached. Any other failure in the run (a navigation,
     * page, browser or assertion error, a timeout, a skipped case, a run-level
     * error, unreadable results) fails it whatever was declared.
     */
    if (compare.signal !== null || compare.code !== 1) {
      const how =
        compare.signal !== null
          ? `was killed by ${compare.signal}`
          : compare.code === PLAYWRIGHT_INTERRUPTED
            ? `was interrupted (exit ${PLAYWRIGHT_INTERRUPTED})`
            : `exited ${compare.code}`;
      console.error(`Visual comparison failed: the working-tree run ${how}, so the comparison is incomplete`);
      printReportHint(console.error);
      return 1;
    }
    const differing = countFiles(TEST_RESULTS, (name) => name.endsWith("-actual.png"));
    if (differing === 0) {
      console.error("Visual comparison failed: the working-tree run failed without a screenshot difference");
      printReportHint(console.error);
      return 1;
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    } catch (err) {
      console.error(`Visual comparison failed: the working-tree run's results cannot be read: ${errorMessage(err)}`);
      printReportHint(console.error);
      return 1;
    }
    const { mismatched, problems } = classifyComparison(report);
    if (problems.length > 0) {
      console.error("Visual comparison failed: the working-tree run failed for reasons other than a screenshot difference");
      for (const problem of problems) console.error(`  ${problem}`);
      if (intent !== null) console.error(`The declared intent (${intent}) covers screenshot differences only.`);
      printReportHint(console.error);
      return 1;
    }
    if (mismatched.length === 0) {
      console.error("Visual comparison failed: the working-tree run exited 1 but reported no failed case");
      printReportHint(console.error);
      return 1;
    }
    if (intent !== null) {
      console.log(
        `Visual comparison: ${mismatched.length} of ${EXPECTED_SCREENSHOTS} screenshots differ from base ${short}; ` +
          `the differences are reported and accepted as intended (${intent})`,
      );
      printReportHint();
      return 0;
    }
    console.error(`Visual comparison failed: blog pages differ from base ${short}`);
    console.error(`${mismatched.length} of ${EXPECTED_SCREENSHOTS} screenshots differ.`);
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
 * The comparison, then the workspace check: a temporary workspace that could
 * not be removed fails an otherwise successful run, and a failed run keeps
 * its own exit code.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Promise<number>} The exit code.
 */
async function run(argv) {
  const code = await main(argv);
  if (session.tmp === null) return code;
  console.error(`Visual comparison failed: the temporary workspace ${session.tmp} could not be removed`);
  return code === 0 ? 1 : code;
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
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      // A retry: a workspace the run could not remove is still recorded.
      cleanup();
      process.exit(1);
    },
  );
}
