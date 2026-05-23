// Telegram notifier — pings Branestormbot when a session transitions into a
// state that needs the human (needs_input / needs_permission), with cooldown
// per session to avoid spam.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SECRETS_PATH = path.join(os.homedir(), ".env.secrets");
const COOLDOWN_MS = 5 * 60 * 1000; // don't re-ping the same session more than once per 5 min
const ATTENTION_STATES = new Set(["needs_input", "needs_permission"]);

let credsCache = null;
async function loadCreds() {
  if (credsCache !== null) return credsCache;
  try {
    const text = await fs.readFile(SECRETS_PATH, "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
    credsCache = {
      token: out.TELEGRAM_BOT_TOKEN || null,
      chatId: out.TELEGRAM_CHAT_ID || null,
    };
  } catch {
    credsCache = { token: null, chatId: null };
  }
  return credsCache;
}

async function sendTelegram(text) {
  const { token, chatId } = await loadCreds();
  if (!token || !chatId) return { ok: false, reason: "no-creds" };
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    const json = await res.json();
    return { ok: json.ok === true, raw: json };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

function emojiForStatus(s) {
  switch (s) {
    case "needs_input": return "👤";
    case "needs_permission": return "🛂";
    case "thinking": return "🧠";
    case "running": return "▶️";
    case "idle": return "💤";
    case "stopped": return "⏹";
    case "archived": return "🗄";
    default: return "•";
  }
}

function formatMessage(session) {
  const icon = emojiForStatus(session.status);
  const titleLine = session.title ? `*${session.title}*` : `_${session.id.slice(0, 8)}_`;
  const projectLine = `\`${session.project}\``;
  const reason = session.status === "needs_permission"
    ? "wartet auf Permission / Tool-Antwort"
    : "wartet auf deinen Input";
  const prompt = session.lastPrompt
    ? "\n\n> " + session.lastPrompt.slice(0, 240).replace(/\n+/g, " ⏎ ")
    : "";
  return `${icon} *Claude braucht dich*\n${titleLine}\n${projectLine} — ${reason}${prompt}`;
}

export class Notifier {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.lastSent = new Map(); // sessionId → ts
    this.lastStatus = new Map(); // sessionId → status (for transition detection)
  }

  async onSnapshot(sessions) {
    if (!this.enabled) return [];
    const fired = [];
    const now = Date.now();
    for (const s of sessions) {
      const prev = this.lastStatus.get(s.id);
      this.lastStatus.set(s.id, s.status);

      if (!ATTENTION_STATES.has(s.status)) continue;
      // Only fire on transition INTO an attention state OR after cooldown.
      const lastSent = this.lastSent.get(s.id) || 0;
      const transitioned = prev !== s.status;
      const cooledDown = now - lastSent > COOLDOWN_MS;
      if (!transitioned && !cooledDown) continue;
      // Avoid firing immediately on the very first scan — wait until we've seen
      // the previous state at least once.
      if (prev === undefined) continue;

      const text = formatMessage(s);
      const result = await sendTelegram(text);
      this.lastSent.set(s.id, now);
      fired.push({ id: s.id, status: s.status, sent: result.ok });
    }
    return fired;
  }
}
