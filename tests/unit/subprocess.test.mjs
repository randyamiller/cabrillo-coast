/* Cabrillo Coast LLC — tests for the child-process transport (node:test, Node built-ins only) */
/**
 * `scripts/lib/subprocess.mjs` is the one transport every blog script uses to
 * run a child process. Its two functions carry two guarantees:
 *   - `runSync`, used by the publishing tool's git calls (AC-03, F-017), never
 *     blocks past its deadline, even against a child that ignores SIGTERM,
 *     and reports a signal, an overflow and a failed start as distinct facts
 *     rather than as an ordinary exit status;
 *   - `spawnSupervised`, used by the verification and visual harness (AC-16,
 *     F-018), escalates SIGTERM → SIGKILL at its deadline, resolves when a
 *     grandchild keeps the child's pipes open, gives up on a child that
 *     survives SIGKILL, and reports the caller's `stop()` as such.
 *
 * Every child is `process.execPath -e <script>`, so the suite runs wherever
 * Node does. Deadlines and grace periods are mostly a few hundred
 * milliseconds, and the whole file takes a few seconds. One is longer only
 * where a child must have started first (installed its SIGTERM handler,
 * spawned its grandchild) or where a case proves a period was not waited out.
 *
 * No case leaves a process behind. Every long-running child ends by itself
 * after `LIFETIME_MS` at the latest. The grandchild exits once its output
 * pipe is gone and is otherwise killed by the case that started it, and the
 * abandoned child is killed by its case.
 * Each child's script starts with `MARK`, so `pgrep -f` can confirm this.
 *
 * Runs with `node --test tests/unit/subprocess.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no build, no git and no
 * network, and writes no files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEADLINES,
  KILL_GRACE_MS,
  REAP_WAIT_MS,
  describeResult,
  formatDuration,
  runSync,
  spawnSupervised,
} from '../../scripts/lib/subprocess.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const NODE = process.execPath;

/** First text of every child's script, so a leftover process can be found with `pgrep -f`. */
const MARK = '/* cabrillo-subprocess-test */';

/** Deadline for a child that ends by itself: generous, since it is never reached. */
const ROOMY_MS = 30_000;

/** Deadline for a child that must be stopped by it. */
const SHORT_MS = 300;

/**
 * Deadline for a child that must start first (install a handler, spawn a
 * grandchild). Node starts in tens of milliseconds; this leaves room for load.
 */
const STARTED_MS = 1_000;

/** Grace and reap periods for the supervised cases. */
const GRACE_MS = 300;
const REAP_MS = 300;

/** Allowance for scheduling delay on a loaded machine. */
const SLACK_MS = 5_000;

/** Every long-running child exits by itself after this, whatever happens to a case. */
const LIFETIME_MS = 20_000;

/** Exit after `LIFETIME_MS`. */
const LIFETIME = `setTimeout(() => process.exit(0), ${LIFETIME_MS});`;

/** Runs until its lifetime ends; default SIGTERM handling, so SIGTERM ends it. */
const LONG_RUNNING = `setInterval(() => {}, 1000); ${LIFETIME}`;

