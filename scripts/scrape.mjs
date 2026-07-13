// Scrapes current League of Legends ranks from op.gg for every player listed in
// data/summoners.json and writes data/data.json.
//
// op.gg server-renders the rank data into the page HTML, so we only need a plain
// fetch + regex parse — no headless browser, no JS execution, no API key. This runs
// server-side (locally or in GitHub Actions), which sidesteps the browser CORS wall
// that would block a static page from scraping op.gg directly.
//
// Usage: node scripts/scrape.mjs
//
// If op.gg ever changes its markup, the parsers below are the only thing to update;
// each returns null on no-match so a single broken field can't take down the run.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SUMMONERS_FILE = join(ROOT, "data", "summoners.json");
const OUT_FILE = join(ROOT, "data", "data.json");
const GAMES_FILE = join(ROOT, "data", "season-games.json"); // per-season games, backfilled once
let GAMES = {}; // account -> { label: games }

const TIERS = ["iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger"];
const TIER_RE = TIERS.join("|");

// Maps op.gg's per-season labels to a chronological order, a display label, and a
// distribution "era" (see data/season-distribution.json). op.gg uses "S4".."S9" for
// 2014-2019 and calendar-year "S2020".."S2026" after, with 2023/2024 split into acts.
const SEASON_META = {
  S1: { order: 1, label: "S1", era: "classic" },
  S2: { order: 2, label: "S2", era: "classic" },
  S3: { order: 3, label: "S3", era: "classic" },
  S4: { order: 4, label: "S4", era: "classic" },
  S5: { order: 5, label: "S5", era: "classic" },
  S6: { order: 6, label: "S6", era: "classic" },
  S7: { order: 7, label: "S7", era: "classic" },
  S8: { order: 8, label: "S8", era: "classic" },
  S9: { order: 9, label: "S9", era: "gm" },
  S2020: { order: 10, label: "S10", era: "gm" },
  S2021: { order: 11, label: "S11", era: "gm" },
  S2022: { order: 12, label: "S12", era: "gm" },
  "S2023 S1": { order: 13.1, label: "S13.1", era: "emerald" },
  "S2023 S2": { order: 13.2, label: "S13.2", era: "emerald" },
  "S2024 S1": { order: 14.1, label: "S14.1", era: "emerald" },
  "S2024 S2": { order: 14.2, label: "S14.2", era: "emerald" },
  "S2024 S3": { order: 14.3, label: "S14.3", era: "emerald" },
  S2025: { order: 15, label: "S15", era: "emerald" },
  S2026: { order: 16, label: "S16", era: "emerald" },
};
const CURRENT_SEASON = SEASON_META.S2026;
// label ("S7", "S10", "S13.1") -> meta, so manual overrides can reference display labels.
const LABEL_META = Object.fromEntries(Object.values(SEASON_META).map((mm) => [mm.label, mm]));

// 2023/2024 shipped as multiple ranked splits; collapse each year's splits into one season.
const SPLIT_PARENT = {
  13.1: { order: 13, label: "S13" },
  13.2: { order: 13, label: "S13" },
  14.1: { order: 14, label: "S14" },
  14.2: { order: 14, label: "S14" },
  14.3: { order: 14, label: "S14" },
};

// Higher score = better rank. TIERS is ordered worst→best, so its index ranks tiers.
function rankScore(s) {
  const t = TIERS.indexOf(String(s.tier).toLowerCase());
  const dr = s.division == null ? 5 : 5 - s.division; // lower division number is better; apex has none
  return t * 100000 + dr * 1000 + (s.lp || 0);
}

