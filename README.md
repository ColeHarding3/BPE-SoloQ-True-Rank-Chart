# Ranked Distribution 📈

What was everyone's **peak** rank — and how do those peaks compare across eras, when a
Diamond in 2017 was rarer than a Diamond today?

This is a small, shareable, interactive web page that pulls each friend's **peak rank for
every season** from [op.gg](https://op.gg) and plots it as an **inflation-adjusted
percentile**, so ranks from different years are compared by where they actually stood at
the time. Each player's all-time peak is marked. It's an automated, always-current version
of a chart we used to draw by hand ([`og.png`](./og.png)).

- **Inflation-adjusted** — Cole's Season 7 Diamond 2 shows up in today's Master range,
  because that's what it was worth back then. Toggle "Raw tier" to see the difference.
- **Full history** — every season each player was ranked, back to ~2014.
- **Interactive** — toggle each player on/off; hover a dot for that season's detail.
- **Auto-updating** — a GitHub Action re-scrapes op.gg every few hours.
- **Zero dependencies, static hosting** — just HTML/CSS/JS on GitHub Pages.

## Add your friends

Edit [`data/summoners.json`](./data/summoners.json). Each player needs an `account` in
`GameName#TAG` form, exactly as it appears on op.gg (the tag is the bit after the `#`,
e.g. `NA1`):

```json
{
  "region": "na",
  "players": [
    { "name": "Syndra God", "account": "Syndra God#NA1", "color": "#ef4444" },
    { "name": "Phiff",      "account": "Phiff#NA1",       "color": "#3b82f6" }
  ]
}
```

- Leave `account` empty to skip someone.
- `region` is the default for everyone; add `"region": "euw"` to a single player to override.
- `color` is that player's line/dot color on the chart.

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm run scrape   # fetch everyone's ranks from op.gg → data/data.json
npm run serve    # open http://localhost:8080
```

> Open it through `npm run serve`, not by double-clicking `index.html` — browsers block
> the data file from loading over `file://`.

## Put it online (GitHub Pages)

1. Push this folder to a GitHub repo.
2. **Settings → Pages → Source: GitHub Actions**.
3. The included workflow ([`.github/workflows/update.yml`](./.github/workflows/update.yml))
   scrapes op.gg and deploys on every push, on a 6-hour schedule, and whenever you click
   **Run workflow**. Share the resulting `*.github.io` link with the squad.

## How it works

op.gg renders rank data — including a full per-season history back to ~2014 — straight
into its page HTML, so a small Node script fetches each profile and parses it (no API key,
no browser). Each season's peak is then converted to an inflation-adjusted percentile using
per-era distribution estimates in [`data/season-distribution.json`](./data/season-distribution.json),
which you can tweak. See [`CLAUDE.md`](./CLAUDE.md) for the full architecture.

> The old-season distribution cutoffs are estimates (calibrated so a classic-era Diamond II
> lands around today's Master). Adjust them in `data/season-distribution.json` and every
> point on the chart recomputes.

*Not affiliated with Riot Games or op.gg. For fun among friends.*
