# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, interactive web page that charts a friend group's **peak League of Legends
rank each season**, converting every peak into an **inflation-adjusted percentile** so a
Diamond in 2017 and an Emerald today are compared by where they actually stood at the
time. Each player's all-time peak is marked. It's an automated, always-current version of
the hand-drawn `og.png`. Season history is scraped from op.gg. Hosted on GitHub Pages.

## Commands

```bash
npm run scrape   # node scripts/scrape.mjs — fetch ranks from op.gg, rewrite data/data.json
npm run serve    # node scripts/serve.mjs — static server on http://localhost:8080 for local preview
```

There are **no dependencies and no build step** (`package.json` has no `dependencies`),
so CI needs no `npm install`. Node >= 18 is required (uses global `fetch`). Open the
page via `npm run serve`, not `file://` — the page `fetch()`es `data/data.json`, which
the browser blocks over `file://`.

## Architecture / data flow

```
data/summoners.json  ─┐
                      ├▶ scripts/scrape.mjs ─▶ data/data.json ─┐
(op.gg per season) ───┘   (op.gg HTML parse)   (per-player      ├▶ app.js ─▶ chart + board
                                                seasons[])      │   index.html / styles.css
data/season-distribution.json  ─────────────────────────────────┘   (inflation → percentile)
```

- **`data/summoners.json`** — the roster you maintain: `name`, `account` ("GameName#TAG"),
  `color`, optional per-player `region`. Empty `account` ⇒ skipped. Optional `overrides: [{
  label, tier, division, lp }]` manually set/patch a season's peak (op.gg doesn't record
  old-season LP); `applyOverrides()` merges them after scraping so they survive re-scrapes.
- **`scripts/scrape.mjs`** — reads the roster, fetches each op.gg summoner page, and writes
  `data/data.json`. For each player it parses the current rank *and* the full season
  history (`seasons[]`: one peak per season back to ~2014). All parsers return `null`/`[]`
  on no-match so one broken field can't fail the run; it exits non-zero only if *every*
  player fails.
- **`data/data.json`** — generated artifact the page consumes. Each player has
  `seasons: [{ order, label, era, tier, division, lp, games }]` plus current `solo`/`flex`.
- **`data/season-games.json`** — per-season solo games (`account → { label: games }`),
  backfilled **once** by `scripts/backfill-games.mjs` from op.gg's champions page
  (`?season_id=…&queue_type=SOLORANKED`; splits summed). Historical games never change, so
  it's committed and merged by `scrape.mjs`; the current season's games come from the live
  W/L instead. The op.gg `season_id` map (not the LoL season number) lives in that script.
- **`data/season-distribution.json`** — the inflation model: a **division-level** rank
  distribution for **each season** (`seasons[]`, keyed by `label`), read from the Season
  1–15 rank-distribution image (`league-of-legends-season-1-15-...png`, the source of truth).
  Each season's `tiers[]` is an ordered list of division entries `{ tier, division, floor }`
  where `floor` = cumulative top% at the bottom of that division (apex tiers have
  `division: null`). Old seasons (S4–S8) have 5 divisions/tier, else 4. Modern seasons
  (S13–S15) were hand-read and validated to 100%; the rest were pixel-extracted from the
  chart (see `scripts/extract-distribution.py`). S16 reuses S15. `app.js` uses it both to draw each
  season's stacked column and to turn a peak into a percentile.
- **`app.js`** — loads both JSON files and draws everything as hand-built inline SVG (no
  chart library). Computes each season's adjusted percentile and each player's peak.
  `index.html` + `styles.css` are the shell and theme.
- **`.github/workflows/update.yml`** — scrapes + deploys to Pages on a 6-hour cron,
  on push to `main`, and via manual dispatch.

### Why scraping runs in CI, not the browser
GitHub Pages is static and op.gg sends no CORS headers, so a browser `fetch('op.gg/...')`
from the Pages site is blocked. The scraper runs **server-side** (locally or in the
GitHub Action), which has no CORS restriction, and ships the resulting `data/data.json`
inside the Pages artifact. Do not try to move scraping into `app.js`.

