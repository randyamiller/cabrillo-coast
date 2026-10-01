/* Cabrillo Coast LLC — Playwright Test configuration for the blog visual comparison */
/**
 * Visual regression of the blog (AC-16): full-page screenshots of the listing
 * and one fixture article at 375px, 800px and 1280px, in light and dark
 * schemes, taken by `blog-visual.spec.mjs` in Playwright's Chromium.
 *
 * Run it only through `node tests/visual/run-visual.mjs`. That script builds
 * the base revision and the working tree, serves each on 127.0.0.1, and calls
 * Playwright twice with this file: first in update mode against the base
 * build, which writes the baseline, then in compare mode against the
 * working-tree build. Snapshot updating is chosen on that command line, never
 * here. It passes the baseline directory in `VISUAL_BASELINE_DIR` and the
 * served site in `VISUAL_BASE_URL`.
 *
 * Baselines are written to a temporary directory outside the repository and
 * are never committed: both sides are rendered by the same browser build on
 * the same machine in one run, so a committed image would only add operating
 * system and font drift.
 *
 * The spec folder, test artefacts and report are resolved from this file's
 * folder, never from `process.cwd()`, so they land in the same place wherever
 * Playwright was launched. Comparison strictness (`threshold: 0`, `maxDiffPixels: 0`) is set
 * on each `toHaveScreenshot` call in the spec and is deliberately not loosened
 * here.
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