/** Ignores SIGTERM, so only SIGKILL ends it before its lifetime does. */
const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); ${LIFETIME}`;

/** A command that exists nowhere on PATH. */
const MISSING_COMMAND = 'cabrillo-coast-no-such-command';

/** A path that exists but is not a directory, for a working directory the system refuses. */
const THIS_FILE = fileURLToPath(import.meta.url);

/** Per-case limit for the supervised cases, so a broken supervisor fails instead of hanging. */
const CASE = { timeout: 30_000 };

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The `-e` arguments for a child running `body`.
 * @param {string} body
 * @returns {string[]}
 */
function script(body) {
  return ['-e', `${MARK} ${body}`];
}

/**
 * Collects a readable stream's text as it arrives.
 * @param {import('node:stream').Readable} stream
 * @returns {{ text: () => string }}
 */
function collect(stream) {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    text += chunk;
  });
  return { text: () => text };
}

/**
 * Resolves true once `text` has arrived on the stream, or false if the stream
 * ends first, so a child that dies early fails its case instead of hanging it.
 * @param {import('node:stream').Readable} stream
 * @param {string} text
 * @returns {Promise<boolean>}
 */
function waitForText(stream, text) {
  return new Promise((resolve) => {
    let seen = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      seen += chunk;
      if (seen.includes(text)) resolve(true);
    });
    stream.once('close', () => resolve(seen.includes(text)));
  });
}

/**
 * True while a process with this id exists (signal 0 tests without sending).
 * @param {number} pid
 * @returns {boolean}
 */
function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

/**
 * Sends SIGKILL to a process this suite started, if it still exists.
 * @param {number} pid
 */
function killIfPresent(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

/**
 * Waits up to `ms` for a process to disappear.
 * @param {number} pid
 * @param {number} ms
 * @returns {Promise<boolean>} true when it is gone.
 */
async function waitGone(pid, ms) {
  const until = Date.now() + ms;
  while (exists(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* Deadlines and messages                                                    */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] formatDuration writes milliseconds, seconds and minutes at one decimal at most', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(750), '750 ms');
  assert.equal(formatDuration(999.6), '1 s');
  assert.equal(formatDuration(1500), '1.5 s');
  assert.equal(formatDuration(30_000), '30 s');
  assert.equal(formatDuration(59_990), '1 min');
  assert.equal(formatDuration(60_000), '1 min');
  assert.equal(formatDuration(90_000), '1.5 min');
  assert.equal(formatDuration(600_000), '10 min');
  assert.equal(formatDuration(DEADLINES.fixtureBuild), '40 min');
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '30']) {
    assert.throws(() => formatDuration(bad), TypeError, `formatDuration(${String(bad)})`);
  }
});

test('[AC-16][F-018] DEADLINES is frozen and every composite exceeds the deadlines it contains', () => {
  assert.ok(Object.isFrozen(DEADLINES));
  assert.deepEqual(
    { ...DEADLINES },
    {
      gitQuery: 60_000,
      gitArchive: 120_000,
      tarExtract: 120_000,
      gitLog: 300_000,
      jekyllBuild: 600_000,
      testRun: 1_200_000,
      playwrightRun: 900_000,
      httpRequest: 30_000,
      fixtureBuild: 2_400_000,
      visualRun: 7_380_000,
    },
  );
  const d = DEADLINES;
  assert.equal(d.fixtureBuild, 3 * d.jekyllBuild + d.gitArchive + d.tarExtract + d.gitQuery + 300_000);
  assert.equal(
    d.visualRun,
    2 * d.fixtureBuild + 2 * d.playwrightRun + d.gitLog + d.gitQuery + 4 * d.httpRequest + 300_000,
  );
  for (const inner of ['jekyllBuild', 'gitArchive', 'tarExtract', 'gitQuery']) {
    assert.ok(d.fixtureBuild > d[inner], `fixtureBuild must exceed ${inner}`);
  }
  for (const inner of ['fixtureBuild', 'playwrightRun', 'gitLog', 'gitQuery', 'httpRequest']) {
    assert.ok(d.visualRun > d[inner], `visualRun must exceed ${inner}`);
  }
  assert.equal(KILL_GRACE_MS, 10_000);
  assert.equal(REAP_WAIT_MS, 10_000);
});

/* ------------------------------------------------------------------------ */
/* runSync                                                                   */
/* ------------------------------------------------------------------------ */

test('[AC-03][F-017] runSync captures UTF-8 stdout and stderr of a child that exits 0', () => {
  const result = runSync(NODE, script('process.stdout.write("héllo wörld"); process.stderr.write("note")'), {
    timeoutMs: ROOMY_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.overflowed, false);
  assert.equal(result.stopped, false);
  assert.equal(result.abandoned, false);
  assert.equal(result.error, null);
  assert.equal(result.stdout, 'héllo wörld');
  assert.equal(result.stderr, 'note');
  assert.equal(result.deadlineMs, ROOMY_MS);
  assert.equal(typeof result.pid, 'number');
  assert.equal(describeResult(result), 'exited with status 0');
});

test('[AC-03][F-017] runSync returns stdout as a Buffer with encoding "buffer" and stderr still as a string', () => {
  const result = runSync(
    NODE,
    script('process.stdout.write(Buffer.from([0, 255, 10, 1])); process.stderr.write("wärning")'),
    { timeoutMs: ROOMY_MS, encoding: 'buffer' },
  );
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.deepEqual([...result.stdout], [0, 255, 10, 1]);
  assert.equal(result.stderr, 'wärning');
});

test('[AC-03][F-017] runSync reports a nonzero exit as completed but not ok', () => {
  const result = runSync(NODE, script('process.stderr.write("bad ref"); process.exit(3)'), { timeoutMs: ROOMY_MS });
  assert.equal(result.completed, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, 'bad ref');
  assert.equal(describeResult(result), 'exited with status 3');
});

test('[AC-03][F-017] runSync kills a child that ignores SIGTERM at its deadline, long before the child would end', () => {
  const started = Date.now();
  const result = runSync(NODE, script(IGNORES_SIGTERM), { timeoutMs: SHORT_MS });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < SLACK_MS, `runSync returned after ${elapsed} ms; the deadline is ${SHORT_MS} ms`);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.status, null);
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, null, 'the deadline is reported by timedOut, not as a start failure');
  assert.equal(result.deadlineMs, SHORT_MS);
  assert.equal(describeResult(result), 'exceeded its 300 ms deadline and was stopped');
});

test('[AC-03][F-017] runSync reports a child killed by a signal from elsewhere as neither completed nor timed out', () => {
  const result = runSync(NODE, script('process.kill(process.pid, "SIGKILL")'), { timeoutMs: ROOMY_MS });
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, null);
  assert.equal(describeResult(result), 'was killed by SIGKILL');
});

test('[AC-03][F-017] runSync reports output beyond maxBuffer as an overflow, naming the limit when given', () => {
  const result = runSync(NODE, script('process.stdout.write("x".repeat(100000))'), {
    timeoutMs: ROOMY_MS,
    maxBuffer: 1000,
  });
  assert.equal(result.overflowed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, null, 'the overflow is reported by overflowed, not as a start failure');
  assert.equal(describeResult(result, 1000), 'produced more output than its capture limit of 1000 bytes and was killed');
  assert.equal(
    describeResult(result, 256 * 1024 * 1024),
    'produced more output than its capture limit of 256 MiB and was killed',
  );
  assert.equal(describeResult(result), 'produced more output than its capture limit and was killed');
});

test('[AC-03][F-017] runSync reports a command missing from PATH as a start failure', () => {
  const result = runSync(MISSING_COMMAND, [], { timeoutMs: ROOMY_MS });
  assert.equal(result.error?.code, 'ENOENT');
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.pid, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(describeResult(result), 'could not be started: not found on PATH');
});

test('[AC-03][F-017] runSync reports a working directory that is not a directory as a start failure', () => {
  const result = runSync(NODE, script('process.exit(0)'), { timeoutMs: ROOMY_MS, cwd: THIS_FILE });
  assert.ok(result.error instanceof Error, 'the refusal is reported in error');
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.pid, null);
  assert.equal(describeResult(result), `could not be started: ${result.error.message}`);
});

test('[AC-03][F-017] runSync writes input to standard input, and closes it when there is none', () => {
  const echo = 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(s.toUpperCase()))';
  const fed = runSync(NODE, script(echo), { timeoutMs: ROOMY_MS, input: 'abc\0def' });
  assert.equal(fed.ok, true);
  assert.equal(fed.stdout, 'ABC\0DEF');
  const unfed = runSync(NODE, script(echo), { timeoutMs: ROOMY_MS });
  assert.equal(unfed.ok, true, 'a child reading standard input must see its end, not wait');
  assert.equal(unfed.stdout, '');
});

test('[AC-03][F-017] runSync with stdio "inherit" captures nothing', () => {
  const text = runSync(NODE, script('process.exit(0)'), { timeoutMs: ROOMY_MS, stdio: 'inherit' });
  assert.equal(text.ok, true);
  assert.equal(text.stdout, '');
  assert.equal(text.stderr, '');
  const bytes = runSync(NODE, script('process.exit(0)'), { timeoutMs: ROOMY_MS, stdio: 'inherit', encoding: 'buffer' });
  assert.equal(bytes.ok, true);
  assert.ok(Buffer.isBuffer(bytes.stdout));
  assert.equal(bytes.stdout.length, 0);
});

test('[AC-03][F-017] runSync refuses a missing or invalid deadline and invalid options with a TypeError', () => {
  const args = script('process.exit(0)');
  for (const timeoutMs of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '1000']) {
    assert.throws(() => runSync(NODE, args, { timeoutMs }), TypeError, `timeoutMs ${String(timeoutMs)}`);
  }
  assert.throws(() => runSync(NODE, args), TypeError, 'no options at all');
  assert.throws(() => runSync(NODE, args, { timeoutMs: ROOMY_MS, stdio: 'ignore' }), TypeError);
  assert.throws(() => runSync(NODE, args, { timeoutMs: ROOMY_MS, encoding: 'latin1' }), TypeError);
  assert.throws(() => runSync(NODE, args, { timeoutMs: ROOMY_MS, stdio: 'inherit', input: 'x' }), TypeError);
  assert.throws(() => runSync(NODE, args, { timeoutMs: ROOMY_MS, maxBuffer: 0 }), TypeError);
});

/* ------------------------------------------------------------------------ */
/* spawnSupervised                                                           */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] spawnSupervised resolves exit 0 as ok and a nonzero exit as completed but not ok', CASE, async () => {
  const passed = await spawnSupervised(NODE, script('process.exit(0)'), { timeoutMs: ROOMY_MS }).done;
  assert.equal(passed.ok, true);
  assert.equal(passed.completed, true);
  assert.equal(passed.status, 0);
  assert.equal(passed.signal, null);
  assert.equal(passed.timedOut, false);
  assert.equal(passed.overflowed, false);
  assert.equal(passed.stopped, false);
  assert.equal(passed.abandoned, false);
  assert.equal(passed.error, null);
  assert.equal(passed.stdout, '');
  assert.equal(passed.stderr, '');
  assert.equal(passed.deadlineMs, ROOMY_MS);
  assert.equal(typeof passed.pid, 'number');

  const failed = await spawnSupervised(NODE, script('process.exit(4)'), { timeoutMs: ROOMY_MS }).done;
  assert.equal(failed.completed, true);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 4);
  assert.equal(describeResult(failed), 'exited with status 4');
});

test('[AC-16][F-018] spawnSupervised sends SIGTERM at the deadline, which ends a default child', CASE, async () => {
  const started = Date.now();
  const result = await spawnSupervised(NODE, script(LONG_RUNNING), {
    timeoutMs: SHORT_MS,
    graceMs: GRACE_MS,
    reapMs: REAP_MS,
  }).done;
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.equal(result.abandoned, false);
  assert.ok(elapsed < SHORT_MS + SLACK_MS, `resolved after ${elapsed} ms`);
  assert.equal(describeResult(result), 'exceeded its 300 ms deadline and was stopped');
});

test('[AC-16][F-018] spawnSupervised escalates to SIGKILL after the grace period for a child that ignores SIGTERM', CASE, async () => {
  const run = spawnSupervised(NODE, script(`${IGNORES_SIGTERM} process.stdout.write("ready");`), {
    stdio: ['ignore', 'pipe', 'inherit'],
    timeoutMs: STARTED_MS,
    graceMs: GRACE_MS,
    reapMs: REAP_MS,
  });
  const started = Date.now();
  const output = collect(run.child.stdout);
  const result = await run.done;
  const elapsed = Date.now() - started;
  assert.equal(output.text(), 'ready', 'the child must install its SIGTERM handler before the deadline');
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.completed, false);
  assert.equal(result.abandoned, false);
  assert.ok(elapsed >= STARTED_MS + GRACE_MS - 50, `SIGKILL must wait for the grace period; resolved after ${elapsed} ms`);
  assert.ok(elapsed < STARTED_MS + GRACE_MS + SLACK_MS, `resolved after ${elapsed} ms`);
  assert.equal(describeResult(result), 'exceeded its 1 s deadline and was stopped');
});

test('[AC-16][F-018] spawnSupervised stop() ends the child as stopped, not timed out', CASE, async () => {
  const run = spawnSupervised(NODE, script(LONG_RUNNING), { timeoutMs: ROOMY_MS, graceMs: GRACE_MS, reapMs: REAP_MS });
  run.stop();
  run.stop();
  const result = await run.done;
  assert.equal(result.stopped, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.abandoned, false);
  assert.equal(describeResult(result), 'was stopped');
  run.stop();
  assert.equal(await run.done, result, 'done resolves once; a late stop() changes nothing');
});

test('[AC-16][F-018] spawnSupervised credits whichever of stop() and the deadline came first in an escalation', CASE, async () => {
  // Both children ignore SIGTERM, so each run is still escalating when the
  // other event arrives: the deadline passes during a stop's grace period, and
  // stop() is called during a deadline's grace period.
  const options = { stdio: ['ignore', 'pipe', 'inherit'], timeoutMs: STARTED_MS, graceMs: 1_500, reapMs: REAP_MS };
  const body = `${IGNORES_SIGTERM} process.stdout.write("ready");`;

  const stopFirst = async () => {
    const run = spawnSupervised(NODE, script(body), options);
    const ready = await waitForText(run.child.stdout, 'ready');
    run.stop();
    return { ready, result: await run.done };
  };
  const deadlineFirst = async () => {
    const run = spawnSupervised(NODE, script(body), options);
    const started = Date.now();
    const ready = await waitForText(run.child.stdout, 'ready');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, STARTED_MS + 200 - (Date.now() - started))));
    run.stop();
    return { ready, result: await run.done };
  };
  const [stopped, expired] = await Promise.all([stopFirst(), deadlineFirst()]);

  assert.ok(stopped.ready && expired.ready, 'each child must install its SIGTERM handler before the deadline');
  assert.equal(stopped.result.stopped, true);
  assert.equal(stopped.result.timedOut, false, 'stop() cancels the deadline');
  assert.equal(stopped.result.signal, 'SIGKILL');
  assert.equal(describeResult(stopped.result), 'was stopped');
  assert.equal(expired.result.timedOut, true);
  assert.equal(expired.result.stopped, false, 'a stop() after the deadline does not relabel the outcome');
  assert.equal(expired.result.signal, 'SIGKILL');
  assert.equal(describeResult(expired.result), 'exceeded its 1 s deadline and was stopped');
});

test('[AC-16][F-018] spawnSupervised reports a command missing from PATH as a start failure', CASE, async () => {
  const run = spawnSupervised(MISSING_COMMAND, [], { timeoutMs: ROOMY_MS });
  assert.ok(run.child !== null, 'an asynchronous start failure still returns the ChildProcess');
  const result = await run.done;
  assert.equal(result.error?.code, 'ENOENT');
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.pid, null);
  assert.equal(describeResult(result), 'could not be started: not found on PATH');
  run.stop();
});

test('[AC-16][F-018] spawnSupervised resolves an operating-system refusal to start instead of throwing', CASE, async () => {
  // Linux refuses a file as working directory synchronously (ENOTDIR), so no
  // ChildProcess exists; elsewhere the refusal may arrive as an 'error' event.
  const run = spawnSupervised(NODE, script('process.exit(0)'), { timeoutMs: ROOMY_MS, cwd: THIS_FILE });
  assert.ok(run.child === null || run.child.pid === undefined, 'no process was started');
  const result = await run.done;
  assert.ok(result.error instanceof Error, 'the refusal is reported in error');
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.pid, null);
  assert.equal(result.timedOut, false);
  assert.equal(describeResult(result), `could not be started: ${result.error.message}`);
  run.stop();
});

test("[AC-16][F-018] spawnSupervised resolves at the deadline when a grandchild keeps the exited child's stdout open", CASE, async () => {
  // The grandchild writes to the inherited pipe until that write fails, so it
  // exits by itself once the supervisor destroys the parent's end.
  const grandchild = `${MARK} setInterval(() => process.stdout.write("."), 100); ${LIFETIME}`;
  const child = [
    'const { spawn } = require("node:child_process");',
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "ignore"] });`,
    'g.unref();',
    'process.stdout.write(g.pid + "\\n", () => process.exit(0));',
  ].join(' ');
  // The default grace and reap periods (10 s each) exceed SLACK_MS, so resolving
  // in time proves no signal sequence ran for a child that had already exited.
  const run = spawnSupervised(NODE, script(child), { stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: STARTED_MS });
  const started = Date.now();
  const output = collect(run.child.stdout);
  const result = await run.done;
  const elapsed = Date.now() - started;
  const grandchildPid = Number.parseInt(output.text().split('\n')[0], 10);
  try {
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `grandchild pid from ${JSON.stringify(output.text())}`);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 0, 'the child itself exited before the deadline');
    assert.equal(result.signal, null);
    assert.equal(result.completed, false);
    assert.equal(result.abandoned, false);
    assert.ok(elapsed >= STARTED_MS - 50, `resolved after ${elapsed} ms, before the deadline`);
    assert.ok(elapsed < STARTED_MS + SLACK_MS, `resolved after ${elapsed} ms; it must not wait out the grace period`);
    assert.ok(run.child.stdout.destroyed, "the parent's end of the pipe is destroyed");
  } finally {
    if (Number.isInteger(grandchildPid) && grandchildPid > 0 && !(await waitGone(grandchildPid, 2_000))) {
      killIfPresent(grandchildPid);
    }
  }
});

