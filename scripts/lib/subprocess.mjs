/* Cabrillo Coast LLC — child-process transport for the blog tooling (Node built-ins only) */
/**
 * The one way the blog tooling runs a child process. Its consumers:
 *
 *   scripts/article.mjs                     read-only git plumbing for `new` and
 *                                           for `guard` in the commit and push hooks
 *   scripts/verify.mjs                      the base-revision probes and the five
 *                                           verification steps
 *   tests/fixtures/build-fixture-site.mjs   git, `git archive`, tar and the Jekyll
 *                                           builds of the fixture sites
 *   tests/visual/run-visual.mjs             git, the fixture builds and Playwright
 *
 * This module is transport only. It starts a command without a shell, gives it
 * a finite deadline, ends it when that deadline expires, and reports what
 * happened as one `ProcessResult`, keeping every fact a caller needs: the exit
 * status, the signal, whether the deadline, an output overflow or the caller
 * ended it, and why it could not start. Policy stays with each caller: the
 * environment it passes (`GIT_OPTIONAL_LOCKS=0`, a hook's `GIT_INDEX_FILE`
 * left inherited), which outcomes count as an answer and which fail closed,
 * and the wording of its messages. `describeResult` supplies a neutral clause
 * for those messages and decides nothing.
 *
 * There are two forms:
 *   - `runSync` blocks until the child ends or its deadline expires and
 *     captures the child's output. It suits short commands whose output is
 *     parsed.
 *   - `spawnSupervised` starts a child and returns at once with a promise of
 *     its result. It suits long steps with inherited output, streamed output,
 *     and callers that must keep handling signals while the child runs. At its
 *     deadline it sends SIGTERM, escalates to SIGKILL after a grace period, and
 *     never waits forever for a child that will not exit.
 *
 * Deadlines: every run takes one from `DEADLINES`. A composite deadline is the
 * sum of the deadlines it contains plus slack, so the innermost expiry is the
 * one reported. A stuck Jekyll build is reported as a Jekyll build that
 * exceeded its own deadline, not as the fixture build that contains it.
 *
 * It has no side effects at import and imports Node built-ins only, so a
 * script that depends on nothing outside Node keeps that property when it
 * imports this module.
 */

import { spawn, spawnSync } from "node:child_process";

/* ------------------------------------------------------------------------ */
/* Deadlines                                                                 */
/* ------------------------------------------------------------------------ */

const GIT_QUERY_MS = 60_000;
const GIT_ARCHIVE_MS = 120_000;
const TAR_EXTRACT_MS = 120_000;
const GIT_LOG_MS = 300_000;
const JEKYLL_BUILD_MS = 600_000;
const TEST_RUN_MS = 1_200_000;
const PLAYWRIGHT_RUN_MS = 900_000;
const HTTP_REQUEST_MS = 30_000;

/** Slack a composite deadline adds for the work between its children: staging, startup, serving. */
const COMPOSITE_SLACK_MS = 300_000;

/** The fixture builder: three Jekyll builds, plus `git archive`, tar and a git query to stage the base. */
const FIXTURE_BUILD_MS =
  3 * JEKYLL_BUILD_MS + GIT_ARCHIVE_MS + TAR_EXTRACT_MS + GIT_QUERY_MS + COMPOSITE_SLACK_MS;

/** The visual comparison: two fixture builds, two Playwright runs, the trailer scan, a git probe, page requests. */
const VISUAL_RUN_MS =
  2 * FIXTURE_BUILD_MS +
  2 * PLAYWRIGHT_RUN_MS +
  GIT_LOG_MS +
  GIT_QUERY_MS +
  4 * HTTP_REQUEST_MS +
  COMPOSITE_SLACK_MS;

/**
 * Deadline of each kind of run, in milliseconds.
 *
 * Nesting rule: a composite deadline is the sum of the deadlines it contains
 * plus slack, so it is always longer than any one of them and the innermost
 * expiry is the one reported. A caller that runs children one after another
 * under a parent deadline must keep this, giving the parent at least the sum
 * of its children.
 */
