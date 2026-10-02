/* Cabrillo Coast LLC — Playwright Test configuration for the blog visual comparison */
/**
 * Configuration for `blog-visual.spec.mjs`, the blog's visual regression
 * check (AC-16), in Playwright's Chromium only.
 *
 * Run only through `node tests/visual/run-visual.mjs`. It supplies
 * `VISUAL_BASELINE_DIR` (required; see the guard below), `VISUAL_BASE_URL`
 * (read by the spec) and, for the comparison run only, `VISUAL_RESULTS_FILE`,
 * and chooses snapshot updating on its command line, never here. Baselines
 * live in a temporary directory and are never committed: both sides render
 * in the same browser build on the same machine, so a committed image would
 * only add operating system and font drift. Comparison strictness is set in
 * the spec and deliberately not loosened here. The spec folder, artefacts and
 * report are resolved from this file's folder, never `process.cwd()`, so they
 * land in the same place wherever Playwright was launched.
 */

import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/*
 * Refuse to load without a baseline directory. Without this guard a bare
 * `npx playwright test --config tests/visual/playwright.config.mjs` would fall
 * back to Playwright's default snapshot location beside the spec and write
 * baseline images into the repository.
 */
const baselineEnv = process.env.VISUAL_BASELINE_DIR;
if (typeof baselineEnv !== "string" || baselineEnv.trim() === "") {
  throw new Error("Run the visual comparison through tests/visual/run-visual.mjs");
}

/*
 * Resolved here, against the launching process's working directory, so a
 * relative value is not reinterpreted by Playwright against this config's
 * folder.
 */
const baselineDir = path.resolve(baselineEnv);

/*
 * The comparison run's machine-readable results. run-visual.mjs sets
 * `VISUAL_RESULTS_FILE` for the comparison run only and reads the file to
 * classify every failed case: a declared intended change is accepted only
 * when each failure is solely a screenshot mismatch. Added to the reporters
 * here rather than with `--reporter`, which would replace the list and html
 * reporters below.
 */
const resultsEnv = process.env.VISUAL_RESULTS_FILE;
const resultsReporters =
  typeof resultsEnv === "string" && resultsEnv.trim() !== ""
    ? [["json", { outputFile: path.resolve(resultsEnv) }]]
    : [];

export default defineConfig({
  testDir: here,

  // Spec files only. `node --test "tests/**/*.test.mjs"` in scripts/verify.mjs
  // owns every `*.test.mjs` file, so the two runners never pick up each
  // other's files.
  testMatch: "*.spec.mjs",

  /* One browser, one page at a time: renders are serial and deterministic. */
  fullyParallel: false,
  workers: 1,
  retries: 0,

  /* A stray `test.only` must not silently shrink the 12-screenshot set. */
  forbidOnly: true,

  /* Per-test artefacts (actual, expected and diff images on failure). */
  outputDir: path.join(here, "test-results"),

  /*
   * `report/` is what the blog-checks workflow uploads as an artifact when
   * verification fails. Both folders are git-ignored.
   */
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(here, "report"), open: "never" }],
    ...resultsReporters,
  ],

  /*
   * Flat baseline files named after the `toHaveScreenshot` argument, for
   * example `<baseline>/listing-375-light.png`. run-visual.mjs counts them.
   */
  snapshotPathTemplate: path.join(baselineDir, "{arg}{ext}"),

  use: {
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  },

  /* Chromium only; Firefox and WebKit runs are outside this comparison. */
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
