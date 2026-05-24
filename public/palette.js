// claude-tower — Command palette.
//
// Pre-builds its DOM on import so the first ⌘+K open is instant (<60ms).
// Data-driven command list; some commands are static, "Jump to session" is
// generated dynamically from the SSE store.

import { subscribe, getLastSnapshot } from "/store.js";
import { play } from "/sounds.js";

const STATUS_LABEL = {
  needs_input: "waiting for you",
  needs_permission: "needs permission",
  thinking: "thinking",
  running: "active",
  idle: "idle",
  stopped: "stopped",
  archived: "archived",
};

// ─── DOM scaffolding (pre-built) ──────────────────────────────────
const root = document.createElement("div");
root.className = "palette-backdrop";
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-label", "Command palette");
root.dataset.open = "0";
root.innerHTML = `
  <div class="palette" role="combobox" aria-expanded="true" aria-haspopup="listbox">
    <div class="palette-search">
      <span class="palette-search-icon">⌘</span>
      <input type="text" placeholder="Type a command or jump to a session…" autocomplete="off" spellcheck="false" />
      <kbd>esc</kbd>
    </div>
    <div class="palette-list" role="listbox"></div>
    <div class="palette-footer">
      <span><kbd>↑↓</kbd>navigate</span>
      <span><kbd>↵</kbd>select</span>
      <span><kbd>esc</kbd>close</span>
    </div>
  </div>
`;
document.body.appendChild(root);

const inputEl = root.querySelector("input");
const listEl = root.querySelector(".palette-list");
const cardEl = root.querySelector(".palette");

// Shortcut help overlay
const shortcutOverlay = document.createElement("div");
shortcutOverlay.className = "shortcut-overlay";
shortcutOverlay.dataset.open = "0";
shortcutOverlay.innerHTML = `
  <div class="shortcut-card" role="dialog" aria-label="Keyboard shortcuts">
    <h3>Keyboard shortcuts</h3>
    <dl>
      <dt><kbd>⌘</kbd> <kbd>K</kbd></dt><dd>Open command palette</dd>
      <dt><kbd>v</kbd></dt><dd>Toggle town / cards view</dd>
      <dt><kbd>a</kbd></dt><dd>Approve focused approval</dd>
      <dt><kbd>d</kbd></dt><dd>Deny focused approval</dd>
      <dt><kbd>t</kbd></dt><dd>Toggle Telegram notifier</dd>
      <dt><kbd>s</kbd></dt><dd>Toggle sound</dd>
      <dt><kbd>r</kbd></dt><dd>Reload</dd>
      <dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>Town filters</dd>
      <dt><kbd>?</kbd></dt><dd>Show this help</dd>
    </dl>
    <div class="shortcut-close">press <kbd>esc</kbd> to close</div>
  </div>
`;
document.body.appendChild(shortcutOverlay);
shortcutOverlay.addEventListener("click", (e) => {
  if (e.target === shortcutOverlay) closeShortcuts();
});

function openShortcuts() { shortcutOverlay.dataset.open = "1"; }
function closeShortcuts() { shortcutOverlay.dataset.open = "0"; }

// ─── Command registry ────────────────────────────────────────────
// External code can call registerCommand({ ... }) to add commands.
const commands = [];
const sessionCache = []; // updated from SSE store

export function registerCommand(cmd) {
  commands.push(cmd);
}

// Static commands.
registerCommand({
  id: "view-town",
  label: "Switch to Town view",
  hint: "pixel-art workshop floor",
  icon: "▣",
  group: "View",
  run: () => document.getElementById("viewTown")?.click(),
});
registerCommand({
  id: "view-cards",
  label: "Switch to Cards view",
  hint: "dense card grid",
  icon: "▦",
  group: "View",
  run: () => document.getElementById("viewCards")?.click(),
});

