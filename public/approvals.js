// Approval UI — injects Approve/Deny buttons into cards & sprites and listens
// to the SSE stream for approval-pending / approval-decided events.
//
// store.js filters for `type === "snapshot"` only, so we open a second
// EventSource on /api/events (cheap; native HTTP/1.1 keep-alive shares a connection).

import { subscribe } from "/store.js";

const pendingById = new Map();    // approval.id → approval row
const bySessionId = new Map();    // session_id → Set<approval.id>

function indexPending(approval) {
  pendingById.set(approval.id, approval);
  let set = bySessionId.get(approval.session_id);
  if (!set) { set = new Set(); bySessionId.set(approval.session_id, set); }
  set.add(approval.id);
}
function dropPending(id) {
  const a = pendingById.get(id);
  if (!a) return;
  pendingById.delete(id);
  const set = bySessionId.get(a.session_id);
  if (set) {
    set.delete(id);
    if (set.size === 0) bySessionId.delete(a.session_id);
  }
}

async function refreshPending() {
  try {
    const res = await fetch("/api/approvals?status=pending&limit=200");
    if (!res.ok) return;
    const rows = await res.json();
    pendingById.clear();
    bySessionId.clear();
    for (const a of rows) indexPending(a);
    paintAllCards();
  } catch (e) { console.warn("approvals: initial fetch failed", e); }
}

// ─── DOM injection ────────────────────────────────────────────────

function approvalForSession(sessionId) {
  const set = bySessionId.get(sessionId);
  if (!set || set.size === 0) return null;
  // Pick the oldest still-pending one.
  const ids = [...set].sort();
  for (const id of ids) {
    const a = pendingById.get(id);
    if (a) return a;
  }
  return null;
}

function ensureApprovalUI(cardEl) {
  let bar = cardEl.querySelector(".approval-bar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "approval-bar";
  bar.innerHTML = `
    <div class="approval-meta">
      <span class="approval-tool"></span>
      <span class="approval-summary"></span>
    </div>
    <div class="approval-actions">
      <button type="button" class="pixel-btn approve-btn" data-action="approve" title="Approve (a)">✅ Approve</button>
      <button type="button" class="pixel-btn deny-btn"    data-action="deny"    title="Deny (d)">❌ Deny</button>
    </div>
    <div class="approval-status" aria-live="polite"></div>
  `;
  cardEl.appendChild(bar);
  bar.addEventListener("click", (e) => {
    e.stopPropagation(); // don't trigger card-click → iTerm focus
    const btn = e.target.closest("button[data-action]");
    if (btn) decide(cardEl, btn.dataset.action);
  });
  return bar;
}

function summarize(toolName, input) {
  if (!input) return "";
  if (toolName === "Bash" && input.command) return truncate(String(input.command), 200);
  if ((toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") && input.file_path) {
    return String(input.file_path);
  }
  if (toolName === "Read" && input.file_path) return String(input.file_path);
  if (typeof input === "string") return truncate(input, 200);
  try { return truncate(JSON.stringify(input), 200); } catch { return ""; }
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function paintCard(cardEl) {
  const sessionId = cardEl.dataset.id;
  const a = approvalForSession(sessionId);
  const existing = cardEl.querySelector(".approval-bar");
  // The presence of a pending approval row is itself the trigger — don't
  // gate on card.dataset.status, because the session-snapshot scanner can
  // be slow to flip status to "needs_permission" (or may never see it if
  // the hook fired faster than the JSONL was flushed).
  if (!a) {
    if (existing) existing.remove();
    return;
  }
  // Promote the card visually so it stands out in any view.
  cardEl.dataset.status = "needs_permission";
  const bar = ensureApprovalUI(cardEl);
  bar.dataset.approvalId = a.id;
  bar.querySelector(".approval-tool").textContent = a.tool_name || "tool";
  bar.querySelector(".approval-summary").textContent = summarize(a.tool_name, a.tool_input);
  const statusEl = bar.querySelector(".approval-status");
  if (statusEl && !bar.dataset.deciding) statusEl.textContent = "";
}

function paintAllCards() {
  const cards = document.querySelectorAll(".card");
  for (const c of cards) paintCard(c);
}

async function decide(cardEl, action) {
  const bar = cardEl.querySelector(".approval-bar");
  if (!bar) return;
  const id = bar.dataset.approvalId;
  if (!id) return;
  if (bar.dataset.deciding) return;
  bar.dataset.deciding = "1";
  const statusEl = bar.querySelector(".approval-status");
  statusEl.textContent = action === "approve" ? "⏳ Approving…" : "⏳ Denying…";
  bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: action }),
    });
    const json = await res.json();
    if (res.status === 409) {
      const who = json.approval?.decided_by || "?";
      const dec = json.approval?.decision || "?";
      statusEl.textContent = `bereits ${dec} via ${who}`;
    } else if (!res.ok || !json.ok) {
      statusEl.textContent = `Fehler: ${json.error || res.status}`;
      bar.querySelectorAll("button").forEach((b) => (b.disabled = false));
      delete bar.dataset.deciding;
      return;
    } else {
      statusEl.textContent = action === "approve" ? "✅ Approved" : "❌ Denied";
    }
    // Local optimistic prune — SSE broadcast will also fire and is idempotent.
    dropPending(id);
    setTimeout(() => paintCard(cardEl), 400);
  } catch (e) {
    statusEl.textContent = `Netzwerkfehler`;
    bar.querySelectorAll("button").forEach((b) => (b.disabled = false));
    delete bar.dataset.deciding;
    console.warn("decide failed", e);
  }
}

