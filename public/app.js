// claude-tower — cards view client.
// Subscribes to the shared SSE store (store.js).

import { subscribe, onConn } from "/store.js";
import { announce } from "/a11y.js";
import { toast } from "/toast.js";

const grid = document.getElementById("grid");
const summary = document.getElementById("summary");
const updatedEl = document.getElementById("updated");
const connEl = document.getElementById("conn");
const portInfo = document.getElementById("portInfo");
const notifierToggle = document.getElementById("notifierToggle");

portInfo.textContent = location.host;

const STATUS_LABEL = {
  needs_input: "waiting for you",
  needs_permission: "permission",
  thinking: "thinking",
  running: "active",
  idle: "idle",
  stopped: "stopped",
  archived: "archived",
};

// Map a stat key to the orb status that visually represents it.
const STAT_ORB_STATUS = {
  attention: "needs_permission",
  thinking: "thinking",
  running: "running",
  idle: "idle",
  stopped: "stopped",
  total: "running",
};

const STATUS_ORDER = ["needs_input", "needs_permission", "thinking", "running", "idle", "stopped", "archived"];

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmtTitle(s) {
  if (s.title) return s.title;
  if (s.lastPrompt) {
    return s.lastPrompt.slice(0, 80) + (s.lastPrompt.length > 80 ? "…" : "");
  }
  return s.id.slice(0, 8);
}

const prevCounts = {};

function tweenStat(el, from, to) {
  if (from === to) { el.textContent = String(to); return; }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduced) { el.textContent = String(to); return; }
  const start = performance.now();
  const dur = 260;
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    // ease-out cubic
    const k = 1 - Math.pow(1 - t, 3);
    const v = Math.round(from + (to - from) * k);
    el.textContent = String(v);
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = String(to);
  }
  requestAnimationFrame(frame);
  el.classList.remove("tween-bump");
  // force reflow to restart animation
  void el.offsetWidth;
  el.classList.add("tween-bump");
}

function renderSummary(sessions) {
  const counts = {
    attention: 0,
    thinking: 0,
    running: 0,
    idle: 0,
    stopped: 0,
    total: sessions.length,
  };
  for (const s of sessions) {
    if (s.status === "needs_input" || s.status === "needs_permission") counts.attention++;
    else if (s.status === "thinking") counts.thinking++;
    else if (s.status === "running") counts.running++;
    else if (s.status === "idle") counts.idle++;
    else counts.stopped++;
  }

  const stats = [
    { key: "attention", label: "Attention", value: counts.attention },
    { key: "thinking", label: "Thinking", value: counts.thinking },
    { key: "running", label: "Active", value: counts.running },
    { key: "idle", label: "Idle", value: counts.idle },
    { key: "stopped", label: "Stopped", value: counts.stopped },
    { key: "total", label: "Total", value: counts.total },
  ];

  // Diff-render so the orb + count-up transition stays smooth (no flicker).
  const existing = new Map();
  for (const el of summary.querySelectorAll(".stat")) existing.set(el.dataset.key, el);

  for (const s of stats) {
    let el = existing.get(s.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "stat";
      el.dataset.key = s.key;
      el.innerHTML = `
        <span class="value">0</span>
        <span class="label">${s.label}</span>
        <span class="orb" data-status="${STAT_ORB_STATUS[s.key] || "idle"}" aria-hidden="true"></span>
      `;
      summary.appendChild(el);
    }
    existing.delete(s.key);
    const valueEl = el.querySelector(".value");
    const prev = prevCounts[s.key] ?? 0;
    tweenStat(valueEl, prev, s.value);
    prevCounts[s.key] = s.value;
  }
  for (const el of existing.values()) el.remove();
}

function makeCard(session) {
  const tpl = document.getElementById("cardTpl");
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = session.id;
  applyCard(node, session);
  node.addEventListener("click", () => focusSession(session, node));
  return node;
}

function renderTimeline(timelineEl, tools, status) {
  timelineEl.innerHTML = "";
  if (!tools || !tools.length) return;
  const limit = 24;
  const slice = tools.slice(-limit);
  const summary = {};
  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    const name = t.name || "tool";
    summary[name] = (summary[name] || 0) + 1;
    const seg = document.createElement("span");
    seg.className = "seg";
    if (i === slice.length - 1) seg.classList.add("last");
    seg.dataset.tool = name;
    timelineEl.appendChild(seg);
  }
  const parts = Object.entries(summary)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([n, c]) => `${n}×${c}`);
  timelineEl.title = `letzte ${slice.length} Tool-Calls: ${parts.join(" · ")}`;
}

function applyCard(node, session) {
  node.dataset.status = session.status;
  node.dataset.tty = session.tty || "";

  const orb = node.querySelector(".orb");
  if (orb) {
    orb.dataset.status = session.status;
    orb.setAttribute("aria-label", `status ${STATUS_LABEL[session.status] || session.status}`);
  }

  node.querySelector(".status-label").textContent = STATUS_LABEL[session.status] || session.status;
  node.querySelector(".age").textContent = fmtAge(session.ageMs);
  node.querySelector(".title").textContent = fmtTitle(session);

  const promptEl = node.querySelector(".prompt");
  promptEl.textContent = session.lastPrompt || "";
  promptEl.style.display = session.lastPrompt ? "" : "none";

  renderTimeline(node.querySelector(".timeline"), session.tools, session.status);

  node.querySelector(".project").textContent = session.project;
  node.querySelector(".pid").textContent = session.pid ? `pid ${session.pid}` : "—";

  const prEl = node.querySelector(".pr");
  prEl.innerHTML = "";
  if (session.pr?.number) {
    prEl.append("↗ ");
    const a = document.createElement("a");
    a.href = session.pr.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `PR #${session.pr.number}`;
    prEl.appendChild(a);
  }

  const permEl = node.querySelector(".permission-mode");
  permEl.textContent = (session.permissionMode && session.permissionMode !== "default")
    ? session.permissionMode
    : "";

  const gbEl = node.querySelector(".git-branch");
  gbEl.textContent = session.gitBranch ? session.gitBranch : "";

  node.title = [
    `Session ${session.id}`,
    `cwd ${session.cwd}`,
    session.tty ? `tty ${session.tty}` : "",
    session.pendingToolUse ? "pending tool_use" : "",
    `stop ${session.stopReason ?? "—"}`,
  ].filter(Boolean).join("\n");
}