test('[AC-16][F-018] spawnSupervised abandons a child that survives SIGKILL after the reap period', CASE, async () => {
  const run = spawnSupervised(NODE, script(LONG_RUNNING), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: ROOMY_MS,
    graceMs: GRACE_MS,
    reapMs: REAP_MS,
  });
  const { child } = run;
  // No signal reaches the child, as with a process stuck in the kernel.
  const sent = [];
  child.kill = (signal) => {
    sent.push(signal);
    return true;
  };
  try {
    const started = Date.now();
    run.stop();
    const result = await run.done;
    const elapsed = Date.now() - started;
    assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
    assert.equal(result.abandoned, true);
    assert.equal(result.stopped, true);
    assert.equal(result.completed, false);
    assert.equal(result.status, null);
    assert.equal(result.signal, null);
    assert.equal(result.pid, child.pid);
    assert.ok(child.stdout.destroyed && child.stderr.destroyed, 'the pipes are destroyed');
    assert.ok(elapsed >= GRACE_MS + REAP_MS - 50, `abandoned after ${elapsed} ms`);
    assert.equal(
      describeResult(result),
      `was stopped; it did not exit after SIGKILL and was abandoned (pid ${child.pid})`,
    );
  } finally {
    // The abandoned child is still this process's unreaped child, so its pid is its own.
    killIfPresent(child.pid);
  }
});

test('[AC-16][F-018] spawnSupervised refuses a missing or invalid duration with a TypeError', () => {
  const args = script('process.exit(0)');
  for (const timeoutMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '300']) {
    assert.throws(() => spawnSupervised(NODE, args, { timeoutMs }), TypeError, `timeoutMs ${String(timeoutMs)}`);
  }
  assert.throws(() => spawnSupervised(NODE, args), TypeError, 'no options at all');
  assert.throws(() => spawnSupervised(NODE, args, { timeoutMs: ROOMY_MS, graceMs: 0 }), TypeError);
  assert.throws(() => spawnSupervised(NODE, args, { timeoutMs: ROOMY_MS, reapMs: Number.NaN }), TypeError);
});
