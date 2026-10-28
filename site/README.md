# Epoptes website

The landing page published on GitHub Pages. Plain HTML, CSS and JavaScript with system fonts: no framework, dependencies, requests or build step. It is separate from the dashboard in `ui/`.

## Preview

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
# http://127.0.0.1:4173
```

## Publish

[`pages.yml`](../.github/workflows/pages.yml) deploys this folder when `site/` or the workflow changes on `main`, or by hand from the **Actions** tab. Enable it once under **Settings → Pages → Build and deployment → Source: GitHub Actions**. The workflow rewrites `og:image` to an absolute URL and adds the canonical URL; the source keeps relative paths.

## Content

The page explains what Epoptes is, why it exists, how a harness run compares with one long agent session, and gives a crash course. Keep claims to what works today. For factual updates, check `README.md`, `docs/spec.md` and `plugin/skills/epoptes/reference/`.

- **Hero dashboard** (`app.js`, `dashboard`): a simulated goal page whose ticker, clock and board move while it's on screen.
- **The night shift** (`SOLO`, `EPO`): one long session against a harness over 8 hours, rendered as a function of the minute so the slider can scrub it. It is labelled an illustration, not a benchmark.
- **Crash course** terminals mirror real CLI output formats (`src/cli.ts`); update them when those change.
- Reduced motion turns the animations off. Without JavaScript, every crash-course step shows at once.
- `social-card.png` is 1200 × 630 and repeats the hero headline.
