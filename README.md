# Cabrillo Coast LLC — website

A single-page marketing site for **Cabrillo Coast LLC**, a boutique software
consultancy focused on **technical advisory & architecture**.

- **Stack:** plain HTML + CSS + a little vanilla JS. No build step, no dependencies.
- **Hosting:** GitHub Pages (static).
- **Contact form:** [Formspree](https://formspree.io) (works on static hosts).

```
index.html     — the page (structure + copy)
styles.css     — coastal theme, light/dark, responsive
main.js        — mobile nav, scroll state, contact-form submit
favicon.svg    — browser-tab icon
```

## Run it locally

Just open `index.html` in a browser. Or serve it (nicer for testing):

```bash
python -m http.server 8000
# then visit http://localhost:8000
```

## Things to customize (search the code for these)

| What | Where | Note |
|------|-------|------|
| Your name / bio | `index.html` → `.about-founder` | Marked `EDIT:` — replace `[Your Name]`, `[X]+ years`, domains, or delete the line |
| Contact email | `index.html` (2 spots) + `main.js` | Currently `hello@cabrillocoast.com` |
| **Form endpoint** | `index.html` → `<form action="…">` | Replace `YOUR_FORM_ID` — see below |
| Copy / services | `index.html` | Edit freely |
| Colors / fonts | `styles.css` → `:root` | Brand colors are CSS variables at the top |

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

### Custom domain (later)

1. Add a file named `CNAME` containing `cabrillocoast.com` (no scheme, no slash).
2. At your DNS provider, point the apex/`www` records at GitHub Pages
   ([instructions](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site)).
3. In the repo's **Settings → Pages**, set the custom domain and enable *Enforce HTTPS*.
