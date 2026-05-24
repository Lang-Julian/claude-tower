// claude-tower — HUD live stats + scroll glow + palette/help/plan wiring.
//
// The HUD's count pills tween smoothly between snapshots (200ms).
// Stats come from the shared SSE store, no extra polling.

import { subscribe } from "/store.js";
import palette from "/palette.js";
import help from "/help-overlay.js";

const hudEl = document.getElementById("hud");
const countEls = {
  thinking:   hudEl?.querySelector('[data-stat="thinking"]'),
  active:     hudEl?.querySelector('[data-stat="active"]'),
  waiting:    hudEl?.querySelector('[data-stat="waiting"]'),
  permission: hudEl?.querySelector('[data-stat="permission"]'),
  idle:       hudEl?.querySelector('[data-stat="idle"]'),
};
const pillEls = {
  thinking:   hudEl?.querySelector('[data-key="thinking"]'),
  active:     hudEl?.querySelector('[data-key="active"]'),
  waiting:    hudEl?.querySelector('[data-key="waiting"]'),
  permission: hudEl?.querySelector('[data-key="permission"]'),
  idle:       hudEl?.querySelector('[data-key="idle"]'),
};
const updatedEl = document.getElementById("updated");

// Number tween — short, decel, no jank.
function tweenNumber(el, to, dur = 200) {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (from === to) return;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = Math.round(from + (to - from) * eased);
    el.textContent = String(v);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setStat(key, count) {
  tweenNumber(countEls[key], count);
  const pill = pillEls[key];
  if (pill) pill.dataset.count = String(count);
}

subscribe((snapshot) => {
  const sessions = snapshot.sessions || [];
  // Separate thinking (reasoning) from running (executing tools). Both are
  // "active" mentally but visually telling them apart matters: if everything
  // sits at "thinking" you're paying for tokens; if "active" you're shipping.
  let thinking = 0, active = 0, waiting = 0, permission = 0, idle = 0;
  for (const s of sessions) {
    if (s.status === "thinking") thinking++;
    else if (s.status === "running") active++;
    else if (s.status === "needs_input") waiting++;
    else if (s.status === "needs_permission") permission++;
    else if (s.status === "idle") idle++;
  }
  setStat("thinking", thinking);
  setStat("active", active);
  setStat("waiting", waiting);
  setStat("permission", permission);
  setStat("idle", idle);

  if (updatedEl) {
    const ts = new Date(snapshot.generatedAt || Date.now());
    updatedEl.textContent = ts.toLocaleTimeString();
  }
});

// Scroll glow — show a stronger border once the page has scrolled past 0.
let raf = 0;
function updateScroll() {
  if (!hudEl) return;
  const scrolled = window.scrollY > 4 ? "1" : "0";
  if (hudEl.dataset.scrolled !== scrolled) hudEl.dataset.scrolled = scrolled;
  raf = 0;
}
window.addEventListener("scroll", () => {
  if (!raf) raf = requestAnimationFrame(updateScroll);
}, { passive: true });
updateScroll();

// ─── Plan pill — MAX (tokens) vs API (USD) ───────────────────────
// Default is tokens (MAX/Pro). Toggling writes `tower:show-usd` and reloads
// so usage.js picks up the flag from its boot-time read.
const planBtn = document.getElementById("planPill");
function readShowUsd() {
  try { return localStorage.getItem("tower:show-usd") === "1"; } catch { return false; }
}
function paintPlan() {
  if (!planBtn) return;
  const usd = readShowUsd();
  const valueEl = planBtn.querySelector(".hud-plan-value");
  valueEl.textContent = usd ? "API" : "MAX";
  valueEl.dataset.value = usd ? "api" : "max";
  planBtn.setAttribute("aria-pressed", usd ? "true" : "false");
  planBtn.title = usd
    ? "Plan: USD shown (API). Click to switch to tokens (Max/Pro)."
    : "Plan: tokens shown (Max/Pro). Click to switch to USD (API plan).";
}
paintPlan();
planBtn?.addEventListener("click", () => {
  const next = !readShowUsd();
  try { localStorage.setItem("tower:show-usd", next ? "1" : "0"); } catch {}
  paintPlan();
  // Notify usage.js (cost-pill rebuild) without a hard reload.
  window.dispatchEvent(new CustomEvent("tower:show-usd-changed", { detail: { showUsd: next } }));
});

// Wire the ⌘K button + the help button.
document.getElementById("cmdBtn")?.addEventListener("click", () => palette.open());
document.getElementById("helpBtn")?.addEventListener("click", () => help.open());