registerCommand({
  id: "approve-all",
  label: "Approve all pending",
  hint: "POST /api/approvals/:id for each pending",
  icon: "✓",
  group: "Approvals",
  run: async () => {
    try {
      const res = await fetch("/api/approvals?status=pending&limit=200");
      if (!res.ok) return;
      const rows = await res.json();
      for (const a of rows) {
        await fetch(`/api/approvals/${encodeURIComponent(a.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        }).catch(() => {});
      }
      play("success");
    } catch (e) { play("error"); console.warn(e); }
  },
});
registerCommand({
  id: "deny-all",
  label: "Deny all pending",
  hint: "POST /api/approvals/:id for each pending",
  icon: "✕",
  group: "Approvals",
  run: async () => {
    try {
      const res = await fetch("/api/approvals?status=pending&limit=200");
      if (!res.ok) return;
      const rows = await res.json();
      for (const a of rows) {
        await fetch(`/api/approvals/${encodeURIComponent(a.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "deny" }),
        }).catch(() => {});
      }
      play("approval-resolve");
    } catch (e) { play("error"); console.warn(e); }
  },
});

registerCommand({
  id: "toggle-telegram",
  label: "Toggle Telegram notifier",
  hint: "push when an agent needs you",
  icon: "✈",
  group: "Toggles",
  run: () => document.getElementById("notifierToggle")?.click(),
});
registerCommand({
  id: "toggle-sound",
  label: "Toggle sound",
  hint: "mute/unmute all chimes",
  icon: "♪",
  group: "Toggles",
  run: () => document.getElementById("soundToggle")?.click(),
});
registerCommand({
  id: "reload",
  label: "Reload",
  hint: "hard reload the page",
  icon: "↻",
  group: "System",
  run: () => location.reload(),
});
registerCommand({
  id: "shortcuts",
  label: "Show keyboard shortcuts",
  hint: "all ⌘ + key combos",
  icon: "⌨",
  group: "System",
  run: () => { close(); setTimeout(openShortcuts, 50); },
});

// ─── Session snapshot for "Jump to session" ──────────────────────
function refreshSessions(snapshot) {
  sessionCache.length = 0;
  for (const s of snapshot.sessions || []) sessionCache.push(s);
  if (root.dataset.open === "1") render();
}
subscribe(refreshSessions);
const last = getLastSnapshot();
if (last) refreshSessions(last);

// ─── Fuzzy filter (substring, all tokens must match) ─────────────
function tokensMatch(haystack, tokens) {
  const h = haystack.toLowerCase();
  for (const t of tokens) if (!h.includes(t)) return false;
  return true;
}

function fmtTitle(s) {
  if (s.title) return s.title;
  if (s.lastPrompt) return s.lastPrompt.slice(0, 80);
  return s.id.slice(0, 8);
}

// Build a single virtual item list for the current query.
function buildItems(query) {
  const q = query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  const items = [];
  // Static commands
  for (const c of commands) {
    const hay = `${c.label} ${c.hint || ""} ${c.group || ""}`;
    if (!tokens.length || tokensMatch(hay, tokens)) {
      items.push({
        kind: "command",
        id: c.id,
        label: c.label,
        hint: c.hint || "",
        icon: c.icon || "›",
        group: c.group || "Commands",
        run: c.run,
      });
    }
  }
  // Sessions
  for (const s of sessionCache) {
    const title = fmtTitle(s);
    const hay = `${title} ${s.cwd || ""} ${s.lastPrompt || ""} ${s.gitBranch || ""}`;
    if (!tokens.length || tokensMatch(hay, tokens)) {
      items.push({
        kind: "session",
        id: `sess-${s.id}`,
        label: title,
        hint: s.cwd || s.id.slice(0, 8),
        status: s.status,
        group: "Jump to session",
        run: async () => {
          if (!s.tty) { play("error"); return; }
          try {
            await fetch("/api/focus", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tty: s.tty }),
            });
            play("click");
          } catch { play("error"); }
        },
      });
    }
  }
  return items;
}

// ─── Render ──────────────────────────────────────────────────────
let currentItems = [];
let selectedIdx = 0;

