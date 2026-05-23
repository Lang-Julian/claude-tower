// Tests for the approval subsystem.
//
// We spin up an isolated SQLite (file in os.tmpdir) and mount only the
// approval routes onto a router instance — no HTTP server needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  createApproval, decideApproval, getApproval, pendingApprovals,
} from "../lib/db.js";
import { mountApprovals, notifyNewApproval, broadcastNewApproval } from "../lib/approvals.js";
import { createApp } from "../lib/router.js";

// Minimal schema copy — keeps the test independent of migrate() side effects on the real DB.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_status TEXT,
  git_branch TEXT,
  version TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  decision TEXT,
  decided_at INTEGER,
  decided_by TEXT,
  reason TEXT
);
`;

function freshDb() {
  const file = path.join(os.tmpdir(), `tower-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sqlite`);
  const db = new Database(file);
  db.exec(SCHEMA);
  return { db, file };
}
function cleanup(file) {
  try { fs.unlinkSync(file); } catch {}
  try { fs.unlinkSync(file + "-wal"); } catch {}
  try { fs.unlinkSync(file + "-shm"); } catch {}
}

// In-memory request/response helpers to drive the router without a real HTTP server.
function mockReq(method, urlPath, body = null) {
  const u = new URL(urlPath, "http://localhost");
  const req = {
    method,
    url: u.pathname + u.search,
    headers: { host: "localhost" },
    _body: body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body)),
    on(event, fn) {
      if (event === "data") fn(this._body);
      if (event === "end") setImmediate(fn);
    },
    socket: { remoteAddress: "127.0.0.1" },
    destroy() {},
  };
  return req;
}
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; this.headersSent = true; },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; this._done = true; },
  };
  return res;
}
async function call(app, method, urlPath, body) {
  const req = mockReq(method, urlPath, body);
  const res = mockRes();
  await app.handle(req, res);
  // wait one tick — body events queued via setImmediate
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body: res.body, json };
}

test("approval lifecycle: create → list pending → decide → list decided", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: null });

  const id = "test-" + Date.now();
  createApproval(db, {
    id,
    sessionId: "sess-1",
    createdAt: Date.now(),
    toolName: "Bash",
    toolInput: { command: "echo hello" },
  });

  // Pending list returns it
  const list1 = await call(app, "GET", "/api/approvals");
  assert.equal(list1.status, 200);
  assert.ok(Array.isArray(list1.json), "list is array");
  const found = list1.json.find((a) => a.id === id);
  assert.ok(found, "pending approval present");
  assert.equal(found.tool_name, "Bash");
  assert.deepEqual(found.tool_input, { command: "echo hello" });
  assert.equal(found.decision, null);

  // Single get
  const one = await call(app, "GET", `/api/approvals/${id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, id);

  // Decide
  const dec = await call(app, "POST", `/api/approvals/${id}`, { decision: "approve", reason: "ok" });
  assert.equal(dec.status, 200);
  assert.equal(dec.json.ok, true);
  assert.equal(dec.json.approval.decision, "approve");
  assert.equal(dec.json.approval.decided_by, "web");
  assert.equal(dec.json.approval.reason, "ok");

  // Idempotency: second decide → 409
  const dec2 = await call(app, "POST", `/api/approvals/${id}`, { decision: "deny" });
  assert.equal(dec2.status, 409);
  assert.equal(dec2.json.error, "already_decided");
  assert.equal(dec2.json.approval.decision, "approve");

  // Decided list contains it
  const decided = await call(app, "GET", "/api/approvals?status=decided&limit=20");
  assert.equal(decided.status, 200);
  assert.ok(decided.json.some((a) => a.id === id));

  // Pending list no longer contains it
  const list2 = await call(app, "GET", "/api/approvals");
  assert.ok(!list2.json.some((a) => a.id === id));
});

test("validation: bad decision → 400", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: null });

  const id = "v-" + Date.now();
  createApproval(db, { id, sessionId: "s", createdAt: Date.now(), toolName: "Bash", toolInput: { command: "x" } });

  const bad = await call(app, "POST", `/api/approvals/${id}`, { decision: "maybe" });
  assert.equal(bad.status, 400);
});

