// SQLite event store. Append-only events table is the source of truth;
// sessions/usage tables are derived projections that can be rebuilt at any time.
//
// Why SQLite (and not just JSONL like Claude Code itself):
//   - cross-session queries are O(index lookup) not O(scan every file)
//   - approval queue needs ACID semantics
//   - historic sessions stay queryable after their .jsonl is rotated away
//
// Schema is versioned and idempotent — boot calls migrate() unconditionally.

import Database from "better-sqlite3";
import { DB_PATH, ensureTowerDir } from "./paths.js";

let _db = null;

export async function getDb() {
  if (_db) return _db;
  await ensureTowerDir();
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

const MIGRATIONS = [
  // v1 — base schema
  `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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
  CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen DESC);

  -- Append-only event log. Source of truth.
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,           -- 'tool_use' | 'tool_result' | 'user' | 'assistant' | 'hook' | 'status' | 'usage'
    subtype TEXT,                 -- tool name, hook event, status name
    payload TEXT,                 -- JSON
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts DESC);

  -- Per-message token usage (extracted from assistant events with usage field)
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_usage_session_ts ON usage(session_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts DESC);

  -- Permission approval queue. Hook blocks until decision is written.
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,          -- correlation id, also filename in queue dir
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    tool_input TEXT,              -- JSON
    decision TEXT,                -- 'approve' | 'deny' | NULL (pending)
    decided_at INTEGER,
    decided_by TEXT,              -- 'web' | 'telegram' | 'cli' | 'auto'
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(decision, created_at) WHERE decision IS NULL;
  CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at DESC);
  `,
  // v2 — dedup index for the usage projection. scanProject can re-insert
  // the same assistant message multiple times across runs; with this index
  // INSERT OR IGNORE makes the sync idempotent.
  `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedup ON usage(session_id, ts, model);
  `,
  // v3 — index for the prune sweep that drops old decided approvals. The
  // `decided_at` partial index makes `WHERE decision IS NOT NULL AND
  // decided_at < ?` an indexed range scan instead of a full table scan.
  `
  CREATE INDEX IF NOT EXISTS idx_approvals_decided_at
    ON approvals(decided_at) WHERE decision IS NOT NULL;
  `,
];

function migrate(db) {
  const current = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${i + 1}`);
  }
}

// --- Insertion helpers (used by hooks + session-scanner) ---

export function upsertSession(db, s) {
  db.prepare(`
    INSERT INTO sessions (id, project_key, cwd, title, first_seen, last_seen, last_status, git_branch, version)
    VALUES (@id, @projectKey, @cwd, @title, @firstSeen, @lastSeen, @lastStatus, @gitBranch, @version)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = excluded.last_seen,
      title = COALESCE(excluded.title, sessions.title),
      last_status = excluded.last_status,
      git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
      version = COALESCE(excluded.version, sessions.version)
  `).run({
    id: s.id,
    projectKey: s.projectKey,
    cwd: s.cwd,
    title: s.title ?? null,
    firstSeen: s.firstSeen ?? s.lastSeen,
    lastSeen: s.lastSeen,
    lastStatus: s.status ?? null,
    gitBranch: s.gitBranch ?? null,
    version: s.version ?? null,
  });
}

export function appendEvent(db, e) {
  db.prepare(`
    INSERT INTO events (session_id, ts, type, subtype, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(e.sessionId, e.ts, e.type, e.subtype ?? null, e.payload ? JSON.stringify(e.payload) : null);
}

export function appendUsage(db, u) {
  db.prepare(`
    INSERT INTO usage (session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    u.sessionId, u.ts, u.model ?? null,
    u.inputTokens | 0, u.outputTokens | 0,
    u.cacheReadTokens | 0, u.cacheCreationTokens | 0,
    Number(u.costUsd || 0),
  );
}

// --- Approval queue ---

export function createApproval(db, a) {
  db.prepare(`
    INSERT INTO approvals (id, session_id, created_at, tool_name, tool_input)
    VALUES (?, ?, ?, ?, ?)
  `).run(a.id, a.sessionId, a.createdAt, a.toolName, a.toolInput ? JSON.stringify(a.toolInput) : null);
}

export function decideApproval(db, id, decision, decidedBy, reason = null) {
  return db.prepare(`
    UPDATE approvals
    SET decision = ?, decided_at = ?, decided_by = ?, reason = ?
    WHERE id = ? AND decision IS NULL
  `).run(decision, Date.now(), decidedBy, reason, id);
}

export function getApproval(db, id) {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
}

// Drop decided approvals older than `keepMs`. Pending rows are never pruned
// — they may still be awaiting a human. Returns the number of rows removed.
export function pruneApprovals(db, keepMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - keepMs;
  const res = db.prepare(
    "DELETE FROM approvals WHERE decision IS NOT NULL AND decided_at < ?"
  ).run(cutoff);
  return res.changes;
}

export function pendingApprovals(db, sessionId = null, limit = null) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : -1;
  if (sessionId) {
    return db.prepare(
      "SELECT * FROM approvals WHERE decision IS NULL AND session_id = ? ORDER BY created_at LIMIT ?"
    ).all(sessionId, cap);
  }
  return db.prepare(
    "SELECT * FROM approvals WHERE decision IS NULL ORDER BY created_at LIMIT ?"
  ).all(cap);
}
