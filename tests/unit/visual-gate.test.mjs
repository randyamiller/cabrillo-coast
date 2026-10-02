/* Cabrillo Coast LLC — regression proof of the visual comparison gate's outcomes (AC-16, F-018) */
/**
 * `tests/visual/run-visual.mjs` is the gate that keeps a visual change from
 * reaching the site unseen (AC-16): it builds the base revision and the
 * working tree, records the baseline from the base and compares the working
 * tree against it, and accepts a difference only when it is declared and is
 * nothing but a screenshot difference. This suite proves both halves.
 *
 * `classifyComparison`, the classifier of the comparison run's JSON report,
 * is fed reports built from the shapes Playwright Test 1.63.0 really writes
 * (`tests/unit/lib/visual-gate-harness.mjs`): the 12 cases of
 * `tests/visual/blog-visual.spec.mjs` nested in its describe block, colour
 * sequences in the messages, and the attachments each failure carries.
 * Pixel, size and zero-tolerance differences with their actual image are
 * differences; every other failure, missing case, run-level error or input
 * that is not a report is a problem, with the exact line printed for it.
 *
 * The gate's outcomes run the REAL runner as a child process, copied with the
 * fixture builder, the transport and the pixel module into a temporary git
 * repository it derives as its own from its location. Stand-ins replace the
 * slow tools only: `bundle` first on PATH writes small pages that hold the
 * staged `styles.css` and fixture articles and logs each build's staged
 * source; `node_modules/@playwright/test/cli.js` fetches the two served pages,
 * writes the baseline in `--update-snapshots=all` mode, compares in `none`
 * mode, writes a real-shaped report and injects one fault per case. Each case
 * asserts the exit code, the lines printed, what the stand-ins were given and
 * that no `blog-visual-*` workspace is left in its TMPDIR. Together they prove
 * that the baseline comes from the archived base commit while the comparison
 * uses the working tree, on two different servers, that both hold the
 * working tree's fixture articles, that a `Visual-Change: intended` trailer
 * declares a change from any commit in `<base>..HEAD`, a `--no-ff` merge
 * commit included, and that undeclared, mixed, incomplete, interrupted and
 * unreadable runs, broken baselines and broken builds fail whatever was
 * declared, while the pre-blog base is skipped with a notice.
 * `--help` and `-h` print the full help and start nothing; beside an unknown
 * argument they are a usage error.
 *
 * Runs with `node --test tests/unit/visual-gate.test.mjs` or as part of
 * `node --test "tests/**\/*.test.mjs"` (Node 22 or later, git, tar and a
 * POSIX shell). No Jekyll, browser or network is used. Git is isolated as in
 * tests/unit/article-cli.test.mjs, and everything is written below one
 * folder in `os.tmpdir()`, removed afterwards; nothing in this repository is
 * written or read through git.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEADLINES, formatDuration } from '../../scripts/lib/subprocess.mjs';
import { strictMismatchMessage } from '../visual/lib/pixels.mjs';
import { classifyComparison } from '../visual/run-visual.mjs';
import {
  BASE_STYLES,
  CASES,
  DELETED_REL,
  DESCRIBE_TITLE,
  DRAFT_IMAGE_REL,
  FIXTURE_EDIT,
  FIXTURE_POST_FILES,
  REAL_DRAFT_REL,
  REAL_POST_REL,
  ROOT,
  UNTRACKED_REL,
  WORK_STYLES,
  buildReport,
  changeWorkingTree,
  commitAll,
  commitBlogSource,
  createSandbox,
  createSiteRepo,
  evidence,
  failed,
  git,
  installFakeBundle,
  installFakePlaywright,
  messages,
  passed,
  read,
  readJsonLines,
  runNode,
} from './lib/visual-gate-harness.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** Where the classifier cases say their files lie; the classifier reads names only. */
const RESULTS_DIR = '/work/tests/visual/test-results';
const BASELINE_DIR = '/tmp/blog-visual-x/baseline';

/** The line `classifyComparison` reports for anything that is not a report. */
const NOT_A_REPORT = 'the results are not a Playwright JSON report';

/** Deadline of one gate run; each takes about a second on a developer machine. */
const GATE_TIMEOUT_MS = 60000;

/** Time limit of one gate case: setup, the run and its assertions. */
const GATE_CASE = { timeout: GATE_TIMEOUT_MS + 30000 };

/** At most this many gate runs at once. */
const GATE_CONCURRENCY = 4;

/** The synthetic draft image every staged source holds (build-fixture-site.mjs `DRAFT_IMAGE`). */
const SYNTHETIC_DRAFT_IMAGE = 'assets/drafts/fixture-private-draft/figure.svg';

/** The runner's usage line. */
const USAGE = 'Usage: node tests/visual/run-visual.mjs [--base <ref>]';

/* ------------------------------------------------------------------------ */
/* Classifier helpers                                                        */
/* ------------------------------------------------------------------------ */

/** The case of the spec titled `<page> <width>px <scheme>`. */
function specCase(page, width, scheme) {
  const found = CASES.find((entry) => entry.page === page && entry.width === width && entry.scheme === scheme);
  assert.ok(found, `${page} ${width}px ${scheme} is one of the 12 cases`);
  return found;
}

/** The output folder Playwright gives a case. */
function caseDir(entry) {
  return path.join(RESULTS_DIR, `blog-visual-${entry.stem}-chromium`);
}

/** A failed attempt of `entry` with `errorMessages` and its expected, actual and diff images attached. */
function failedWithImages(entry, errorMessages, options) {
  return failed(errorMessages, evidence(entry.stem, caseDir(entry)), options);
}

/** The classification of a report in which only `entry` failed, with `results`. */
function classifyOne(entry, results) {
  return classifyComparison(buildReport({ [entry.title]: results }));
}

/* ------------------------------------------------------------------------ */
/* classifyComparison                                                        */
/* ------------------------------------------------------------------------ */

