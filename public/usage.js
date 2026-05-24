// Token + cost overlay. Adds:
//   • a topbar pill with "today / burn-rate"
//   • per-card cost pill + 60min sparkline (Braille-encoded, 12 bins)
//   • hover-to-expand breakdown popover
//
// Talks to /api/usage every 30s. The endpoint is fast (<10ms warm).

const POLL_MS = 30_000;

const BRAILLE_LEVELS = [
  // 8 visual levels — empty, 1/8, 2/8 ... full
  "⠀", "⠁", "⠃", "⠇", "⠏", "⠟", "⠿", "⣿",
];

// Display mode: tokens (default, Claude Max plan) vs USD ($).
// Opt-in to USD via localStorage["tower:show-usd"] = "1".
function showUsd() {
  try { return localStorage.getItem("tower:show-usd") === "1"; }
  catch { return false; }
}

// Threshold for "hot" token mode (per-card halo + ⚡ glyph).
const TOKEN_HOT_THRESHOLD = 100_000_000; // 100M tokens

function fmtUsd(n) {
  if (!n) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(1)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// 12 buckets → 4-char Braille string (each char = 2 vertical x 4 horizontal pixels).
// Simpler: render each bucket as one Braille level char.
function sparkBraille(buckets) {
  if (!buckets || !buckets.length) return "";
  const max = Math.max(...buckets, 1);
  let out = "";
  for (const v of buckets) {
    const lvl = Math.min(7, Math.floor((v / max) * 7));
    out += BRAILLE_LEVELS[lvl];
  }
  return out;
}

// Inject the topbar pill once.
function ensureTopbarPill() {
  let pill = document.getElementById("costPill");
  if (pill) return pill;
  const meta = document.querySelector(".topbar-meta");
  if (!meta) return null;
  pill = document.createElement("span");
  pill.id = "costPill";
  pill.className = "pill cost-pill cost-pill-top";
  pill.textContent = "—";
  meta.insertBefore(pill, meta.firstChild);
  return pill;
}

function updateTopbar(data) {
  const pill = ensureTopbarPill();
  if (!pill) return;
  if (showUsd()) {
    const today = data.today?.costUsd || 0;
    const burn = data.burnRateUsdPerHour || 0;
    pill.textContent = `${fmtUsd(today)} today · ${fmtUsd(burn)}/h`;
    pill.title = "USD cost today · burn-rate over the last 60min";
    pill.dataset.mode = "usd";
    pill.dataset.hot = burn > 50 ? "1" : "0";
  } else {
    const today = data.today?.tokens || 0;
    // Backend may add recentTokensPerHour; fall back to currentBlock-derived rate.
    const tphBackend = Number(data.recentTokensPerHour) || 0;
    const blockTokens = Number(data.currentBlock?.totalTokens) || 0;
    const tph = tphBackend || blockTokens; // currentBlock is a 5h rolling window → coarse but useful
    pill.textContent = `${fmtTokens(today)} today · ${fmtTokens(tph)}/h`;
    pill.title = "Tokens today · tokens per hour";
    pill.dataset.mode = "tokens";
    pill.dataset.hot = tph >= TOKEN_HOT_THRESHOLD ? "1" : "0";
  }
}

// Render 12 bars + halo dot on the last bucket. Uses currentColor for fill so
// the CSS can color it per status. The SVG already exists in the card template.
function renderSparkSvg(svg, buckets) {
  if (!svg) return false;
  if (!buckets || !buckets.length) { svg.classList.remove("spark-svg-on"); return false; }
  const max = Math.max(...buckets, 1);
  const w = 72, h = 16;
  const n = buckets.length;
  const gap = 1;
  const barW = (w - gap * (n - 1)) / n;
  let bars = "";
  for (let i = 0; i < n; i++) {
    const v = buckets[i] || 0;
    // min 1px so empty buckets are still hinted at — keeps the strip readable
    const bh = v > 0 ? Math.max(2, Math.round((v / max) * (h - 2))) : 1;
    const x = i * (barW + gap);
    const y = h - bh;
    const cls = i === n - 1 ? "spark-bar last" : "spark-bar";
    bars += `<rect class="${cls}" x="${x.toFixed(2)}" y="${y}" width="${barW.toFixed(2)}" height="${bh}" rx="1"/>`;
  }
  // Halo dot on last bar — only if last bucket has activity.
  const lastV = buckets[n - 1] || 0;
  const totalActive = buckets.some((v) => v > 0);
  let dot = "";
  if (lastV > 0 && totalActive) {
    const cx = (n - 1) * (barW + gap) + barW / 2;
    const lastH = Math.max(2, Math.round((lastV / max) * (h - 2)));
    const cy = h - lastH;
    dot = `<circle class="spark-dot" cx="${cx.toFixed(2)}" cy="${cy}" r="1.8"/>`;
  }
  svg.innerHTML = bars + dot;
  svg.classList.add("spark-svg-on");
  return true;
}

// Returns the index of the meta-row inside a card. Cards are template-based,
// so we know the layout: <header>, <h2.title>, <p.prompt>, <div.timeline>,
// <div.spark-row>, <footer>, <div.meta-row>.
function ensureCardCostUi(card, session) {
  let pill = card.querySelector(".cost-pill-card");
  const spark = card.querySelector(".sparkline");
  const sparkSvg = card.querySelector(".spark-svg");
  const metaRow = card.querySelector(".meta-row");
  if (!metaRow) return null;

  if (!pill) {
    pill = document.createElement("span");
    pill.className = "cost-pill cost-pill-card";
    metaRow.appendChild(pill);
  }

  // Choose display mode: tokens (default for Claude Max) or USD.
  const usd = showUsd();
  if (usd) {
    pill.textContent = fmtUsd(session.totalCostUsd);
    pill.dataset.mode = "usd";
    pill.dataset.hot = "0";
    pill.title = `Session cost: $${(session.totalCostUsd || 0).toFixed(2)} · ${fmtTokens(session.totalTokens)} tokens`;
  } else {
    const tokens = Number(session.totalTokens) || 0;
    pill.textContent = fmtTokens(tokens);
    pill.dataset.mode = "tokens";
    pill.dataset.hot = tokens >= TOKEN_HOT_THRESHOLD ? "1" : "0";
    pill.title = `Session tokens: ${tokens.toLocaleString()} · $${(session.totalCostUsd || 0).toFixed(2)}`;
  }

  // SVG sparkline is the source of truth. Braille text is kept in-DOM but
  // hidden when SVG renders successfully (backwards-compat fallback).
  const drew = renderSparkSvg(sparkSvg, session.spark);
  if (spark) {
    if (drew) {
      spark.classList.add("sparkline-hidden");
      spark.textContent = sparkBraille(session.spark); // still written for a11y/fallback
    } else {
      spark.classList.remove("sparkline-hidden");
      spark.textContent = sparkBraille(session.spark);
    }
    spark.title = "Token-Aktivität letzte 60min (12 × 5min Buckets)";
  }
  if (sparkSvg) {
    sparkSvg.setAttribute("role", "img");
    sparkSvg.setAttribute("aria-label", "Token-Aktivität letzte 60 Minuten");
  }
  // Stash detail for hover.
  card.dataset.totalCost = String(session.totalCostUsd);
  card.dataset.totalTokens = String(session.totalTokens);
  card.dataset.usageSessionId = session.sessionId;
  return { pill, spark };
}

// ─── popover for breakdown ────────────────────────────────────────────────

let popover = null;
function getPopover() {
  if (popover) return popover;
  popover = document.createElement("div");
  popover.id = "costPopover";
  popover.className = "cost-popover";
  popover.style.display = "none";
  document.body.appendChild(popover);
  return popover;
}

async function showBreakdown(card, evt) {
  const sid = card.dataset.usageSessionId;
  if (!sid) return;
  const pop = getPopover();
  pop.textContent = "lade…";
  positionPopover(pop, evt);
  pop.style.display = "block";
  try {
    const res = await fetch(`/api/usage/${sid}`);
    if (!res.ok) { pop.textContent = "keine Daten"; return; }
    const d = await res.json();
    const b = d.breakdown;
    pop.innerHTML = `
      <div class="pop-head">
        <span>${typeof d.model === "string" ? d.model : (d.model || []).join(", ") || "—"}</span>
        <span class="pop-cost">${fmtUsd(d.totalCostUsd)}</span>
      </div>
      <div class="pop-row"><span>input</span><span>${fmtTokens(b.input)}</span></div>
      <div class="pop-row"><span>output</span><span>${fmtTokens(b.output)}</span></div>
      <div class="pop-row"><span>cache read</span><span>${fmtTokens(b.cacheRead)}</span></div>
      <div class="pop-row"><span>cache write</span><span>${fmtTokens(b.cacheCreation)}</span></div>
      <div class="pop-foot">${d.timeline.length} Nachrichten</div>
    `;
  } catch {
    pop.textContent = "Fehler";
  }
}

function positionPopover(pop, evt) {
  const x = Math.min(window.innerWidth - 260, (evt?.clientX || 0) + 12);
  const y = Math.min(window.innerHeight - 180, (evt?.clientY || 0) + 12);
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}

function hideBreakdown() {
  if (popover) popover.style.display = "none";
}

// Wire hover handlers once per card.
function wireCardHover(card) {
  if (card.dataset.usageWired === "1") return;
  card.dataset.usageWired = "1";
  card.addEventListener("mouseenter", (e) => showBreakdown(card, e));
  card.addEventListener("mousemove", (e) => {
    if (popover && popover.style.display !== "none") positionPopover(popover, e);
  });
  card.addEventListener("mouseleave", hideBreakdown);
}

// ─── poll loop ────────────────────────────────────────────────────────────

let lastData = null;

async function poll() {
  try {
    const res = await fetch("/api/usage");
    if (!res.ok) return;
    const data = await res.json();
    lastData = data;
    updateTopbar(data);
    decorateCards(data);
  } catch {
    // network blip — try again next tick
  }
}

function decorateCards(data) {
  const bySid = new Map();
  for (const s of data.sessions || []) bySid.set(s.sessionId, s);
  const cards = document.querySelectorAll(".card");
  for (const card of cards) {
    const sid = card.dataset.id;
    const s = bySid.get(sid);
    if (!s) continue;
    ensureCardCostUi(card, s);
    wireCardHover(card);
  }
}

// Re-decorate when cards are re-rendered. The cards view diff-renders so a
// pure interval-poll covers most cases; for instant decoration on first
// snapshot we also observe the grid for child changes.
function observeGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;
  const mo = new MutationObserver(() => { if (lastData) decorateCards(lastData); });
  mo.observe(grid, { childList: true });
}

// Boot
ensureTopbarPill();
observeGrid();
poll();
setInterval(poll, POLL_MS);
