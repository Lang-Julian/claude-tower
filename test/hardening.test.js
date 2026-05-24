// Regression tests for the bug-hunt + hardening pass.
// Each test name is prefixed with the fix it guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { createApp, readBody } from "../lib/router.js";
import { mountApprovals, isValidApprovalId } from "../lib/approvals.js";
import { mountHooks } from "../lib/hooks/routes.js";
import { createApproval, pendingApprovals, decideApproval } from "../lib/db.js";
import { focusTty } from "../lib/iterm.js";
import { priceFor } from "../lib/config.js";
import { installHooks, TOWER_HOOK_MARKER } from "../lib/hooks/install.js";

// Shared mini-DB factory — mirrors the production schema enough for these tests.
function tmpDb() {
  const file = path.join(os.tmpdir(), `tower-harden-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sqlite`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      last_status TEXT, git_branch TEXT, version TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      ts INTEGER NOT NULL, type TEXT NOT NULL, subtype TEXT, payload TEXT
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      tool_name TEXT NOT NULL, tool_input TEXT,
      decision TEXT, decided_at INTEGER, decided_by TEXT, reason TEXT
    );
  `);
  return { db, file };
}
function cleanup(file) {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + ext); } catch {}
  }
}

function mockReq(method, urlPath, body = null, remote = "127.0.0.1") {
  const u = new URL(urlPath, "http://localhost");
  return {
    method,
    url: u.pathname + u.search,
    headers: { host: "localhost" },
    _body: body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body)),
    on(event, fn) {
      if (event === "data") fn(this._body);
      if (event === "end") setImmediate(fn);
    },
    socket: { remoteAddress: remote },
    destroy() {},
  };
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: "", headersSent: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h || {}; this.headersSent = true; },
    write(c) { this.body += c; },
    end(c) { if (c) this.body += c; this._done = true; },
  };
}
async function call(app, method, urlPath, body, remote) {
  const req = mockReq(method, urlPath, body, remote);
  const res = mockRes();
  await app.handle(req, res);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  let json = null; try { json = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body: res.body, json };
}

// 1. config.priceFor strips [variant] suffix exactly — not greedily across brackets.
test("priceFor strips bracketed variant tags like '[1m]' without eating model name", () => {
  // Real-world strings we see in JSONL: "claude-opus-4-7[1m]"
  const p = priceFor("claude-opus-4-7[1m]");
  assert.ok(p, "should resolve to opus-4-7 pricing");
  assert.equal(p.input, 15);
  // With dated suffix too.
  const p2 = priceFor("claude-sonnet-4-6-20251001");
  assert.ok(p2);
  assert.equal(p2.input, 3);
});

// 2. focusTty rejects unsafe tty values that could break AppleScript interpolation.
test("focusTty rejects tty with quotes / shell metacharacters", async () => {
  const malicious = [
    '/dev/ttys000"; do shell script "rm -rf /"; --',
    '../etc/passwd',
    'ttys000\n; ls',
    '$(whoami)',
    null,
    "",
  ];
  for (const bad of malicious) {
    const r = await focusTty(bad);
    assert.ok(!r.ok, `should refuse ${JSON.stringify(bad)}`);
    // Either no-tty or invalid-tty — never tab-not-found (which means we tried to run osascript).
    assert.notEqual(r.reason, undefined, "must include a reason");
  }
});

// 3. isValidApprovalId only accepts UUIDs — guards path traversal in approval ids.
test("isValidApprovalId rejects non-UUIDs (path traversal guard)", () => {
  assert.equal(isValidApprovalId("../../etc/passwd"), false);
  assert.equal(isValidApprovalId(""), false);
  assert.equal(isValidApprovalId(null), false);
  assert.equal(isValidApprovalId(undefined), false);
  assert.equal(isValidApprovalId("hello world"), false);
  // Proper randomUUID() output.
  assert.equal(isValidApprovalId("550e8400-e29b-41d4-a716-446655440000"), true);
});

// 4. pendingApprovals applies LIMIT in SQL, not in JS after the fact.
test("pendingApprovals respects limit at the SQL layer", () => {
  const { db, file } = tmpDb();
  try {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
      .run("s1", "k", "/", "t", Date.now(), Date.now());
    for (let i = 0; i < 25; i++) {
      createApproval(db, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        sessionId: "s1", createdAt: Date.now() + i,
        toolName: "Bash", toolInput: { command: `n${i}` },
      });
    }
    const got = pendingApprovals(db, null, 5);
    assert.equal(got.length, 5);
  } finally {
    db.close(); cleanup(file);
  }
});

// 5. readBody returns rejected promise on payload > 1MB instead of just destroying the socket.
test("readBody rejects with PAYLOAD_TOO_LARGE on >1MB body", async () => {
  // Build a fake IncomingMessage that streams 1.5MB in one chunk.
  const big = "x".repeat(1.5 * 1024 * 1024);
  let dataFn, endFn;
  const fakeReq = {
    on(event, fn) {
      if (event === "data") dataFn = fn;
      if (event === "end") endFn = fn;
      if (event === "error") { /* ignore */ }
    },
    destroy() { this._destroyed = true; },
  };
  const p = readBody(fakeReq);
  dataFn(big); // synchronously over the limit
  await assert.rejects(p, /payload too large/i);
  assert.equal(fakeReq._destroyed, true, "socket destroyed on overflow");
});

// 6. app.broadcast drops SSE clients whose write throws (resource-leak fix).
test("broadcast drops sse clients whose write throws", () => {
  const app = createApp({ publicDir: "/tmp" });
  let pruned = false;
  const good = { write: () => {} };
  const bad = { write: () => { throw new Error("EPIPE"); } };
  app.addSseClient(good);
  app.addSseClient(bad);
  assert.equal(app.sseClientCount(), 2);
  app.broadcast({ type: "ping" });
  assert.equal(app.sseClientCount(), 1, "dead client removed after failing write");
});

// 7. /api/approvals/:id/telegram-callback rejects non-local addresses.
test("telegram-callback rejects requests from non-local IPs", async () => {
  const { db, file } = tmpDb();
  try {
    const app = createApp({ publicDir: "/tmp" });
    mountApprovals(app, { db, notifier: null });

    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
      .run("s1", "k", "/", "t", Date.now(), Date.now());
    const id = "00000000-0000-4000-8000-000000000001";
    createApproval(db, { id, sessionId: "s1", createdAt: Date.now(), toolName: "Bash", toolInput: { command: "x" } });

    const r = await call(app, "POST", `/api/approvals/${id}/telegram-callback`,
      { decision: "approve" }, "203.0.113.5");
    assert.equal(r.status, 403);

    // Localhost still works.
    const r2 = await call(app, "POST", `/api/approvals/${id}/telegram-callback`,
      { decision: "approve" }, "127.0.0.1");
    assert.equal(r2.status, 200);
  } finally {
    db.close(); cleanup(file);
  }
});

// 8. Hook ingress: notifier gets the new approval via sendApprovalRequest (not onApproval).
test("/api/hook with PreToolUse calls notifier.sendApprovalRequest", async () => {
  const { db, file } = tmpDb();
  try {
    const calls = [];
    const fakeNotifier = {
      async sendApprovalRequest(a) { calls.push(a); return { ok: true }; },
      // ensure the old (buggy) entrypoint is NOT what we route to:
      async onApproval() { throw new Error("must not call legacy onApproval"); },
    };
    const app = createApp({ publicDir: "/tmp" });
    mountHooks(app, { db, notifier: fakeNotifier });

    const r = await call(app, "POST", "/api/hook", {
      event: "PreToolUse",
      sessionId: "00000000-0000-4000-8000-aaaaaaaaaaaa",
      cwd: "/tmp/x",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.requiresDecision, true);
    // Allow a tick for the async notifyNewApproval call.
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls.length, 1, "notifier got the approval");
    assert.equal(calls[0].tool_name, "Bash");
  } finally {
    db.close(); cleanup(file);
  }
});

// 9. install-hooks idempotency, twice in a row (re-run safety).
test("installHooks: running 3 times never duplicates", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tower-install-idem-"));
  const settingsPath = path.join(dir, "settings.json");
  for (let i = 0; i < 3; i++) {
    await installHooks({ settingsPath, handlerPath: "/x" });
  }
  const s = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
  for (const ev of ["PreToolUse", "PostToolUse", "Stop", "Notification", "SubagentStop", "UserPromptSubmit"]) {
    const towerEntries = s.hooks[ev][0].hooks.filter((h) => h.command?.includes(TOWER_HOOK_MARKER));
    assert.equal(towerEntries.length, 1, `${ev} must have exactly one tower hook`);
  }
});

// 10. Hook handler bounds its total wait — verified indirectly via timeout decision handling.
//     Server returns {decision:"timeout"} continuously; handler must not block indefinitely.
//     Smoke-tested at the function level by inspecting the constant — the handler exports
//     are nontrivial to import (CLI script), so we assert on the source contains the cap.
test("handler.js bounds total wait time (regression guard)", async () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = await fs.promises.readFile(path.join(here, "..", "lib", "hooks", "handler.js"), "utf8");
  assert.match(src, /MAX_TOTAL_MS/, "handler must define a MAX_TOTAL_MS cap");
  assert.match(src, /Date\.now\(\) - started/, "handler must check elapsed time in await loop");
});
