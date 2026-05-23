// Claude Town — pixel-art view of your live Claude sessions.
//
// Reads the same SSE snapshot as the cards view (no backend changes).
// Routes each session to a workspace room based on cwd, renders a sprite
// whose animation reflects the session's current status + last tool.

import { subscribe } from "/store.js";

// ─── Workspace map ────────────────────────────────────────────────
// Synced with ~/.config/claude-workspaces.zsh. Edit here if you add a
// workspace there (or we'll grow a /api/workspaces endpoint later).
const HOME = "/Users/jal";
const WORKSPACES = [
  { key: "box",       label: "Brane AIF",     path: `${HOME}/ai-in-the-box`,                    icon: "shield" },
  { key: "portal",    label: "Portal",        path: `${HOME}/Documents/DEV/ai-z-portal`,        icon: "chart" },
  { key: "website",   label: "Website",       path: `${HOME}/Documents/DEV/ai-z-group`,         icon: "globe" },
  { key: "veit",      label: "Veit Select",   path: `${HOME}/Documents/DEV/cafe-journey-builder`, icon: "coffee" },
  { key: "hop",       label: "HOP",           path: `${HOME}/Documents/DEV/HOP`,                icon: "factory" },
  { key: "marketing", label: "Marketing",     path: `${HOME}/Documents/DEV/brane-aif-marketing`, icon: "megaphone" },
  { key: "sales",     label: "Sales Agent",   path: `${HOME}/Documents/DEV/ai-z-sales-agent`,   icon: "handshake" },
  { key: "phone",     label: "Phone Agent",   path: `${HOME}/Documents/DEV/ai-z-phone-assistant`, icon: "phone" },
  { key: "noderack",  label: "Noderack",      path: `${HOME}/Documents/DEV/ai-z-noderack`,      icon: "server" },
  { key: "training",  label: "Training",      path: `${HOME}/Documents/DEV/training`,           icon: "book" },
  { key: "brain",     label: "AI-Z Brain",    path: `${HOME}/ObsidianVaults/AI-Z-Brain`,        icon: "brain" },
  { key: "personal",  label: "Personal Brain", path: `${HOME}/ObsidianVaults/Personal-Brain`,   icon: "user" },
];
const OTHER = { key: "other", label: "Other", path: null, icon: "house" };

function workspaceFor(cwd) {
  if (!cwd) return OTHER;
  for (const w of WORKSPACES) {
    if (cwd === w.path || cwd.startsWith(w.path + "/")) return w;
  }
  return OTHER;
}

// ─── Pixel-art primitives ────────────────────────────────────────
// Each sprite is a multi-line ASCII string. Each non-space, non-dot
// char is a pixel; the palette resolves it to a color. We build them
// into <svg> with <rect>s, scaled up via CSS.

const PALETTE = {
  // skin (per-session via CSS vars with fallback)
  s: "var(--skin, #fcd9b0)",
  S: "var(--skin-dark, #e2b38e)",
  // hair (per-session via CSS var) / outline
  h: "var(--hair, #1f2937)",
  H: "#0f172a", // outline always dark
  // clothing — varies per agent, set via CSS custom prop --shirt
  c: "var(--shirt, #3b82f6)",
  C: "var(--shirt-dark, #1d4ed8)",
  // pants
  p: "#1e293b",
  P: "#0f172a",
  // accents
  w: "#ffffff",
  k: "#000000",
  y: "#fbbf24",
  Y: "#f59e0b",
  r: "#ef4444",
  R: "#b91c1c",
  g: "#22c55e",
  G: "#15803d",
  b: "#38bdf8",
  B: "#0ea5e9",
  v: "#a78bfa",
  V: "#7c3aed",
  o: "#fb923c",
  O: "#ea580c",
  n: "#64748b", // neutral gray
  N: "#334155",
  e: "#e2e8f0", // light gray
};

// 16x16 humanoid base — facing forward, neutral pose.
const SPRITE_AGENT = `
................
.....hhhh.......
....hhhhhh......
....hsssh.......
....hswswh......
.....ssss.......
....SccccS......
...CccccccC.....
..CccccccccC....
...CcccccC......
....cccccC......
....pp..pp......
....PP..PP......
....PP..PP......
....PP..PP......
....nn..nn......
`;

