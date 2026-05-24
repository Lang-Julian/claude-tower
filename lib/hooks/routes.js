// Hook ingress routes. The hook handler binary forwards every Claude Code hook
// fire here. We persist it to the event store, decide whether it needs human
// approval, and long-poll for the decision.
//
// PreToolUse is the only blocking path; everything else is fire-and-forget.

import { randomUUID } from "node:crypto";
import { readBody, sendJson } from "../router.js";
import { appendEvent, createApproval, getApproval, upsertSession } from "../db.js";
import { cwdToProjectKey } from "../sessions.js";
import { notifyNewApproval, isValidApprovalId } from "../approvals.js";

// Tools that always require explicit human approval. Hardcoded for v1; will
// move to config once the dashboard exposes per-tool toggles.
const DANGEROUS_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);

function needsApproval(toolName, toolInput) {
  if (!toolName) return false;
  if (DANGEROUS_TOOLS.has(toolName)) return true;
  if (toolName.startsWith("mcp__")) return true;
  if (toolName === "WebFetch") {
    const url = String(toolInput?.url || "");
    // Localhost fetches are safe — anything else hits the public internet.
    return !/^https?:\/\/(localhost|127\.0\.0\.1|::1)(:|\/|$)/i.test(url);
  }
  return false;
}


const POLL_INTERVAL_MS = 200;
const MAX_WAIT_MS = 60_000;

export function mountHooks(app, { db, notifier }) {
  app.route("POST", "/api/hook", async ({ req, res }) => {
    let data;
    try {
      const raw = await readBody(req);
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "invalid json" });
    }

    const {
      event,
      sessionId,
      cwd,
      transcriptPath,
      toolName,
      toolInput,
      payload,
    } = data;

    if (!event || !sessionId) {
      return sendJson(res, 400, { ok: false, error: "missing event or sessionId" });
    }

    const ts = Date.now();

    // Make sure the session row exists so the FK on events doesn't fire.
    // We may be the first to see this session (before the JSONL scanner does).
    try {
      upsertSession(db, {
        id: sessionId,
        projectKey: cwd ? cwdToProjectKey(cwd) : "unknown",
        cwd: cwd || "",
        lastSeen: ts,
        firstSeen: ts,
        status: null,
      });
    } catch (e) {
      // Race with scanner is fine; log so unexpected errors surface in --debug.
      if (process.env.TOWER_DEBUG) console.error("[hook] upsertSession", e);
    }

    appendEvent(db, {
      sessionId,
      ts,
      type: "hook",
      subtype: event,
      payload: {
        toolName: toolName ?? null,
        toolInput: toolInput ?? null,
        transcriptPath: transcriptPath ?? null,
        cwd: cwd ?? null,
        ...(payload || {}),
      },
    });

    app.broadcast({ type: "hook", event, sessionId, toolName, ts });

    if (event === "PreToolUse" && needsApproval(toolName, toolInput)) {
      const id = randomUUID();
      createApproval(db, {
        id,
        sessionId,
        createdAt: ts,
        toolName,
        toolInput,
      });
      const approval = getApproval(db, id);
      app.broadcast({ type: "approval-pending", approval });
      // Notify via Telegram fire-and-forget — never block the hook response on
      // a slow Telegram API (the hook handler's POST timeout is only 3s).
      Promise.resolve(notifyNewApproval(notifier, approval, db))
        .catch((e) => console.error("[hook] notifyNewApproval", e));
      return sendJson(res, 200, { ok: true, approvalId: id, requiresDecision: true });
    }

    sendJson(res, 200, { ok: true, requiresDecision: false });
  });

  app.route("GET", "/api/hook/await/:approvalId", async ({ req, res, params }) => {
    const id = params.approvalId;
    if (!isValidApprovalId(id)) {
      return sendJson(res, 400, { decision: "deny", reason: "invalid approval id" });
    }
    const start = Date.now();
    let aborted = false;
    req.on("close", () => { aborted = true; });

    while (Date.now() - start < MAX_WAIT_MS) {
      if (aborted) return; // client disconnected, drop quietly
      const row = getApproval(db, id);
      if (!row) return sendJson(res, 404, { decision: "deny", reason: "approval not found" });
      if (row.decision) {
        return sendJson(res, 200, {
          decision: row.decision,
          reason: row.reason || null,
          decidedBy: row.decided_by || null,
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (aborted) return;
    sendJson(res, 200, { decision: "timeout", reason: "no decision within 60s" });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
