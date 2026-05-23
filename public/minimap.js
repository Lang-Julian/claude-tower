// Minimap — all sessions as pixel squares in the HUD bar.
// Click → scrolls the matching sprite into view + flashes it.

const STATUS_COLORS = {
  needs_permission: "#ef4444",
  needs_input: "#fbbf24",
  thinking: "#38bdf8",
  running: "#34d399",
  idle: "#64748b",
  stopped: "#475569",
  archived: "#334155",
};

const canvas = document.createElement("canvas");
canvas.id = "minimap";
canvas.title = "Mini-Map · Click → Sprite";
const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
const TILE = 12;
const GAP = 2;
const MAX_WIDTH = 220;

let cells = []; // [{x,y,w,h, sessionId, status}]
let attachedTo = null;

function attach() {
  if (attachedTo) return;
  const hud = document.getElementById("townHud");
  if (!hud) return;
  hud.appendChild(canvas);
  attachedTo = hud;
  canvas.addEventListener("click", onClick);
}

function onClick(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const hit = cells.find((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
  if (!hit) return;
  const sprite = document.querySelector(`.sprite[data-id="${CSS.escape(hit.sessionId)}"]`);
  if (!sprite) return;
  sprite.scrollIntoView({ behavior: "smooth", block: "center" });
  sprite.classList.add("sprite-flash");
  setTimeout(() => sprite.classList.remove("sprite-flash"), 1200);
}

const STATUS_RANK = {
  needs_permission: 0, needs_input: 1, thinking: 2, running: 3, idle: 4, stopped: 5, archived: 6,
};

function update(sessions) {
  attach();
  if (!attachedTo) return;

  // Sort: attention first, group preserved
  const sorted = sessions.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 99;
    const rb = STATUS_RANK[b.status] ?? 99;
    return ra - rb;
  });

  const cellsPerRow = Math.max(8, Math.floor((MAX_WIDTH + GAP) / (TILE + GAP)));
  const rows = Math.max(1, Math.ceil(sorted.length / cellsPerRow));
  const widthPx = Math.min(sorted.length, cellsPerRow) * (TILE + GAP) - GAP;
  const heightPx = rows * (TILE + GAP) - GAP;

  canvas.style.width = widthPx + "px";
  canvas.style.height = heightPx + "px";
  canvas.width = Math.floor(widthPx * dpr);
  canvas.height = Math.floor(heightPx * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, widthPx, heightPx);

  cells = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const col = i % cellsPerRow;
    const row = (i / cellsPerRow) | 0;
    const x = col * (TILE + GAP);
    const y = row * (TILE + GAP);
    ctx.fillStyle = STATUS_COLORS[s.status] || "#475569";
    ctx.fillRect(x, y, TILE, TILE);
    // attention pulse: little glow ring drawn on a second pass below
    cells.push({ x, y, w: TILE, h: TILE, sessionId: s.id, status: s.status });
  }
  // Attention glow on top
  ctx.shadowColor = "#fbbf24";
  ctx.shadowBlur = 6;
  for (const c of cells) {
    if (c.status === "needs_input") {
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(c.x, c.y, TILE, TILE);
    }
  }
  ctx.shadowColor = "#ef4444";
  for (const c of cells) {
    if (c.status === "needs_permission") {
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(c.x, c.y, TILE, TILE);
    }
  }
  ctx.shadowBlur = 0;
}

window.__minimap = { update };
