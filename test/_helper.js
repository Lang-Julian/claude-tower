// Shared test fixtures: tmp DB, mock JSONL, fake claude session row.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { upsertSession } from "../lib/db.js";

export async function tmpDir(prefix = "tower-test-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

// Returns a fresh DB with the schema applied, but isolated from ~/.claude-tower.
export function freshDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Inline the v1 migration so we don't import lib/db.js's singleton.
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      last_status TEXT, git_branch TEXT, version TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      ts INTEGER NOT NULL, type TEXT NOT NULL, subtype TEXT, payload TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      ts INTEGER NOT NULL, model TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      tool_name TEXT NOT NULL, tool_input TEXT,
      decision TEXT, decided_at INTEGER, decided_by TEXT, reason TEXT
    );
  `);
  db.pragma("user_version = 1");
  return db;
}

export function fakeSession(db, overrides = {}) {
  const s = {
    id: "test-session-" + Math.random().toString(36).slice(2, 10),
    projectKey: "-tmp-test",
    cwd: "/tmp/test",
    title: "test session",
    firstSeen: Date.now() - 10_000,
    lastSeen: Date.now(),
    status: "idle",
    gitBranch: "main",
    version: "test",
    ...overrides,
  };
  upsertSession(db, s);
  return s;
}

export async function writeJsonl(dir, name, events) {
  const file = path.join(dir, name);
  await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}