// 16x16 humanoid — typing/working pose (arms forward at desk)
const SPRITE_AGENT_TYPING = `
................
.....hhhh.......
....hhhhhh......
....hsssh.......
....hswswh......
.....ssss.......
....SccccS......
...Ccccccc......
...Sccccccss....
....cccccc......
....ccccc.......
....pp..pp......
....PP..PP......
....PP..PP......
....PP..PP......
....nn..nn......
`;

// Sleeping pose (lying side)
const SPRITE_AGENT_SLEEP = `
................
................
................
....hhhh........
...hsswsh.......
...sccccss......
..CcccccccC.....
..CcccccccC.....
..pppppppppp....
..PPPPPPPPPP....
................
................
................
................
................
................
`;

// Ghost (stopped/archived)
const SPRITE_GHOST = `
................
.....eeeeee.....
....eeeeeeee....
...eekeekee.k...
...eekeekee.....
...eeeeeeeee....
...eeeeeeeee....
...eeeeeeeee....
....eeeeeeee....
....eeeeeeee....
....eeeeeeee....
....e.ee.ee.....
....e..e..e.....
................
................
................
`;

// Props — drawn next to the agent based on last tool
const PROP_TERMINAL = `
NNNNNNNN
NkkkkkkN
NkgggggN
Nkg>_..N
Nkg....N
Nkg....N
NNNNNNNN
`;

const PROP_BOOK = `
.HHHHHH.
.HwwwwH.
.HwHHwH.
.HwwwwH.
.HwHHwH.
.HwwwwH.
.HHHHHH.
`;

const PROP_WHITEBOARD = `
NNNNNNNN
NwwwwwwN
Nw....bN
Nw.bb.bN
Nw....bN
Nw....bN
NNNNNNNN
`;

const PROP_GLOBE = `
.HHHHHH.
HBBBBBBH
HBbbbBgH
HgbgbBBH
HBgggBBH
HBBgBBBH
.HHHHHH.
`;

const PROP_MAGNIFIER = `
HHHH....
HbbHH...
HbbbH...
HbbHH...
HHHH....
...HH...
....HH..
.....HH.
`;

const PROP_ANTENNA = `
....k...
...kkk..
...kvk..
....k...
....k...
.HHHkHHH
HwwwwwwH
HHHHHHHH
`;

const PROP_HELPER = `
................
.....hhhh.......
....hsoosh......
....hswswh......
.....ssss.......
....SoooS.......
...SoooooS......
....oooo........
....pp.pp.......
................
`;

// Status overlays — drawn above the agent's head
const OVERLAY_EXCLAIM = `
.yy.
.yy.
.yy.
.yy.
....
.yy.
`;

const OVERLAY_QUESTION = `
.rrr.
rr.rr
...rr
..rr.
.rr..
.....
.rr..
`;

const OVERLAY_THINK = `
......
.nnnnn
n.....
.nnnnn
.....n
.nnnnn
......
.....k
....k.
...k..
`;

const OVERLAY_ZZZ = `
nnn...
..n...
.n....
nnn...
......
.nnn..
...n..
..n...
.nnn..
`;

// ─── Renderer ────────────────────────────────────────────────────

function parsePattern(str) {
  const lines = str.split("\n").filter((l) => l.length > 0);
  const rects = [];
  let w = 0;
  lines.forEach((line, y) => {
    w = Math.max(w, line.length);
    [...line].forEach((ch, x) => {
      if (ch === "." || ch === " ") return;
      const fill = PALETTE[ch];
      if (!fill) return;
      rects.push({ x, y, fill });
    });
  });
  return { w, h: lines.length, rects };
}

function svgFromPattern(pattern, { scale = 4, className = "" } = {}) {
  const { w, h, rects } = parsePattern(pattern);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w * scale);
  svg.setAttribute("height", h * scale);
  svg.setAttribute("shape-rendering", "crispEdges");
  if (className) svg.setAttribute("class", className);
  for (const r of rects) {
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", r.x);
    rect.setAttribute("y", r.y);
    rect.setAttribute("width", 1);
    rect.setAttribute("height", 1);
    rect.setAttribute("fill", r.fill);
    svg.appendChild(rect);
  }
  return svg;
}