describe('[AC-16][F-018] classifyComparison sorts real Playwright 1.63 reports', () => {
  test('[AC-16][F-018] the report builders name the 12 cases exactly as blog-visual.spec.mjs does', () => {
    const spec = fs.readFileSync(path.join(ROOT, 'tests', 'visual', 'blog-visual.spec.mjs'), 'utf8');
    for (const source of [
      '{ name: "listing", path: "/blog/" }',
      '{ name: "article", path: "/blog/fixture-code-and-tables/" }',
      'const WIDTHS = [375, 800, 1280];',
      'const SCHEMES = ["light", "dark"];',
      `test.describe(${JSON.stringify(DESCRIBE_TITLE)}, () => {`,
      // The spec's template literals, compared as source text.
      'test(`[AC-16][F-018] ${name} ${width}px ${scheme}`',
      'const file = `${name}-${width}-${scheme}.png`;',
    ]) {
      assert.ok(spec.includes(source), `blog-visual.spec.mjs contains ${source}`);
    }
    assert.equal(CASES.length, 12);
    assert.equal(new Set(CASES.map((entry) => entry.title)).size, 12, 'the titles are unique');
    assert.equal(new Set(CASES.map((entry) => entry.file)).size, 12, 'the screenshot files are unique');
    assert.deepEqual(CASES.slice(0, 2).map((entry) => [entry.title, entry.file]), [
      ['[AC-16][F-018] listing 375px light', 'listing-375-light.png'],
      ['[AC-16][F-018] listing 375px dark', 'listing-375-dark.png'],
    ]);
  });

  test('[AC-16][F-018] a run in which all 12 cases passed has no difference and no problem', () => {
    const report = buildReport();
    assert.equal(report.suites[0].suites[0].title, DESCRIBE_TITLE, 'the cases are nested in the describe suite');
    assert.deepEqual(classifyComparison(report), { mismatched: [], problems: [] });
  });

  test('[AC-16][F-018] pixel and size differences with their actual image are differences, colour sequences included', () => {
    const results = {};
    for (const entry of CASES) {
      const message = entry.page === 'listing' ? messages.pixelMismatch(entry.file) : messages.sizeMismatch(entry.file, entry.width);
      assert.ok(message.includes('\u001b[2mexpect('), 'the message keeps Playwright\'s colour sequences');
      results[entry.title] = [failedWithImages(entry, [message])];
    }
    assert.deepEqual(classifyComparison(buildReport(results)), {
      mismatched: CASES.map((entry) => entry.title),
      problems: [],
    });
  });

  test('[AC-16][F-018] a zero-tolerance difference reported by the spec\'s strict layer is a difference', () => {
    const listing = specCase('listing', 375, 'light');
    const article = specCase('article', 1280, 'dark');
    const same = { width: 375, height: 900 };
    const strict = strictMismatchMessage(listing.file, {
      equal: false, differentPixels: 1, totalPixels: 375 * 900, expectedSize: same, actualSize: same,
    });
    const sized = strictMismatchMessage(article.file, {
      equal: false,
      differentPixels: 1280 * 48,
      totalPixels: 1280 * 948,
      expectedSize: { width: 1280, height: 900 },
      actualSize: { width: 1280, height: 948 },
    });
    assert.deepEqual(
      classifyComparison(buildReport({
        [listing.title]: [failedWithImages(listing, [messages.thrown(strict)])],
        [article.title]: [failedWithImages(article, [messages.thrown(sized)])],
      })),
      { mismatched: [listing.title, article.title], problems: [] },
    );
  });

  test('[AC-16][F-018] a difference without its *-actual.png attachment is a problem', () => {
    const entry = specCase('article', 800, 'light');
    const withoutActual = failed([messages.pixelMismatch(entry.file)], evidence(entry.stem, caseDir(entry), ['expected', 'diff']));
    assert.deepEqual(classifyOne(entry, [withoutActual]), {
      mismatched: [],
      problems: [`${entry.title}: failed without an actual screenshot (*-actual.png)`],
    });
    // A bare `actual.png`, or an attachment without a name, is not the captured screenshot either.
    const oddNames = failed([messages.pixelMismatch(entry.file)], [
      { name: 'actual.png', contentType: 'image/png', path: path.join(caseDir(entry), 'actual.png') },
      { contentType: 'image/png', path: path.join(caseDir(entry), `${entry.stem}-actual.png`) },
    ]);
    assert.deepEqual(classifyOne(entry, [oddNames]).problems, [`${entry.title}: failed without an actual screenshot (*-actual.png)`]);
  });

  test('[AC-16][F-018] every failure other than a screenshot difference is a problem, even with an actual image', () => {
    const entry = specCase('listing', 375, 'light');
    const matcherLine = `${entry.title}: Error: expect(page).toHaveScreenshot(expected) failed`;
    const url = 'http://127.0.0.1:41234/cabrillo-coast/blog/';
    const cases = [
      [
        'a matcher that timed out (a Timeout line before the diff)',
        messages.timedOutMismatch(entry.file),
        `${matcherLine} — Timeout: 5000ms; 10000 pixels (ratio 0.01 of all image pixels) are different.`,
      ],
      [
        'a page that never rendered the same twice',
        messages.unstable(entry.file),
        `${matcherLine} — Timeout: 5000ms; Failed to take two consecutive stable screenshots.`,
      ],
      [
        'a screenshot matcher that failed without timing out (no Timeout line)',
        messages.screenshotError(entry.file, 'The page has closed'),
        `${matcherLine} — The page has closed`,
      ],
      [
        'a missing baseline',
        messages.missingSnapshot(`${BASELINE_DIR}/${entry.file}`),
        `${entry.title}: Error: A snapshot doesn't exist at ${BASELINE_DIR}/${entry.file}.`,
      ],
      ['a navigation error', messages.navigation(url), `${entry.title}: Error: page.goto: net::ERR_CONNECTION_REFUSED at ${url}`],
      [
        'a thrown error worded like the strict message',
        messages.thrown(`Strict pixel comparison failed for ${entry.file}: 1 pixel differs\n\nsecond line`),
        `${entry.title}: Error: Strict pixel comparison failed for ${entry.file}: 1 pixel differs`,
      ],
      [
        'a strict comparison that could not decode an image',
        messages.thrown(`Strict pixel comparison of ${entry.file} could not run: the expected image cannot be decoded: Invalid PNG: no IHDR chunk`),
        `${entry.title}: Error: Strict pixel comparison of ${entry.file} could not run: the expected image cannot be decoded: Invalid PNG: no IHDR chunk`,
      ],
      [
        'a page that did not answer 2xx',
        messages.thrown(`${url} must load with a 2xx status\n\nexpect(received).toBe(expected) // Object.is equality`),
        `${entry.title}: Error: ${url} must load with a 2xx status`,
      ],
    ];
    for (const [label, message, line] of cases) {
      assert.deepEqual(classifyOne(entry, [failedWithImages(entry, [message])]), { mismatched: [], problems: [line] }, label);
    }
  });

  test('[AC-16][F-018] a Playwright matcher failure is summed up with the reason after its header, on one line without colour sequences', () => {
    const entry = specCase('article', 800, 'light');
    const header = 'Error: expect(page).toHaveScreenshot(expected) failed';
    const coloured =
      'Error: \u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m\u001b[2m).\u001b[22mtoHaveScreenshot' +
      '\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed';
    const unstableReason = `${header} — Timeout: 5000ms; Failed to take two consecutive stable screenshots.`;
    const cases = [
      // The reason is every line of the first paragraph after the header, joined with "; ".
      ['the real unstable-screenshot message', messages.unstable(entry.file), unstableReason],
      [
        'another matcher with Locator, Expected and Timeout lines',
        'Error: expect(locator).toBeVisible() failed\n\nLocator: locator(\'#year\')\nExpected: visible\nTimeout: 5000ms\n' +
          'Error: element(s) not found\n\nCall log:\n  - Expect "toBeVisible" with timeout 5000ms\n  - waiting for locator(\'#year\')',
        'Error: expect(locator).toBeVisible() failed — Locator: locator(\'#year\'); Expected: visible; Timeout: 5000ms; Error: element(s) not found',
      ],
      [
        'a negated matcher',
        'Error: expect(page).not.toHaveScreenshot(expected) failed\n\n  The page has closed\n',
        'Error: expect(page).not.toHaveScreenshot(expected) failed — The page has closed',
      ],
      // A header with nothing after it stands alone.
      ['the header alone', header, header],
      ['the header and blank lines', `${coloured}\n\n\n`, header],
      ['the header followed by its call log', `${coloured}\n\nCall log:\n\u001b[2m  - taking page screenshot\u001b[22m`, header],
      // Colour sequences in the reason are stripped as well.
      [
        'a coloured reason',
        `${coloured}\n\n\u001b[2mTimeout: 5000ms\u001b[22m\n  \u001b[31mFailed to take two consecutive stable screenshots.\u001b[39m\n\n  Snapshot: ${entry.file}`,
        unstableReason,
      ],
      // A first line that is not exactly a matcher header keeps the first-line output.
      [
        'a generic expect failure',
        'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 404',
        'Error: expect(received).toBe(expected) // Object.is equality',
      ],
      ['a header with more text after it', `${header} twice\n\nTimeout: 5000ms`, `${header} twice`],
      ['a header inside another message', `Error: the spec saw ${header.slice('Error: '.length)}\n\nTimeout: 5000ms`, `Error: the spec saw ${header.slice('Error: '.length)}`],
    ];
    for (const [label, message, line] of cases) {
      const { mismatched, problems } = classifyOne(entry, [failedWithImages(entry, [message])]);
      assert.deepEqual({ mismatched, problems }, { mismatched: [], problems: [`${entry.title}: ${line}`] }, label);
      assert.doesNotMatch(problems[0], /[\u001b\n]/, `${label}: one line without colour sequences`);
    }

    // A run-level error and a case that did not end "failed" are summed up the same way.
    const unstable = messages.unstable(entry.file);
    assert.deepEqual(classifyComparison(buildReport({}, { errors: [{ message: unstable }] })).problems, [
      `the run reported an error: ${unstableReason}`,
    ]);
    assert.deepEqual(classifyOne(entry, [failed([unstable], evidence(entry.stem, caseDir(entry)), { status: 'timedOut' })]).problems, [
      `${entry.title}: timedOut: ${unstableReason}`,
    ]);
  });

  test('[AC-16][F-018] a case that timed out, was interrupted, was skipped or has no status is a problem', () => {
    const entry = specCase('article', 375, 'dark');
    const withImages = evidence(entry.stem, caseDir(entry));
    const cases = [
      [failed([messages.testTimeout()], withImages, { status: 'timedOut' }), `${entry.title}: timedOut: Test timeout of 30000ms exceeded.`],
      [failed([], withImages, { status: 'interrupted' }), `${entry.title}: interrupted`],
      [failed([], [], { status: 'skipped' }), `${entry.title}: skipped`],
      [{ ...failed([], withImages), status: undefined }, `${entry.title}: no status`],
    ];
    for (const [result, line] of cases) {
      assert.deepEqual(classifyOne(entry, [result]), { mismatched: [], problems: [line] }, line);
    }
  });

  test('[AC-16][F-018] a case without a result did not run, and a short report says how many cases it holds', () => {
    const entry = specCase('listing', 1280, 'dark');
    assert.deepEqual(classifyOne(entry, []), { mismatched: [], problems: [`${entry.title}: did not run`] });

    assert.deepEqual(classifyComparison(buildReport({}, { cases: CASES.slice(0, 11) })), {
      mismatched: [],
      problems: ['only 11 of 12 cases were reported'],
    });
    assert.deepEqual(classifyComparison(buildReport({}, { cases: [] })).problems, ['only 0 of 12 cases were reported']);

    // Eleven differences do not make up for the missing twelfth case.
    const results = Object.fromEntries(
      CASES.slice(0, 11).map((item) => [item.title, [failedWithImages(item, [messages.pixelMismatch(item.file)])]]),
    );
    const short = classifyComparison(buildReport(results, { cases: CASES.slice(0, 11) }));
    assert.equal(short.mismatched.length, 11);
    assert.deepEqual(short.problems, ['only 11 of 12 cases were reported']);
  });

  test('[AC-16][F-018] a run-level error is a problem even when every case passed', () => {
    const errors = [
      { message: 'Error: Timed out waiting 900s for the test suite to run', stack: 'Error: Timed out waiting 900s for the test suite to run' },
      { message: '\u001b[31mError: No tests found\u001b[39m\nMake sure the files match testMatch' },
      {},
    ];
    assert.deepEqual(classifyComparison(buildReport({}, { errors })), {
      mismatched: [],
      problems: [
        'the run reported an error: Error: Timed out waiting 900s for the test suite to run',
        'the run reported an error: Error: No tests found',
        'the run reported an error: (no message)',
      ],
    });
  });

  test('[AC-16][F-018] a failed result without an error message is a problem', () => {
    const entry = specCase('article', 800, 'dark');
    assert.deepEqual(classifyOne(entry, [failed([], evidence(entry.stem, caseDir(entry)))]), {
      mismatched: [],
      problems: [`${entry.title}: failed without an error message`],
    });
  });

  test('[AC-16][F-018] a mixed case is a problem, never a difference, and other cases still count as differences', () => {
    const entry = specCase('listing', 800, 'light');
    const mixed = failedWithImages(entry, [messages.pixelMismatch(entry.file), 'Error: page.evaluate: Target crashed']);
    assert.deepEqual(classifyOne(entry, [mixed]), {
      mismatched: [],
      problems: [`${entry.title}: Error: page.evaluate: Target crashed`],
    });

    const last = CASES.at(-1);
    const url = 'http://127.0.0.1:41235/cabrillo-coast/blog/fixture-code-and-tables/';
    const results = Object.fromEntries(
      CASES.slice(0, 11).map((item) => [item.title, [failedWithImages(item, [messages.pixelMismatch(item.file)])]]),
    );
    results[last.title] = [failed([messages.navigation(url)], evidence(last.stem, caseDir(last), []))];
    assert.deepEqual(classifyComparison(buildReport(results)), {
      mismatched: CASES.slice(0, 11).map((item) => item.title),
      problems: [`${last.title}: Error: page.goto: net::ERR_CONNECTION_REFUSED at ${url}`],
    });
  });

  test('[AC-16][F-018] every attempt of a retried case is classified', () => {
    const entry = specCase('article', 1280, 'light');
    const difference = () => failedWithImages(entry, [messages.pixelMismatch(entry.file)]);
    // A difference on the first attempt still counts once the retry passed, and only once.
    assert.deepEqual(classifyOne(entry, [difference(), passed({ retry: 1 })]), { mismatched: [entry.title], problems: [] });
    assert.deepEqual(classifyOne(entry, [difference(), { ...difference(), retry: 1 }]), { mismatched: [entry.title], problems: [] });
    // A navigation error on the first attempt is not wiped out by a passing retry.
    const url = 'http://127.0.0.1:41234/cabrillo-coast/blog/fixture-code-and-tables/';
    assert.deepEqual(classifyOne(entry, [failed([messages.navigation(url)]), passed({ retry: 1 })]), {
      mismatched: [],
      problems: [`${entry.title}: Error: page.goto: net::ERR_CONNECTION_REFUSED at ${url}`],
    });
  });

  test('[AC-16][F-018] input that is not a Playwright JSON report is a problem', () => {
    for (const input of [null, undefined, 'not json', 42, [], {}, { suites: [] }, { errors: [] }, { suites: {}, errors: [] }]) {
      assert.deepEqual(classifyComparison(input), { mismatched: [], problems: [NOT_A_REPORT] }, JSON.stringify(input) ?? 'undefined');
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Gate runs                                                                 */
/* ------------------------------------------------------------------------ */

const sandbox = createSandbox('visual-gate-');
after(() => sandbox.cleanup());
const BIN = installFakeBundle(sandbox.parent);

/** SHA-256 of a file's bytes, as the stand-in bundle logs posts. */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * A case folder: the site repository (`repo`), the TMPDIR its run gets
 * (`tmp`, outside the repository) and the stand-ins' logs.
 */
function caseFolder(name) {
  const dir = sandbox.folder(name);
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  return {
    dir,
    repo: path.join(dir, 'repo'),
    tmp,
    bundleLog: path.join(dir, 'bundle.log'),
    playwrightLog: path.join(dir, 'playwright.log'),
  };
}

/**
 * A site repository with one base commit (`baseOptions` as in
 * `createSiteRepo`) and the stand-in Playwright; `changed` leaves the working
 * tree changed (`changeWorkingTree`), uncommitted.
 */
function siteCase(name, { changed = true, workStyles = WORK_STYLES, ...baseOptions } = {}) {
  const folder = caseFolder(name);
  const base = createSiteRepo(sandbox.env, folder.repo, baseOptions);
  if (changed) changeWorkingTree(folder.repo, { styles: workStyles });
  installFakePlaywright(folder.repo);
  return { ...folder, base, short: base.slice(0, 12) };
}

/**
 * Runs the repository's copy of run-visual.mjs with `args`, the sandbox
 * environment, the stand-in bundle first on PATH, the case's TMPDIR and
 * `env`, and reads what the stand-ins logged.
 */
async function runGate(site, args, { env = {}, fault = '' } = {}) {
  const result = await runNode([path.join(site.repo, 'tests', 'visual', 'run-visual.mjs'), ...args], {
    cwd: site.repo,
    env: {
      ...sandbox.env,
      PATH: `${BIN}${path.delimiter}${sandbox.env.PATH ?? ''}`,
      TMPDIR: site.tmp,
      FAKE_BUNDLE_LOG: site.bundleLog,
      FAKE_PW_LOG: site.playwrightLog,
      FAKE_PW_FAULT: fault,
      ...env,
    },
    timeoutMs: GATE_TIMEOUT_MS,
  });
  return {
    ...result,
    builds: readJsonLines(site.bundleLog),
    runs: readJsonLines(site.playwrightLog),
    leftovers: fs.readdirSync(site.tmp).filter((name) => name.startsWith('blog-visual-')),
  };
}

/** Asserts the exit code, showing the run's output when it differs. */
function expectExit(result, code) {
  assert.equal(
    result.status,
    code,
    `expected exit code ${code}, got ${result.status} (signal ${result.signal}, deadline hit ${result.timedOut}); output:\n${result.out}`,
  );
}

/** Asserts that `text` holds `line` as a whole line. */
function expectLine(text, line) {
  assert.ok(text.split('\n').includes(line), `expected the line ${JSON.stringify(line)} in:\n${text}`);
}

/** Asserts that the run removed its workspace. */
function expectNoWorkspace(result) {
  assert.deepEqual(result.leftovers, [], 'no blog-visual-* workspace is left in TMPDIR');
}

/** The base and working-tree site URLs the run printed. */
function servedUrls(stdout) {
  const base = /^run-visual: serving base [0-9a-f]{12} at (http:\/\/127\.0\.0\.1:\d+\/cabrillo-coast)\/$/m.exec(stdout);
  const work = /^run-visual: serving the working tree at (http:\/\/127\.0\.0\.1:\d+\/cabrillo-coast)\/$/m.exec(stdout);
  assert.ok(base && work, `both servers are announced in:\n${stdout}`);
  return { base: base[1], work: work[1] };
}

/** The Playwright arguments run-visual.mjs passes in `repo` for `mode`. */
function playwrightArgs(repo, mode) {
  return ['test', '--config', path.join(repo, 'tests', 'visual', 'playwright.config.mjs'), `--update-snapshots=${mode}`];
}

/** The modes of the logged Playwright runs, in order. */
function modes(result) {
  return result.runs.map((run) => run.mode);
}

/** The intent run-visual.mjs reports for a trailer in `<short>..HEAD`. */
function trailerIntent(short) {
  return `a "Visual-Change: intended" trailer in ${short}..HEAD`;
}

/** Declares the change through the environment. */
const DECLARED = Object.freeze({ VISUAL_CHANGE_INTENDED: '1' });

describe('[AC-16][F-018] run-visual.mjs gate outcomes in temporary git repositories', { concurrency: GATE_CONCURRENCY }, () => {
  test('[AC-16][F-018] identical source passes: baseline (all) from the base server, comparison (none) on another', GATE_CASE, async () => {
    const site = siteCase('identical', { changed: false });
    const hostileReport = path.join(site.dir, 'hostile-report');
    const hostileJson = path.join(site.dir, 'hostile-results.json');
    const result = await runGate(site, ['--base', site.base], {
      env: {
        PLAYWRIGHT_HTML_OUTPUT_DIR: hostileReport,
        PLAYWRIGHT_HTML_REPORT: hostileReport,
        PLAYWRIGHT_HTML_OPEN: 'always',
        PW_TEST_HTML_REPORT_OPEN: 'always',
        PW_TEST_REPORTER: 'html',
        PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: 'https://example.com/attachments/',
        PLAYWRIGHT_JSON_OUTPUT_FILE: hostileJson,
        JEKYLL_ENV: 'production',
      },
    });
    expectExit(result, 0);
    expectLine(result.stdout, 'Visual comparison passed: 12 screenshots identical');
    expectLine(result.stdout, `run-visual: base ${site.base} is ${site.base}`);

    assert.deepEqual(modes(result), ['all', 'none'], 'exactly two Playwright runs: the baseline, then the comparison');
    const [baseline, compare] = result.runs;
    const served = servedUrls(result.stdout);
    assert.notEqual(served.base, served.work, 'the two builds are served on different ports');
    assert.equal(baseline.env.VISUAL_BASE_URL, served.base, 'the baseline is recorded from the base server');
    assert.equal(compare.env.VISUAL_BASE_URL, served.work, 'the comparison screenshots the working-tree server');
    assert.deepEqual(baseline.argv, playwrightArgs(site.repo, 'all'));
    assert.deepEqual(compare.argv, playwrightArgs(site.repo, 'none'));
    for (const run of result.runs) assert.equal(run.cwd, site.repo);

    const workspace = path.dirname(baseline.env.VISUAL_BASELINE_DIR);
    assert.equal(path.dirname(workspace), site.tmp, 'the workspace lies in TMPDIR');
    assert.match(path.basename(workspace), /^blog-visual-/);
    assert.equal(baseline.env.VISUAL_BASELINE_DIR, path.join(workspace, 'baseline'));
    assert.equal(compare.env.VISUAL_BASELINE_DIR, baseline.env.VISUAL_BASELINE_DIR, 'both runs share one baseline folder');
    assert.equal(baseline.env.VISUAL_RESULTS_FILE, '', 'the baseline run writes no JSON report');
    assert.equal(compare.env.VISUAL_RESULTS_FILE, path.join(workspace, 'compare-results.json'));

    // The hostile reporter variables never reach Playwright.
    for (const run of result.runs) {
      assert.deepEqual(
        {
          PLAYWRIGHT_HTML_OUTPUT_DIR: run.env.PLAYWRIGHT_HTML_OUTPUT_DIR,
          PLAYWRIGHT_HTML_REPORT: run.env.PLAYWRIGHT_HTML_REPORT,
          PLAYWRIGHT_HTML_OPEN: run.env.PLAYWRIGHT_HTML_OPEN,
          PW_TEST_HTML_REPORT_OPEN: run.env.PW_TEST_HTML_REPORT_OPEN,
          PW_TEST_REPORTER: run.env.PW_TEST_REPORTER,
          PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: run.env.PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL,
          PLAYWRIGHT_JSON_OUTPUT_FILE: run.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
          JEKYLL_ENV: run.env.JEKYLL_ENV,
        },
        {
          PLAYWRIGHT_HTML_OUTPUT_DIR: null,
          PLAYWRIGHT_HTML_REPORT: null,
          PLAYWRIGHT_HTML_OPEN: 'never',
          PW_TEST_HTML_REPORT_OPEN: null,
          PW_TEST_REPORTER: null,
          PLAYWRIGHT_HTML_ATTACHMENTS_BASE_URL: null,
          PLAYWRIGHT_JSON_OUTPUT_FILE: null,
          JEKYLL_ENV: null,
        },
        `the ${run.mode} run's reporter environment is neutralised`,
      );
      for (const page of ['listing', 'article']) {
        assert.equal(run.bodies[page].status, 200, `${run.mode} ${page} answered`);
        assert.ok(run.bodies[page].text.includes('BASE-MARKER'), `${run.mode} ${page} holds the committed stylesheet`);
      }
    }
    assert.deepEqual(compare.bodies, baseline.bodies, 'identical sources serve identical pages');
    assert.equal(fs.existsSync(hostileReport), false);
    assert.equal(fs.existsSync(hostileJson), false);

    assert.equal(result.builds.length, 6, 'three Jekyll builds per side');
    for (const build of result.builds) {
      assert.equal(build.jekyllEnv, null, 'JEKYLL_ENV never reaches a build');
      assert.equal(build.bundleGemfile, path.join(site.repo, 'Gemfile'), 'every build uses the repository Gemfile');
    }
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] provenance: an undeclared change fails; base from the archived commit, fixtures from the working tree', GATE_CASE, async () => {
    const site = siteCase('provenance');
    const result = await runGate(site, ['--base', site.base]);
    expectExit(result, 1);
    expectLine(result.stderr, `Visual comparison failed: blog pages differ from base ${site.short}`);
    expectLine(result.stderr, '12 of 12 screenshots differ.');
    assert.match(result.stderr, /If the change is intended, add a `Visual-Change: intended` trailer/);
    assert.doesNotMatch(result.stdout, /intended visual change declared/);

    // What each Playwright run screenshotted.
    assert.deepEqual(modes(result), ['all', 'none']);
    const [baseline, compare] = result.runs;
    for (const page of ['listing', 'article']) {
      assert.match(baseline.bodies[page].text, /BASE-MARKER/, `the baseline ${page} is the base commit's`);
      assert.doesNotMatch(baseline.bodies[page].text, /WORK-MARKER/);
      assert.match(compare.bodies[page].text, /WORK-MARKER/, `the compared ${page} is the working tree's`);
      assert.doesNotMatch(compare.bodies[page].text, /BASE-MARKER/);
    }

    // What each build was given to build.
    const workspace = path.dirname(baseline.env.VISUAL_BASELINE_DIR);
    const sources = result.builds.map((build) => path.relative(workspace, build.source));
    assert.deepEqual(sources, [
      'base/project-src', 'base/src', 'base/empty-src',
      'work/project-src', 'work/src', 'work/empty-src',
    ], 'the base is built first, each side in its three variants');
    const fixtureHashes = Object.fromEntries(
      FIXTURE_POST_FILES.map((file) => [file, sha256(fs.readFileSync(path.join(site.repo, 'tests', 'fixtures', 'posts', file)))]),
    );
    // The base commit holds this repository's fixture articles; the working tree edited the first one.
    const committedRel = `tests/fixtures/posts/${FIXTURE_POST_FILES[0]}`;
    assert.equal(git(sandbox.env, site.repo, 'diff', '--name-only', site.base, '--', committedRel), committedRel);
    assert.equal(read(site.repo, committedRel), `${read(ROOT, committedRel)}${FIXTURE_EDIT}`);

    for (const build of result.builds) {
      const label = path.relative(workspace, build.source);
      if (label.split(path.sep)[0] === 'base') {
        assert.equal(build.styles, BASE_STYLES, `${label} holds the base commit's styles.css`);
        assert.ok(build.files.includes(DELETED_REL), `${label} holds the file the working tree deleted`);
        assert.ok(!build.files.includes(UNTRACKED_REL), `${label} holds no untracked working-tree file`);
      } else {
        assert.equal(build.styles, WORK_STYLES, `${label} holds the working tree's styles.css`);
        assert.ok(build.files.includes(UNTRACKED_REL), `${label} holds the untracked working-tree file`);
        assert.ok(!build.files.includes(DELETED_REL), `${label} does not hold the deleted file`);
      }
      assert.ok(!build.files.includes(DRAFT_IMAGE_REL), `${label} holds no real draft image`);
      assert.ok(!build.files.includes(REAL_DRAFT_REL), `${label} holds no real draft`);
      assert.ok(!build.files.includes(REAL_POST_REL), `${label} holds no real post (fixtures only)`);
      assert.deepEqual(
        build.files.filter((file) => file.startsWith('assets/drafts/')),
        [SYNTHETIC_DRAFT_IMAGE],
        `${label}: the synthetic draft image is the only file under assets/drafts/`,
      );
      if (label.endsWith('empty-src')) {
        assert.deepEqual(build.posts, [], `${label} has no _posts/`);
        continue;
      }
      const fixtures = build.posts.filter((post) => FIXTURE_POST_FILES.includes(post.file));
      assert.deepEqual(
        Object.fromEntries(fixtures.map((post) => [post.file, post.sha256])),
        fixtureHashes,
        `${label} holds the working tree's fixture articles, byte for byte`,
      );
      const others = build.posts.filter((post) => !FIXTURE_POST_FILES.includes(post.file)).map((post) => post.file);
      assert.equal(others.length, 1, `${label}: one more post, the synthetic future-dated one`);
      assert.match(others[0], /^\d{4}-\d{2}-\d{2}-fixture-future-post\.md$/);
    }
    const [baseProject, , , workProject] = result.builds;
    assert.deepEqual(baseProject.posts, workProject.posts, 'both sides build the same articles');
    assert.deepEqual(baseProject.args.slice(-2), ['--baseurl', '/cabrillo-coast']);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a change declared with VISUAL_CHANGE_INTENDED=1 is reported and accepted', GATE_CASE, async () => {
    const site = siteCase('declared-env');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED });
    expectExit(result, 0);
    expectLine(result.stdout, 'run-visual: intended visual change declared by VISUAL_CHANGE_INTENDED=1');
    expectLine(
      result.stdout,
      `Visual comparison: 12 of 12 screenshots differ from base ${site.short}; ` +
        'the differences are reported and accepted as intended (VISUAL_CHANGE_INTENDED=1)',
    );
    expectLine(result.stdout, 'Report: tests/visual/report/index.html (open with: npx playwright show-report tests/visual/report)');
    assert.deepEqual(modes(result), ['all', 'none']);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a change declared by a Visual-Change: intended trailer in base..HEAD is accepted', GATE_CASE, async () => {
    const site = siteCase('declared-trailer');
    commitAll(sandbox.env, site.repo, 'Restyle the blog\n\nWider cards on large screens.\n\nVisual-Change: intended\n');
    const result = await runGate(site, ['--base', site.base]);
    expectExit(result, 0);
    expectLine(result.stdout, `run-visual: intended visual change declared by ${trailerIntent(site.short)}`);
    expectLine(
      result.stdout,
      `Visual comparison: 12 of 12 screenshots differ from base ${site.short}; ` +
        `the differences are reported and accepted as intended (${trailerIntent(site.short)})`,
    );
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a Visual-Change: intended trailer carried only by a --no-ff merge commit in base..HEAD is accepted', GATE_CASE, async () => {
    const site = siteCase('declared-merge-trailer');
    // The change is committed on a feature branch without a trailer; only the merge commit declares it.
    const start = git(sandbox.env, site.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(sandbox.env, site.repo, 'checkout', '-q', '-b', 'restyle');
    const feature = commitAll(sandbox.env, site.repo, 'Restyle the blog');
    git(sandbox.env, site.repo, 'checkout', '-q', start);
    // --no-ff records a merge commit although a fast-forward is possible; hooks never run.
    git(sandbox.env, site.repo, 'merge', '--no-ff', '--no-verify', '--no-edit', '-q', '-m', 'Merge the restyle', '-m', 'Visual-Change: intended', 'restyle');
    assert.deepEqual(
      git(sandbox.env, site.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1),
      [site.base, feature],
      'HEAD is a merge commit of the base and the feature commit',
    );
    assert.doesNotMatch(git(sandbox.env, site.repo, 'log', '-1', '--format=%B', feature), /visual-change/i, 'the feature commit carries no trailer');
    assert.match(git(sandbox.env, site.repo, 'log', '-1', '--format=%B', 'HEAD'), /^Visual-Change: intended$/m, 'the merge commit carries the trailer');

    const result = await runGate(site, ['--base', site.base]);
    expectExit(result, 0);
    expectLine(result.stdout, `run-visual: intended visual change declared by ${trailerIntent(site.short)}`);
    expectLine(
      result.stdout,
      `Visual comparison: 12 of 12 screenshots differ from base ${site.short}; ` +
        `the differences are reported and accepted as intended (${trailerIntent(site.short)})`,
    );
    assert.deepEqual(modes(result), ['all', 'none']);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a trailer on the base commit itself lies outside base..HEAD and declares nothing', GATE_CASE, async () => {
    const site = siteCase('trailer-on-base', { message: 'Base commit\n\nVisual-Change: intended\n' });
    commitAll(sandbox.env, site.repo, 'Restyle the blog without a trailer');
    const result = await runGate(site, ['--base', site.base]);
    expectExit(result, 1);
    assert.doesNotMatch(result.stdout, /intended visual change declared/);
    expectLine(result.stderr, `Visual comparison failed: blog pages differ from base ${site.short}`);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] differences found only by the zero-tolerance layer are accepted when declared', GATE_CASE, async () => {
    const site = siteCase('strict-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'strict' });
    expectExit(result, 0);
    expectLine(
      result.stdout,
      `Visual comparison: 12 of 12 screenshots differ from base ${site.short}; ` +
        'the differences are reported and accepted as intended (VISUAL_CHANGE_INTENDED=1)',
    );
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] differences found only by the zero-tolerance layer fail when not declared', GATE_CASE, async () => {
    const site = siteCase('strict-undeclared');
    const result = await runGate(site, ['--base', site.base], { fault: 'strict' });
    expectExit(result, 1);
    expectLine(result.stderr, `Visual comparison failed: blog pages differ from base ${site.short}`);
    expectLine(result.stderr, '12 of 12 screenshots differ.');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when another case failed for a different reason', GATE_CASE, async () => {
    const site = siteCase('mixed-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'mixed' });
    expectExit(result, 1);
    const served = servedUrls(result.stdout);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run failed for reasons other than a screenshot difference');
    expectLine(
      result.stderr,
      `  ${CASES.at(-1).title}: Error: page.goto: net::ERR_CONNECTION_REFUSED at ${served.work}/blog/fixture-code-and-tables/`,
    );
    expectLine(result.stderr, 'The declared intent (VISUAL_CHANGE_INTENDED=1) covers screenshot differences only.');
    assert.doesNotMatch(result.stdout, /accepted as intended/);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when the report lists fewer than 12 cases', GATE_CASE, async () => {
    const site = siteCase('incomplete-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'incomplete' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run failed for reasons other than a screenshot difference');
    expectLine(result.stderr, '  only 10 of 12 cases were reported');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when the comparison wrote no actual screenshot', GATE_CASE, async () => {
    const site = siteCase('no-actual-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'no-actual' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run failed without a screenshot difference');
    assert.doesNotMatch(result.stdout, /accepted as intended/);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when the comparison was interrupted (exit 130)', GATE_CASE, async () => {
    const site = siteCase('interrupted-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'interrupted' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run was interrupted (exit 130), so the comparison is incomplete');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when the comparison was killed', GATE_CASE, async () => {
    const site = siteCase('killed-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'killed' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run was killed by SIGKILL, so the comparison is incomplete');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when the comparison wrote no JSON results', GATE_CASE, async () => {
    const site = siteCase('no-results-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'no-results' });
    expectExit(result, 1);
    assert.match(result.stderr, /^Visual comparison failed: the working-tree run's results cannot be read: ENOENT/m);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails on a run-level error', GATE_CASE, async () => {
    const site = siteCase('run-error-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'run-error' });
    expectExit(result, 1);
    expectLine(result.stderr, '  the run reported an error: Error: Timed out waiting 900s for the test suite to run');
    expectLine(result.stderr, 'The declared intent (VISUAL_CHANGE_INTENDED=1) covers screenshot differences only.');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails when a case timed out', GATE_CASE, async () => {
    const site = siteCase('timedout-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'timedout' });
    expectExit(result, 1);
    expectLine(result.stderr, `  ${CASES[1].title}: timedOut: Test timeout of 30000ms exceeded.`);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a declared change fails on unstable screenshots, and each problem line says why', GATE_CASE, async () => {
    const site = siteCase('unstable-declared');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'unstable' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run failed for reasons other than a screenshot difference');
    const reason = 'Error: expect(page).toHaveScreenshot(expected) failed — Timeout: 5000ms; Failed to take two consecutive stable screenshots.';
    const unstable = CASES.filter((entry) => entry.page === 'article').map((entry) => `  ${entry.title}: ${reason}`);
    for (const line of unstable) expectLine(result.stderr, line);
    // The listing cases differed only in pixels, so the article cases are the only problems.
    assert.deepEqual(result.stderr.split('\n').filter((line) => line.startsWith('  [AC-16]')), unstable);
    expectLine(result.stderr, 'The declared intent (VISUAL_CHANGE_INTENDED=1) covers screenshot differences only.');
    assert.doesNotMatch(result.stdout, /accepted as intended/);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a baseline run that records fewer than 12 screenshots fails before any comparison', GATE_CASE, async () => {
    const site = siteCase('baseline-short');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'baseline-short' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: baseline run did not produce 12 screenshots');
    expectLine(result.stderr, 'run-visual: baseline run exited 0, 11 screenshots recorded');
    assert.deepEqual(modes(result), ['all'], 'only the baseline run ran');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a baseline run that exits 1 fails before any comparison', GATE_CASE, async () => {
    const site = siteCase('baseline-exit');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'baseline-exit' });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: baseline run did not produce 12 screenshots');
    expectLine(result.stderr, 'run-visual: baseline run exited 1, 12 screenshots recorded');
    assert.deepEqual(modes(result), ['all'], 'only the baseline run ran');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a baseline whose files are all misnamed is never taken for a difference', GATE_CASE, async () => {
    const site = siteCase('baseline-misnamed');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'baseline-misnamed' });
    expectExit(result, 1);
    assert.deepEqual(modes(result), ['all', 'none']);
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run failed without a screenshot difference');
    assert.doesNotMatch(result.stdout, /accepted as intended/);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a missing baseline file is a problem beside real differences, whatever was declared', GATE_CASE, async () => {
    const site = siteCase('baseline-one-misnamed');
    const result = await runGate(site, ['--base', site.base], { env: DECLARED, fault: 'baseline-one-misnamed' });
    expectExit(result, 1);
    const baselineDir = result.runs[1].env.VISUAL_BASELINE_DIR;
    expectLine(result.stderr, 'Visual comparison failed: the working-tree run failed for reasons other than a screenshot difference');
    expectLine(result.stderr, `  ${CASES[0].title}: Error: A snapshot doesn't exist at ${path.join(baselineDir, CASES[0].file)}.`);
    expectLine(result.stderr, 'The declared intent (VISUAL_CHANGE_INTENDED=1) covers screenshot differences only.');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a failed working-tree build fails whatever was declared, before Playwright runs', GATE_CASE, async () => {
    const site = siteCase('work-build-fails', { workStyles: '/* FAKE-BUILD-FAIL */\n' });
    const result = await runGate(site, ['--base', site.base], { env: DECLARED });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: working-tree build failed');
    assert.match(result.stderr, /^run-visual: bundle exited with status 1: bundle exec jekyll build --source \S+\/work\/project-src /m);
    assert.deepEqual(result.runs, [], 'Playwright never ran');
    assert.deepEqual(result.builds.map((build) => build.failed), [false, false, false, true]);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a base build without the screenshotted article fails as a build failure', GATE_CASE, async () => {
    const site = siteCase('base-no-article', { styles: '/* BASE-MARKER FAKE-NO-ARTICLE */\n' });
    const result = await runGate(site, ['--base', site.base], { env: DECLARED });
    expectExit(result, 1);
    expectLine(result.stderr, 'Visual comparison failed: base build failed');
    expectLine(result.stderr, 'run-visual: the build produced no cabrillo-coast/blog/fixture-code-and-tables/index.html');
    assert.deepEqual(result.runs, [], 'Playwright never ran');
    assert.equal(result.builds.length, 3, 'the working tree was never built');
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a base that predates the blog is skipped with a notice, without a build or a Playwright run', GATE_CASE, async () => {
    const folder = caseFolder('pre-blog');
    const preBlog = createSiteRepo(sandbox.env, folder.repo, { preBlog: true, message: 'Home page only' });
    commitBlogSource(sandbox.env, folder.repo, 'Add the blog');
    installFakePlaywright(folder.repo);
    const result = await runGate(folder, ['--base', preBlog]);
    expectExit(result, 0);
    expectLine(result.stdout, `Visual comparison skipped: base ${preBlog} has no _layouts/post.html`);
    assert.deepEqual(result.builds, []);
    assert.deepEqual(result.runs, []);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] a --base that names no commit is a usage error (exit 2)', GATE_CASE, async () => {
    const site = siteCase('unresolvable-base', { changed: false });
    const result = await runGate(site, ['--base', 'no-such-revision']);
    expectExit(result, 2);
    expectLine(result.stderr, 'Cannot resolve base revision "no-such-revision"');
    assert.deepEqual(result.builds, []);
    assert.deepEqual(result.runs, []);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] an unknown argument is a usage error (exit 2)', GATE_CASE, async () => {
    const site = siteCase('unknown-argument', { changed: false });
    const result = await runGate(site, ['--bogus']);
    expectExit(result, 2);
    expectLine(result.stderr, 'run-visual: unknown argument --bogus');
    expectLine(result.stderr, USAGE);
    assert.deepEqual(result.builds, []);
    assert.deepEqual(result.runs, []);
    expectNoWorkspace(result);
  });

  test('[AC-16][F-018] --help and -h print the full help on stdout, build and run nothing, and exit 0', GATE_CASE, async () => {
    const site = siteCase('help', { changed: false });
    const phrases = [
      // What the run does.
      'tests/fixtures/build-fixture-site.mjs',
      'served on 127.0.0.1 under /cabrillo-coast/',
      "compares the working tree's 12",
      // Options and the base default.
      '--base <ref>',
      'also --base=<ref>',
      'Default: @{upstream}',
      'or HEAD when the branch has no upstream',
      "names no commit or starts with '-' is refused (exit 2)",
      '-h, --help',
      // The skip rule.
      'Skip rule: a base without _layouts/post.html predates the blog',
      'with a notice and nothing is built (exit 0)',
      // Declaring intent.
      'set VISUAL_CHANGE_INTENDED=1',
      '"Visual-Change: intended"',
      'trailer in any commit message in <base>..HEAD, merge commits included',
      'Operational failures are never accepted',
      // Environment.
      'JEKYLL_ENV is removed from every git and Playwright child',
      // Outputs.
      'tests/visual/report/',
      'npx playwright show-report tests/visual/report',
      'tests/visual/test-results/',
      'blog-visual-*',
      'removed every run',
      // Deadlines the runner applies.
      `each Playwright run ${formatDuration(DEADLINES.playwrightRun)}`,
      `the trailer scan (git log) ${formatDuration(DEADLINES.gitLog)}`,
      `each git query ${formatDuration(DEADLINES.gitQuery)}`,
      `each page request ${formatDuration(DEADLINES.httpRequest)}`,
      // Exit status and an example.
      'Exit status: 0 when the 12 screenshots are identical',
      '1 for an undeclared difference or an operational failure',
      '2 for a usage',
      'error or a base that names no commit',
      '130 when interrupted by SIGINT, 143 by SIGTERM',
      'node tests/visual/run-visual.mjs --base origin/main',
    ];
    const printed = {};
    for (const flag of ['--help', '-h']) {
      const result = await runGate(site, [flag]);
      expectExit(result, 0);
      assert.equal(result.stderr, '', `${flag} writes nothing on stderr`);
      assert.equal(result.stdout.split('\n')[0], USAGE, `${flag} prints the usage line first`);
      for (const phrase of phrases) {
        assert.ok(result.stdout.includes(phrase), `${flag} mentions ${JSON.stringify(phrase)}:\n${result.stdout}`);
      }
      assert.deepEqual(result.builds, [], `${flag} builds nothing`);
      assert.deepEqual(result.runs, [], `${flag} starts no Playwright run`);
      expectNoWorkspace(result);
      printed[flag] = result.stdout;
    }
    assert.equal(printed['-h'], printed['--help'], '-h prints exactly what --help prints');
  });

  test('[AC-16][F-018] --help beside an unknown argument is still a usage error (exit 2)', GATE_CASE, async () => {
    const site = siteCase('help-unknown-argument', { changed: false });
    const result = await runGate(site, ['--help', '--bogus']);
    expectExit(result, 2);
    expectLine(result.stderr, 'run-visual: unknown argument --bogus');
    expectLine(result.stderr, USAGE);
    assert.equal(result.stdout, '', 'no help is printed');
    assert.deepEqual(result.builds, []);
    assert.deepEqual(result.runs, []);
    expectNoWorkspace(result);
  });
});
