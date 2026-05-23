// Centralized localStorage wrapper with one-shot migration from the old
// "claude-control-*" key namespace. Keeps user settings (view, sound, filter)
// across the 0.1.0 rename.

const PREFIX = "tower:";
const LEGACY_PREFIX = "claude-control-";
const MIGRATION_KEY = "tower:migrated-from-claude-control";

function migrate() {
  try {
    if (localStorage.getItem(MIGRATION_KEY)) return;
    const moved = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
      const newKey = PREFIX + key.slice(LEGACY_PREFIX.length);
      if (!localStorage.getItem(newKey)) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
      moved.push(key);
    }
    for (const key of moved) localStorage.removeItem(key);
    localStorage.setItem(MIGRATION_KEY, "1");
  } catch { /* private browsing etc — ignore */ }
}

migrate();

export function read(key, fallback = null) {
  try { return localStorage.getItem(PREFIX + key) ?? fallback; } catch { return fallback; }
}

export function write(key, value) {
  try { localStorage.setItem(PREFIX + key, value); } catch {}
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch {}
}