// Color per workspace — deterministic, drawn from a pleasant palette.
const SHIRT_COLORS = [
  ["#3b82f6", "#1d4ed8"], // blue
  ["#a78bfa", "#7c3aed"], // violet
  ["#22c55e", "#15803d"], // green
  ["#f59e0b", "#b45309"], // amber
  ["#ec4899", "#be185d"], // pink
  ["#06b6d4", "#0e7490"], // cyan
  ["#ef4444", "#b91c1c"], // red
  ["#84cc16", "#4d7c0f"], // lime
  ["#8b5cf6", "#6d28d9"], // purple
  ["#14b8a6", "#0f766e"], // teal
  ["#f97316", "#c2410c"], // orange
  ["#0ea5e9", "#0369a1"], // sky
  ["#eab308", "#a16207"], // yellow
];

function shirtFor(workspaceKey) {
  let h = 0;
  for (let i = 0; i < workspaceKey.length; i++) h = (h * 31 + workspaceKey.charCodeAt(i)) | 0;
  return SHIRT_COLORS[Math.abs(h) % SHIRT_COLORS.length];
}

// Per-session visual variation so multiple agents in the same room are
// individually recognizable. Stable hash of session id.
const HAIR_COLORS = ["#1f2937", "#451a03", "#7c2d12", "#facc15", "#9333ea", "#0c4a6e", "#831843", "#374151"];
const SKIN_TONES  = [
  ["#fcd9b0", "#e2b38e"],
  ["#f5c6a5", "#d8a47f"],
  ["#e8b48a", "#c5926a"],
  ["#d9a47b", "#b27d52"],
  ["#b07a55", "#8a5a3a"],
  ["#8a5a3a", "#5f3a23"],
];
function variantFor(sessionId) {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 17 + sessionId.charCodeAt(i)) | 0;
  const hair = HAIR_COLORS[Math.abs(h) % HAIR_COLORS.length];
  const skin = SKIN_TONES[Math.abs(h >> 3) % SKIN_TONES.length];
  return { hair, skin };
}

// Map status + last tool → which sprite + which prop + which overlay
function spriteForSession(session) {
  const lastTool = session.tools?.[session.tools.length - 1]?.name || null;
  const status = session.status;

  let body = SPRITE_AGENT_TYPING;
  let prop = null;
  let overlay = null;
  let overlayClass = "";

  // Status-driven overlays + body changes
  if (status === "needs_input") {
    overlay = OVERLAY_EXCLAIM;
    overlayClass = "overlay-blink";
    body = SPRITE_AGENT;
  } else if (status === "needs_permission") {
    overlay = OVERLAY_QUESTION;
    overlayClass = "overlay-blink overlay-red";
    body = SPRITE_AGENT;
  } else if (status === "thinking") {
    overlay = OVERLAY_THINK;
    overlayClass = "overlay-pulse";
  } else if (status === "idle") {
    body = SPRITE_AGENT_SLEEP;
    overlay = OVERLAY_ZZZ;
    overlayClass = "overlay-zzz";
  } else if (status === "stopped" || status === "archived") {
    body = SPRITE_GHOST;
  }

  // Tool-driven props (also when waiting, so you see what they were doing)
  const showProp = status === "thinking" || status === "running"
                || status === "needs_input" || status === "needs_permission";
  if (showProp) {
    if (lastTool === "Bash") prop = PROP_TERMINAL;
    else if (lastTool === "Read" || lastTool === "Grep" || lastTool === "Glob") prop = PROP_MAGNIFIER;
    else if (lastTool === "Edit" || lastTool === "Write" || lastTool === "NotebookEdit") prop = PROP_WHITEBOARD;
    else if (lastTool === "WebFetch" || lastTool === "WebSearch") prop = PROP_GLOBE;
    else if (lastTool === "Agent" || lastTool === "Task") prop = PROP_HELPER;
    else if (lastTool === "Skill") prop = PROP_BOOK;
    else if (lastTool?.startsWith("mcp__")) prop = PROP_ANTENNA;
  }

  return { body, prop, overlay, overlayClass };
}

