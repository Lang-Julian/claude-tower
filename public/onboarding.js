// claude-tower — first-run onboarding overlay.
//
// Shows ONCE per browser (gated by localStorage `tower:visited`). Renders
// after the first SSE snapshot lands so the page isn't empty behind it.
// Esc, click-outside, or "Got it" dismiss + persist the flag.

import { subscribe } from "/store.js";

const VISITED_KEY = "tower:visited";

function hasVisited() {
  try { return localStorage.getItem(VISITED_KEY) === "1"; } catch { return true; }
}
function markVisited() {
  try { localStorage.setItem(VISITED_KEY, "1"); } catch {}
}

// Build the overlay DOM once. Hidden until we decide to show it.
const root = document.createElement("div");
root.className = "onb-backdrop";
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-labelledby", "onb-title");
root.dataset.open = "0";
root.innerHTML = `
  <div class="onb-card glass-strong" tabindex="-1">
    <div class="onb-mark">claude-tower</div>
    <h2 id="onb-title" class="onb-title">Welcome aboard.</h2>
    <p class="onb-sub">Air-traffic control for every Claude Code session you run. Here's the 30-second tour.</p>

    <ul class="onb-list">
      <li>
        <span class="onb-ico">⌁</span>
        <div><b>Live status, no refresh.</b> <span>Each session shows up the moment <code>claude</code> starts. Thinking, waiting, permission — all surfaced up top.</span></div>
      </li>
      <li>
        <span class="onb-ico">✓</span>
        <div><b>Approve from the card.</b> <span>When an agent asks for permission, hit <kbd>a</kbd> / <kbd>d</kbd> right here. No terminal switch.</span></div>
      </li>
      <li>
        <span class="onb-ico">⌘</span>
        <div><b>Press ⌘K to fly.</b> <span>The command palette jumps you to any session, bulk-approves, toggles views — everything keyboard-first.</span></div>
      </li>
      <li>
        <span class="onb-ico">📱</span>
        <div><b>Mobile in 10 seconds.</b> <span>Start with <code>tower start --mobile</code> for a QR + token. Approve from your phone over LAN or Tailscale.</span></div>
      </li>
    </ul>

    <div class="onb-cta">
      <button type="button" class="onb-btn" data-action="dismiss">Got it</button>
      <button type="button" class="onb-link" data-action="hooks">Install hooks for real-time →</button>
    </div>

    <div class="onb-hooks" data-section="hooks" hidden>
      <p class="onb-sub" style="margin-top:18px;">Hooks push events sub-second instead of polling every 2s. One-time install — run this in your shell:</p>
      <div class="onb-code">
        <code>tower install-hooks</code>
        <button type="button" class="copy-btn" data-copy="tower install-hooks">copy</button>
      </div>
      <p class="onb-sub" style="margin-top:14px; font-size:12px;">It edits <code>~/.claude/settings.json</code> and registers SessionStart / Stop / PreToolUse handlers. Reversible with <code>tower uninstall-hooks</code>.</p>
    </div>
  </div>
`;

document.body.appendChild(root);

const cardEl = root.querySelector(".onb-card");
const hooksSection = root.querySelector("[data-section='hooks']");

function open() {
  if (root.dataset.open === "1") return;
  root.dataset.open = "1";
  // Focus the dismiss button so Tab moves through CTAs naturally.
  requestAnimationFrame(() => {
    root.querySelector("[data-action='dismiss']")?.focus();
  });
}

function close() {
  if (root.dataset.open === "0") return;
  root.dataset.open = "0";
  markVisited();
}

// Click-outside dismiss
root.addEventListener("click", (e) => {
  if (e.target === root) close();
});

// CTA wiring
root.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  if (t.dataset.action === "dismiss") close();
  if (t.dataset.action === "hooks") {
    if (hooksSection) hooksSection.hidden = !hooksSection.hidden;
  }
});

// Copy button (delegated)
root.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const text = btn.dataset.copy;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.dataset.copied = "1";
    btn.textContent = "copied";
    setTimeout(() => { btn.dataset.copied = "0"; btn.textContent = "copy"; }, 1400);
  } catch {
    // ignore — clipboard can be blocked
  }
});

// Esc closes
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && root.dataset.open === "1") {
    e.preventDefault();
    close();
  }
});

// Show after the first snapshot lands — but only for new visitors.
if (!hasVisited()) {
  let shown = false;
  const unsub = subscribe(() => {
    if (shown) return;
    shown = true;
    // Tiny delay so the cards/town render first; feels less abrupt.
    setTimeout(open, 350);
    unsub();
  });
  // Safety net: if no snapshot in 4s (server slow / dev), show anyway.
  setTimeout(() => { if (!shown) { shown = true; open(); } }, 4000);
}

// Allow palette / help overlay to re-open it on demand.
export default { open, close };
