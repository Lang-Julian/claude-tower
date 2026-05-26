// Telegram notifier — pings your configured Telegram bot when a session
// transitions into a state that needs the human (needs_input /
// needs_permission), with cooldown per session to avoid spam.
//
// Approval extension: sends inline-keyboard Approve/Deny messages and
// long-polls getUpdates to capture button taps. A bound "approval sink"
// (see lib/approvals.js#mountApprovals) writes the decision back to SQLite.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SECRETS_PATH = path.join(os.homedir(), ".env.secrets");
const COOLDOWN_MS = 5 * 60 * 1000; // don't re-ping the same session more than once per 5 min
const ATTENTION_STATES = new Set(["needs_input", "needs_permission"]);

let credsCache = null;
async function loadCreds() {
  if (credsCache !== null) return credsCache;
  const fromEnv = {
    token: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
  };
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
      token: fromEnv.token || out.TELEGRAM_BOT_TOKEN || null,
      chatId: fromEnv.chatId || out.TELEGRAM_CHAT_ID || null,
    };
  } catch {
    credsCache = fromEnv;
  }
  return credsCache;
}

async function tgApi(method, payload) {
  const { token } = await loadCreds();
  if (!token) return { ok: false, reason: "no-creds" };
  try {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    return { ok: json.ok === true, raw: json };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

async function sendTelegram(text, extra = {}) {
  const { chatId } = await loadCreds();
  if (!chatId) return { ok: false, reason: "no-creds" };
  return tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode || "Markdown",
    disable_web_page_preview: true,
    ...extra,
  });
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

// HTML-escape for Telegram HTML parse mode.
function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Pretty-print a tool_input blob (JSON-parsed or string), trimmed for Telegram.
function summarizeToolInput(toolName, input) {
  if (input == null) return "";
  if (toolName === "Bash" && input.command) return truncate(String(input.command), 200);
  if ((toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") && input.file_path) {
    const body = input.new_string || input.content || input.new_source || "";
    const head = body ? ` · ${truncate(String(body).split("\n")[0], 100)}` : "";
    return `${input.file_path}${head}`;
  }
  if (toolName === "Read" && input.file_path) return String(input.file_path);
  if (typeof input === "string") return truncate(input, 200);
  try { return truncate(JSON.stringify(input), 200); } catch { return ""; }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export class Notifier {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.lastSent = new Map(); // sessionId → ts
    this.lastStatus = new Map(); // sessionId → status (for transition detection)
    this._pollUpdateId = 0;
    this._pollActive = false;
    this._sink = null; // { decide(id, decision, reason), get(id) }
    // approvalId → telegram message ids (so we can edit when decided externally)
    this._approvalMsgs = new Map();
  }

  // Called by mountApprovals(). Lets us route callback_query taps into SQLite.
  bindApprovalSink(sink) {
    this._sink = sink;
  }

  async onSnapshot(sessions) {
    if (!this.enabled) return [];
    const fired = [];
    const now = Date.now();
    for (const s of sessions) {
      const prev = this.lastStatus.get(s.id);
      this.lastStatus.set(s.id, s.status);

      if (!ATTENTION_STATES.has(s.status)) continue;
      const lastSent = this.lastSent.get(s.id) || 0;
      const transitioned = prev !== s.status;
      const cooledDown = now - lastSent > COOLDOWN_MS;
      if (!transitioned && !cooledDown) continue;
      if (prev === undefined) continue;

      const text = formatMessage(s);
      const result = await sendTelegram(text);
      this.lastSent.set(s.id, now);
      fired.push({ id: s.id, status: s.status, sent: result.ok });
    }
    return fired;
  }

  // Send an actionable approval message with inline Approve/Deny buttons.
  // callback_data encodes "av:<id>" / "dn:<id>" (44 chars cap for callback data).
  async sendApprovalRequest(approval) {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    const { token, chatId } = await loadCreds();
    if (!token || !chatId) return { ok: false, reason: "no-creds" };

    const session = approval._session_title || approval.session_id?.slice(0, 8) || "?";
    const tool = approval.tool_name || "?";
    const summary = summarizeToolInput(tool, approval.tool_input);

    const lines = [
      `🛂 <b>Permission Request</b>`,
      `<b>${esc(session)}</b> · <code>${esc(tool)}</code>`,
    ];
    if (summary) lines.push(`<code>${esc(summary)}</code>`);
    lines.push(`<i>Reply within 60s or it stays pending.</i>`);

    const res = await tgApi("sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `av:${approval.id}` },
          { text: "❌ Deny",    callback_data: `dn:${approval.id}` },
        ]],
      },
    });

    if (res.ok && res.raw?.result) {
      this._approvalMsgs.set(approval.id, {
        chat_id: res.raw.result.chat.id,
        message_id: res.raw.result.message_id,
      });
    }
    return res;
  }

  // Long-poll getUpdates and dispatch button taps. Loops forever; safe to call once on boot.
  async pollTelegramUpdates() {
    if (this._pollActive) return;
    const { token } = await loadCreds();
    if (!token) return; // no-op
    this._pollActive = true;
    this._pollAbort = new AbortController();
    // Drain pending callback_query updates without blocking the boot path.
    (async () => {
      while (this._pollActive) {
        try {
          const url = `https://api.telegram.org/bot${token}/getUpdates`
            + `?timeout=30&offset=${this._pollUpdateId + 1}&allowed_updates=${encodeURIComponent('["callback_query"]')}`;
          const res = await fetch(url, { signal: this._pollAbort.signal });
          const json = await res.json();
          if (json.ok && Array.isArray(json.result)) {
            for (const upd of json.result) {
              if (!this._pollActive) return;
              this._pollUpdateId = Math.max(this._pollUpdateId, upd.update_id);
              if (upd.callback_query) await this._handleCallback(upd.callback_query);
            }
          } else if (!json.ok) {
            await sleep(2000); // bad token / 429 / network — back off
          }
        } catch (e) {
          if (e?.name === "AbortError") return;
          console.error("[notifier] poll iteration failed:", e?.message || e);
          await sleep(2000);
        }
      }
    })().catch((e) => { console.error("notifier poll loop crashed:", e); this._pollActive = false; });
  }

  stopPolling() {
    this._pollActive = false;
    try { this._pollAbort?.abort(); } catch {}
    this._pollAbort = null;
  }

  async _handleCallback(cb) {
    const data = String(cb.data || "");
    const [kind, id] = data.split(":");
    if (!id || (kind !== "av" && kind !== "dn")) {
      await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "unbekannt" });
      return;
    }
    const decision = kind === "av" ? "approve" : "deny";

    if (!this._sink) {
      await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Tower offline" });
      return;
    }

    const result = this._sink.decide(id, decision, null);
    const current = this._sink.get(id);

    let toastText;
    if (result.changes > 0) {
      toastText = decision === "approve" ? "✅ Approved" : "❌ Denied";
    } else if (current && current.decision) {
      toastText = `bereits ${current.decision} via ${current.decided_by || "?"}`;
    } else {
      toastText = "nicht gefunden";
    }

    await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: toastText });

    // Edit the original message to reflect the resolved state and remove the inline keyboard.
    if (cb.message?.chat?.id && cb.message?.message_id && current) {
      const who = current.decided_by || "telegram";
      const verb = current.decision === "approve" ? "✅ Approved" : "❌ Denied";
      const body = (cb.message.text || "").split("\n").slice(0, -1).join("\n"); // drop "Reply within…"
      await tgApi("editMessageText", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: `${body}\n<i>${verb} via ${esc(who)}</i>`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