/** Merge split seasons into their parent year, keeping each player's highest rank across splits. */
function collapseSplits(seasons) {
  const best = new Map();
  for (const s of seasons) {
    const parent = SPLIT_PARENT[s.order];
    const entry = parent ? { ...s, order: parent.order, label: parent.label } : s;
    const cur = best.get(entry.order);
    if (!cur || rankScore(entry) > rankScore(cur)) best.set(entry.order, entry);
  }
  return [...best.values()].sort((a, b) => a.order - b.order);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "GameName#TAG" + region -> canonical op.gg summoner URL. */
function accountToUrl(account, region) {
  const hash = account.lastIndexOf("#");
  if (hash === -1) throw new Error(`Account "${account}" is missing its #TAG (expected "GameName#TAG").`);
  const name = account.slice(0, hash).trim();
  const tag = account.slice(hash + 1).trim();
  return `https://op.gg/lol/summoners/${region}/${encodeURIComponent(name)}-${encodeURIComponent(tag)}`;
}

async function fetchHtml(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/** Parse a "Emerald 2 2 37LP / 19Win 22Lose" style summary out of a text segment. */
function parseSummary(text) {
  const re = new RegExp(
    `(${TIER_RE})\\s*(\\d)?\\s*\\d*\\s*(\\d+)\\s*LP\\s*/\\s*(\\d+)\\s*Win\\s*(\\d+)\\s*Lose`,
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  return {
    tier: m[1].toUpperCase(),
    division: m[2] ? Number(m[2]) : null,
    lp: Number(m[3]),
    wins: Number(m[4]),
    losses: Number(m[5]),
    percentile: null,
  };
}

/** Ladder "8.18% of top" -> 8.18. This is the solo-queue percentile that positions a player. */
function parsePercentile(html) {
  const m = html.match(/([\d.]+)%\s*of\s*top/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse the structured rank cards ("<strong>diamond 3</strong> ... 97 LP ... 41W 35L ... Win rate").
 * op.gg splits text nodes with `<!-- -->` comments, so strip those first. Returns cards in DOM order;
 * the current-season Solo and Flex cards are the ones carrying an adjacent "Win rate".
 */
function parseStructuredBlocks(html) {
  const clean = html.replace(/<!--.*?-->/g, "");
  const re = new RegExp(
    `<strong[^>]*>(${TIER_RE})\\s*(\\d)?</strong>\\s*<span[^>]*>\\s*(\\d+)\\s*LP</span>` +
      `[\\s\\S]{0,240}?(\\d+)\\s*W[\\s\\S]{0,30}?(\\d+)\\s*L[\\s\\S]{0,90}?Win rate`,
    "gi"
  );
  const out = [];
  let m;
  while ((m = re.exec(clean))) {
    out.push({
      tier: m[1].toUpperCase(),
      division: m[2] ? Number(m[2]) : null,
      lp: Number(m[3]),
      wins: Number(m[4]),
      losses: Number(m[5]),
      percentile: null,
    });
  }
  return out;
}

/** Pick the Flex card: the first structured card whose rank differs from Solo. */
function pickFlex(blocks, solo) {
  return blocks.find((b) => !solo || b.tier !== solo.tier || b.lp !== solo.lp) || null;
}

/** First champion portrait on the page is the profile's most-played / most-recent. */
function parseMainChampion(html) {
  const m = html.match(/champion\/([A-Za-z0-9]+)\.png/i);
  return m ? m[1] : null;
}

/**
 * Per-season peak tiers + LP. op.gg embeds a season history in its RSC payload as
 * `"season":"S7","rank_entries":{"high_rank_info":{tier,lp},"rank_info":{tier,lp}}`,
 * reaching back to ~2014. `high_rank_info` is the true peak but op.gg only fills it for the
 * most recent season(s); `rank_info` is the end-of-season rank and is populated for all.
 * We prefer the peak when present, else fall back to end-of-season. LP is `null` when op.gg
 * has none (oldest seasons), in which case the chart uses mid-division placement.
 * Old seasons (S4-S8) use the five-division system, so `division` can be 1-5.
 */
function parseSeasons(html) {
  const h = html.replace(/\\"/g, '"'); // unescape the RSC JSON string layer
  const re =
    /"season"\s*:\s*"([^"]+)"\s*,\s*"rank_entries"\s*:\s*\{\s*"high_rank_info"\s*:\s*\{([^}]*)\}\s*,\s*"rank_info"\s*:\s*\{([^}]*)\}/g;
  const pick = (block) => {
    const tier = (block.match(/"tier"\s*:\s*"([^"]*)"/) || [])[1] || "";
    const lpm = block.match(/"lp"\s*:\s*(?:"([^"]*)"|null)/);
    const lpRaw = lpm ? lpm[1] : undefined; // undefined => "lp":null, "" => empty string
    return { tier, lp: lpRaw != null && lpRaw !== "" ? Number(lpRaw) : null };
  };
  const seen = new Map();
  let m;
  while ((m = re.exec(h))) {
    const key = m[1].trim().replace(/\s+/g, " ");
    const meta = SEASON_META[key];
    if (!meta) continue;
    const high = pick(m[2]);
    const src = high.tier ? high : pick(m[3]); // prefer true peak, else end-of-season
    const tm = src.tier.match(new RegExp(`(${TIER_RE})\\s*(\\d)?`, "i"));
    if (!tm) continue;
    if (!seen.has(key)) {
      seen.set(key, {
        order: meta.order,
        label: meta.label,
        era: meta.era,
        tier: tm[1].toUpperCase(),
        division: tm[2] ? Number(tm[2]) : null,
        lp: src.lp,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.order - b.order);
}

/** Best-effort summoner level; op.gg does not label it reliably, so null is acceptable. */
function parseLevel(html) {
  const m =
    html.match(/summoner[_-]?level\\?"?\s*[:=]\s*\\?"?(\d{2,4})/i) ||
    html.match(/"level"\s*:\s*(\d{2,4})[,}]/);
  return m ? Number(m[1]) : null;
}

/**
 * Apply manual season overrides from summoners.json (e.g. a peak op.gg doesn't record with
 * LP, like "S7 Diamond 2 at 90 LP"). Each override is `{ label, tier, division, lp }`; it
 * updates the matching season in place, or inserts one if that season wasn't scraped.
 */
function applyOverrides(seasons, overrides) {
  for (const o of overrides || []) {
    const meta = LABEL_META[o.label];
    if (!meta) {
      console.log(`  (skipping override for unknown season "${o.label}")`);
      continue;
    }
    const patch = {
      tier: (o.tier || "").toUpperCase(),
      division: o.division ?? null,
      lp: o.lp ?? null,
    };
    const existing = seasons.find((s) => s.order === meta.order);
    if (existing) Object.assign(existing, patch);
    else {
      seasons.push({ order: meta.order, label: meta.label, era: meta.era, ...patch });
      seasons.sort((a, b) => a.order - b.order);
    }
  }
}

async function scrapePlayer(player, defaultRegion) {
  const region = (player.region || defaultRegion).toLowerCase();
  const url = accountToUrl(player.account, region);
  const base = { name: player.name, color: player.color, account: player.account, opggUrl: url };

  try {
    const html = await fetchHtml(url);
    const blocks = parseStructuredBlocks(html);
    const solo = parseSummary(html) || blocks[0] || null;
    if (solo) solo.percentile = parsePercentile(html);

    const seasons = parseSeasons(html);
    // The live current rank is more precise than the season-history snapshot; fold it
    // in as the current season so the chart's latest point matches today's ladder.
    if (solo) {
      const cur = seasons.find((s) => s.order === CURRENT_SEASON.order);
      const entry = { ...CURRENT_SEASON, tier: solo.tier, division: solo.division, lp: solo.lp };
      if (cur) Object.assign(cur, entry);
      else seasons.push(entry) && seasons.sort((a, b) => a.order - b.order);
    }

    applyOverrides(seasons, player.overrides);
    const merged = collapseSplits(seasons);

    // Attach per-season games + wins: current season from live W/L, historical from season-games.json.
    const acctGames = GAMES[player.account] || {};
    for (const s of merged) {
      if (s.order === CURRENT_SEASON.order && solo && solo.wins != null && solo.losses != null) {
        s.games = solo.wins + solo.losses;
        s.wins = solo.wins;
      } else {
        const g = acctGames[s.label];
        s.games = g ? g.games : null;
        s.wins = g ? g.wins : null;
      }
    }

    return {
      ...base,
      level: parseLevel(html),
      mainChampion: parseMainChampion(html),
      solo,
      flex: pickFlex(blocks, solo),
      seasons: merged,
      error: solo || merged.length ? null : "No ranked data found (unranked or markup changed).",
    };
  } catch (err) {
    return { ...base, level: null, mainChampion: null, solo: null, flex: null, seasons: [], error: String(err.message || err) };
  }
}

async function main() {
  const config = JSON.parse(await readFile(SUMMONERS_FILE, "utf8"));
  try { GAMES = JSON.parse(await readFile(GAMES_FILE, "utf8")); } catch {} // optional; backfilled by scripts/backfill-games.mjs
  const defaultRegion = (config.region || "na").toLowerCase();
  const roster = (config.players || []).filter((p) => p.account && p.account.trim());

  if (roster.length === 0) {
    console.error("No players with accounts in data/summoners.json — nothing to scrape.");
  }

  const players = [];
  for (const player of roster) {
    process.stdout.write(`Fetching ${player.name} (${player.account})... `);
    const result = await scrapePlayer(player, defaultRegion);
    const cur = result.solo
      ? `${result.solo.tier} ${result.solo.division ?? ""} ${result.solo.lp}LP`.replace(/\s+/g, " ").trim()
      : "unranked (solo)";
    console.log(`${cur} · ${result.seasons.length} seasons` + (result.error ? ` · WARN: ${result.error}` : ""));
    players.push(result);
    await sleep(1500); // be polite to op.gg between requests
  }

  const out = {
    updatedAt: new Date().toISOString(),
    region: defaultRegion,
    source: "op.gg",
    players,
  };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${players.length} player(s) to ${OUT_FILE}`);

  // Non-zero exit if every single player failed, so CI surfaces a total outage.
  if (players.length > 0 && players.every((p) => p.error)) {
    console.error("Every player failed to scrape — op.gg may be blocking or its markup changed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
