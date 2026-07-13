// Peak-rank-per-season chart. For every season each player was ranked, we convert their
// peak tier into an *inflation-adjusted* percentile using that season's distribution
// (data/season-distribution.json), so a Diamond 2 in 2017 and an Emerald today land where
// they actually stood among players at the time. Each player's all-time peak is marked.

const SVG_NS = "http://www.w3.org/2000/svg";
const MINP = 0.01; // top of axis (best)
const MAXP = 100; // bottom of axis
const APEX = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

// Colors + short codes for drawing the "today's ladder" backdrop and tier badges.
const TIER_COLOR = {
  CHALLENGER: "#f4c145", GRANDMASTER: "#e0533d", MASTER: "#b061e6", DIAMOND: "#4f7cff",
  EMERALD: "#20a55a", PLATINUM: "#3fb6ad", GOLD: "#d9a441", SILVER: "#9aa5ad",
  BRONZE: "#a26b3f", IRON: "#6b6564",
};

const state = { hidden: new Set(), data: null, dist: null, curve: "smooth", peakStyle: "lines" };

const $ = (s) => document.querySelector(s);
const el = (name, attrs = {}, children = []) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of [].concat(children)) n.append(c);
  return n;
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Smooth curve through the points (Catmull-Rom → cubic bézier).
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

// ---- percentile model ---------------------------------------------------

let DIST_BY_LABEL = new Map(); // season label -> that season's distribution
let TODAY = null; // latest season's distribution (used for "≈ today")

const distFor = (label) => DIST_BY_LABEL.get(label) || TODAY;

// Convert a rank to a percentile using the season's exact division boundaries (read from
// the source image). Each entry's `floor` is the cumulative top% at the bottom of that
// division; the entry above gives the top. `lp` (0-100) places within the division:
// 100 LP → top edge (best), 0 LP → bottom edge.
function percentileIn(sd, tier, division, lp) {
  const entries = sd.tiers;
  let idx;
  if (division == null || APEX.has(tier)) {
    idx = entries.findIndex((t) => t.tier === tier);
  } else {
    const tierIdxs = [];
    for (let i = 0; i < entries.length; i++) if (entries[i].tier === tier) tierIdxs.push(i);
    if (tierIdxs.length === 0) return null; // tier didn't exist that season
    idx = tierIdxs[Math.min(division, tierIdxs.length) - 1]; // clamp to available divisions
  }
  if (idx == null || idx === -1) return null;
  const floor = entries[idx].floor;
  const top = idx === 0 ? 0 : entries[idx - 1].floor;
  let f; // 0 = top (best) edge, 1 = bottom (worst) edge
  if (tier === "MASTER" && lp != null) f = Math.min(1, Math.max(0, 1 - lp / 500)); // Master spread across its band, assuming 0–500 LP
  else if (division == null || APEX.has(tier) || lp == null) f = 0.5;
  else f = Math.min(1, Math.max(0, 1 - lp / 100));
  return Math.max(MINP, top + f * (floor - top));
}

// Collapse a distribution's division entries into per-tier [top, bottom] ranges (for labels/bands).
function tierRanges(sd) {
  const out = [];
  sd.tiers.forEach((e, i) => {
    const top = i === 0 ? MINP : sd.tiers[i - 1].floor;
    const last = out[out.length - 1];
    if (last && last.tier === e.tier) last.bottom = e.floor;
    else out.push({ tier: e.tier, top, bottom: e.floor });
  });
  return out;
}

// Always use the season's own distribution — a rank's true standing that season.
function percentileOf(season) {
  const sd = distFor(season.label);
  let p = percentileIn(sd, season.tier, season.division, season.lp);
  if (p == null && sd !== TODAY) p = percentileIn(TODAY, season.tier, season.division, season.lp);
  return p;
}

// Which of today's tiers a percentile corresponds to (for the "≈ today" readout).
function tierAtPercentile(pct) {
  for (const t of TODAY.tiers) if (pct <= t.floor) return t.tier;
  return TODAY.tiers[TODAY.tiers.length - 1].tier;
}