// ─── Sound: short alert for new approvals (Web Audio API) ─────────
let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  return audioCtx;
}
window.addEventListener("click", () => {
  const c = ensureAudio();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}, { passive: true, once: false });

function isSoundOn() {
  try { return localStorage.getItem("tower:sound") !== "off"; } catch { return true; }
}
function playApprovalAlert() {
  if (document.hidden) return;
  if (!isSoundOn()) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const tones = [988, 1318, 1568]; // C#6 E6 G6 — alert chord
  for (let i = 0; i < tones.length; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(tones[i], now + i * 0.07);
    g.gain.setValueAtTime(0.0001, now + i * 0.07);
    g.gain.exponentialRampToValueAtTime(0.14, now + i * 0.07 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.16);
    o.connect(g).connect(ctx.destination);
    o.start(now + i * 0.07);
    o.stop(now + i * 0.07 + 0.18);
  }
}

// ─── Keyboard: a = approve focused card, d = deny ─────────────────
let focusedCard = null;
window.addEventListener("mouseover", (e) => {
  const card = e.target.closest(".card");
  if (card) focusedCard = card;
});
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && /input|textarea/i.test(e.target.tagName)) return;
  if (e.key !== "a" && e.key !== "d") return;
  // Pick a target: focused/hovered card if it has an approval, else any card with one.
  let target = focusedCard && focusedCard.querySelector(".approval-bar") ? focusedCard : null;
  if (!target) target = document.querySelector(".card .approval-bar")?.closest(".card") || null;
  if (!target) return;
  e.preventDefault();
  decide(target, e.key === "a" ? "approve" : "deny");
});

// ─── SSE listener (parallel to store.js, only consumes approval events) ─
function connectApprovals() {
  let es;
  let backoff = 1000;
  function open() {
    try { es = new EventSource("/api/events"); }
    catch { setTimeout(open, backoff = Math.min(backoff * 2, 15000)); return; }
    es.onopen = () => { backoff = 1000; };
    es.onerror = () => {
      try { es.close(); } catch {}
      setTimeout(open, backoff = Math.min(backoff * 2, 15000));
    };
    es.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }
      if (data.type === "approval-pending" && data.approval) {
        const existed = pendingById.has(data.approval.id);
        indexPending(data.approval);
        paintAllCards();
        if (!existed) playApprovalAlert();
      } else if (data.type === "approval-decided" && data.id) {
        dropPending(data.id);
        paintAllCards();
      }
    };
  }
  open();
}

// ─── Re-paint whenever cards re-render ────────────────────────────
subscribe(() => {
  // Cards are re-applied on every snapshot via app.js#applyCard — we add
  // approval UI on the next microtask so we paint after the diff-render.
  queueMicrotask(paintAllCards);
});

// Boot
refreshPending();
connectApprovals();