async function focusSession(session, cardEl) {
  if (!session.tty) {
    cardEl.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
      { duration: 250 }
    );
    toast("No TTY for this session — can't focus iTerm.", { type: "warn" });
    return;
  }
  try {
    const res = await fetch("/api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tty: session.tty }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.warn("focus failed", json);
      toast(`Focus failed: ${json.error || "unknown"}`, { type: "error" });
    }
  } catch (e) {
    console.warn("focus error", e);
    toast("Focus failed — network error", { type: "error" });
  }
}

let firstSnapshot = true;
let prevAttention = 0;

function clearSkeletons() {
  const skels = grid.querySelectorAll(".skeleton-card");
  if (!skels.length) return;
  skels.forEach((el) => el.classList.add("state-fade-out"));
  setTimeout(() => skels.forEach((el) => el.remove()), 240);
  const townLoading = document.getElementById("townLoading");
  if (townLoading) {
    townLoading.classList.add("state-fade-out");
    setTimeout(() => townLoading.remove(), 240);
  }
  grid.setAttribute("aria-busy", "false");
}

function renderEmptyHero() {
  if (grid.querySelector(".empty-hero")) return;
  grid.innerHTML = `
    <div class="empty-hero" role="status">
      <div class="empty-mark" aria-hidden="true">⌁</div>
      <h2>No sessions yet</h2>
      <p>Run <code>claude</code> anywhere — it'll show up here automatically.</p>
      <div class="empty-cmd"><code>claude</code></div>
    </div>
  `;
}

function render(snapshot) {
  const sessions = (snapshot.sessions || []).slice();
  sessions.sort((a, b) => {
    const oa = STATUS_ORDER.indexOf(a.status);
    const ob = STATUS_ORDER.indexOf(b.status);
    if (oa !== ob) return oa - ob;
    return a.mtimeMs - b.mtimeMs > 0 ? -1 : 1;
  });

  if (firstSnapshot) {
    clearSkeletons();
    firstSnapshot = false;
  }

  renderSummary(sessions);

  // Diff-render: reuse existing nodes where possible to avoid flicker.
  const existing = new Map();
  for (const el of grid.querySelectorAll(".card")) existing.set(el.dataset.id, el);

  const seen = new Set();
  let prevNode = null;
  for (const s of sessions) {
    seen.add(s.id);
    let node = existing.get(s.id);
    if (!node) {
      node = makeCard(s);
    } else {
      updateCard(node, s);
    }
    if (prevNode) prevNode.after(node);
    else grid.prepend(node);
    prevNode = node;
  }
  for (const [id, el] of existing) {
    if (!seen.has(id)) el.remove();
  }

  if (!sessions.length) {
    renderEmptyHero();
  } else {
    const hero = grid.querySelector(".empty-hero");
    if (hero) hero.remove();
    const legacy = grid.querySelector(".empty");
    if (legacy) legacy.remove();
  }

  // Announce attention transitions to assistive tech (throttled in a11y.js).
  const attention = sessions.filter((s) => s.status === "needs_input" || s.status === "needs_permission").length;
  if (attention !== prevAttention) {
    if (attention > prevAttention) {
      announce(`${attention} session${attention === 1 ? "" : "s"} need attention`);
    } else if (attention === 0) {
      announce("All sessions clear");
    }
    prevAttention = attention;
  }

  const ts = new Date(snapshot.generatedAt || Date.now());
  updatedEl.textContent = ts.toLocaleTimeString();
}

function updateCard(node, session) {
  applyCard(node, session);
}

// Subscribe to shared store
subscribe((snapshot) => render(snapshot));

let prevConn = "connecting";
onConn((state) => {
  document.body.setAttribute("data-conn", state);
  if (state === "live") {
    connEl.textContent = "live";
    connEl.classList.remove("pill-muted", "pill-offline");
    connEl.classList.add("pill-live");
    if (prevConn === "offline") {
      toast("Back online", { type: "success", duration: 2500 });
    }
  } else if (state === "offline") {
    connEl.textContent = "RECONNECTING…";
    connEl.classList.remove("pill-live", "pill-muted");
    connEl.classList.add("pill-offline");
    if (prevConn === "live") {
      toast("Connection lost — retrying", { type: "warn", duration: 5000 });
    }
  } else {
    connEl.textContent = "connecting…";
    connEl.classList.remove("pill-live", "pill-offline");
    connEl.classList.add("pill-muted");
  }
  prevConn = state;
});

// Notifier toggle
notifierToggle.addEventListener("change", async () => {
  try {
    await fetch("/api/notifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: notifierToggle.checked }),
    });
  } catch (e) { console.warn(e); }
});

// Keyboard: r = reload, t = toggle notifier (v handled in view.js)
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.key === "r") location.reload();
  if (e.key === "t") notifierToggle.click();
});