const titleCase = (t) => t[0] + t.slice(1).toLowerCase();
const rankLabel = (s) => titleCase(s.tier) + (s.division != null ? ` ${s.division}` : "");

// Each player's best (lowest-percentile) season.
function peakOf(player) {
  let best = null;
  for (const s of player.seasons) {
    const p = percentileOf(s);
    if (p == null) continue;
    if (!best || p < best.pct) best = { season: s, pct: p };
  }
  return best;
}

// ---- axis ---------------------------------------------------------------

function seasonAxis() {
  const byOrder = new Map();
  for (const p of state.data.players)
    for (const s of p.seasons || []) if (!byOrder.has(s.order)) byOrder.set(s.order, s.label);
  return [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([order, label]) => ({ order, label }));
}

// ---- rendering ----------------------------------------------------------

function renderChart() {
  const host = $("#chart");
  host.textContent = "";
  const axis = seasonAxis();
  const players = state.data.players.filter((p) => !state.hidden.has(p.name) && p.seasons && p.seasons.length);

  const W = 920, H = 560;
  const m = { top: 22, right: state.peakStyle === "labels" ? 46 : 92, bottom: 46, left: 52 };
  const x0 = m.left, x1 = W - m.right, y0 = m.top, y1 = H - m.bottom;
  const clamp = (p) => Math.min(MAXP, Math.max(MINP, p));
  const lg = (p) => Math.log10(clamp(p));
  const yFor = (p) => y0 + ((lg(p) - lg(MINP)) / (lg(MAXP) - lg(MINP))) * (y1 - y0);
  const xOf = new Map(axis.map((a, i) => [a.order, axis.length === 1 ? (x0 + x1) / 2 : x0 + (i / (axis.length - 1)) * (x1 - x0)]));

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Peak rank per season" });

  const ticks = [0.02, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100];

  // per-season stacked distribution columns; each division is a band with a thin divider stroke
  const colW = axis.length > 1 ? (x1 - x0) / (axis.length - 1) : x1 - x0;
  const barW = Math.min(38, colW * 0.76);
  for (const a of axis) {
    const sd = distFor(a.label);
    const cx = xOf.get(a.order);
    sd.tiers.forEach((t, i) => {
      const top = i === 0 ? MINP : sd.tiers[i - 1].floor;
      const yt = yFor(top), yb = yFor(t.floor);
      if (yb - yt < 0.5) return;
      svg.append(el("rect", { x: cx - barW / 2, y: yt, width: barW, height: yb - yt, fill: TIER_COLOR[t.tier], "fill-opacity": 0.5, stroke: "#0b0e13", "stroke-width": 0.5, "stroke-opacity": 0.55 }));
    });
    svg.append(el("text", { x: cx, y: y1 + 16, "text-anchor": "middle", class: "axis-label season-label" }, [a.label]));
  }

  // gridline value labels (left margin, over everything)
  for (const p of ticks) {
    svg.append(el("text", { x: x0 - 7, y: yFor(p) + 3.5, "text-anchor": "end", class: "axis-label" }, [`${p}%`]));
  }
  svg.append(el("text", { x: 12, y: (y0 + y1) / 2, class: "axis-title", "text-anchor": "middle", transform: `rotate(-90 12 ${(y0 + y1) / 2})` }, ["Top percentile (better ↑)"]));

  // player lines + dots
  const peaks = [];
  for (const p of players) {
    const pts = p.seasons
      .map((s) => ({ s, x: xOf.get(s.order), y: yFor(percentileOf(s)), pct: percentileOf(s) }))
      .filter((pt) => pt.pct != null && pt.x != null);
    if (!pts.length) continue;
    const peak = peakOf(p);

    if (pts.length > 1) {
      const attrs = { fill: "none", stroke: p.color, "stroke-width": 2.5, "stroke-opacity": 0.85, "stroke-linejoin": "round" };
      if (state.curve === "smooth") svg.append(el("path", { d: smoothPath(pts), ...attrs }));
      else svg.append(el("polyline", { points: pts.map((pt) => `${pt.x},${pt.y}`).join(" "), ...attrs }));
    }

    for (const pt of pts) {
      const isPeak = peak && pt.s.order === peak.season.order;
      if (isPeak) svg.append(el("circle", { cx: pt.x, cy: pt.y, r: 9, fill: "none", stroke: p.color, "stroke-width": 2 }));
      const dot = el("circle", { cx: pt.x, cy: pt.y, r: isPeak ? 5.5 : 4, fill: p.color, class: "player-dot" });
      dot.addEventListener("mousemove", (e) => showTooltip(p, pt, e));
      dot.addEventListener("mouseleave", hideTooltip);
      svg.append(dot);
    }

    const peakPt = peak && pts.find((q) => q.s.order === peak.season.order);
    if (peakPt) peaks.push({ p, peak, x: peakPt.x, y: peakPt.y });
  }

  if (state.peakStyle === "lines") {
    // A dotted line from each peak out to the right, with the name at the end — ranked
    // visually by height. De-collide the end labels so they don't overlap.
    peaks.sort((a, b) => a.y - b.y);
    const GAP = 18;
    let prev = -Infinity;
    for (const o of peaks) { o.labelY = Math.max(o.y, prev + GAP); prev = o.labelY; }
    const overflow = peaks.length ? peaks[peaks.length - 1].labelY - y1 : 0;
    if (overflow > 0) peaks.forEach((o) => (o.labelY -= overflow));

    for (const o of peaks) {
      svg.append(el("line", { x1: o.x, y1: o.y, x2: x1, y2: o.y, stroke: o.p.color, "stroke-width": 2, "stroke-dasharray": "2 5", "stroke-linecap": "round", "stroke-opacity": 0.9 }));
      if (Math.abs(o.labelY - o.y) > 1)
        svg.append(el("path", { d: `M ${x1} ${o.y} L ${x1 + 9} ${o.labelY}`, stroke: o.p.color, "stroke-width": 1.5, fill: "none", "stroke-opacity": 0.7 }));
      svg.append(el("circle", { cx: x1, cy: o.y, r: 3, fill: o.p.color }));
      svg.append(el("text", { x: x1 + 13, y: o.labelY + 4, class: "peak-name", fill: o.p.color }, [o.p.name]));
    }
  } else {
    // "Name · rank" label just above each peak dot (no rails). Anchor away from the edges.
    for (const o of peaks) {
      const anchor = o.x > x1 - 55 ? "end" : o.x < x0 + 55 ? "start" : "middle";
      svg.append(el("text", { x: o.x, y: o.y - 13, "text-anchor": anchor, class: "peak-tag", fill: o.p.color }, [`${o.p.name} · ${rankLabel(o.peak.season)}`]));
    }
  }

  host.append(svg);
}

