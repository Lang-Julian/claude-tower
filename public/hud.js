// claude-tower — HUD live stats + scroll glow + palette button wiring.
//
// The HUD's count pills tween smoothly between snapshots (200ms).
// Stats come from the shared SSE store, no extra polling.

import { subscribe } from "/store.js";
import palette from "/palette.js";

const hudEl = document.getElementById("hud");
const countEls = {
  thinking: hudEl?.querySelector('[data-stat="thinking"]'),
  waiting:  hudEl?.querySelector('[data-stat="waiting"]'),
  permission: hudEl?.querySelector('[data-stat="permission"]'),
  idle:     hudEl?.querySelector('[data-stat="idle"]'),
};
const pillEls = {
  thinking: hudEl?.querySelector('[data-key="thinking"]'),
  waiting:  hudEl?.querySelector('[data-key="waiting"]'),
  permission: hudEl?.querySelector('[data-key="permission"]'),
  idle:     hudEl?.querySelector('[data-key="idle"]'),
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
    // ease-decel-ish
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
  let thinking = 0, waiting = 0, permission = 0, idle = 0;
  for (const s of sessions) {
    if (s.status === "thinking" || s.status === "running") thinking++;
    else if (s.status === "needs_input") waiting++;
    else if (s.status === "needs_permission") permission++;
    else if (s.status === "idle") idle++;
  }
  setStat("thinking", thinking);
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

// Wire the ⌘K button — open palette.
document.getElementById("cmdBtn")?.addEventListener("click", () => palette.open());
