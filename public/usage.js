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
  pill.title = "Token-Kosten heute · Burn-Rate letzte 60min";
  pill.textContent = "—";
  meta.insertBefore(pill, meta.firstChild);
  return pill;
}

function updateTopbar(data) {
  const pill = ensureTopbarPill();
  if (!pill) return;
  const today = data.today?.costUsd || 0;
  const burn = data.burnRateUsdPerHour || 0;
  pill.textContent = `${fmtUsd(today)} heute · ${fmtUsd(burn)}/h`;
  pill.dataset.hot = burn > 50 ? "1" : "0";
}

// Returns the index of the meta-row inside a card. Cards are template-based,
// so we know the layout: <header>, <h2.title>, <p.prompt>, <div.timeline>,
// <footer>, <div.meta-row>.
function ensureCardCostUi(card, session) {
  let pill = card.querySelector(".cost-pill-card");
  let spark = card.querySelector(".sparkline");
  const metaRow = card.querySelector(".meta-row");
  if (!metaRow) return null;

  if (!pill) {
    pill = document.createElement("span");
    pill.className = "cost-pill cost-pill-card";
    metaRow.appendChild(pill);
  }
  if (!spark) {
    spark = document.createElement("span");
    spark.className = "sparkline";
    metaRow.appendChild(spark);
  }

  pill.textContent = fmtUsd(session.totalCostUsd);
  spark.textContent = sparkBraille(session.spark);
  spark.title = "Token-Aktivität letzte 60min (12 × 5min Buckets)";
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