const WR_GREEN = "#3fb950", WR_RED = "#f85149";
// Win rate → color: neutral at 50%, full green by 60% and full red by 40%.
function wrColor(wr) {
  const g = [63, 185, 80], r = [248, 81, 73], n = [150, 160, 170];
  const t = Math.max(-1, Math.min(1, (wr - 50) / 10));
  const to = t >= 0 ? g : r, k = Math.abs(t);
  return `rgb(${n.map((v, i) => Math.round(v + (to[i] - v) * k)).join(",")})`;
}

function showTooltip(player, pt, e) {
  const tip = $("#tooltip");
  const adj = percentileIn(distFor(pt.s.label), pt.s.tier, pt.s.division, pt.s.lp) ?? percentileIn(TODAY, pt.s.tier, pt.s.division, pt.s.lp);
  const todayTier = tierAtPercentile(adj);
  const rankStr = rankLabel(pt.s) + (pt.s.lp != null ? ` · ${pt.s.lp} LP` : "");
  const rows = [
    `<div class="row"><span>Season</span><b>${pt.s.label}</b></div>`,
    `<div class="row"><span>Peak that season</span><b style="color:${TIER_COLOR[pt.s.tier] || "inherit"}">${rankStr}</b></div>`,
  ];
  if (pt.s.games != null) rows.push(`<div class="row"><span>Games played</span><b>${pt.s.games}</b></div>`);
  if (pt.s.games > 0 && pt.s.wins != null) {
    const wr = Math.round((pt.s.wins / pt.s.games) * 100);
    rows.push(`<div class="row"><span>Win rate</span><b><span style="color:${wrColor(wr)}">${wr}%</span> · <span style="color:${WR_GREEN}">${pt.s.wins}W</span> <span style="color:${WR_RED}">${pt.s.games - pt.s.wins}L</span></b></div>`);
  }
  rows.push(`<div class="row"><span>Top percentile</span><b>${fmtPct(pt.pct)}</b></div>`);
  rows.push(`<div class="row"><span>≈ today</span><b style="color:${TIER_COLOR[todayTier] || "inherit"}">${titleCase(todayTier)}</b></div>`);
  tip.innerHTML = `<h3 style="color:${player.color}">${escapeHtml(player.name)}</h3>${rows.join("")}`;
  tip.hidden = false;
  const rect = $(".chart-wrap").getBoundingClientRect();
  tip.style.left = `${e.clientX - rect.left}px`;
  tip.style.top = `${e.clientY - rect.top}px`;
}
const hideTooltip = () => ($("#tooltip").hidden = true);
const fmtPct = (p) => (p < 1 ? p.toFixed(3) : p.toFixed(2)) + "%";


