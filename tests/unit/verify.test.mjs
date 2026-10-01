/* Cabrillo Coast LLC — orchestration tests for the verification entry point (AC-16, F-018) */
/**
 * `scripts/verify.mjs` is the one command authors run before a push and the
 * blog-checks workflow runs in CI. Its `main` is run here with injected
 * collaborators: a fake that records every child process instead of starting
 * it, a temporary repository root holding only `_config.yml`, a temporary
 * parent for the fixture folder, and a fake browser preflight. This suite
 * proves that
 *   - the five steps run in their only order, each with its exact program,
 *     arguments, working directory, inherited output and deadline, and each
 *     command is printed before it runs;
 *   - the fixture folder is a fresh `cabrillo-verify-*` folder that exists
 *     for steps 3 to 5, is removed after a pass and kept after a failure;
 *   - JEKYLL_ENV and the caller's SITE_DIR, SITE_BASEURL, SITE_URL and
 *     FIXTURE_DIR reach no step; step 2 gets SITE_URL from `_config.yml`,
 *     step 4 gets all four fixture variables, and VISUAL_CHANGE_INTENDED and
 *     every other variable reach every step;
 *   - `--base` reaches step 5 unchanged, the default is the upstream or
 *     `HEAD` commit, and a base that does not resolve, an unanswered git
 *     query, an unreadable `_config.yml` or a usage error stops the run
 *     before the browser preflight and before any step;
 *   - a refusing browser preflight stops the run before step 1;
 *   - the first failing step decides the exit status and no later step runs.
 *
 * `preflightPlaywright` is run with fake Playwright modules. It must judge
 * both partial installs by launching the browser, never by the path of full
 * Chromium: a headless shell alone passes and full Chromium alone fails with
 * the install command. The last case holds tests/visual/playwright.config.mjs
 * to the launch the probe makes (Chromium, no channel, headless), so a probe
 * that passes means the visual comparison can start its browser.
 *
 * Runs with `node --test tests/unit/verify.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"`. It needs no Jekyll build, no git, no
 * browser and no network. It writes only temporary folders under
 * `os.tmpdir()` and removes them. Loading the visual configuration needs the
 * installed `@playwright/test`, as the visual comparison does. Importing
 * verify.mjs runs nothing: its entry point only starts when it is the
 * program Node runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEADLINES } from '../../scripts/lib/subprocess.mjs';
import { main, preflightPlaywright } from '../../scripts/verify.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** The visual project's configuration and runner, held to the probe's launch. */
const VISUAL_CONFIG = path.join(REPO, 'tests', 'visual', 'playwright.config.mjs');
const VISUAL_RUNNER = path.join(REPO, 'tests', 'visual', 'run-visual.mjs');

/**
 * Injected Node executable. It differs from `process.execPath`, so a step
 * that ignores the injection is caught; the fake never starts it.
 */
const EXEC_PATH = '/cabrillo-verify-test/bin/node';

const ORIGIN_MAIN_SHA = '4611c37f24e4f0c4409dc519abf330a478721c29';
const UPSTREAM_SHA = '0123456789abcdef0123456789abcdef01234567';
const HEAD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

/** What git answers for each revision; any other revision is "not a commit". */
const REFS = Object.freeze({ 'origin/main': ORIGIN_MAIN_SHA, '@{upstream}': UPSTREAM_SHA, HEAD: HEAD_SHA });
const REFS_WITHOUT_UPSTREAM = Object.freeze({ 'origin/main': ORIGIN_MAIN_SHA, HEAD: HEAD_SHA });

const CUSTOM_DOMAIN_URL = 'https://www.cabrillocoast.com';
const PROJECT_URL = 'https://randyamiller.github.io';
const CUSTOM_DOMAIN_CONFIG = `title: Cabrillo Coast\nurl: "${CUSTOM_DOMAIN_URL}"\ntheme: null\nfuture: false\n`;
const PROJECT_PATH_CONFIG = `title: Cabrillo Coast\nurl: "${PROJECT_URL}"\ntheme: null\nfuture: false\n`;

/** A caller environment with nothing verify.mjs removes. */
const CALLER_ENV = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', CABRILLO_VERIFY_MARKER: 'kept' });

