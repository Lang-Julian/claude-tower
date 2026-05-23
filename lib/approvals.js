// Approval subsystem — the killer feature.
//
// When Claude Code wants permission for a sensitive tool, the hooks subsystem
// creates an approval row (decision=NULL). The user decides via:
//   1. Web dashboard card buttons → POST /api/approvals/:id
//   2. Telegram inline buttons    → Notifier.pollTelegramUpdates() → same DB write
//   3. CLI (future)                → tower decide ...
//
// All paths converge on db.decideApproval() which is idempotent (UPDATE ... WHERE decision IS NULL).
// On every decision we broadcast SSE `approval-decided` so the hooks handler
// (which polls every 200ms) and all open dashboards see the result.

import { createApproval, decideApproval, getApproval, pendingApprovals } from "./db.js";
import { sendJson, readJson } from "./router.js";

// Hydrate a raw DB row into something safe for the wire.
function hydrate(row) {
  if (!row) return null;
  let parsedInput = null;
  if (row.tool_input) {
    try { parsedInput = JSON.parse(row.tool_input); } catch { parsedInput = row.tool_input; }
  }
  return {
    id: row.id,
    session_id: row.session_id,
    created_at: row.created_at,
    tool_name: row.tool_name,
    tool_input: parsedInput,
    decision: row.decision,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    reason: row.reason,
  };
}

function listDecided(db, limit) {
  return db.prepare(
    "SELECT * FROM approvals WHERE decision IS NOT NULL ORDER BY decided_at DESC LIMIT ?"
  ).all(limit);
}

function listAll(db, limit) {
  return db.prepare(
    "SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
}

function sessionTitle(db, sessionId) {
  try {
    const row = db.prepare("SELECT title, cwd FROM sessions WHERE id = ?").get(sessionId);
    if (!row) return sessionId.slice(0, 8);
    return row.title || (row.cwd ? row.cwd.split("/").pop() : sessionId.slice(0, 8));
  } catch {
    return sessionId.slice(0, 8);
  }
}

// Exported so the hooks subsystem can call us after createApproval().
export async function notifyNewApproval(notifier, approval, db = null) {
  if (!notifier) return { ok: false, reason: "no-notifier" };
  if (typeof notifier.sendApprovalRequest !== "function") return { ok: false, reason: "no-handler" };
  let enriched = approval;
  if (db && approval?.session_id) {
    enriched = { ...approval, _session_title: sessionTitle(db, approval.session_id) };
  }
  try {
    return await notifier.sendApprovalRequest(enriched);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export function mountApprovals(app, { db, notifier }) {
  // Wire the notifier to the same DB so its Telegram callback handler can write decisions.
  if (notifier && typeof notifier.bindApprovalSink === "function") {
    notifier.bindApprovalSink({
      decide: (id, decision, reason) => {
        const result = decideApproval(db, id, decision, "telegram", reason ?? null);
        if (result.changes > 0) {
          app.broadcast({ type: "approval-decided", id, decision, by: "telegram" });
        }
        return result;
      },
      get: (id) => hydrate(getApproval(db, id)),
    });
    // Start long-poll loop (no-op if no token).
    if (typeof notifier.pollTelegramUpdates === "function") {
      notifier.pollTelegramUpdates();
    }
  }

  // GET /api/approvals?status=pending|decided|all&limit=50
  app.route("GET", "/api/approvals", ({ res, url }) => {
    const status = (url.searchParams.get("status") || "pending").toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)));
    let rows;
    if (status === "decided") rows = listDecided(db, limit);
    else if (status === "all") rows = listAll(db, limit);
    else rows = pendingApprovals(db).slice(0, limit);
    sendJson(res, 200, rows.map(hydrate));
  });

  // GET /api/approvals/:id
  app.route("GET", "/api/approvals/:id", ({ res, params }) => {
    const row = getApproval(db, params.id);
    if (!row) return sendJson(res, 404, { ok: false, error: "not_found" });
    sendJson(res, 200, hydrate(row));
  });

  // POST /api/approvals/:id  {decision, reason?}
  app.route("POST", "/api/approvals/:id", async ({ req, res, params }) => {
    let body;
    try { body = await readJson(req); }
    catch { return sendJson(res, 400, { ok: false, error: "bad_json" }); }

    const decision = String(body.decision || "").toLowerCase();
    if (decision !== "approve" && decision !== "deny") {
      return sendJson(res, 400, { ok: false, error: "decision must be approve|deny" });
    }
    const reason = body.reason ? String(body.reason).slice(0, 500) : null;

    const existing = getApproval(db, params.id);
    if (!existing) return sendJson(res, 404, { ok: false, error: "not_found" });

    const result = decideApproval(db, params.id, decision, "web", reason);
    if (result.changes === 0) {
      // Already decided → 409 with current state
      return sendJson(res, 409, {
        ok: false,
        error: "already_decided",
        approval: hydrate(getApproval(db, params.id)),
      });
    }

    const updated = hydrate(getApproval(db, params.id));
    app.broadcast({ type: "approval-decided", id: params.id, decision, by: "web" });
    sendJson(res, 200, { ok: true, approval: updated });
  });

  // POST /api/approvals/:id/telegram-callback — internal use by Notifier
  // (Kept for symmetry / future external webhook setup.)
  app.route("POST", "/api/approvals/:id/telegram-callback", async ({ req, res, params }) => {
    let body;
    try { body = await readJson(req); }
    catch { return sendJson(res, 400, { ok: false, error: "bad_json" }); }
    const decision = String(body.decision || "").toLowerCase();
    if (decision !== "approve" && decision !== "deny") {
      return sendJson(res, 400, { ok: false, error: "decision must be approve|deny" });
    }
    const result = decideApproval(db, params.id, decision, "telegram", body.reason ?? null);
    if (result.changes === 0) {
      return sendJson(res, 409, {
        ok: false,
        error: "already_decided",
        approval: hydrate(getApproval(db, params.id)),
      });
    }
    app.broadcast({ type: "approval-decided", id: params.id, decision, by: "telegram" });
    sendJson(res, 200, { ok: true, approval: hydrate(getApproval(db, params.id)) });
  });
}

// Re-export for convenience so hook handlers can `import { createApproval, broadcastNewApproval } from "./approvals.js"`.
export { createApproval };

// Helper to broadcast a freshly created approval (called by the hooks subsystem).
export function broadcastNewApproval(app, approval) {
  if (!app || typeof app.broadcast !== "function") return;
  app.broadcast({ type: "approval-pending", approval: hydrate(approval) });
}