function renderChips() {
  const host = $("#players");
  host.textContent = "";
  for (const p of state.data.players) {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.hidden.has(p.name) ? " off" : "");
    chip.innerHTML = `<span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}`;
    chip.addEventListener("click", () => {
      state.hidden.has(p.name) ? state.hidden.delete(p.name) : state.hidden.add(p.name);
      renderChips();
      renderChart();
    });
    host.append(chip);
  }
}

// Tier color key below the chart (colors are consistent across every season's columns).
function renderLegend() {
  $("#legend").innerHTML = Object.keys(TIER_COLOR)
    .map((t) => `<span class="legend-item"><span class="swatch" style="background:${TIER_COLOR[t]}"></span>${titleCase(t)}</span>`)
    .join("");
}

function renderAll() {
  renderChips();
  renderChart();
  renderLegend();
}

// ---- wiring -------------------------------------------------------------

function bindControls() {
  document.querySelectorAll("[data-curve]").forEach((b) =>
    b.addEventListener("click", () => {
      state.curve = b.dataset.curve;
      document.querySelectorAll("[data-curve]").forEach((x) => x.classList.toggle("active", x === b));
      renderChart();
    })
  );
  document.querySelectorAll("[data-peak]").forEach((b) =>
    b.addEventListener("click", () => {
      state.peakStyle = b.dataset.peak;
      document.querySelectorAll("[data-peak]").forEach((x) => x.classList.toggle("active", x === b));
      renderChart();
    })
  );
}

async function main() {
  bindControls();
  try {
    const [d, dist] = await Promise.all([
      fetch(`./data/data.json?t=${Date.now()}`).then((r) => r.json()),
      fetch(`./data/season-distribution.json?t=${Date.now()}`).then((r) => r.json()),
    ]);
    state.data = d;
    state.dist = dist;
    DIST_BY_LABEL = new Map(dist.seasons.map((s) => [s.label, s]));
    TODAY = dist.seasons.reduce((a, b) => (b.order > a.order ? b : a));
  } catch (err) {
    $("#chart").innerHTML = `<div class="empty">Couldn't load data. Run <code>npm run scrape</code>, then <code>npm run serve</code>.</div>`;
    return;
  }
  $("#updated").textContent = state.data.updatedAt ? `Updated ${timeAgo(state.data.updatedAt)}` : "";
  renderAll();
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

main();