export const DEADLINES = Object.freeze({
  /** 1 min: one read-only git plumbing command (`rev-parse`, `cat-file`, `ls-tree`, `diff-tree`, …). */
  gitQuery: GIT_QUERY_MS,
  /** 2 min: one `git archive` of the base revision. */
  gitArchive: GIT_ARCHIVE_MS,
  /** 2 min: one tar extraction of that archive. */
  tarExtract: TAR_EXTRACT_MS,
  /** 5 min: one streamed `git log` over a push range. */
  gitLog: GIT_LOG_MS,
  /** 10 min: one `bundle exec jekyll build`. */
  jekyllBuild: JEKYLL_BUILD_MS,
  /** 20 min: one `node --test` run. */
  testRun: TEST_RUN_MS,
  /** 15 min: one Playwright Test run. */
  playwrightRun: PLAYWRIGHT_RUN_MS,
  /** 30 s: one HTTP request, body included. */
  httpRequest: HTTP_REQUEST_MS,
  /** 40 min: one fixture builder run, 3 × jekyllBuild + gitArchive + tarExtract + gitQuery + 5 min. */
  fixtureBuild: FIXTURE_BUILD_MS,
  /**
   * 123 min: one visual comparison, 2 × fixtureBuild + 2 × playwrightRun +
   * gitLog + gitQuery + 4 × httpRequest + 5 min.
   */
  visualRun: VISUAL_RUN_MS,
});

/** How long a supervised child has to exit after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 10_000;

/** How long a supervised child has to exit after SIGKILL before it is abandoned. */
export const REAP_WAIT_MS = 10_000;

/** Longest delay `setTimeout` honours; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const MIB = 1024 * 1024;

/* ------------------------------------------------------------------------ */
/* Results                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * What happened to one child process. `runSync` returns it and
 * `spawnSupervised` resolves `done` with it.
 * @typedef {object} ProcessResult
 * @property {boolean} ok  `completed` with exit status 0.
 * @property {boolean} completed  The child ran to its own end: it started,
 *   no deadline, output overflow, caller stop or abandonment ended it, and it
 *   exited with a status rather than by a signal. Only then is `status` the
 *   tool's real answer.
 * @property {number | null} status  Exit status. It is null when the child was
 *   ended by a signal, never started or was abandoned. A number with
 *   `timedOut` means the child exited by itself just as its deadline expired,
 *   or exited while another process held its output open.
 * @property {string | null} signal  Signal that ended the child, whoever sent it, or null.
 * @property {boolean} timedOut  The deadline expired and the child was stopped.
 * @property {boolean} overflowed  Captured output exceeded `maxBuffer` and the
 *   child was killed (`runSync` only; otherwise false).
 * @property {boolean} stopped  The caller ended the child with `stop()`
 *   (`spawnSupervised` only; otherwise false).
 * @property {boolean} abandoned  The child had not exited `reapMs` after
 *   SIGKILL and was left running (`spawnSupervised` only; otherwise false).
 * @property {Error | null} error  Why the child could not be started, or null.
 *   The deadline and the overflow are reported by `timedOut` and
 *   `overflowed`, never here.
 * @property {string | Buffer} stdout  Captured standard output: a string with
 *   encoding "utf8", a Buffer with "buffer", empty when it was not piped.
 *   Always "" from `spawnSupervised`, whose callers read `child.stdout`.
 * @property {string} stderr  Captured standard error as UTF-8, "" when it was
 *   not piped. Always "" from `spawnSupervised`.
 * @property {number} deadlineMs  The deadline the child ran under.
 * @property {number | null} pid  The child's process id, or null when it never started.
 */

/**
 * Assembles a `ProcessResult`, deriving `completed` and `ok` from the facts.
 * @param {object} facts
 * @returns {ProcessResult}
 */
function makeResult(facts) {
  const { status, signal, timedOut, overflowed, stopped, abandoned, error, stdout, stderr, deadlineMs, pid } = facts;
  const completed =
    error === null && !timedOut && !overflowed && !stopped && !abandoned && signal === null && status !== null;
  return {
    ok: completed && status === 0,
    completed,
    status,
    signal,
    timedOut,
    overflowed,
    stopped,
    abandoned,
    error,
    stdout,
    stderr,
    deadlineMs,
    pid,
  };
}

/* ------------------------------------------------------------------------ */
/* Messages                                                                  */
/* ------------------------------------------------------------------------ */