// Sprite cache: reuse DOM nodes across snapshots so animations don't restart.
// Key: session.id → { el, signature, sessionRef }
const spriteCache = new Map();

function spriteSignature(session) {
  const lastTool = session.tools?.[session.tools.length - 1]?.name || "";
  // Re-build internals only when one of these visual inputs changes.
  return `${session.status}|${lastTool}|${workspaceFor(session.cwd).key}`;
}

function buildAgentEl(session) {
  const cached = spriteCache.get(session.id);
  const sig = spriteSignature(session);
  let wrap;

  if (cached && cached.signature === sig) {
    // Hot path: same visuals, just refresh hover-data + dataset.
    wrap = cached.el;
  } else if (cached) {
    // Status/tool changed → rebuild internals but keep the wrapper element.
    wrap = cached.el;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    paintSprite(wrap, session);
    cached.signature = sig;
  } else {
    // New session.
    wrap = document.createElement("button");
    wrap.className = "sprite";
    wrap.type = "button";
    wrap.dataset.id = session.id;
    paintSprite(wrap, session);

    wrap.addEventListener("click", () => {
      const ref = spriteCache.get(session.id);
      focusSession(ref?.sessionRef || session, wrap);
    });
    wrap.addEventListener("mouseenter", () => showBubble(wrap));
    wrap.addEventListener("mouseleave", hideBubble);

    spriteCache.set(session.id, { el: wrap, signature: sig, sessionRef: session });
  }

  // Always-fresh metadata for filter, hover, age display, click handler.
  wrap.dataset.status = session.status;
  wrap.dataset.tty = session.tty || "";
  wrap.dataset.group = groupOf(session.status);
  wrap.dataset.sessionData = JSON.stringify({
    id: session.id,
    ws: workspaceFor(session.cwd).label,
    status: STATUS_DE[session.status] || session.status,
    title: session.title || null,
    prompt: session.lastPrompt || null,
    tool: session.tools?.[session.tools.length - 1]?.name || null,
    pid: session.pid,
    branch: session.gitBranch,
    age: session.ageMs,
  });
  // Update the cached session reference so click handler sees latest tty/pid.
  const entry = spriteCache.get(session.id);
  if (entry) entry.sessionRef = session;

  // If the bubble is open and points to this sprite, refresh its contents.
  if (bubbleEl && bubbleEl.classList.contains("bub-show") && bubbleEl.dataset.spriteId === session.id) {
    showBubble(wrap, /* skipReposition */ true);
  }

  return wrap;
}

function paintSprite(wrap, session) {
  const ws = workspaceFor(session.cwd);
  const [shirt, shirtDark] = shirtFor(ws.key);
  const variant = variantFor(session.id);
  wrap.style.setProperty("--shirt", shirt);
  wrap.style.setProperty("--shirt-dark", shirtDark);
  wrap.style.setProperty("--hair", variant.hair);
  wrap.style.setProperty("--skin", variant.skin[0]);
  wrap.style.setProperty("--skin-dark", variant.skin[1]);

  const { body, prop, overlay, overlayClass } = spriteForSession(session);
  if (overlay) wrap.appendChild(svgFromPattern(overlay, { scale: 4, className: `sprite-overlay ${overlayClass}` }));
  if (prop)    wrap.appendChild(svgFromPattern(prop,    { scale: 3, className: "sprite-prop" }));
  wrap.appendChild(svgFromPattern(body, { scale: 4, className: "sprite-body" }));

  if (session.status === "thinking" || session.status === "running") {
    const beat = document.createElement("span");
    beat.className = "sprite-beat";
    wrap.appendChild(beat);
  }
}

// ─── Speech-Bubble (hover-tooltip) ──────────────────────────────
let bubbleEl = null;
function ensureBubble() {
  if (bubbleEl) return bubbleEl;
  bubbleEl = document.createElement("div");
  bubbleEl.className = "speech-bubble";
  bubbleEl.style.display = "none";
  document.body.appendChild(bubbleEl);
  return bubbleEl;
}

