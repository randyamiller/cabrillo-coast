/* Cabrillo Coast LLC — Playwright Chromium preflight for scripts/verify.mjs (loads @playwright/test on demand) */
/**
 * Confirms the visual comparison can run before any slow verification step
 * starts, by launching and closing the browser it uses. A missing install or
 * a Chromium that cannot start fails verification rather than skipping the
 * comparison, so a local pass means the same as a CI pass.
 *
 * Loading `@playwright/test` lives here, with the visual files:
 * scripts/verify.mjs imports this module by relative path, importing it loads
 * only Node built-ins, and the package is loaded only when the probe runs.
 */

import process from "node:process";

/**
 * How long the Chromium launch may take, passed to Playwright as the launch
 * `timeout`. A cold start takes a few seconds; a launch still pending after a
 * minute cannot serve the visual comparison either.
 */
export const PREFLIGHT_LAUNCH_MS = 60_000;

/**
 * How long one `browser.close()` may take before it counts as failed; a
 * clean close takes well under a second.
 */
export const PREFLIGHT_CLOSE_MS = 30_000;

export const PLAYWRIGHT_MISSING = "Playwright is not installed. Run: npm ci && npx playwright install chromium";
export const CHROMIUM_MISSING =
  "Playwright Chromium is missing or cannot start. Run: npx playwright install chromium " +
  "(in CI: npx playwright install --with-deps chromium)";
export const CHROMIUM_NOT_CLOSED =
  "Playwright Chromium started, but the preflight could not close it; it may still be running. " +
  "End that browser and run verify again.";

/** Message of a thrown value, whatever its type. */
function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * The browser's environment when the caller passes none: a copy of this
 * process's, without `JEKYLL_ENV`, which no child of the blog tooling inherits.
 */
function defaultEnv() {
  const env = { ...process.env };
  delete env.JEKYLL_ENV;
  return env;
}

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
 * One `browser.close()`, bounded by `timeoutMs`.
 * @param {{ close: () => Promise<void> }} browser
 * @param {number} timeoutMs
 * @returns {Promise<void>} resolves when the close does.
 * @throws {Error} the close's own reason, or one naming the bound when it has not settled in time.
 */
async function closeWithin(browser, timeoutMs) {
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`browser.close() did not finish within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => browser.close()), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** True only when Playwright reports the browser disconnected, which establishes that it was released. */
function disconnected(browser) {
  try {
    return typeof browser.isConnected === "function" && browser.isConnected() === false;
  } catch {
    return false;
  }
}

/**
 * Launches and closes the browser the visual comparison uses.
 *
 * The probe launches exactly what tests/visual/playwright.config.mjs
 * launches: browserName chromium, no channel, no executable path, and
 * Playwright Test's default `headless: true`. Playwright starts its
 * `chromium-headless-shell` build for that, not the full Chromium that
 * `chromium.executablePath()` names, so only a launch tells whether the
 * comparison can start its browser: with just the shell installed it runs,
 * and with just full Chromium it cannot. The launch also checks the host
 * libraries Chromium needs. tests/unit/verify.test.mjs holds the visual
 * project to this launch configuration.
 *
 * The browser it started is its own to release. Each close is bounded by
 * `closeTimeoutMs`; after a failed or late close it counts as released only
 * once Playwright reports it disconnected, or a second bounded close
 * succeeds. Released after a failure, the probe reports the failure as a
 * notice and passes; otherwise it fails, since the browser may still be
 * running. It never signals a process itself.
 * @param {object} [options]
 * @param {() => Promise<object>} [options.load]  Loads `@playwright/test`; tests pass a fake module.
 * @param {number} [options.timeoutMs]  Launch timeout; `PREFLIGHT_LAUNCH_MS` by default.
 * @param {NodeJS.ProcessEnv} [options.env]  The browser's environment, passed to the launch;
 *   this process's without `JEKYLL_ENV` by default.
 * @param {(message: string) => void} [options.report]  Prints a notice; stderr by default.
 * @param {number} [options.closeTimeoutMs]  Bound on each close; `PREFLIGHT_CLOSE_MS` by default.
 * @returns {Promise<string | null>} the failure message, or null when ready.
 */
export async function preflightPlaywright(options = {}) {
  const {
    // Resolved from this file's location, so the repository's node_modules is used from any directory.
    load = () => import("@playwright/test"),
    timeoutMs = PREFLIGHT_LAUNCH_MS,
    env = defaultEnv(),
    report = (message) => console.error(message),
    closeTimeoutMs = PREFLIGHT_CLOSE_MS,
  } = options;
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
    // The visual project's selection (no channel, headless), so this starts chromium-headless-shell as it does.
    browser = await chromium.launch({ headless: true, timeout: timeoutMs, env });
  } catch (err) {
    const reason = firstLine(errorMessage(err));
    return reason === "" ? CHROMIUM_MISSING : `${CHROMIUM_MISSING}\n(${reason})`;
  }
  const reasons = [];
  let released = false;
  for (let attempt = 0; attempt < 2 && !released; attempt += 1) {
    try {
      await closeWithin(browser, closeTimeoutMs);
      released = true;
    } catch (err) {
      reasons.push(firstLine(errorMessage(err)) || "no reason given");
      released = disconnected(browser);
    }
  }
  if (reasons.length === 0) return null;
  if (released) {
    report(`notice: closing the preflight's Chromium failed (${reasons.join("; ")}); it has since disconnected`);
    return null;
  }
  return `${CHROMIUM_NOT_CLOSED}\n(${reasons.join("; ")})`;
}
