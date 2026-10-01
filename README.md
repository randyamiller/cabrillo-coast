# Cabrillo Coast LLC — website

A single-page marketing site for **Cabrillo Coast LLC**, a boutique software
consultancy focused on **technical advisory & architecture**.

- **Stack:** the home page is plain HTML + CSS + a little vanilla JS. Blog pages are
  rendered from Markdown by GitHub Pages' built-in Jekyll. Visitors receive no
  third-party JavaScript and no shipped runtime libraries; the Google Fonts stylesheet
  and fonts are the only third-party resources. `Gemfile` and `package.json` pin
  development-only tooling for preview and checks.
- **Hosting:** GitHub Pages (static).
- **Contact form:** [Formspree](https://formspree.io) (works on static hosts).

```
index.html     — the page (structure + copy)
styles.css     — coastal theme, light/dark, responsive
main.js        — mobile nav, scroll state, contact-form submit
favicon.svg    — browser-tab icon

_config.yml                       — Jekyll configuration (URL, permalinks, excludes)
_config.preview.yml               — local preview overlay (lets draft images render)
_layouts/                         — blog page layouts (blog.html, post.html)
_includes/                        — blog header and footer (copies of the home page chrome)
_posts/                           — published articles (YYYY-MM-DD-slug.md)
_templates/article.md             — starter for new articles
blog/                             — listing page, search index template, search.js, blog.css
assets/blog/                      — images of published articles
scripts/                          — article.mjs publishing tool, verify.mjs checks
.githooks/                        — pre-commit and pre-push draft guards
tests/                            — node:test suites, fixtures, visual comparison
Gemfile, package.json             — development-only tool pins
.github/workflows/blog-checks.yml — CI verification (does not deploy)
```

## Run it locally

The home page alone needs no tooling. Just open `index.html` in a browser. Or serve
it (nicer for testing):

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

Served this way, blog paths show raw Liquid instead of rendered pages. Use Jekyll to
preview the blog.

### One-time setup

Install Git, Ruby 3.3.4 with Bundler, and Node.js 22 or later (with npm). Then, from
the repository root:

```bash
bundle install                        # the GitHub Pages gem set (github-pages 232)
npm ci                                # @playwright/test, for the visual comparison
npx playwright install chromium       # the browser the visual comparison uses
git config core.hooksPath .githooks   # enable the draft guards, once per clone
```

### Preview

```bash
bundle exec jekyll serve --drafts --config _config.yml,_config.preview.yml
# then visit http://localhost:4000/blog/
```

Drafts and their images render only in this preview. Jekyll binds to 127.0.0.1, so it
is reachable from your machine only.

### Checks

```bash
node scripts/verify.mjs
```

Runs every automated check in order (the real build, the `node:test` suites, the
fixture builds and the visual comparison) and stops at the first failure. Exit code 0
means every check passed. CI runs the same script.

Never set `JEKYLL_ENV=production` locally: without a Pages API token, a production
build derives the wrong base path (`/pages/randyamiller/cabrillo-coast`).

## Things to customize (search the code for these)

| What | Where | Note |
|------|-------|------|
| Your name / bio | `index.html` → `.about-founder` | Marked `EDIT:` — replace `[Your Name]`, `[X]+ years`, domains, or delete the line |
| Contact email | `index.html` (2 spots) + `main.js` | Currently `hello@cabrillocoast.com` |
| **Form endpoint** | `index.html` → `<form action="…">` | Replace `YOUR_FORM_ID` — see below |
| Copy / services | `index.html` | Edit freely |
| Colors / fonts | `styles.css` → `:root` | Brand colors are CSS variables at the top |
| Blog intro copy | `blog/index.html` | Kicker, heading and lede |
| Default article author | `_config.yml` → `defaults` | Currently "Randy Miller" |
| Blog styles | `blog/blog.css` | Uses the `:root` tokens from `styles.css` |

### Publishing a technical article

Articles are Markdown files in `_posts/`. GitHub Pages renders each one at
`/blog/<slug>/`, lists it newest first at `/blog/` and adds it to the search index.
Do the [one-time setup](#one-time-setup) first, including
`git config core.hooksPath .githooks`.

#### What "private" means

- Changing the live site (publishing, updating or unpublishing) requires GitHub write
  access to this repository.
- Drafts (`_drafts/<slug>.md`) and draft images (`assets/drafts/<slug>/`) live only in
  your working copy. Both folders are git-ignored, and normal builds exclude draft
  images.
- Backing up drafts is your responsibility: they are not in git.
- The repository is public. **Never commit drafts, draft images, `published:` or
  future dates.** Each would be hidden from the site but readable on GitHub.

#### Write, preview, publish

1. **Create.** `node scripts/article.mjs new <slug>` copies `_templates/article.md` to
   `_drafts/<slug>.md` and creates `assets/drafts/<slug>/` for its images. It refuses
   an invalid slug or one already in use, and warns if the hooks are not enabled.
2. **Edit and preview.** Edit the draft, put its images in `assets/drafts/<slug>/`
   and run the [preview](#preview). The draft is at
   `http://localhost:4000/blog/<slug>/`.
3. **Check.** `node scripts/article.mjs check _drafts/<slug>.md` reports schema
   errors, placeholder markers left over from the article template, unsafe markup,
   missing, external or `data:` images, and Liquid in code that is not wrapped in
   `{% raw %}`.
4. **Publish.** `node scripts/article.mjs publish <slug>` re-runs the check, moves the
   draft to `_posts/<UTC date>-<slug>.md`, moves its images to `assets/blog/<slug>/`
   and rewrites their paths. An empty image folder is deleted instead, so an article
   without images gets no image folder.
5. **Verify.** `node scripts/verify.mjs`. Exit code 0 means every check passed.
6. **Release.** `publish` prints these commands with the real names filled in:

   ```bash
   git add _posts/YYYY-MM-DD-<slug>.md assets/blog/<slug>   # the folder only when it exists
   git commit -m "Publish: <title>"
   git push origin main
   ```

   The hooks run `guard`, Pages rebuilds, and the article goes live (see
   [Deploy](#deploy-to-github-pages) for timing).

**Updating** a published article: edit its file in `_posts/`, set
`updated: YYYY-MM-DD`, then check, verify, commit and push. The URL stays the same,
because the date prefix is not part of it.

Every `article.mjs` command exits 0 on success, 1 on a validation failure (details on
stderr) and 2 on a usage error. `node scripts/article.mjs --help` lists them all.

#### Safeguards and their limits

Every safeguard runs on your machine except the last, which only reports.

| Safeguard | What it stops | Limit |
|-----------|---------------|-------|
| `.gitignore` (`_drafts/`, `assets/drafts/`) | `git add -A` and `git add .` skip drafts and draft images | `git add -f` overrides it |
| `article.mjs check` and `publish` | A draft that fails the schema, date or image rules is not moved into `_posts/` | Runs only when you run it |
| `.githooks/pre-commit` (`guard --staged`) | Refuses a commit when the staged tree holds a draft, a draft image, a `published:` key, a future date or an `assets/blog/<slug>/` folder without its post, when a staged article fails the schema or unsafe-markup checks, or when a staged hook is not executable | Needs `git config core.hooksPath .githooks` once per clone; skipped by `git commit --no-verify`; does not run for edits made on github.com or in a clone without the setting |
| `.githooks/pre-push` (`guard --pre-push`) | The same rules for every commit in the pushed range, not only the tip, so a draft committed and later deleted still blocks the push | As for pre-commit; skipped by `git push --no-verify` |
| `node scripts/verify.mjs` | Every automated check, before the push | Voluntary |
| `blog-checks` workflow | Reports a violation after the push | Detection only: the content is already public |

**Residual risk.** Drafts stay private only while the hooks are enabled and not
bypassed. GitHub offers no server-side push rule that could refuse draft paths for
this public repository, so nothing stops a draft that gets past the local safeguards.
Anything pushed is public at once (an image under `assets/blog/` is also served by the
next Pages build) and stays in git history, in clones and in caches. Deleting it later
does not undo the disclosure.

#### Front matter

```yaml
---
title: "Upgrading Kubernetes without downtime"
summary: "A checklist for control-plane and node upgrades that keep traffic flowing."
tags: [kubernetes, platform-engineering]
---
```

| Field | Rule |
|-------|------|
| slug | From the filename; `^[a-z0-9]+(?:-[a-z0-9]+)*$`; ≤ 60 characters; unique across `_posts/` and `_drafts/` |
| date | From the filename prefix (`YYYY-MM-DD`), read as UTC; set by `publish`; never in the future |
| `title` | Double-quoted; 1–100 characters |
| `summary` | Double-quoted; 1–200 characters |
| `tags` | Flow list `[a, b]`; 1–5 lowercase kebab-case items; double-quote an item YAML would read as a number, date, boolean or null, such as `["2026", "null", "on"]` |
| `updated` | Optional `YYYY-MM-DD`; not before the date |
| `author` | Optional; double-quoted; defaults to "Randy Miller" |
| body | Required; the Markdown after the closing `---` (article content, not a front-matter key); must not be empty; rendered by kramdown (GFM input) with Rouge highlighting |

Any other key is rejected, including `layout`, `permalink`, `published`, `date` and
`categories`: the layout, URL and date come from `_config.yml` and the filename.

#### Images

While drafting, keep images in `assets/drafts/<slug>/` and reference them like this
(`publish` rewrites the path to `/assets/blog/<slug>/`):

```markdown
![Alt text]({{ '/assets/drafts/<slug>/figure.png' | relative_url }})
```

Alt text is required. Images must be local files in the article's own folder;
external and `data:` images are rejected by `check` and blocked by the blog's
Content-Security-Policy.

#### Code and links

- Put a language name after the opening fence, e.g. `` ```python ``, for highlighting.
- Wrap Liquid-looking text (`{{ }}`, `{% %}`) in `{% raw %}…{% endraw %}`; unwrapped,
  it can break the Pages build, and `check` warns about it:

  ````markdown
  {% raw %}
  ```yaml
  image: {{ .Values.image }}
  ```
  {% endraw %}
  ````

- Link to another article with `{{ site.baseurl }}{% post_url YYYY-MM-DD-slug %}`. The
  build fails if the target is renamed or unpublished.
- Raw `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>`, `<meta>`,
  `<link>` and `<style>` tags, `on*=` attributes and `javascript:` URLs are rejected
  by `check` and `guard`. HTML shown inside code is fine.

#### Unpublishing

`node scripts/article.mjs unpublish <slug>` refuses while other articles still
reference the post (a `post_url` tag or a link to `/blog/<slug>/`) and lists each file
and line. Repoint or remove those references first. Otherwise it moves the post back
to `_drafts/<slug>.md` and any images back to `assets/drafts/<slug>/`. Then commit the
deletions and push (it prints the commands). The next build removes the page, its
search entry and its images.

Unpublishing ends current publication only: everything already pushed stays readable
in git history.

#### Intended visual changes

The visual comparison in `verify.mjs` fails on any pixel difference in the blog
listing or an article. When a change is meant to look different, add a
`Visual-Change: intended` trailer to a commit message in the pushed range, or set
`VISUAL_CHANGE_INTENDED=1`. The differences are then reported without failing.

#### Search index budget

`verify.mjs` warns when `blog/search.json` grows above 300,000 bytes and fails above
400,000 (roughly 45 articles of 2,000 words). To go further, raise the limit in
`tests/static/built-search-index.test.mjs` in the same commit that grows the index.

#### Account hygiene

- Review who has write access under **Settings → Collaborators**.
- Enable two-factor authentication on every account with write access.
- Before giving a second person write access, configure branch protection on `main`
  with a mandatory pull-request gate and required reviews.

### Wire up the contact form (2 minutes)

1. Create a free form at **https://formspree.io** (verify your email).
2. Copy the endpoint it gives you, e.g. `https://formspree.io/f/xdorwqkz`.
3. In `index.html`, replace `https://formspree.io/f/YOUR_FORM_ID` with it.

Until then, the form shows a friendly "not connected yet" message instead of failing.

## Deploy to GitHub Pages

Already a git repo? Push it and enable Pages:

```bash
git add -A && git commit -m "Update site"
git push
```

First-time setup (done via `gh`):

```bash
gh repo create cabrillo-coast --public --source=. --push
gh api -X POST repos/{owner}/cabrillo-coast/pages -f build_type=legacy \
  -f "source[branch]=main" -f "source[path]=/"
```

Site goes live at `https://<username>.github.io/cabrillo-coast/`.

### Publishing on push

- A push to `main` publishes articles. Pages runs Jekyll on every push; the live site
  updates within about 10 minutes, plus up to 600 s of cache (worst case about 20
  minutes). If the build fails, Pages keeps serving the last good site and notifies
  the owner.
- **Never add `.nojekyll`.** It switches Jekyll off and stops the blog rendering.
- The `blog-checks` workflow (`.github/workflows/blog-checks.yml`) runs
  `node scripts/verify.mjs` on every push to `main` and every pull request. It reports
  but does not block: branch-mode Pages publishes `main` regardless. Run
  `node scripts/verify.mjs` before pushing.

### Keeping the build in step with Pages

`Gemfile`, `Gemfile.lock` and `.ruby-version` reproduce the gem versions GitHub Pages
runs. When https://pages.github.com/versions.json changes:

1. Update `github-pages` and `nokogiri` in `Gemfile` and the Ruby version in
   `.ruby-version` together, to the versions it lists.
2. Regenerate `Gemfile.lock` with `bundle lock`, using the Bundler shipped with that
   Ruby.
3. Run `node scripts/verify.mjs`, then commit all three files together.

### Project-path mode

To serve the site from `https://randyamiller.github.io/cabrillo-coast/` instead of the
custom domain, in the same commit delete `CNAME` and set
`url: "https://randyamiller.github.io"` in `_config.yml`. Pages supplies the base path
itself. Never set `baseurl`.

### Custom domain (later)

1. Add a file named `CNAME` containing `cabrillocoast.com` (no scheme, no slash).
2. At your DNS provider, point the apex/`www` records at GitHub Pages
   ([instructions](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site)).
3. In the repo's **Settings → Pages**, set the custom domain and enable *Enforce HTTPS*.
