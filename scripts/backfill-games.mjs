// One-time backfill of per-season SOLO ranked games from op.gg's champions page.
// op.gg exposes a season's total games as the top-level {play,win,lose} of
//   /lol/summoners/{region}/{name}-{tag}/champions?season_id={id}&queue_type=SOLORANKED
// Historical games never change, so this is stored in data/season-games.json and merged by
// scrape.mjs — it does NOT run on every scrape. The current season's games come from the
// live W/L instead (see scrape.mjs). Run: node scripts/backfill-games.mjs
//
// op.gg's champions season_id is not the LoL season number (preseasons take ids too), and
// 2023/2024 are split into acts with their own ids — so a collapsed season sums its acts.
// Map established empirically (season_id=7 == Season 7). S16 (current) is omitted here — its
// games come from the live W/L in scrape.mjs (op.gg returns no data for the current id).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// collapsed season label -> op.gg champions season_id(s) to sum (splits are summed)
const SEASON_IDS = {
  S4: [4], S5: [5], S6: [6], S7: [7], S8: [11], S9: [13], S10: [15], S11: [17], S12: [19],
  S13: [21, 23], S14: [25, 27, 29], S15: [31],
};

function accountToUrl(account, region) {
  const h = account.lastIndexOf("#");
  const name = account.slice(0, h).trim(), tag = account.slice(h + 1).trim();
  return `https://op.gg/lol/summoners/${region}/${encodeURIComponent(name)}-${encodeURIComponent(tag)}`;
}

async function seasonGames(baseUrl, seasonId) {
  const url = `${baseUrl}/champions?season_id=${seasonId}&queue_type=SOLORANKED`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) return null;
  const h = (await res.text()).replace(/\\"/g, '"');
  const m = h.match(/"season_id":(\d+),"year":[^,]*,"play":(\d+),"win":(\d+),"lose":(\d+)/);
  return m && Number(m[2]) > 0 ? { games: Number(m[2]), wins: Number(m[3]), losses: Number(m[4]) } : null;
}

const summoners = JSON.parse(await readFile(join(ROOT, "data/summoners.json"), "utf8"));
const region = (summoners.region || "na").toLowerCase();
const data = JSON.parse(await readFile(join(ROOT, "data/data.json"), "utf8"));
const out = {};

for (const p of summoners.players) {
  if (!p.account?.trim()) continue;
  const played = new Set((data.players.find((d) => d.name === p.name)?.seasons || []).map((s) => s.label));
  const base = accountToUrl(p.account, (p.region || region).toLowerCase());
  out[p.account] = {};
  for (const [label, ids] of Object.entries(SEASON_IDS)) {
    if (!played.has(label)) continue; // skip seasons the player wasn't ranked
    let games = 0, wins = 0;
    for (const sid of ids) {
      try {
        const g = await seasonGames(base, sid);
        if (g) { games += g.games; wins += g.wins; }
      } catch {}
      await sleep(1100); // be polite — op.gg rate-limits bulk requests
    }
    if (games > 0) { out[p.account][label] = { games, wins }; process.stdout.write(`${p.name} ${label}=${wins}/${games}  `); }
  }
  console.log("");
}

await writeFile(join(ROOT, "data/season-games.json"), JSON.stringify(out, null, 1) + "\n", "utf8");
console.log("\nWrote data/season-games.json");