function fmtAgeShort(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function showBubble(spriteEl, skipReposition = false) {
  const bub = ensureBubble();
  bub.dataset.spriteId = spriteEl.dataset.id || "";
  const data = JSON.parse(spriteEl.dataset.sessionData);
  const prompt = data.prompt ? (data.prompt.length > 220 ? data.prompt.slice(0, 220) + "…" : data.prompt) : null;
  bub.innerHTML = `
    <div class="bub-head">
      <span class="bub-ws">${escapeHtml(data.ws)}</span>
      <span class="bub-status">${escapeHtml(data.status)}</span>
      <span class="bub-age">${fmtAgeShort(data.age)}</span>
    </div>
    ${data.title ? `<div class="bub-title">${escapeHtml(data.title)}</div>` : ""}
    ${prompt ? `<div class="bub-prompt">❝ ${escapeHtml(prompt)}</div>` : ""}
    <div class="bub-foot">
      ${data.tool ? `<span class="bub-tool">⚙ ${escapeHtml(data.tool)}</span>` : ""}
      ${data.branch ? `<span class="bub-branch">⎇ ${escapeHtml(data.branch)}</span>` : ""}
      ${data.pid ? `<span class="bub-pid">pid ${data.pid}</span>` : ""}
    </div>
    <div class="bub-hint">click → iTerm fokussieren</div>
  `;
  bub.style.display = "block";

  if (!skipReposition) {
    const rect = spriteEl.getBoundingClientRect();
    const bubRect = bub.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - bubRect.width / 2;
    let top = rect.top - bubRect.height - 12;
    left = Math.max(8, Math.min(window.innerWidth - bubRect.width - 8, left));
    if (top < 8) top = rect.bottom + 12;
    bub.style.left = left + "px";
    bub.style.top = top + "px";
  }
  bub.classList.add("bub-show");
}

function hideBubble() {
  if (!bubbleEl) return;
  bubbleEl.classList.remove("bub-show");
  bubbleEl.style.display = "none";
}

const STATUS_DE = {
  needs_input: "wartet auf dich",
  needs_permission: "braucht Permission",
  thinking: "denkt",
  running: "aktiv",
  idle: "schläft",
  stopped: "gestoppt",
  archived: "archiviert",
};

async function focusSession(session, spriteEl) {
  if (!session.tty) {
    spriteEl.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }],
      { duration: 240 }
    );
    return;
  }
  try {
    await fetch("/api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tty: session.tty }),
    });
  } catch (e) {
    console.warn("focus error", e);
  }
}

// ─── Layout ──────────────────────────────────────────────────────

const townEl = document.getElementById("town");
const questsEl = document.getElementById("quests");
const hudEl = document.getElementById("townHud");

const roomEls = new Map(); // workspaceKey → { room, floor, info }

function ensureRoom(ws) {
  if (roomEls.has(ws.key)) return roomEls.get(ws.key);

  const room = document.createElement("section");
  room.className = "room";
  room.dataset.workspace = ws.key;

  const head = document.createElement("header");
  head.innerHTML = `
    <span class="room-icon">${ICON_GLYPH[ws.icon] || "▣"}</span>
    <span class="room-label">${ws.label}</span>
    <span class="room-count" data-count="0">0</span>
  `;

  const floor = document.createElement("div");
  floor.className = "floor";

  room.append(head, floor);
  townEl.appendChild(room);

  const entry = { room, floor, head, countEl: head.querySelector(".room-count") };
  roomEls.set(ws.key, entry);
  return entry;
}

const ICON_GLYPH = {
  shield: "🛡",
  chart: "📊",
  globe: "🌐",
  coffee: "☕",
  factory: "🏭",
  megaphone: "📣",
  handshake: "🤝",
  phone: "📞",
  server: "🖥",
  book: "📚",
  brain: "🧠",
  user: "👤",
  house: "📂",
};

