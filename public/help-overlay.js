// claude-tower — help / shortcuts overlay.
//
// One overlay listing every keyboard shortcut + every palette command + how
// to install hooks + Telegram setup. Reachable via `?` and via palette.
// Esc closes. Click-outside closes. Scrollable on small viewports.

const root = document.createElement("div");
root.className = "help-backdrop";
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-labelledby", "help-title");
root.dataset.open = "0";
root.innerHTML = `
  <div class="help-card">
    <div class="help-head">
      <h2 id="help-title">Help &amp; shortcuts</h2>
      <button type="button" class="help-close" data-action="close" title="Close (Esc)" aria-label="Close help">✕</button>
    </div>
    <div class="help-body">

      <section class="help-section">
        <h3 class="help-section-title">Keyboard</h3>
        <dl class="help-list">
          <div class="help-row"><dt><kbd>⌘</kbd> <kbd>K</kbd></dt><dd>Open the command palette</dd></div>
          <div class="help-row"><dt><kbd>?</kbd></dt><dd>Show this help overlay</dd></div>
          <div class="help-row"><dt><kbd>v</kbd></dt><dd>Toggle between Town and Cards view</dd></div>
          <div class="help-row"><dt><kbd>a</kbd></dt><dd>Approve the focused pending approval</dd></div>
          <div class="help-row"><dt><kbd>d</kbd></dt><dd>Deny the focused pending approval</dd></div>
          <div class="help-row"><dt><kbd>t</kbd></dt><dd>Toggle the Telegram notifier</dd></div>
          <div class="help-row"><dt><kbd>s</kbd></dt><dd>Toggle sound chimes</dd></div>
          <div class="help-row"><dt><kbd>r</kbd></dt><dd>Hard reload the dashboard</dd></div>
          <div class="help-row"><dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>Town filters: <code>all</code> · <code>attention</code> · <code>active</code> · <code>idle</code></dd></div>
          <div class="help-row"><dt><kbd>Esc</kbd></dt><dd>Close any open overlay</dd></div>
        </dl>
      </section>

      <section class="help-section">
        <h3 class="help-section-title">Command palette (⌘K)</h3>
        <dl class="help-list">
          <div class="help-row"><dt>Switch view</dt><dd>Town ⇄ Cards</dd></div>
          <div class="help-row"><dt>Approve all</dt><dd>Bulk-approve every pending approval</dd></div>
          <div class="help-row"><dt>Deny all</dt><dd>Bulk-deny every pending approval</dd></div>
          <div class="help-row"><dt>Jump to session</dt><dd>Fuzzy-match across title, cwd, last prompt, branch — focuses the iTerm tab</dd></div>
          <div class="help-row"><dt>Open ~/.claude-tower</dt><dd>Reveal the data folder (logs, DB, port file)</dd></div>
          <div class="help-row"><dt>Copy mobile URL</dt><dd>Grab the LAN URL for your phone (paired with QR from <code>tower mobile</code>)</dd></div>
          <div class="help-row"><dt>Toggle telegram / sound</dt><dd>Same as keyboard shortcuts</dd></div>
          <div class="help-row"><dt>Show welcome</dt><dd>Re-open the first-run tour</dd></div>
        </dl>
      </section>

      <section class="help-section">
        <h3 class="help-section-title">Install hooks for sub-second updates</h3>
        <p style="margin:0 0 8px;color:var(--text-2);font-size:12.5px;line-height:1.5;">
          Polling refreshes every 2s. Hooks push events the moment Claude Code emits them.
          Run this once in your shell:
        </p>
        <div class="help-code">
          <code>tower install-hooks</code>
          <button type="button" class="copy-btn" data-copy="tower install-hooks">copy</button>
        </div>
        <p style="margin:10px 0 0;color:var(--text-3);font-size:11.5px;line-height:1.5;">
          It edits <code style="color:var(--accent-2);">~/.claude/settings.json</code>. Reversible with <code style="color:var(--accent-2);">tower uninstall-hooks</code>.
        </p>
      </section>

      <section class="help-section">
        <h3 class="help-section-title">Telegram bridge</h3>
        <p style="margin:0 0 8px;color:var(--text-2);font-size:12.5px;line-height:1.5;">
          Drop these two lines in <code style="color:var(--accent-2);">~/.env.secrets</code> (chmod 600). The notifier pings you when an agent needs you and accepts inline approve / deny.
        </p>
        <div class="help-code">
          <code>TELEGRAM_BOT_TOKEN=…
TELEGRAM_CHAT_ID=…</code>
          <button type="button" class="copy-btn" data-copy="TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=">copy</button>
        </div>
        <p style="margin:10px 0 0;color:var(--text-3);font-size:11.5px;line-height:1.5;">
          Toggle it from the HUD or with <kbd>t</kbd>. Restart tower after editing the env file.
        </p>
      </section>

    </div>
    <div class="help-foot">
      <span>Press <kbd>Esc</kbd> to close</span>
      <span>claude-tower</span>
    </div>
  </div>
`;
document.body.appendChild(root);

function open() {
  if (root.dataset.open === "1") return;
  root.dataset.open = "1";
  requestAnimationFrame(() => {
    root.querySelector(".help-close")?.focus();
  });
}

function close() {
  if (root.dataset.open === "0") return;
  root.dataset.open = "0";
}

function toggle() {
  if (root.dataset.open === "1") close(); else open();
}

// Click-outside / close button
root.addEventListener("click", (e) => {
  if (e.target === root) close();
  const t = e.target.closest("[data-action='close']");
  if (t) close();
});

// Copy buttons
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
  } catch {}
});

// Global keys
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && root.dataset.open === "1") {
    e.preventDefault();
    close();
    return;
  }
  if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    e.preventDefault();
    toggle();
  }
});

export default { open, close, toggle };