/** Values a caller could have left set; none of them may reach a step. */
const HOSTILE_ENV = Object.freeze({
  JEKYLL_ENV: 'production',
  SITE_DIR: '/hostile/site',
  SITE_BASEURL: '/hostile',
  SITE_URL: 'https://hostile.example',
  FIXTURE_DIR: '/hostile/fixtures',
});

const SUITE_VARIABLES = Object.freeze(['SITE_DIR', 'SITE_BASEURL', 'SITE_URL', 'FIXTURE_DIR']);

const USAGE = 'Usage: node scripts/verify.mjs [--base <ref>]';
const INSTALL_COMMAND = 'npx playwright install chromium';
const PLAYWRIGHT_MISSING = 'Playwright is not installed. Run: npm ci && npx playwright install chromium';

/** Playwright 1.63.0's launch error when only full Chromium is installed. */
const SHELL_PATH =
  '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const SHELL_MISSING_LINE = `browserType.launch: Executable doesn't exist at ${SHELL_PATH}`;
const SHELL_MISSING_ERROR =
  `${SHELL_MISSING_LINE}\n` +
  '╔═════════════════════════════════════════════════════════════════════════╗\n' +
  '║ Looks like Playwright Test or Playwright was just installed or updated. ║\n' +
  '║ Please run the following command to download new browsers:              ║\n' +
  '║                                                                         ║\n' +
  '║     npx playwright install                                              ║\n' +
  '╚═════════════════════════════════════════════════════════════════════════╝';

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * A `ProcessResult` as `runSync` returns it: a clean exit 0 unless `facts`
 * says otherwise, with `completed` and `ok` derived the way runSync derives them.
 * @param {{ timeoutMs: number }} options The options the call was made with.
 * @param {object} [facts]
 */
function processResult(options, facts = {}) {
  const result = {
    status: 0,
    signal: null,
    timedOut: false,
    overflowed: false,
    stopped: false,
    abandoned: false,
    error: null,
    stdout: '',
    stderr: '',
    deadlineMs: options.timeoutMs,
    pid: 4242,
    ...facts,
  };
  const completed =
    result.error === null &&
    !result.timedOut &&
    !result.overflowed &&
    !result.stopped &&
    !result.abandoned &&
    result.signal === null &&
    result.status !== null;
  return { ok: completed && result.status === 0, completed, ...result };
}

/** An error as `spawnSync` reports a failed start. */
function spawnError(command, code) {
  return Object.assign(new Error(`spawnSync ${command} ${code}`), { code, syscall: `spawnSync ${command}` });
}

/**
 * Temporary repository root and fixture parent, removed after the test, and
 * the console captured so output is asserted rather than printed.
 * @param {import('node:test').TestContext} t
 * @param {string | null} [config] `_config.yml` contents; null writes none.
 */
function workspace(t, config = CUSTOM_DOMAIN_CONFIG) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-root-'));
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-tmp-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
  if (config !== null) fs.writeFileSync(path.join(root, '_config.yml'), config);
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...parts) => {
    stdout.push(parts.map(String).join(' '));
  });
  t.mock.method(console, 'error', (...parts) => {
    stderr.push(parts.map(String).join(' '));
  });
  return { root, tmpdir, stdout, stderr };
}

/**
 * Runs `main` with a recording stand-in for `runSync` and a counting preflight.
 *
 * git is answered from `refs` for `rev-parse --verify --quiet <ref>^{commit}`
 * (status 1 with no output for a revision it does not hold), or with
 * `gitFacts(ref)` when given. Any other git command is recorded as
 * unexpected. Every other call is a step, answered with `stepFacts(number)`;
 * its call records a copy of its options, the entries of the fixture parent
 * at that moment and the last line printed before it.
 * @param {ReturnType<typeof workspace>} ws
 * @param {string[]} argv
 * @param {object} [options]
 */
async function runVerify(ws, argv, options = {}) {
  const {
    env = { ...CALLER_ENV },
    refs = REFS,
    gitFacts,
    stepFacts = () => ({}),
    preflightResult = null,
    tmpdir = ws.tmpdir,
  } = options;
  const events = [];
  const gitCalls = [];
  const steps = [];
  const unexpected = [];
  let preflightCalls = 0;

  const run = (command, args, callOptions) => {
    const copy = { ...callOptions, env: { ...callOptions.env } };
    if (command === 'git') {
      events.push('git');
      gitCalls.push({ args: [...args], options: copy });
      const query =
        args.length === 4 && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet'
          ? /^(.+)\^\{commit\}$/.exec(args[3])
          : null;
      if (query === null) {
        unexpected.push(['git', ...args].join(' '));
        return processResult(callOptions, { status: 128, stderr: 'unexpected git command' });
      }
      if (gitFacts) return processResult(callOptions, gitFacts(query[1]));
      const sha = Object.hasOwn(refs, query[1]) ? refs[query[1]] : null;
      return processResult(callOptions, sha === null ? { status: 1 } : { stdout: `${sha}\n` });
    }
    const number = steps.length + 1;
    events.push(`step ${number}`);
    steps.push({
      command,
      args: [...args],
      options: copy,
      tmpEntries: fs.existsSync(tmpdir) ? fs.readdirSync(tmpdir) : null,
      lastPrinted: ws.stdout.at(-1),
    });
    return processResult(callOptions, stepFacts(number));
  };

  const preflight = async () => {
    preflightCalls += 1;
    events.push('preflight');
    return preflightResult;
  };

  const code = await main(argv, { env, root: ws.root, run, preflight, tmpdir, execPath: EXEC_PATH });
  assert.deepEqual(unexpected, [], 'only rev-parse queries reach git');
  return { code, events, gitCalls, steps, preflightCalls, fixtureDir: steps[2] ? steps[2].args[1] : undefined };
}

/** The built-output suite variables in `env`, with their values. */
function suiteVariables(env) {
  const present = SUITE_VARIABLES.filter((name) => Object.hasOwn(env, name));
  return Object.fromEntries(present.map((name) => [name, env[name]]));
}

/** The revisions `git rev-parse` was asked about, in order. */
function queriedRevisions(gitCalls) {
  return gitCalls.map((call) => call.args[3]);
}

/**
 * A fake `@playwright/test` whose Chromium launch is `launch`. Records every
 * launch's options, every close and every `executablePath()` call.
 * @param {object} behaviour
 * @param {(options: object) => Promise<object>} behaviour.launch
 * @param {string} [behaviour.executable] What `executablePath()` returns.
 */
function fakePlaywright({ launch, executable = path.join(os.tmpdir(), 'no-such-chromium', 'chrome') }) {
  const record = { launches: [], closes: 0, executablePathCalls: 0 };
  const chromium = {
    executablePath() {
      record.executablePathCalls += 1;
      return executable;
    },
    async launch(options) {
      record.launches.push(options);
      return launch(options, record);
    },
  };
  return { record, module: { chromium } };
}

/** A browser whose close resolves, or rejects with `closeError`. */
function fakeBrowser(record, closeError) {
  return {
    async close() {
      record.closes += 1;
      if (closeError) throw closeError;
    },
  };
}

/** Asserts a launch configuration starts what `chromium.launch({ headless: true })` starts. */
function assertProbeLaunch(use, where) {
  if (use === undefined) return;
  assert.ok(use.browserName === undefined || use.browserName === 'chromium', `${where}: browserName is chromium`);
  assert.equal(use.channel, undefined, `${where}: a channel would launch another executable`);
  assert.notEqual(use.headless, false, `${where}: headed runs launch full Chromium, not the headless shell`);
  const launch = use.launchOptions ?? {};
  assert.equal(launch.channel, undefined, `${where}: launchOptions.channel would launch another executable`);
  assert.equal(launch.executablePath, undefined, `${where}: launchOptions.executablePath bypasses the probe`);
  assert.notEqual(launch.headless, false, `${where}: launchOptions.headless false launches full Chromium`);
}

/* ------------------------------------------------------------------------ */
/* Step sequence                                                             */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] runs the five steps in order: exact commands, folder, output and deadlines', async (t) => {
  const ws = workspace(t);
  const r = await runVerify(ws, ['--base', 'origin/main']);

  assert.equal(r.code, 0);
  assert.equal(r.steps.length, 5);
  const fixtureDir = r.fixtureDir;
  assert.deepEqual(
    r.steps.map((step) => [step.command, step.args]),
    [
      ['bundle', ['exec', 'jekyll', 'build']],
      [EXEC_PATH, ['--test', 'tests/**/*.test.mjs']],
      [EXEC_PATH, ['tests/fixtures/build-fixture-site.mjs', fixtureDir]],
      [EXEC_PATH, ['--test', 'tests/static/built-*.test.mjs']],
      [EXEC_PATH, ['tests/visual/run-visual.mjs', '--base', 'origin/main']],
    ],
  );
  assert.deepEqual(
    r.steps.map((step) => step.options.timeoutMs),
    [DEADLINES.jekyllBuild, DEADLINES.testRun, DEADLINES.fixtureBuild, DEADLINES.testRun, DEADLINES.visualRun],
  );
  for (const step of r.steps) {
    assert.equal(step.options.cwd, ws.root);
    assert.equal(step.options.stdio, 'inherit');
  }

  // The base is checked, then the browser, once, then the steps.
  assert.equal(r.preflightCalls, 1);
  assert.deepEqual(r.events, ['git', 'preflight', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5']);

  // Each command is printed just before it runs.
  r.steps.forEach((step, i) => {
    assert.match(step.lastPrinted, new RegExp(`^\\n==> \\[${i + 1}/5\\] `), `step ${i + 1} header`);
  });
  assert.equal(r.steps[0].lastPrinted, '\n==> [1/5] bundle exec jekyll build');
  assert.equal(r.steps[4].lastPrinted, '\n==> [5/5] node tests/visual/run-visual.mjs --base origin/main');

  // A fresh fixture folder under the injected parent, there for steps 3 to 5, gone after the pass.
  const name = path.basename(fixtureDir);
  assert.equal(path.dirname(fixtureDir), ws.tmpdir);
  assert.match(name, /^cabrillo-verify-.+$/);
  assert.deepEqual(
    r.steps.map((step) => step.tmpEntries),
    [[], [], [name], [name], [name]],
  );
  assert.equal(fs.existsSync(fixtureDir), false);
  assert.deepEqual(fs.readdirSync(ws.tmpdir), []);

  // A caller that declared nothing passes nothing on.
  assert.deepEqual(r.steps[4].options.env, CALLER_ENV);
  assert.equal(ws.stdout.some((line) => line.includes('VISUAL_CHANGE_INTENDED')), false);

  assert.equal(ws.stdout.at(-1), 'verify: all checks passed');
  assert.ok(ws.stdout.includes(`verify: repository: ${ws.root}`));
  assert.deepEqual(ws.stderr, []);
});

test("[AC-16][F-018] strips JEKYLL_ENV and the caller's suite variables; steps 2 and 4 set theirs", async (t) => {
  const ws = workspace(t);
  const env = { ...CALLER_ENV, ...HOSTILE_ENV, VISUAL_CHANGE_INTENDED: '1' };
  const before = { ...env };
  const r = await runVerify(ws, ['--base', 'origin/main'], { env });

  assert.equal(r.code, 0);
  assert.deepEqual(env, before, "the caller's environment is not modified");
  const fixtureDir = r.fixtureDir;
  const kept = { ...CALLER_ENV, VISUAL_CHANGE_INTENDED: '1' };
  assert.deepEqual(
    r.steps.map((step) => step.options.env),
    [
      kept,
      { ...kept, SITE_URL: CUSTOM_DOMAIN_URL },
      kept,
      {
        ...kept,
        SITE_DIR: path.join(fixtureDir, 'project', 'cabrillo-coast'),
        SITE_BASEURL: '/cabrillo-coast',
        SITE_URL: PROJECT_URL,
        FIXTURE_DIR: fixtureDir,
      },
      kept,
    ],
  );
  for (const step of r.steps) assert.equal(Object.hasOwn(step.options.env, 'JEKYLL_ENV'), false);
  assert.deepEqual(suiteVariables(r.steps[1].options.env), { SITE_URL: CUSTOM_DOMAIN_URL });

  // Each removed variable is named with its reason; the intent flag is announced.
  assert.ok(
    ws.stdout.includes(
      'verify: notice: JEKYLL_ENV=production is ignored — a local production build without a Pages API token ' +
        'derives the wrong base path (/pages/randyamiller/cabrillo-coast)',
    ),
  );
  for (const name of SUITE_VARIABLES) {
    assert.ok(
      ws.stdout.some((line) => line.startsWith(`verify: notice: ${name}=${HOSTILE_ENV[name]} is ignored — `)),
      `notice for ${name}`,
    );
  }
  assert.ok(ws.stdout.includes('verify: VISUAL_CHANGE_INTENDED=1 is passed to step 5'));

  // git queries see the caller's environment with optional locks off, in the root, under their deadline.
  assert.equal(r.gitCalls.length, 1);
  for (const call of r.gitCalls) {
    assert.deepEqual(call.options.env, { ...env, GIT_OPTIONAL_LOCKS: '0' });
    assert.equal(call.options.cwd, ws.root);
    assert.equal(call.options.timeoutMs, DEADLINES.gitQuery);
  }
});

/* ------------------------------------------------------------------------ */
/* Deployment host                                                           */
/* ------------------------------------------------------------------------ */

test("[AC-16][F-018] step 2's SITE_URL follows the url in _config.yml", async (t) => {
  const ws = workspace(t, PROJECT_PATH_CONFIG);
  const r = await runVerify(ws, ['--base', 'origin/main']);

  assert.equal(r.code, 0);
  assert.deepEqual(suiteVariables(r.steps[1].options.env), { SITE_URL: PROJECT_URL });
  assert.ok(ws.stdout.includes(`verify: deployment host: ${PROJECT_URL} (_config.yml url, step 2 SITE_URL)`));
});

test('[AC-16][F-018] a _config.yml without a usable url, or none, fails before the preflight', async (t) => {
  const cases = [
    {
      config: 'title: Cabrillo Coast\ntheme: null\n',
      message: "verify: cannot set step 2's SITE_URL: _config.yml sets no url",
    },
    {
      config: 'url: "ftp://www.cabrillocoast.com"\n',
      message:
        "verify: cannot set step 2's SITE_URL: " +
        '_config.yml url "ftp://www.cabrillocoast.com" is not an http or https URL',
    },
    { config: null, message: null },
  ];
  for (const { config, message } of cases) {
    await t.test(`[AC-16][F-018] ${config === null ? 'missing _config.yml' : JSON.stringify(config)}`, async (st) => {
      const ws = workspace(st, config);
      const r = await runVerify(ws, ['--base', 'origin/main']);
      assert.equal(r.code, 1);
      assert.equal(r.preflightCalls, 0);
      assert.deepEqual(r.steps, []);
      const expected = message ?? `verify: cannot read ${path.join(ws.root, '_config.yml')}: `;
      assert.ok(
        ws.stderr.some((line) => (message === null ? line.startsWith(expected) : line === expected)),
        ws.stderr.join('\n'),
      );
    });
  }
});

/* ------------------------------------------------------------------------ */
/* Base revision and command line                                            */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] an explicit --base reaches step 5 unchanged in both spellings', async (t) => {
  for (const argv of [['--base', 'origin/main'], ['--base=origin/main']]) {
    await t.test(`[AC-16][F-018] ${argv.join(' ')}`, async (st) => {
      const ws = workspace(st);
      const r = await runVerify(ws, argv);
      assert.equal(r.code, 0);
      assert.deepEqual(r.steps[4].args, ['tests/visual/run-visual.mjs', '--base', 'origin/main']);
      assert.deepEqual(queriedRevisions(r.gitCalls), ['origin/main^{commit}']);
      assert.ok(ws.stdout.includes('verify: base: origin/main (4611c37)'));
    });
  }
});

test('[AC-16][F-018] without --base, step 5 compares against the upstream commit, or HEAD without one', async (t) => {
  await t.test('[AC-16][F-018] upstream', async (st) => {
    const ws = workspace(st);
    const r = await runVerify(ws, []);
    assert.equal(r.code, 0);
    assert.deepEqual(r.steps[4].args, ['tests/visual/run-visual.mjs', '--base', UPSTREAM_SHA]);
    assert.deepEqual(queriedRevisions(r.gitCalls), ['@{upstream}^{commit}']);
    assert.ok(ws.stdout.includes('verify: base: @{upstream} (0123456)'));
  });
  await t.test('[AC-16][F-018] no upstream', async (st) => {
    const ws = workspace(st);
    const r = await runVerify(ws, [], { refs: REFS_WITHOUT_UPSTREAM });
    assert.equal(r.code, 0);
    assert.deepEqual(r.steps[4].args, ['tests/visual/run-visual.mjs', '--base', HEAD_SHA]);
    assert.deepEqual(queriedRevisions(r.gitCalls), ['@{upstream}^{commit}', 'HEAD^{commit}']);
    assert.ok(ws.stdout.includes('verify: base: HEAD (fedcba9, no upstream)'));
  });
});

test('[AC-16][F-018] a base that does not resolve is a usage error before the preflight and every step', async (t) => {
  const ws = workspace(t);
  const r = await runVerify(ws, ['--base', 'no-such-ref']);

  assert.equal(r.code, 2);
  assert.equal(r.preflightCalls, 0);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(queriedRevisions(r.gitCalls), ['no-such-ref^{commit}']);
  assert.ok(ws.stderr.includes('verify: base revision "no-such-ref" does not resolve to a commit'));
  assert.ok(ws.stderr.includes(USAGE));
  assert.deepEqual(fs.readdirSync(ws.tmpdir), []);
});

test('[AC-16][F-018] a git query that gives no answer fails the run instead of falling back to HEAD', async (t) => {
  const cases = [
    {
      name: 'timed out',
      facts: { status: null, signal: 'SIGKILL', timedOut: true },
      message:
        'verify: git rev-parse --verify --quiet @{upstream}^{commit} ' +
        'exceeded its 1 min deadline and was stopped',
    },
    {
      name: 'not installed',
      facts: { status: null, error: spawnError('git', 'ENOENT') },
      message: 'verify: git could not be started: git not found on PATH — install Git',
    },
  ];
  for (const { name, facts, message } of cases) {
    await t.test(`[AC-16][F-018] ${name}`, async (st) => {
      const ws = workspace(st);
      const r = await runVerify(ws, [], { gitFacts: () => facts });
      assert.equal(r.code, 1);
      assert.deepEqual(queriedRevisions(r.gitCalls), ['@{upstream}^{commit}']);
      assert.equal(r.preflightCalls, 0);
      assert.deepEqual(r.steps, []);
      assert.ok(ws.stderr.includes(message), ws.stderr.join('\n'));
    });
  }
});

test('[AC-16][F-018] a usage error exits 2 and --help exits 0, both without git, preflight or any step', async (t) => {
  const usageErrors = [['--frobnicate'], ['--base'], ['--base', '--help'], ['--base='], ['--base', 'a', '--base', 'b']];
  for (const argv of usageErrors) {
    await t.test(`[AC-16][F-018] usage error: ${argv.join(' ')}`, async (st) => {
      const ws = workspace(st);
      const r = await runVerify(ws, argv);
      assert.equal(r.code, 2);
      assert.deepEqual(r.events, []);
      assert.equal(ws.stderr.at(-1), USAGE);
    });
  }
  for (const argv of [['--help'], ['-h']]) {
    await t.test(`[AC-16][F-018] help: ${argv[0]}`, async (st) => {
      const ws = workspace(st);
      const r = await runVerify(ws, argv);
      assert.equal(r.code, 0);
      assert.deepEqual(r.events, []);
      assert.ok(ws.stdout[0].startsWith(`${USAGE}\n`));
      assert.deepEqual(ws.stderr, []);
    });
  }
});

/* ------------------------------------------------------------------------ */
/* Browser preflight refusal                                                 */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] a refusing browser preflight fails the run before step 1', async (t) => {
  const ws = workspace(t);
  const message = `Playwright Chromium is missing or cannot start. Run: ${INSTALL_COMMAND}`;
  const r = await runVerify(ws, ['--base', 'origin/main'], { preflightResult: message });

  assert.equal(r.code, 1);
  assert.equal(r.preflightCalls, 1);
  assert.deepEqual(r.events, ['git', 'preflight']);
  assert.deepEqual(r.steps, []);
  assert.ok(ws.stderr.includes(`verify: ${message}`));
  assert.deepEqual(fs.readdirSync(ws.tmpdir), []);
});

/* ------------------------------------------------------------------------ */
/* First failure                                                             */
/* ------------------------------------------------------------------------ */

for (const failing of [1, 2, 3, 4, 5]) {
  test(`[AC-16][F-018] a failure of step ${failing} is the exit status and no later step runs`, async (t) => {
    const ws = workspace(t);
    const r = await runVerify(ws, ['--base', 'origin/main'], {
      stepFacts: (number) => (number === failing ? { status: 10 + failing } : {}),
    });

    assert.equal(r.code, 10 + failing);
    assert.equal(r.steps.length, failing);
    assert.ok(ws.stderr.some((line) => line.startsWith(`verify: step ${failing} failed (`)), ws.stderr.join('\n'));
    assert.equal(ws.stdout.includes('verify: all checks passed'), false);
    if (failing < 3) {
      assert.deepEqual(fs.readdirSync(ws.tmpdir), [], 'no fixture folder before step 3');
      assert.equal(ws.stderr.some((line) => line.includes('fixture builds kept')), false);
    } else {
      assert.equal(fs.statSync(r.fixtureDir).isDirectory(), true, 'the fixture folder is kept');
      assert.ok(ws.stderr.includes(`verify: fixture builds kept for inspection in ${r.fixtureDir}`));
    }
  });
}

test('[AC-16][F-018] a step killed, timed out or unable to start fails with 1 and stops the run', async (t) => {
  const cases = [
    {
      name: 'signal',
      failing: 2,
      facts: { status: null, signal: 'SIGTERM' },
      message: 'verify: node was killed by SIGTERM',
    },
    {
      name: 'deadline',
      failing: 1,
      facts: { status: null, signal: 'SIGKILL', timedOut: true },
      message: 'verify: step 1 exceeded its 10 min deadline: bundle exceeded its 10 min deadline and was stopped',
    },
    {
      name: 'deadline with a clean exit status',
      failing: 4,
      facts: { status: 0, timedOut: true },
      message: 'verify: step 4 exceeded its 20 min deadline: node exceeded its 20 min deadline and was stopped',
    },
    {
      name: 'bundle not found',
      failing: 1,
      facts: { status: null, error: spawnError('bundle', 'ENOENT') },
      message: 'verify: bundle not found — install Ruby 3.3.4 and run bundle install',
    },
    {
      name: 'node not startable',
      failing: 3,
      facts: { status: null, error: spawnError(EXEC_PATH, 'EACCES') },
      message: `verify: node could not be started: spawnSync ${EXEC_PATH} EACCES`,
    },
  ];
  for (const { name, failing, facts, message } of cases) {
    await t.test(`[AC-16][F-018] ${name}`, async (st) => {
      const ws = workspace(st);
      const r = await runVerify(ws, ['--base', 'origin/main'], {
        stepFacts: (number) => (number === failing ? facts : {}),
      });
      assert.equal(r.code, 1);
      assert.equal(r.steps.length, failing);
      assert.ok(ws.stderr.includes(message), ws.stderr.join('\n'));
      assert.ok(ws.stderr.some((line) => line.startsWith(`verify: step ${failing} failed (`)));
    });
  }
});

test('[AC-16][F-018] a fixture folder that cannot be created fails the run before step 3', async (t) => {
  const ws = workspace(t);
  const parent = path.join(ws.tmpdir, 'missing-parent');
  const r = await runVerify(ws, ['--base', 'origin/main'], { tmpdir: parent });

  assert.equal(r.code, 1);
  assert.equal(r.steps.length, 2);
  assert.ok(ws.stderr.some((line) => line.startsWith(`verify: cannot create the fixture folder under ${parent}: `)));
});

/* ------------------------------------------------------------------------ */
/* Browser preflight probe                                                   */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] the preflight accepts a headless-shell-only install by launching it', async () => {
  const fake = fakePlaywright({ launch: (options, record) => fakeBrowser(record) });
  const message = await preflightPlaywright({ load: async () => fake.module });

  assert.equal(message, null);
  assert.equal(fake.record.launches.length, 1);
  const [options] = fake.record.launches;
  assert.equal(options.headless, true);
  assert.ok(Number.isFinite(options.timeout) && options.timeout > 0, 'the launch has a finite timeout');
  assert.equal(Object.hasOwn(options, 'channel'), false);
  assert.equal(Object.hasOwn(options, 'executablePath'), false);
  assert.equal(fake.record.closes, 1);
  assert.equal(fake.record.executablePathCalls, 0, 'the path of full Chromium decides nothing');
});

test('[AC-16][F-018] the preflight refuses a full-Chromium-only install with the install command', async () => {
  const fake = fakePlaywright({
    executable: process.execPath,
    launch: async () => {
      throw new Error(SHELL_MISSING_ERROR);
    },
  });
  const message = await preflightPlaywright({ load: async () => fake.module, timeoutMs: 1234 });

  assert.equal(typeof message, 'string');
  assert.ok(message.includes(INSTALL_COMMAND), message);
  assert.ok(message.includes(SHELL_MISSING_LINE), message);
  assert.equal(message.includes('╔'), false, 'only the first line of the launch error is kept');
  assert.equal(fake.record.launches.length, 1);
  assert.equal(fake.record.launches[0].timeout, 1234);
  assert.equal(fake.record.closes, 0);
  assert.equal(fake.record.executablePathCalls, 0, 'an existing full Chromium does not pass the probe');
});

test('[AC-16][F-018] a launch failure with a blank reason is reported as the install command alone', async () => {
  const fake = fakePlaywright({
    launch: async () => {
      throw '\n  \n';
    },
  });
  const message = await preflightPlaywright({ load: async () => fake.module });
  assert.ok(message.includes(INSTALL_COMMAND), message);
  assert.equal(message.includes('\n'), false);
});

test('[AC-16][F-018] the preflight refuses a missing or incomplete Playwright install', async () => {
  const notFound = Object.assign(new Error("Cannot find package '@playwright/test'"), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.equal(
    await preflightPlaywright({
      load: async () => {
        throw notFound;
      },
    }),
    PLAYWRIGHT_MISSING,
  );
  const broken = await preflightPlaywright({
    load: async () => {
      throw new SyntaxError('Unexpected token in playwright/lib/index.js');
    },
  });
  assert.equal(broken, `${PLAYWRIGHT_MISSING}\n(Unexpected token in playwright/lib/index.js)`);
  for (const module of [{}, { chromium: {} }, { chromium: { executablePath: () => process.execPath } }, null]) {
    assert.equal(await preflightPlaywright({ load: async () => module }), PLAYWRIGHT_MISSING, JSON.stringify(module));
  }
});

test('[AC-16][F-018] the preflight reads Chromium from a default export and ignores a failed close', async () => {
  const closing = fakePlaywright({ launch: (options, record) => fakeBrowser(record, new Error('Target closed')) });
  assert.equal(await preflightPlaywright({ load: async () => ({ default: closing.module }) }), null);
  assert.equal(closing.record.launches.length, 1);
  assert.equal(closing.record.closes, 1);
});

/* ------------------------------------------------------------------------ */
/* Probe and visual project agree                                            */
/* ------------------------------------------------------------------------ */

test('[AC-16][F-018] the visual project launches Chromium exactly as the preflight probe does', async (t) => {
  const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-baseline-'));
  const saved = {
    VISUAL_BASELINE_DIR: process.env.VISUAL_BASELINE_DIR,
    VISUAL_RESULTS_FILE: process.env.VISUAL_RESULTS_FILE,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(baselineDir, { recursive: true, force: true });
  });
  process.env.VISUAL_BASELINE_DIR = baselineDir;
  delete process.env.VISUAL_RESULTS_FILE;

  const { default: config } = await import(pathToFileURL(VISUAL_CONFIG).href);
  assertProbeLaunch(config.use, 'use');
  assert.ok(Array.isArray(config.projects) && config.projects.length > 0, 'at least one project');
  for (const project of config.projects) {
    assert.equal(project.use?.browserName, 'chromium', `project ${project.name} runs Chromium`);
    assertProbeLaunch(project.use, `project ${project.name}`);
  }

  // The runner's command line must not switch the browser either.
  const runner = fs.readFileSync(VISUAL_RUNNER, 'utf8');
  assert.equal(/--headed\b/.test(runner), false, 'run-visual.mjs passes no --headed');
  assert.equal(/--browser\b/.test(runner), false, 'run-visual.mjs passes no --browser');
});
