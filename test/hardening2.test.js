// Regression tests for the second-pass bug-hunt. Each test name flags the
// fix it guards. Keep this file additive — never delete a guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { createApp } from "../lib/router.js";
import { mountHooks } from "../lib/hooks/routes.js";
import { mountUsage } from "../lib/usage.js";
import { createApproval, decideApproval, pruneApprovals } from "../lib/db.js";
import { installHooks, TOWER_HOOK_MARKER } from "../lib/hooks/install.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

// ─── tiny mini-DB helpers (kept inline; mirrors test/hardening.test.js) ──

function tmpDb() {
  const file = path.join(os.tmpdir(), `tower-h2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.sqlite`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      last_status TEXT, git_branch TEXT, version TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      ts INTEGER NOT NULL, type TEXT NOT NULL, subtype TEXT, payload TEXT
    );
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      ts INTEGER NOT NULL, model TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_usage_dedup ON usage(session_id, ts, model);
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
    method, url: u.pathname + u.search, headers: { host: "localhost" },
    _body: body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body)),
    on(event, fn) {
      if (event === "data") fn(this._body);
      if (event === "end") setImmediate(fn);
    },
    socket: { remoteAddress: remote }, destroy() {},
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

// ─── 1. /api/hook rejects unknown event types with 400 ─────────────────

test("/api/hook rejects unknown event types with 400", async (t) => {
  const { db, file } = tmpDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountHooks(app, { db, notifier: null });

  const bad = await call(app, "POST", "/api/hook", {
    event: "FakeEvent", sessionId: "s1", cwd: "/tmp",
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.json), /unknown event/i);

  // Every legitimate Claude Code event still passes.
  for (const ev of [
    "PreToolUse", "PostToolUse", "Stop", "Notification",
    "UserPromptSubmit", "SubagentStop", "SessionStart",
  ]) {
    const ok = await call(app, "POST", "/api/hook", {
      event: ev, sessionId: "s1", cwd: "/tmp",
    });
    assert.equal(ok.status, 200, `event ${ev} should be accepted`);
  }
});

// ─── 2. /api/usage exposes both burnRateUsdPerHour + recentTokensPerHour ─

test("/api/usage returns both burn rate fields (no NaN on empty)", async (t) => {
  const { db, file } = tmpDb();
  t.after(() => { db.close(); cleanup(file); });

  const app = createApp({ publicDir: "/tmp" });
  mountUsage(app, { db });

  const r = await call(app, "GET", "/api/usage");
  assert.equal(r.status, 200);
  // Numeric fields must be real numbers, not NaN — even with zero rows.
  assert.equal(typeof r.json.burnRateUsdPerHour, "number");
  assert.equal(typeof r.json.recentTokensPerHour, "number");
  assert.ok(!Number.isNaN(r.json.burnRateUsdPerHour));
  assert.ok(!Number.isNaN(r.json.recentTokensPerHour));
  assert.equal(r.json.burnRateUsdPerHour, 0);
  assert.equal(r.json.recentTokensPerHour, 0);
  assert.equal(r.json.totalCostUsd, 0);
  assert.equal(r.json.totalTokens, 0);
  assert.equal(r.json.currentBlock, null);
});

// ─── 3. pruneApprovals drops decided rows older than the cutoff ────────

test("pruneApprovals removes only decided rows older than keepMs", () => {
  const { db, file } = tmpDb();
  try {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
      .run("s1", "k", "/", "t", Date.now(), Date.now());

    const now = Date.now();
    // pending — must survive
    createApproval(db, { id: "00000000-0000-4000-8000-000000000001",
      sessionId: "s1", createdAt: now - 90 * 24 * 60 * 60 * 1000,
      toolName: "Bash", toolInput: { command: "x" } });
    // decided old — must be pruned
    createApproval(db, { id: "00000000-0000-4000-8000-000000000002",
      sessionId: "s1", createdAt: now - 90 * 24 * 60 * 60 * 1000,
      toolName: "Bash", toolInput: { command: "x" } });
    decideApproval(db, "00000000-0000-4000-8000-000000000002", "approve", "cli");
    // Force decided_at into the past.
    db.prepare("UPDATE approvals SET decided_at = ? WHERE id = ?")
      .run(now - 60 * 24 * 60 * 60 * 1000, "00000000-0000-4000-8000-000000000002");
    // decided recent — must survive (< 30d)
    createApproval(db, { id: "00000000-0000-4000-8000-000000000003",
      sessionId: "s1", createdAt: now - 1000,
      toolName: "Bash", toolInput: { command: "x" } });
    decideApproval(db, "00000000-0000-4000-8000-000000000003", "deny", "cli");

    const removed = pruneApprovals(db, 30 * 24 * 60 * 60 * 1000);
    assert.equal(removed, 1, "exactly the old decided row was pruned");

    const left = db.prepare("SELECT id FROM approvals ORDER BY id").all().map((r) => r.id);
    assert.deepEqual(left, [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000003",
    ]);
  } finally {
    db.close(); cleanup(file);
  }
});

