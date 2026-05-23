import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb, fakeSession } from "./_helper.js";
import {
  appendEvent, appendUsage,
  createApproval, decideApproval, getApproval, pendingApprovals,
} from "../lib/db.js";

test("upsert session is idempotent", () => {
  const db = freshDb();
  const s = fakeSession(db, { title: "first" });
  fakeSession(db, { ...s, title: "second", lastSeen: Date.now() + 1000 });
  const rows = db.prepare("SELECT * FROM sessions WHERE id = ?").all(s.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "second");
});

test("appendEvent stores JSON payload", () => {
  const db = freshDb();
  const s = fakeSession(db);
  appendEvent(db, { sessionId: s.id, ts: Date.now(), type: "tool_use", subtype: "Bash", payload: { cmd: "ls" } });
  const row = db.prepare("SELECT * FROM events WHERE session_id = ?").get(s.id);
  assert.equal(row.type, "tool_use");
  assert.equal(JSON.parse(row.payload).cmd, "ls");
});

test("appendUsage coerces nulls to zero", () => {
  const db = freshDb();
  const s = fakeSession(db);
  appendUsage(db, { sessionId: s.id, ts: Date.now(), model: "claude-opus-4-7", inputTokens: 100, outputTokens: 50 });
  const row = db.prepare("SELECT * FROM usage WHERE session_id = ?").get(s.id);
  assert.equal(row.cache_read_tokens, 0);
  assert.equal(row.input_tokens, 100);
});

test("approval lifecycle: create → pending → decide → not pending", () => {
  const db = freshDb();
  const s = fakeSession(db);
  createApproval(db, { id: "ap-1", sessionId: s.id, createdAt: Date.now(), toolName: "Bash", toolInput: { command: "rm -rf foo" } });

  assert.equal(pendingApprovals(db).length, 1);
  assert.equal(pendingApprovals(db, s.id).length, 1);

  const result = decideApproval(db, "ap-1", "approve", "web", "looks safe");
  assert.equal(result.changes, 1);

  assert.equal(pendingApprovals(db).length, 0);
  const row = getApproval(db, "ap-1");
  assert.equal(row.decision, "approve");
  assert.equal(row.decided_by, "web");
  assert.equal(row.reason, "looks safe");
});

test("decideApproval is idempotent — second call is a no-op", () => {
  const db = freshDb();
  const s = fakeSession(db);
  createApproval(db, { id: "ap-2", sessionId: s.id, createdAt: Date.now(), toolName: "Edit" });
  decideApproval(db, "ap-2", "approve", "web");
  const second = decideApproval(db, "ap-2", "deny", "telegram");
  assert.equal(second.changes, 0);
  assert.equal(getApproval(db, "ap-2").decision, "approve");
});
