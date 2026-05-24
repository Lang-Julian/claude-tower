// toast.js — minimal toast system. No deps, <100 LOC.
// Usage: import { toast } from "/toast.js"; toast("Saved", { type: "success" });
// Or via global: window.tower.toast("...").
// Click toast to copy its text. Auto-dismiss after `duration` ms. Max 3 visible.

const MAX_VISIBLE = 3;
const DEFAULTS = { type: "info", duration: 4000 };

let stackEl = null;
const live = new Set();

function ensureStack() {
  if (stackEl) return stackEl;
  stackEl = document.createElement("div");
  stackEl.id = "toastStack";
  stackEl.className = "toast-stack";
  stackEl.setAttribute("role", "region");
  stackEl.setAttribute("aria-label", "Notifications");
  document.body.appendChild(stackEl);
  return stackEl;
}

export function toast(message, opts = {}) {
  if (!message) return () => {};
  const { type, duration } = { ...DEFAULTS, ...opts };
  ensureStack();

  // Cap visible toasts: pop oldest if over the limit.
  while (live.size >= MAX_VISIBLE) {
    const oldest = live.values().next().value;
    if (oldest) dismiss(oldest, true);
    else break;
  }

  const el = document.createElement("button");
  el.type = "button";
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  el.title = "Click to copy";

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = type === "error" ? "✕" : type === "success" ? "✓" : type === "warn" ? "!" : "i";
  icon.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = String(message);

  el.append(icon, text);
  el.addEventListener("click", () => copyText(String(message), el));

  stackEl.appendChild(el);
  live.add(el);

  // Optional sound hook (HUD agent's sounds.js).
  if (type === "error") { try { window.tower?.play?.("error"); } catch {} }

  // Reveal next frame for transition.
  requestAnimationFrame(() => el.classList.add("toast-show"));

  let timer = null;
  if (duration > 0) timer = setTimeout(() => dismiss(el), duration);

  el._dismiss = () => { if (timer) clearTimeout(timer); dismiss(el); };
  return el._dismiss;
}

function dismiss(el, immediate = false) {
  if (!el || !live.has(el)) return;
  live.delete(el);
  if (immediate) { el.remove(); return; }
  el.classList.remove("toast-show");
  el.classList.add("toast-hide");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  // Hard fallback if transitionend doesn't fire.
  setTimeout(() => el.remove(), 400);
}

async function copyText(s, el) {
  try {
    await navigator.clipboard.writeText(s);
    el.classList.add("toast-copied");
    setTimeout(() => el.classList.remove("toast-copied"), 800);
  } catch { /* ignore */ }
}

// Expose globally for non-module callers and convenience.
window.tower = window.tower || {};
window.tower.toast = toast;