test("not found → 404", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: null });

  const nf = await call(app, "GET", "/api/approvals/does-not-exist");
  assert.equal(nf.status, 404);

  const nf2 = await call(app, "POST", "/api/approvals/does-not-exist", { decision: "approve" });
  assert.equal(nf2.status, 404);
});

test("?status=all returns both pending + decided", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: null });

  const a = "a-" + Date.now();
  const b = "b-" + Date.now();
  createApproval(db, { id: a, sessionId: "s", createdAt: Date.now(), toolName: "Bash", toolInput: { command: "x" } });
  createApproval(db, { id: b, sessionId: "s", createdAt: Date.now() + 1, toolName: "Edit", toolInput: { file_path: "/x" } });
  decideApproval(db, b, "deny", "cli", "no");

  const all = await call(app, "GET", "/api/approvals?status=all&limit=50");
  assert.equal(all.status, 200);
  const ids = all.json.map((x) => x.id);
  assert.ok(ids.includes(a));
  assert.ok(ids.includes(b));
});

test("SSE broadcast fires on decide", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: null });

  // Hook a fake SSE client.
  const received = [];
  const fakeRes = {
    write(chunk) { received.push(chunk); },
  };
  app.addSseClient(fakeRes);

  const id = "sse-" + Date.now();
  createApproval(db, { id, sessionId: "s", createdAt: Date.now(), toolName: "Bash", toolInput: { command: "ls" } });
  await call(app, "POST", `/api/approvals/${id}`, { decision: "approve" });

  assert.ok(received.length > 0, "got SSE chunks");
  const joined = received.join("");
  assert.match(joined, /approval-decided/);
  assert.match(joined, new RegExp(id));
});

test("notifyNewApproval routes to notifier.sendApprovalRequest", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const calls = [];
  const fakeNotifier = {
    async sendApprovalRequest(a) { calls.push(a); return { ok: true }; },
  };
  const approval = {
    id: "n-1", session_id: "s", created_at: Date.now(),
    tool_name: "Bash", tool_input: { command: "ls" },
  };
  const res = await notifyNewApproval(fakeNotifier, approval, db);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "n-1");
});

test("notifyNewApproval no-ops without notifier", async () => {
  const res = await notifyNewApproval(null, { id: "x" });
  assert.equal(res.ok, false);
});

test("broadcastNewApproval triggers SSE", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: null });

  const received = [];
  app.addSseClient({ write(c) { received.push(c); } });

  broadcastNewApproval(app, {
    id: "bcast-1", session_id: "s", created_at: Date.now(),
    tool_name: "Bash", tool_input: JSON.stringify({ command: "ls" }),
    decision: null, decided_at: null, decided_by: null, reason: null,
  });

  assert.ok(received.length > 0);
  const joined = received.join("");
  assert.match(joined, /approval-pending/);
  assert.match(joined, /bcast-1/);
});

test("telegram sink binding writes 'telegram' as decided_by", async (t) => {
  const { db, file } = freshDb();
  t.after(() => { db.close(); cleanup(file); });

  let sink = null;
  const fakeNotifier = {
    bindApprovalSink(s) { sink = s; },
    pollTelegramUpdates() {},
  };
  const app = createApp({ publicDir: "/tmp" });
  mountApprovals(app, { db, notifier: fakeNotifier });

  assert.ok(sink, "sink was bound");

  const id = "tg-" + Date.now();
  createApproval(db, { id, sessionId: "s", createdAt: Date.now(), toolName: "Bash", toolInput: { command: "x" } });

  const r = sink.decide(id, "approve", null);
  assert.equal(r.changes, 1);
  const row = sink.get(id);
  assert.equal(row.decision, "approve");
  assert.equal(row.decided_by, "telegram");

  // Calling again is idempotent (changes=0)
  const r2 = sink.decide(id, "deny", null);
  assert.equal(r2.changes, 0);
});