// ─── 4. install-hooks sweeps stale tower entries across non-current matchers

test("installHooks sweeps stale tower entries under different matchers", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tower-h2-install-"));
  const settingsPath = path.join(dir, "settings.json");

  // Pre-seed: a previous tower install used matcher "" for PreToolUse with a
  // different absolute handler path. The new install must remove it.
  const stale = {
    type: "command",
    command: `node "/old/absolute/path/handler.js" # ${TOWER_HOOK_MARKER}`,
  };
  await fsp.writeFile(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "", hooks: [stale] },                              // stale tower entry under wrong matcher
        { matcher: "Read", hooks: [{ type: "command", command: "echo user" }] }, // unrelated user hook
      ],
    },
  }));

  await installHooks({ settingsPath, handlerPath: "/new/handler.js" });
  const s = JSON.parse(await fsp.readFile(settingsPath, "utf8"));

  // Total tower entries across the entire PreToolUse list must be exactly 1.
  const allTower = s.hooks.PreToolUse.flatMap((m) => m.hooks || [])
    .filter((h) => h.command?.includes(TOWER_HOOK_MARKER));
  assert.equal(allTower.length, 1, "exactly one tower entry survives across all matchers");
  assert.match(allTower[0].command, /\/new\/handler\.js/, "uses the new handler path");

  // User's unrelated entry under matcher "Read" must still be present.
  const userMatcher = s.hooks.PreToolUse.find((m) => m.matcher === "Read");
  assert.ok(userMatcher, "user's matcher entry survives");
  assert.equal(userMatcher.hooks.length, 1);
  assert.equal(userMatcher.hooks[0].command, "echo user");
});

// ─── 5. config.SHOW_USD is exported and respected ──────────────────────

test("config.SHOW_USD is a boolean used by the CLI", async () => {
  const { SHOW_USD } = await import("../lib/config.js");
  assert.equal(typeof SHOW_USD, "boolean");
  // Source-level guard: bin/tower must reference the export, not the legacy
  // inline env+argv check (avoids drift).
  const src = await fsp.readFile(path.join(__dirname, "..", "bin", "tower"), "utf8");
  assert.match(src, /import\s+\{[^}]*SHOW_USD[^}]*\}\s+from\s+"\.\.\/lib\/config\.js"/);
  // Must not contain the legacy duplicate.
  assert.doesNotMatch(src, /process\.env\.TOWER_SHOW_USD\s*===\s*"1"/, "bin/tower must use SHOW_USD import");
});

// ─── 6. Frontend asset coverage: every <script>/<link> resolves to 200 ──

test("every public asset referenced from index.html is reachable", async () => {
  const html = await fsp.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const refs = new Set();
  // <script src="/foo.js">  (we only care about local /-prefixed files)
  for (const m of html.matchAll(/<script[^>]+src=["']\/([^"']+)["']/g)) refs.add(m[1]);
  // <link href="/foo.css">
  for (const m of html.matchAll(/<link[^>]+href=["']\/([^"']+)["']/g)) refs.add(m[1]);

  assert.ok(refs.size > 0, "should find at least one asset reference in index.html");
  for (const r of refs) {
    const full = path.join(PUBLIC_DIR, r);
    const exists = fs.existsSync(full);
    assert.ok(exists, `referenced asset is missing: /${r}`);
  }
});

// ─── 7. db migrations: running twice is a no-op (idempotent) ───────────