## op.gg scraping specifics (the fragile part)

op.gg **server-renders** all of this into the page HTML, so a plain `fetch` + regex is
enough — no headless browser. `scrape.mjs` parses several renderings of the same data:

1. **Current Solo/Duo** — flat text summary ("`Emerald 2 2 37LP / 19Win 22Lose`") via
   `parseSummary()`; ladder percentile ("`8.18% of top`") via `parsePercentile()`.
2. **Current Flex** — structured rank cards (`<strong>diamond 3</strong> … 97 LP … 41W 35L
   … Win rate`) via `parseStructuredBlocks()` + `pickFlex()`.
3. **Season history** (the important one) — op.gg embeds a per-season list in its RSC
   payload as escaped JSON: `"season":"S7","rank_entries":{"high_rank_info":{tier,lp},
   "rank_info":{tier,lp}}`, reaching back to ~2014. `parseSeasons()` unescapes the `\"` layer,
   and for each season prefers `high_rank_info` (true peak — but op.gg only fills it for the
   newest season(s)) else `rank_info` (end-of-season, populated for all). LP is captured too
   (`null` on the oldest seasons). Labels map to `{ order, label, era }` via `SEASON_META`.
   The live current rank is folded in as the current season (with its LP). 2023/2024 shipped
   as multiple ranked splits, so `collapseSplits()` merges each year's splits into one season
   (S13, S14), keeping the player's highest rank across them (`rankScore`). **Caveat:** the
   per-season LP is end-of-season, not peak — so `data/summoners.json` `overrides` (applied
   after, and winning) are the source of truth where a real peak is known (e.g. Cole S7 90 LP
   vs op.gg's end-of-season 0).

Note op.gg splits text nodes with `<!-- -->` comments (stripped before matching), and old
seasons (S4–S8) use the **five-division** system so `division` can be 1–5. If op.gg changes
its markup, these parsers + `TIERS`/`TIER_RE` + `SEASON_META` are the only things to touch.

## Season model & inflation adjustment (the core idea)

`app.js` converts each season's peak `(tier, division, lp)` into a percentile using that
**season's own** division-level distribution in `data/season-distribution.json`:

- `DIST_BY_LABEL` maps label → distribution; `TODAY` is the latest season (used for "≈ today").
- `percentileIn()` finds the exact division entry for `(tier, division)`, takes its `[top,
  floor]` cumulative span (the entry above gives `top`), and interpolates within it by `lp`
  (100 LP → top edge, 0 → bottom, null → midpoint). So a rank lands at its *true* standing
  that season (e.g. S7 Diamond II at 90 LP ≈ top 0.08% ≈ high Master today).
- `tierRanges()` collapses the division entries back to per-tier `[top, bottom]` spans for
  the right-edge tier labels (so each tier is labeled once, not per division).
- The chart draws **one stacked column per season** from these distributions (each division
  is a band, colored by tier), and each player's dot sits at its percentile in that column.
- The **Log/Linear** control (`state.scale`) only changes the y-axis mapping in `renderChart`
  (`yFor`) and gridline ticks; log is the default. Linear zooms to the top 2% (below is chopped).
- A player's **peak** is their lowest-percentile season; it gets a ringed dot + label.
- To re-read or fix the distribution, `scripts/extract-distribution.py` pixel-extracts the source image
  (3 zoom charts: 0-100% for Gold→Iron, 0-10% for Diamond, 0-1% for apex); values validate
  against hand reads within ~0.02%.

## Gotchas

- `level` is best-effort and frequently `null` — op.gg doesn't label it reliably. Don't
  build anything that depends on it.
- The Action has `continue-on-error` on the scrape step so a temporary op.gg block/markup
  change still deploys the last-good `data/data.json` instead of failing the pipeline.
- GitHub Actions runner IPs can occasionally be rate-limited or challenged by op.gg. If
  scrapes start failing only in CI, that's the likely cause (a proxy would be the fix).

## Deploying (GitHub Pages)

Repo settings → Pages → Source: **GitHub Actions**. The workflow needs `pages: write`
and `id-token: write` (already declared). First deploy happens on push to `main` or via
"Run workflow".