function render() {
  const items = buildItems(inputEl.value);
  currentItems = items;
  if (selectedIdx >= items.length) selectedIdx = Math.max(0, items.length - 1);

  if (!items.length) {
    listEl.innerHTML = `<div class="palette-empty">No matches.</div>`;
    return;
  }

  // Group by group label, preserving insertion order.
  const groups = new Map();
  for (let i = 0; i < items.length; i++) {
    const g = items[i].group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ item: items[i], index: i });
  }

  const frag = document.createDocumentFragment();
  for (const [groupName, rows] of groups) {
    const head = document.createElement("div");
    head.className = "palette-group-label";
    head.textContent = groupName;
    frag.appendChild(head);
    for (const { item, index } of rows) {
      const el = document.createElement("div");
      el.className = "palette-item";
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", index === selectedIdx ? "true" : "false");
      el.dataset.idx = String(index);

      const iconHtml = item.kind === "session"
        ? `<span class="palette-item-status" data-status="${item.status}"></span>`
        : `<span class="palette-item-icon">${item.icon}</span>`;

      el.innerHTML = `
        ${iconHtml}
        <div class="palette-item-body">
          <div class="palette-item-label"></div>
          <div class="palette-item-hint"></div>
        </div>
      `;
      el.querySelector(".palette-item-label").textContent = item.label;
      el.querySelector(".palette-item-hint").textContent = item.hint;

      el.addEventListener("mousemove", () => {
        if (selectedIdx !== index) {
          selectedIdx = index;
          updateSelection();
        }
      });
      el.addEventListener("click", () => {
        selectedIdx = index;
        execute();
      });

      frag.appendChild(el);
    }
  }
  listEl.innerHTML = "";
  listEl.appendChild(frag);
}

function updateSelection() {
  const els = listEl.querySelectorAll(".palette-item");
  for (const el of els) {
    const idx = Number(el.dataset.idx);
    el.setAttribute("aria-selected", idx === selectedIdx ? "true" : "false");
    if (idx === selectedIdx) {
      el.scrollIntoView({ block: "nearest" });
    }
  }
}

function execute() {
  const item = currentItems[selectedIdx];
  if (!item) return;
  close();
  // Defer so close animation doesn't lag the action
  setTimeout(() => {
    try { item.run(); } catch (e) { console.warn("command failed", e); play("error"); }
  }, 30);
}

// ─── Open / close ────────────────────────────────────────────────
export function open() {
  if (root.dataset.open === "1") return;
  root.dataset.open = "1";
  inputEl.value = "";
  selectedIdx = 0;
  render();
  // Focus after paint so the spring-in completes smoothly
  requestAnimationFrame(() => inputEl.focus());
  play("click");
}

export function close() {
  if (root.dataset.open === "0") return;
  root.dataset.open = "0";
  inputEl.blur();
}

export function toggle() {
  if (root.dataset.open === "1") close(); else open();
}

// ─── Wiring ──────────────────────────────────────────────────────
inputEl.addEventListener("input", () => {
  selectedIdx = 0;
  render();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key === "Enter")  { e.preventDefault(); execute(); return; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (currentItems.length) {
      selectedIdx = (selectedIdx + 1) % currentItems.length;
      updateSelection();
    }
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (currentItems.length) {
      selectedIdx = (selectedIdx - 1 + currentItems.length) % currentItems.length;
      updateSelection();
    }
    return;
  }
  if (e.key === "Tab") {
    // Cycle within palette: just move selection, keep focus in input.
    e.preventDefault();
    if (currentItems.length) {
      const dir = e.shiftKey ? -1 : 1;
      selectedIdx = (selectedIdx + dir + currentItems.length) % currentItems.length;
      updateSelection();
    }
  }
});

root.addEventListener("click", (e) => {
  if (e.target === root) close();
});

// Global key listener — ⌘+K / Ctrl+K opens.
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    toggle();
    return;
  }
  if (e.key === "Escape") {
    if (shortcutOverlay.dataset.open === "1") { closeShortcuts(); return; }
  }
  if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    e.preventDefault();
    openShortcuts();
  }
});

// Helpful default export shape for app.js wiring.
export default { open, close, toggle, registerCommand };