test("db migrations re-run cleanly (v1 → v2 → v3 idempotent)", async () => {
  // Use a real file-backed DB and call getDb() twice via closeDb between.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tower-h2-mig-"));
  const towerDir = path.join(tmp, ".tower");
  // Point paths.js at our scratch dir via the env override.
  const prevDir = process.env.TOWER_DIR_OVERRIDE;
  process.env.TOWER_DIR_OVERRIDE = towerDir;
  try {
    // Re-import paths/db so the override takes effect for this isolated run.
    const dbMod = await import(`../lib/db.js?bust=${Date.now()}`);
    const db1 = await dbMod.getDb();
    const v1 = db1.pragma("user_version", { simple: true });
    assert.ok(v1 >= 3, "expect at least v3 after first boot");
    dbMod.closeDb();

    const db2 = await dbMod.getDb();
    const v2 = db2.pragma("user_version", { simple: true });
    assert.equal(v2, v1, "second boot must not bump user_version further");
    // The v3 index exists.
    const idx = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_approvals_decided_at'"
    ).get();
    assert.ok(idx, "idx_approvals_decided_at must exist after migration");
    dbMod.closeDb();
  } finally {
    if (prevDir == null) delete process.env.TOWER_DIR_OVERRIDE;
    else process.env.TOWER_DIR_OVERRIDE = prevDir;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 8. Concurrent /api/hook/await for the same approval is consistent ──

test("concurrent hook awaits all see the same decision", async (t) => {
  // Stand up a real http server with mounted hooks + approvals, hit
  // /api/hook/await with N=5 parallel clients, then decide once.
  const { db, file } = tmpDb();
  // Use a separate in-process app — emulate the live server.
  const app = createApp({ publicDir: PUBLIC_DIR });
  const { mountApprovals } = await import("../lib/approvals.js");
  mountHooks(app, { db, notifier: null });
  mountApprovals(app, { db, notifier: null });

  const server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(() => { server.close(); db.close(); cleanup(file); });

  // Create an approval row through the hook endpoint.
  const post = await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({
      event: "PreToolUse", sessionId: "00000000-0000-4000-8000-aaaaaaaaaaaa",
      cwd: "/tmp/x", toolName: "Bash", toolInput: { command: "ls" },
    }));
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: "/api/hook",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
    }, (res) => {
      let buf = ""; res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve(JSON.parse(buf)));
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
  const approvalId = post.approvalId;
  assert.ok(approvalId);

  // Race 5 awaiters; after a short delay, decide once via POST.
  const awaiters = Array.from({ length: 5 }, () => new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1", port, method: "GET",
      path: `/api/hook/await/${approvalId}`,
    }, (res) => {
      let buf = ""; res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve(JSON.parse(buf)));
    });
    r.on("error", reject); r.end();
  }));

  // Brief delay so awaiters are mid-poll, then approve.
  await new Promise((r) => setTimeout(r, 250));
  await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ decision: "approve" }));
    const r = http.request({
      host: "127.0.0.1", port, method: "POST",
      path: `/api/approvals/${approvalId}`,
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
    }, (res) => {
      res.resume(); res.on("end", resolve);
    });
    r.on("error", reject); r.write(data); r.end();
  });

  const results = await Promise.all(awaiters);
  for (const r of results) {
    assert.equal(r.decision, "approve", "every awaiter sees the same approve");
  }
});

// ─── 9. install-hooks 3rd-run idempotency (re-affirms the existing guard)

test("installHooks remains idempotent across 3 sequential runs", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tower-h2-idem-"));
  const settingsPath = path.join(dir, "settings.json");
  for (let i = 0; i < 3; i++) {
    await installHooks({ settingsPath, handlerPath: "/x" });
  }
  const s = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  for (const ev of ["PreToolUse", "PostToolUse", "Stop", "Notification", "SubagentStop", "UserPromptSubmit"]) {
    const all = s.hooks[ev].flatMap((m) => m.hooks || [])
      .filter((h) => h.command?.includes(TOWER_HOOK_MARKER));
    assert.equal(all.length, 1, `${ev} should have exactly one tower hook after 3 runs`);
  }
});

// ─── 10. tower db prune CLI is wired (runs end-to-end via spawn) ───────
//
// Seeding the DB in-process collides with the db.js singleton across tests;
// instead we seed via a one-shot subprocess, then prune via another.

test("tower db prune CLI prints a friendly summary", async (t) => {
  const TOWER_BIN = path.resolve(__dirname, "..", "bin", "tower");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tower-h2-prune-cli-"));
  t.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  // Seed: spawn node to create the DB + insert one old decided approval.
  const seedScript = `
    import("${path.resolve(__dirname, "..", "lib", "db.js").replace(/\\/g, "\\\\")}").then(async (m) => {
      const db = await m.getDb();
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
        .run("s1", "k", "/", "t", Date.now(), Date.now());
      m.createApproval(db, {
        id: "00000000-0000-4000-8000-000000000099",
        sessionId: "s1", createdAt: Date.now() - 365*24*60*60*1000,
        toolName: "Bash", toolInput: { command: "x" },
      });
      m.decideApproval(db, "00000000-0000-4000-8000-000000000099", "deny", "cli");
      db.prepare("UPDATE approvals SET decided_at = ? WHERE id = ?")
        .run(Date.now() - 365*24*60*60*1000, "00000000-0000-4000-8000-000000000099");
      m.closeDb();
    });
  `;
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", seedScript], {
      env: { ...process.env, TOWER_DIR_OVERRIDE: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`seed exit ${code}: ${err}`)));
  });

  // Prune via the actual CLI.
  const res = await new Promise((resolve) => {
    const p = spawn(process.execPath, [TOWER_BIN, "db", "prune"], {
      env: { ...process.env, TOWER_DIR_OVERRIDE: dir, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (c) => { out += c; });
    p.stderr.on("data", (c) => { err += c; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /pruned 1 decided approval/i);
});
