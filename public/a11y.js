// a11y.js — small accessibility helpers.
//   • announce(text)        → polite aria-live region (throttled)
//   • announceUrgent(text)  → assertive (used very sparingly)
//   • trapFocus(el)         → focus-trap helper for modal-ish elements
//   • restoreFocus(el)      → remember + restore previous focus
//
// The skip-link and live region are injected once at boot if they aren't
// already present in the markup.

const LIVE_ID = "a11yLive";
const ALERT_ID = "a11yAlert";
const SKIP_ID = "skipLink";

function ensureLiveRegions() {
  if (!document.getElementById(LIVE_ID)) {
    const live = document.createElement("div");
    live.id = LIVE_ID;
    live.className = "sr-only";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    document.body.appendChild(live);
  }
  if (!document.getElementById(ALERT_ID)) {
    const alert = document.createElement("div");
    alert.id = ALERT_ID;
    alert.className = "sr-only";
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "assertive");
    alert.setAttribute("aria-atomic", "true");
    document.body.appendChild(alert);
  }
}

function currentMain() {
  const view = document.body.getAttribute("data-view");
  if (view === "town") return document.getElementById("town-wrap") || document.getElementById("grid");
  return document.getElementById("grid") || document.getElementById("town-wrap");
}

function ensureSkipLink() {
  let a = document.getElementById(SKIP_ID);
  if (!a) {
    a = document.createElement("a");
    a.id = SKIP_ID;
    a.className = "skip-link";
    a.textContent = "Skip to content";
    document.body.insertBefore(a, document.body.firstChild);
  }
  const sync = () => {
    const main = currentMain();
    if (main) {
      if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      a.href = `#${main.id}`;
    }
  };
  sync();
  // Re-sync on view-toggle (mutation observer on body[data-view]).
  const mo = new MutationObserver(sync);
  mo.observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
}

// ─── Announcements (throttled) ─────────────────────────────────────────────
const THROTTLE_MS = 600;
let lastAnnounce = 0;
let pending = null;
let pendingTimer = null;

function flushPending() {
  if (!pending) return;
  const el = document.getElementById(LIVE_ID);
  if (el) {
    el.textContent = "";
    // Force re-trigger by setting on next tick.
    requestAnimationFrame(() => { el.textContent = pending; });
  }
  pending = null;
  pendingTimer = null;
  lastAnnounce = Date.now();
}

export function announce(text) {
  if (!text) return;
  const now = Date.now();
  pending = String(text);
  const wait = Math.max(0, THROTTLE_MS - (now - lastAnnounce));
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPending, wait);
}

export function announceUrgent(text) {
  if (!text) return;
  const el = document.getElementById(ALERT_ID);
  if (!el) return;
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = String(text); });
}

// ─── Focus restoration ─────────────────────────────────────────────────────
const focusStack = [];

export function rememberFocus() {
  focusStack.push(document.activeElement);
}

export function restoreFocus() {
  const prev = focusStack.pop();
  if (prev && typeof prev.focus === "function" && document.contains(prev)) {
    try { prev.focus(); } catch {}
  }
}

// ─── Focus trap (modal/palette) ────────────────────────────────────────────
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapFocus(container) {
  if (!container) return () => {};
  rememberFocus();
  function focusables() {
    return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
  }
  function onKey(e) {
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  container.addEventListener("keydown", onKey);
  const first = focusables()[0];
  if (first) try { first.focus(); } catch {}
  return () => {
    container.removeEventListener("keydown", onKey);
    restoreFocus();
  };
}

// ─── Boot ──────────────────────────────────────────────────────────────────
ensureLiveRegions();
ensureSkipLink();

// Expose globally for non-module callers.
window.tower = window.tower || {};
window.tower.announce = announce;
window.tower.announceUrgent = announceUrgent;
window.tower.trapFocus = trapFocus;