function renderTown(sessions) {
  // Group sessions by workspace
  const byWs = new Map();
  for (const s of sessions) {
    const ws = workspaceFor(s.cwd);
    if (!byWs.has(ws.key)) byWs.set(ws.key, { ws, sessions: [] });
    byWs.get(ws.key).sessions.push(s);
  }

  // Ensure rooms exist only for active workspaces (auto-collapse empty ones)
  const seen = new Set();
  // Stable order: workspaces with attention first, then size
  const ordered = [...byWs.values()].sort((a, b) => {
    const aAtt = a.sessions.filter(needsAttention).length;
    const bAtt = b.sessions.filter(needsAttention).length;
    if (aAtt !== bAtt) return bAtt - aAtt;
    return b.sessions.length - a.sessions.length;
  });
  const MAX_PER_ROOM = 12;
  const visibleSessionIds = new Set();
  for (const { ws, sessions } of ordered) {
    seen.add(ws.key);
    const entry = ensureRoom(ws);
    sessions.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
    const visible = sessions.slice(0, MAX_PER_ROOM);
    const hidden = sessions.length - visible.length;

    // Diff floor children: re-append in new order (DOM keeps focus + animation state).
    const desiredChildren = [];
    for (const s of visible) {
      desiredChildren.push(buildAgentEl(s));
      visibleSessionIds.add(s.id);
    }
    // Remove stale children (sprites that don't belong in this room anymore)
    for (const child of Array.from(entry.floor.children)) {
      if (child.classList.contains("sprite-more")) { child.remove(); continue; }
      if (!desiredChildren.includes(child)) child.remove();
    }
    // Re-order / append
    let prev = null;
    for (const child of desiredChildren) {
      if (child.parentNode !== entry.floor) entry.floor.appendChild(child);
      if (prev && prev.nextSibling !== child) entry.floor.insertBefore(child, prev.nextSibling);
      prev = child;
    }

    if (hidden > 0) {
      const more = document.createElement("div");
      more.className = "sprite-more";
      more.textContent = `+${hidden}`;
      more.title = `${hidden} weitere Sessions (sortiert nach Status, älteste ausgeblendet)`;
      entry.floor.appendChild(more);
    }
    entry.countEl.textContent = sessions.length;
    entry.countEl.dataset.count = sessions.length;
    entry.room.dataset.attention = sessions.some(needsAttention) ? "1" : "0";
    townEl.appendChild(entry.room);
  }
  // Hide rooms that lost all their sessions
  for (const [key, entry] of roomEls) {
    if (!seen.has(key)) entry.room.remove(), roomEls.delete(key);
  }
  // Drop sprites from cache that aren't visible anymore
  for (const [id] of spriteCache) {
    if (!visibleSessionIds.has(id)) spriteCache.delete(id);
  }
  // If the speech bubble pointed to a sprite that's gone, hide it.
  if (bubbleEl?.dataset.spriteId && !visibleSessionIds.has(bubbleEl.dataset.spriteId)) {
    hideBubble();
  }

  renderQuests(sessions);
  renderHud(sessions);
}

function needsAttention(s) {
  return s.status === "needs_input" || s.status === "needs_permission";
}

const STATUS_RANK = {
  needs_permission: 0,
  needs_input: 1,
  thinking: 2,
  running: 3,
  idle: 4,
  stopped: 5,
  archived: 6,
};

function groupOf(status) {
  if (status === "needs_input" || status === "needs_permission") return "attention";
  if (status === "thinking" || status === "running") return "active";
  if (status === "idle") return "idle";
  return "rest"; // stopped, archived
}

function renderHud(sessions) {
  let thinking = 0, waiting = 0, perm = 0, idle = 0, stopped = 0;
  for (const s of sessions) {
    if (s.status === "thinking") thinking++;
    else if (s.status === "running") thinking++;
    else if (s.status === "needs_input") waiting++;
    else if (s.status === "needs_permission") perm++;
    else if (s.status === "idle") idle++;
    else stopped++;
  }
  ensureHudStats();
  hudStatEls.thinking.firstChild.data = String(thinking);
  hudStatEls.waiting.firstChild.data  = String(waiting);
  hudStatEls.perm.firstChild.data     = String(perm);
  hudStatEls.idle.firstChild.data     = String(idle);
  hudStatEls.stopped.firstChild.data  = String(stopped);
}

