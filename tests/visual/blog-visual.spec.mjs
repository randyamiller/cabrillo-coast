/* Cabrillo Coast LLC — blog visual comparison (AC-16, F-018 public viewing) */
/**
 * Twelve full-page screenshots: the blog listing and the code-and-tables
 * fixture article, each at 375px, 800px and 1280px wide, in light and dark
 * colour schemes.
 *
 * Run only through `node tests/visual/run-visual.mjs`, which builds the
 * project fixture site twice (base revision and working tree), serves each on
 * 127.0.0.1 with the site mounted at `/cabrillo-coast/`, and runs this spec
 * through `tests/visual/playwright.config.mjs` twice:
 *   1. with `--update-snapshots=all` against the base build, writing the
 *      baseline into `VISUAL_BASELINE_DIR` (one flat file per screenshot, for
 *      example `listing-375-light.png`);
 *   2. with `--update-snapshots=none` against the working-tree build,
 *      comparing every screenshot with its baseline.
 *
 * The comparison is literal pixel equality (`threshold: 0`,
 * `maxDiffPixels: 0`). Two separate builds of identical source render
 * identically in the same browser build on the same machine, so any tolerance
 * would only hide a real regression. Intended visual changes are declared to
 * run-visual.mjs (a `Visual-Change: intended` commit trailer or
 * `VISUAL_CHANGE_INTENDED=1`), never by loosening this file.
 *
 * Inputs (environment):
 *   VISUAL_BASE_URL      Served site root including the base path, for example
 *                        `http://127.0.0.1:41234/cabrillo-coast`.
 *   VISUAL_BASELINE_DIR  Read by the config, which places baselines there.
 *
 * Determinism:
 *   - Google Fonts requests are aborted, so both renders use the same local
 *     fallback fonts whatever the network does.
 *   - Reduced motion is emulated (styles.css then disables every transition
 *     and animation) and screenshots disable CSS animations as well.
 *   - The footer `span#year` is masked: main.js rewrites it to the current
 *     year, which must never change pixels between the base and the change.
 *   - Nothing is focused, hovered, clicked or scrolled. main.js adds the
 *     header's `.scrolled` shadow only once `scrollY > 8`, and a full-page
 *     capture does not scroll the window.
 *   - The listing loads without `?q=`, so search.js only unhides the search
 *     form: it fetches no index and leaves the status line empty.
 */

import { test, expect } from "@playwright/test";

/*
 * Fail at load time, before any test runs, rather than screenshot an
 * unrelated origin or a relative path. One trailing slash is tolerated so
 * that page paths below always join with exactly one `/`.
 */
const RAW_BASE = process.env.VISUAL_BASE_URL;
if (typeof RAW_BASE !== "string" || RAW_BASE.trim() === "") {
  throw new Error("VISUAL_BASE_URL is not set; run tests/visual/run-visual.mjs");
}
const BASE = RAW_BASE.trim().replace(/\/$/, "");

/*
 * The listing and one article. The article is the fixture
 * tests/fixtures/posts/2026-01-15-fixture-code-and-tables.md (Python and YAML
 * fences with Rouge tokens, inline code, an aligned table and a blockquote),
 * rendered by _layouts/post.html at `permalink: /blog/:title/`.
 */
const PAGES = [
  { name: "listing", path: "/blog/" },
  { name: "article", path: "/blog/fixture-code-and-tables/" },
];

/*
 * One width per layout regime: up to 720px (single column, hamburger),
 * 721px to 900px (hamburger, since the navigation switch sits at 900px), and
 * above 900px (one-row desktop navigation).
 */
const WIDTHS = [375, 800, 1280];

const SCHEMES = ["light", "dark"];

/* Viewport height only; `fullPage` captures the whole document height. */
const HEIGHT = 900;

/* Google Fonts stylesheet and font files, the only third-party requests. */
const FONT_ROUTE = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

test.describe("[AC-16][F-018] blog visual comparison", () => {
  for (const { name, path } of PAGES) {
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        test(`[AC-16][F-018] ${name} ${width}px ${scheme}`, async ({ page }) => {
          await page.route(FONT_ROUTE, (route) => route.abort());
          await page.setViewportSize({ width, height: HEIGHT });
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });

          const url = BASE + path;
          const response = await page.goto(url, { waitUntil: "load" });
          // A missing page would otherwise be screenshotted as a 404 body and
          // compared like any other page; fail with the URL instead.
          expect(response?.ok(), `${url} must load with a 2xx status`).toBe(true);

          // Await inside the page and return nothing: a FontFaceSet cannot be
          // serialized back to the test.
          await page.evaluate(async () => {
            await document.fonts.ready;
          });

          await expect(page).toHaveScreenshot(`${name}-${width}-${scheme}.png`, {
            fullPage: true,
            animations: "disabled",
            threshold: 0,
            maxDiffPixels: 0,
            mask: [page.locator("#year")],
          });
        });
      }
    }
  }
});