/** Message of a thrown value, whatever its type. */
function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/** A value as it should appear in a programming-error message. */
function shown(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Tenths of a unit as text: "30" for a whole number, "1.5" otherwise.
 * @param {number} tenths
 * @returns {string}
 */
function tenthsText(tenths) {
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

/**
 * A duration for messages: "750 ms" below one second, "30 s" or "1.5 s" below
 * one minute, "10 min" or "1.5 min" from one minute on. Values are rounded to
 * the shown precision first, so 59,990 ms reads "1 min", not "60 s".
 * @param {number} ms A finite, non-negative number of milliseconds.
 * @returns {string}
 * @throws {TypeError} when `ms` is not a finite, non-negative number.
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError(`formatDuration: expected a finite, non-negative number of milliseconds, got ${shown(ms)}`);
  }
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} ms`;
  const tenthsOfSecond = Math.round(ms / 100);
  if (tenthsOfSecond < 600) return `${tenthsText(tenthsOfSecond)} s`;
  return `${tenthsText(Math.round(ms / 6000))} min`;
}

/** A byte count for messages: "256 MiB", "64 KiB" or "1000 bytes". */
function formatBytes(bytes) {
  if (bytes >= MIB && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/**
 * One neutral clause saying how a run ended, for the caller to put after the
 * command's name: `git rev-parse … ${describeResult(result)}`.
 * @param {ProcessResult} result
 * @param {number} [maxBuffer] The capture limit the run used, named in the overflow clause.
 * @returns {string}
 */
export function describeResult(result, maxBuffer) {
  if (result.error) {
    return result.error.code === "ENOENT"
      ? "could not be started: not found on PATH"
      : `could not be started: ${errorMessage(result.error)}`;
  }
  const left = result.abandoned ? `; it did not exit after SIGKILL and was abandoned (pid ${result.pid})` : "";
  if (result.timedOut) return `exceeded its ${formatDuration(result.deadlineMs)} deadline and was stopped${left}`;
  if (result.overflowed) {
    const limit =
      typeof maxBuffer === "number" && Number.isFinite(maxBuffer) && maxBuffer > 0 ? ` of ${formatBytes(maxBuffer)}` : "";
    return `produced more output than its capture limit${limit} and was killed`;
  }
  if (result.stopped) return `was stopped${left}`;
  if (result.signal) return `was killed by ${result.signal}`;
  if (typeof result.status === "number") return `exited with status ${result.status}`;
  return "ended without an exit status";
}

/* ------------------------------------------------------------------------ */
/* Option checks                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Refuses a duration that is not a positive, finite number of milliseconds
 * within the timer limit. A bad value is a programming error, never a
 * reason to run without a deadline.
 * @param {string} where Function name, for the message.
 * @param {string} name Option name, for the message.
 * @param {unknown} value
 * @throws {TypeError}
 */
function requireDuration(where, name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(
      `${where}: ${name} must be a positive, finite number of milliseconds no greater than ${MAX_TIMER_MS}, ` +
        `got ${shown(value)}`,
    );
  }
}

/**
 * Refuses an option value outside its fixed set.
 * @param {string} where
 * @param {string} name
 * @param {unknown} value
 * @param {string[]} allowed
 * @throws {TypeError}
 */
function requireChoice(where, name, value, allowed) {
  if (!allowed.includes(/** @type {string} */ (value))) {
    throw new TypeError(`${where}: ${name} must be ${allowed.map(shown).join(" or ")}, got ${shown(value)}`);
  }
}

/** True for an operating-system refusal (`ENOTDIR`, `E2BIG`, …) as opposed to an argument error. */
function isSystemError(err) {
  return err instanceof Error && typeof err.code === "string" && typeof err.errno === "number";
}

/* ------------------------------------------------------------------------ */
/* Synchronous runs                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Runs one command to completion or to its deadline, without a shell.
 *
 * With stdio "pipe" (the default) standard input is closed unless `input` is
 * given, and standard output and error are captured. With "inherit" the child
 * shares the caller's terminal and nothing is captured.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]  Defaults to the caller's environment.
 * @param {string | Buffer} [options.input]  Written to standard input, which is then closed.
 * @param {number} options.timeoutMs  Required deadline, e.g. `DEADLINES.gitQuery`.
 * @param {"pipe" | "inherit"} [options.stdio="pipe"]
 * @param {"utf8" | "buffer"} [options.encoding="utf8"]  Type of `stdout`; `stderr` is always a string.
 * @param {number} [options.maxBuffer]  Capture limit per stream, in bytes; Node's 1 MiB when omitted.
 * @returns {ProcessResult}
 * @throws {TypeError} for a missing or invalid deadline or option; nothing is started.
 */
export function runSync(command, args, options = {}) {
  const { cwd, env, input, timeoutMs, stdio = "pipe", encoding = "utf8", maxBuffer } = options;
  requireDuration("runSync", "timeoutMs", timeoutMs);
  requireChoice("runSync", "stdio", stdio, ["pipe", "inherit"]);
  requireChoice("runSync", "encoding", encoding, ["utf8", "buffer"]);
  if (input !== undefined && stdio === "inherit") {
    throw new TypeError(`runSync: input needs stdio "pipe"; with "inherit" the child reads the caller's standard input`);
  }
  if (maxBuffer !== undefined && !(typeof maxBuffer === "number" && maxBuffer > 0)) {
    throw new TypeError(`runSync: maxBuffer must be a positive number of bytes, got ${shown(maxBuffer)}`);
  }

  /** @type {import("node:child_process").SpawnSyncOptions} */
  const spawnOptions = {
    cwd,
    env,
    stdio: stdio === "inherit" ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    encoding,
    timeout: timeoutMs,
    // SIGKILL rather than the default SIGTERM. spawnSync returns only once the
    // child has exited, so a child that handles or ignores a catchable signal
    // would keep the caller blocked for its whole run and defeat the deadline;
    // a SIGTERM-ignoring child was observed to hold spawnSync for its full
    // runtime. A blocked caller cannot escalate later, so there is no grace.
    killSignal: "SIGKILL",
    windowsHide: true,
  };
  if (input !== undefined) spawnOptions.input = input;
  if (maxBuffer !== undefined) spawnOptions.maxBuffer = maxBuffer;

  const raw = spawnSync(command, args, spawnOptions);

  // spawnSync reports its own deadline and capture limit as errors, and can
  // report status 0 together with ETIMEDOUT, so the error code is read first.
  const code = raw.error ? raw.error.code : undefined;
  const timedOut = code === "ETIMEDOUT";
  const overflowed = code === "ENOBUFS";
  const error = raw.error && !timedOut && !overflowed ? raw.error : null;

  let stdout;
  if (encoding === "buffer") stdout = Buffer.isBuffer(raw.stdout) ? raw.stdout : Buffer.alloc(0);
  else stdout = typeof raw.stdout === "string" ? raw.stdout : "";
  let stderr = "";
  if (Buffer.isBuffer(raw.stderr)) stderr = raw.stderr.toString("utf8");
  else if (typeof raw.stderr === "string") stderr = raw.stderr;

  return makeResult({
    status: error === null && typeof raw.status === "number" ? raw.status : null,
    signal: raw.signal ?? null,
    timedOut,
    overflowed,
    stopped: false,
    abandoned: false,
    error,
    stdout,
    stderr,
    deadlineMs: timeoutMs,
    pid: typeof raw.pid === "number" && raw.pid > 0 ? raw.pid : null,
  });
}

/* ------------------------------------------------------------------------ */
/* Supervised runs                                                           */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} SupervisedRun
 * @property {import("node:child_process").ChildProcess | null} child  The
 *   running child. Stream `child.stdout` when stdio is piped, and keep the
 *   reference for signal handlers. It is null only when the operating system
 *   refused to create the process (`ENOTDIR` cwd, `E2BIG`, …), in which case
 *   `done` is already resolved with that `error`.
 * @property {() => void} stop  Ends the child on the caller's request, with the
 *   same SIGTERM → SIGKILL → abandon sequence as the deadline. Idempotent; a
 *   no-op once `done` has resolved. The result is marked `stopped` unless the
 *   deadline had already expired.
 * @property {Promise<ProcessResult>} done  Resolves exactly once, when the
 *   child and its stdio have closed or the child is given up on. It never rejects.
 */

/**
 * Starts one command without a shell and supervises it until it ends.
 *
 * When the deadline expires, or the caller calls `stop()`, a child that is
 * still running is sent SIGTERM, SIGKILL `graceMs` later, and is abandoned
 * `reapMs` after that if it still has not exited: it is unreferenced, its
 * pipes are destroyed and the result says `abandoned`. A child that has
 * already exited while another process (a grandchild) keeps its pipes open
 * receives no signal; its pipes are destroyed and the result resolves at once.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]  Defaults to the caller's environment.
 * @param {import("node:child_process").StdioOptions} [options.stdio="inherit"]
 * @param {number} options.timeoutMs  Required deadline, e.g. `DEADLINES.jekyllBuild`.
 * @param {number} [options.graceMs=KILL_GRACE_MS]  SIGTERM → SIGKILL delay.
 * @param {number} [options.reapMs=REAP_WAIT_MS]  SIGKILL → abandon delay.
 * @returns {SupervisedRun}
 * @throws {TypeError} for a missing or invalid duration, or an argument
 *   `spawn` rejects; nothing is started.
 */
export function spawnSupervised(command, args, options = {}) {
  const { cwd, env, stdio = "inherit", timeoutMs, graceMs = KILL_GRACE_MS, reapMs = REAP_WAIT_MS } = options;
  requireDuration("spawnSupervised", "timeoutMs", timeoutMs);
  requireDuration("spawnSupervised", "graceMs", graceMs);
  requireDuration("spawnSupervised", "reapMs", reapMs);

  const facts = {
    status: null,
    signal: null,
    timedOut: false,
    overflowed: false,
    stopped: false,
    abandoned: false,
    error: null,
    stdout: "",
    stderr: "",
    deadlineMs: timeoutMs,
    pid: null,
  };

  let child;
  try {
    child = spawn(command, args, { cwd, env, stdio, windowsHide: true });
  } catch (err) {
    // An argument error is a programming error and propagates. An operating
    // system refusal is a start failure, reported like ENOENT.
    if (!isSystemError(err)) throw err;
    return { child: null, stop() {}, done: Promise.resolve(makeResult({ ...facts, error: err })) };
  }

  let resolveDone;
  /** @type {Promise<ProcessResult>} */
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let exited = false;
  let terminating = false;
  let settled = false;
  const timers = new Set();

  const later = (ms, action) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (facts.error === null && child.pid !== undefined) facts.pid = child.pid;
    if (facts.error !== null) facts.status = null;
    resolveDone(makeResult(facts));
  };

  const record = (code, signal) => {
    if (exited) return;
    exited = true;
    facts.status = typeof code === "number" ? code : null;
    facts.signal = signal ?? null;
  };

  // Destroys the parent's end of every pipe, so a process still holding the
  // other end cannot keep this one waiting.
  const destroyPipes = () => {
    for (const stream of child.stdio) {
      if (stream && !stream.destroyed) stream.destroy();
    }
  };

  // Signals only a started child that has not exited. A failed kill emits
  // 'error', which the listener below ignores; the timers carry on.
  const send = (signal) => {
    if (child.pid !== undefined && !exited) child.kill(signal);
  };

  const release = () => {
    destroyPipes();
    settle();
  };

  const terminate = () => {
    if (settled || terminating) return;
    terminating = true;
    if (exited) {
      release();
      return;
    }
    send("SIGTERM");
    later(graceMs, () => {
      if (exited) {
        release();
        return;
      }
      send("SIGKILL");
      later(reapMs, () => {
        if (!exited) {
          facts.abandoned = true;
          child.unref();
        }
        release();
      });
    });
  };

  child.on("exit", (code, signal) => record(code, signal));
  child.on("close", (code, signal) => {
    record(code, signal);
    settle();
  });
  child.on("error", (err) => {
    // Without a pid the child never started; any other error (a failed kill)
    // is not an outcome, and the termination sequence continues.
    if (child.pid === undefined && facts.error === null) {
      facts.error = err;
      settle();
    }
  });

  const deadline = later(timeoutMs, () => {
    facts.timedOut = true;
    terminate();
  });

  const stop = () => {
    if (settled) return;
    if (!facts.timedOut) {
      facts.stopped = true;
      clearTimeout(deadline);
      timers.delete(deadline);
    }
    terminate();
  };

  return { child, stop, done };
}