const hudStatEls = {};
function ensureHudStats() {
  if (hudStatEls.thinking) return;
  const mk = (cls, label) => {
    const el = document.createElement("span");
    el.className = "hud-stat " + cls;
    el.appendChild(document.createTextNode("0 "));
    const sm = document.createElement("small");
    sm.textContent = label;
    el.appendChild(sm);
    hudEl.appendChild(el);
    return el;
  };
  hudStatEls.thinking = mk("hud-thinking", "thinking");
  hudStatEls.waiting  = mk("hud-waiting",  "wartet");
  hudStatEls.perm     = mk("hud-perm",     "perm");
  hudStatEls.idle     = mk("hud-idle",     "idle");
  hudStatEls.stopped  = mk("hud-stopped",  "gestoppt");
}

function renderQuests(sessions) {
  const attention = sessions.filter(needsAttention)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  if (!attention.length) {
    questsEl.innerHTML = `<div class="quest-empty">⚔ Alle Agents arbeiten ruhig. Keine Quests.</div>`;
    return;
  }
  questsEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "quest-head";
  head.textContent = `⚔ Quest Log — ${attention.length} brauchen dich`;
  questsEl.appendChild(head);

  for (const s of attention) {
    const ws = workspaceFor(s.cwd);
    const item = document.createElement("button");
    item.type = "button";
    item.className = `quest quest-${s.status}`;
    item.dataset.tty = s.tty || "";
    const label = s.title || (s.lastPrompt ? s.lastPrompt.slice(0, 80) : s.id.slice(0, 8));
    item.innerHTML = `
      <span class="quest-icon">${s.status === "needs_permission" ? "🔴" : "🟡"}</span>
      <span class="quest-ws">${ws.label}</span>
      <span class="quest-label">${escapeHtml(label)}</span>
      <span class="quest-status">${STATUS_DE[s.status]}</span>
    `;
    item.addEventListener("click", () => focusSession(s, item));
    questsEl.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── Transition detector (audio + sparkles + confetti) ─────────
const prevState = new Map(); // sessionId → { status, toolCount }
let prevAttention = 0;

function detectTransitions(sessions) {
  let attention = 0;
  for (const s of sessions) {
    const prev = prevState.get(s.id);
    const toolCount = s.tools?.length || 0;
    const status = s.status;
    if (needsAttention(s)) attention++;

    if (prev) {
      if (!isAttentionStatus(prev.status) && isAttentionStatus(status)) {
        fireAttentionBurst(s.id, status, s);
      }
      if (toolCount > prev.toolCount) {
        fireToolSparkle(s.id);
      }
    }
    prevState.set(s.id, { status, toolCount });
  }

  // Inbox-zero confetti: was >0, now 0 → celebrate
  if (prevAttention > 0 && attention === 0 && document.visibilityState === "visible") {
    fireConfetti();
  }
  prevAttention = attention;

  // Prune state for gone sessions
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of prevState.keys()) if (!ids.has(id)) prevState.delete(id);
}

function isAttentionStatus(s) { return s === "needs_input" || s === "needs_permission"; }

// ─── Audio (Web Audio API, no asset) ────────────────────────────
let audioCtx = null;
let audioUnlocked = false;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  return audioCtx;
}
// Unlock audio on ANY first user gesture (browser autoplay policy).
function unlockAudio() {
  if (audioUnlocked) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  audioUnlocked = true;
}
["click", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, unlockAudio, { once: false, passive: true })
);
function isSoundOn() {
  try { return localStorage.getItem("claude-control-sound") !== "off"; } catch { return true; }
}
function setSoundOn(on) {
  try { localStorage.setItem("claude-control-sound", on ? "on" : "off"); } catch {}
  syncSoundToggle();
}
function playBing(kind) {
  if (!isSoundOn()) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  // resume in case it's been suspended (browser policy)
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  // Two short tones — different pitch per kind (perm = lower/urgent, input = higher)
  const tones = kind === "needs_permission" ? [880, 660] : [988, 1318];
  for (let i = 0; i < tones.length; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square"; // 8-bit feel
    o.frequency.setValueAtTime(tones[i], now + i * 0.09);
    g.gain.setValueAtTime(0.0001, now + i * 0.09);
    g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.09 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.12);
    o.connect(g).connect(ctx.destination);
    o.start(now + i * 0.09);
    o.stop(now + i * 0.09 + 0.14);
  }
}

// ─── Visual bursts (attached to a sprite, position-aware) ───────
function spriteById(id) {
  return townEl.querySelector(`.sprite[data-id="${CSS.escape(id)}"]`);
}

function fireAttentionBurst(id, status, session) {
  playBing(status);
  notifyBrowser(status, session);
  const sprite = spriteById(id);
  if (!sprite) return;
  const burst = document.createElement("span");
  burst.className = `burst burst-${status}`;
  sprite.appendChild(burst);
  setTimeout(() => burst.remove(), 900);
  // Particles handled in particles.js (canvas overlay)
  if (window.__particles) {
    const rect = sprite.getBoundingClientRect();
    window.__particles.burst(rect.left + rect.width / 2, rect.top + rect.height / 2, status);
  }
}

// Browser Notification API — only fires when page is hidden, opt-in via Permission.
function notifyBrowser(status, session) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return; // already audible+visible
  try {
    const ws = workspaceFor(session.cwd).label;
    const verb = status === "needs_permission" ? "braucht Permission" : "wartet auf dich";
    const body = session.lastPrompt ? session.lastPrompt.slice(0, 140) : (session.title || "");
    const n = new Notification(`${ws} ${verb}`, {
      body, tag: session.id, silent: false, icon: "/favicon.svg",
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch (e) { /* ignore — some browsers throw on hidden state */ }
}

function requestBrowserNotifications() {
  if (!("Notification" in window)) return Promise.resolve("unsupported");
  if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
  return Notification.requestPermission();
}

function fireToolSparkle(id) {
  const sprite = spriteById(id);
  if (!sprite) return;
  if (window.__particles) {
    const rect = sprite.getBoundingClientRect();
    window.__particles.sparkAt(rect.left + rect.width / 2, rect.top + 20);
  }
}

function fireConfetti() {
  if (window.__particles) window.__particles.confetti();
}

// ─── Filter ─────────────────────────────────────────────────────
function currentFilter() {
  try { return localStorage.getItem("claude-control-filter") || "all"; } catch { return "all"; }
}
function setFilter(f) {
  try { localStorage.setItem("claude-control-filter", f); } catch {}
  document.body.dataset.filter = f;
  for (const btn of document.querySelectorAll(".filter-chip")) {
    btn.setAttribute("aria-pressed", btn.dataset.filter === f ? "true" : "false");
  }
}

function syncSoundToggle() {
  const btn = document.getElementById("soundToggle");
  if (!btn) return;
  const on = isSoundOn();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = on ? "🔊" : "🔇";
  btn.title = on ? "Sound an (klick zum Stummschalten)" : "Sound aus";
}

// Initialize filter + sound toggle on first load
setFilter(currentFilter());
syncSoundToggle();
for (const btn of document.querySelectorAll(".filter-chip")) {
  btn.addEventListener("click", () => setFilter(btn.dataset.filter));
}
const soundBtn = document.getElementById("soundToggle");
if (soundBtn) {
  soundBtn.addEventListener("click", () => {
    setSoundOn(!isSoundOn());
    if (isSoundOn()) {
      playBing("needs_input");
      // Also request browser notification permission on opt-in (silent if denied/granted)
      requestBrowserNotifications().catch(() => {});
    }
  });
}
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.key === "s") soundBtn?.click();
  if (e.key === "1") setFilter("all");
  if (e.key === "2") setFilter("attention");
  if (e.key === "3") setFilter("active");
  if (e.key === "4") setFilter("idle");
});

// ─── Subscribe to the shared SSE store ──────────────────────────

subscribe((snapshot) => {
  try {
    const sessions = snapshot.sessions || [];
    detectTransitions(sessions);
    if (window.__minimap) window.__minimap.update(sessions);
    if (!isTownActive()) return;
    renderTown(sessions);
  } catch (e) {
    console.error("town render failed", e);
  }
});

function isTownActive() {
  return document.body.dataset.view === "town";
}

// Re-render when the user switches into town view (cards-view doesn't update us)
window.addEventListener("view:town", () => {
  // The store will replay the last snapshot via subscribe.
});

export { renderTown };
