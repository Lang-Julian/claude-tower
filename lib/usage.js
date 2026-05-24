// Token + cost subsystem.
//
// Sources:
//   - assistant messages in ~/.claude/projects/<projectKey>/<sessionId>.jsonl carry
//     `message.usage` ({input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}).
//   - `message.model` identifies pricing tier; priced via config.priceFor().
//
// Projection: usage table with UNIQUE(session_id, ts, model) — INSERT OR IGNORE
// makes re-syncing idempotent.
//
// Smart caching: meta table stores per-file {mtime, size}. If a file is unchanged
// since the last sync we skip parsing it entirely — full re-scan of ~800 jsonl
// files (~850 MB) drops from O(seconds) to O(stat-call-per-file).
//
// Resilience: a half-written JSONL (Claude actively appending) yields the last
// line as truncated JSON; iterateJsonl() silently skips it — we'll re-parse on
// the next mtime tick once the line is complete.
//
// 5h-block aggregation mirrors ccusage: a block starts at the first usage event
// after a 5h gap (rolling Anthropic quota windows).

import { promises as fs, createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";

import { PROJECTS_DIR } from "./paths.js";
import { priceFor } from "./config.js";
import { sendJson } from "./router.js";
import { projectKeyToCwd } from "./sessions.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 60_000;
const MIN_FILE_BYTES = 100; // anything smaller can't have an assistant message

// ─── core: cost + parsing ─────────────────────────────────────────────────

export function computeCost({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }) {
  const p = priceFor(model);
  if (!p) return 0;
  // Prices are USD per 1M tokens.
  return (
    (inputTokens * p.input) +
    (outputTokens * p.output) +
    (cacheReadTokens * p.cacheRead) +
    (cacheCreationTokens * p.cacheWrite)
  ) / 1_000_000;
}

function extractUsageRow(rec) {
  if (!rec || rec.type !== "assistant") return null;
  const msg = rec.message;
  const usage = msg?.usage;
  if (!usage) return null;
  const sessionId = rec.sessionId || null;
  if (!sessionId) return null;
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
  if (!ts || Number.isNaN(ts)) return null;
  const model = msg.model || null;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;
  // Skip empty rows (no tokens at all — keepalives / errors).
  if (!(inputTokens || outputTokens || cacheReadTokens || cacheCreationTokens)) return null;
  const costUsd = computeCost({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });
  return { sessionId, ts, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
}

// Streams one jsonl file line-by-line. Skips malformed lines silently.
async function* iterateJsonl(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // malformed line — skip
    }
  }
}

// ─── scan ─────────────────────────────────────────────────────────────────

export async function scanFile(filePath, sessionIdHint = null) {
  const rows = [];
  for await (const rec of iterateJsonl(filePath)) {
    const row = extractUsageRow(rec);
    if (row) {
      if (!row.sessionId && sessionIdHint) row.sessionId = sessionIdHint;
      rows.push(row);
    }
  }
  return rows;
}

export async function scanProject(projectDir) {
  let files;
  try {
    files = await fs.readdir(projectDir);
  } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(projectDir, f);
    let stat;
    try { stat = await fs.stat(full); } catch { continue; }
    if (stat.size < MIN_FILE_BYTES) continue;
    const sessionIdHint = f.replace(/\.jsonl$/, "");
    try {
      const rows = await scanFile(full, sessionIdHint);
      out.push(...rows);
    } catch {
      // unreadable — skip
    }
  }
  return out;
}

// ─── db sync ──────────────────────────────────────────────────────────────

function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function insertRow(db, r) {
  return db.prepare(`
    INSERT OR IGNORE INTO usage (session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.sessionId, r.ts, r.model ?? null, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.costUsd);
}

// usage.session_id has a FK to sessions.id. The session-scanner only inserts
// rows for "live" (≤12h old) sessions, but we price historical sessions too.
// Upsert a minimal session stub so the FK holds; the scanner's upsert will
// later overwrite our placeholders with the real metadata.
function ensureSession(db, sessionId, projectKey, ts) {
  db.prepare(`
    INSERT INTO sessions (id, project_key, cwd, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = MAX(sessions.last_seen, excluded.last_seen)
  `).run(sessionId, projectKey, projectKeyToCwd(projectKey), ts, ts);
}

export async function syncToDb(db) {
  const start = Date.now();
  let projects;
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return { ms: 0, files: 0, inserted: 0, skipped: 0 }; }

  let filesScanned = 0;
  let filesSkipped = 0;
  let inserted = 0;

  const insertMany = db.transaction((rows, projectKey) => {
    const sessions = new Set();
    for (const r of rows) {
      if (!sessions.has(r.sessionId)) {
        ensureSession(db, r.sessionId, projectKey, r.ts);
        sessions.add(r.sessionId);
      }
      const res = insertRow(db, r);
      if (res.changes > 0) inserted++;
    }
  });

  for (const key of projects) {
    const dir = path.join(PROJECTS_DIR, key);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      let stat;
      try { stat = await fs.stat(full); } catch { continue; }
      if (stat.size < MIN_FILE_BYTES) continue;

      const metaKey = `usage:file:${full}`;
      const prev = getMeta(db, metaKey);
      const sig = `${stat.mtimeMs}|${stat.size}`;
      if (prev === sig) {
        filesSkipped++;
        continue;
      }
      filesScanned++;
      const sessionIdHint = f.replace(/\.jsonl$/, "");
      try {
        const rows = await scanFile(full, sessionIdHint);
        if (rows.length) insertMany(rows, key);
        setMeta(db, metaKey, sig);
      } catch (e) {
        // unreadable — leave meta untouched so we retry next time
        if (process.env.TOWER_DEBUG) console.error("[usage] file scan failed", full, e);
      }
    }
  }
  return { ms: Date.now() - start, files: filesScanned, skipped: filesSkipped, inserted };
}

// ─── aggregation ──────────────────────────────────────────────────────────

// Group rows into rolling 5h windows. ccusage convention: block starts at first
// usage event, ends 5h later. Next event after that boundary opens a new block.
// Rows must be chronologically sorted by ts.
export function block5h(rows) {
  if (!rows.length) return [];
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  const blocks = [];
  let cur = null;
  const sessionSet = new Set();
  for (const r of sorted) {
    if (!cur || r.ts >= cur.startTs + FIVE_HOURS_MS) {
      if (cur) {
        cur.sessionCount = sessionSet.size;
        sessionSet.clear();
      }
      cur = {
        startTs: r.ts,
        endTs: r.ts + FIVE_HOURS_MS,
        totalTokens: 0,
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        sessionCount: 0,
      };
      blocks.push(cur);
    }
    cur.totalTokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
    cur.totalCostUsd += r.costUsd;
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.cacheReadTokens += r.cacheReadTokens;
    cur.cacheCreationTokens += r.cacheCreationTokens;
    sessionSet.add(r.sessionId);
  }
  if (cur) cur.sessionCount = sessionSet.size;
  return blocks;
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function queryAggregate(db) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) AS cost,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens
    FROM usage
  `).get();
  const today = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) AS cost,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens
    FROM usage WHERE ts >= ?
  `).get(startOfTodayMs());
  const sessions = db.prepare(`
    SELECT session_id AS sessionId,
           COALESCE(SUM(cost_usd), 0) AS totalCostUsd,
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS totalTokens,
           MAX(ts) AS lastTs
    FROM usage
    GROUP BY session_id
    ORDER BY lastTs DESC
    LIMIT 200
  `).all();
  return { totals, today, sessions };
}

// burnRate: cost + tokens over the last 60 minutes (already per-hour).
function burnRate(db) {
  const since = Date.now() - 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) AS cost,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens
    FROM usage WHERE ts >= ?
  `).get(since);
  return { usd: Number(row.cost) || 0, tokens: Number(row.tokens) || 0 };
}

function recentBlocks(db, sinceMs) {
  const rows = db.prepare(`
    SELECT session_id AS sessionId, ts, model,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
           cost_usd AS costUsd
    FROM usage WHERE ts >= ?
    ORDER BY ts
  `).all(sinceMs);
  return block5h(rows);
}

// Last 60min token spark for one session — bucketed into 12 × 5min bins.
function sparkline60min(db, sessionId) {
  const now = Date.now();
  const since = now - 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT ts, input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
    FROM usage WHERE session_id = ? AND ts >= ?
  `).all(sessionId, since);
  const buckets = new Array(12).fill(0);
  for (const r of rows) {
    const idx = Math.min(11, Math.floor((r.ts - since) / (5 * 60 * 1000)));
    buckets[idx] += r.tokens;
  }
  return buckets;
}

// ─── routes ───────────────────────────────────────────────────────────────

export function mountUsage(app, { db }) {
  app.route("GET", "/api/usage", ({ res }) => {
    const { totals, today, sessions } = queryAggregate(db);
    const blocks = recentBlocks(db, Date.now() - 7 * 24 * 60 * 60 * 1000);
    const currentBlock = blocks.length ? blocks[blocks.length - 1] : null;
    const burn = burnRate(db);
    sendJson(res, 200, {
      totalCostUsd: Number(totals.cost) || 0,
      totalTokens: Number(totals.tokens) || 0,
      today: { costUsd: Number(today.cost) || 0, tokens: Number(today.tokens) || 0 },
      currentBlock,
      burnRateUsdPerHour: burn.usd,
      recentTokensPerHour: burn.tokens,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        totalCostUsd: Number(s.totalCostUsd) || 0,
        totalTokens: Number(s.totalTokens) || 0,
        lastTs: s.lastTs,
        spark: sparkline60min(db, s.sessionId),
      })),
    });
  });

  app.route("GET", "/api/usage/blocks", ({ res }) => {
    const blocks = recentBlocks(db, Date.now() - 7 * 24 * 60 * 60 * 1000);
    sendJson(res, 200, { blocks });
  });

  app.route("GET", "/api/usage/:sessionId", ({ res, params }) => {
    const sid = params.sessionId;
    const rows = db.prepare(`
      SELECT ts, model,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
             cost_usd AS costUsd
      FROM usage WHERE session_id = ?
      ORDER BY ts
    `).all(sid);
    if (!rows.length) return sendJson(res, 404, { ok: false, error: "no usage for session" });
    const breakdown = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let totalCostUsd = 0;
    const models = new Set();
    const timeline = [];
    for (const r of rows) {
      breakdown.input += r.inputTokens;
      breakdown.output += r.outputTokens;
      breakdown.cacheRead += r.cacheReadTokens;
      breakdown.cacheCreation += r.cacheCreationTokens;
      totalCostUsd += r.costUsd;
      if (r.model) models.add(r.model);
      timeline.push({
        ts: r.ts,
        tokens: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens,
        costUsd: r.costUsd,
      });
    }
    sendJson(res, 200, {
      sessionId: sid,
      model: models.size === 1 ? [...models][0] : [...models],
      totalCostUsd,
      breakdown,
      timeline,
    });
  });

  // Kick off an initial sync, then poll. Don't block module load on it.
  syncToDb(db).then((r) => {
    console.log(`[usage] initial sync: ${r.inserted} new rows, ${r.files} files scanned, ${r.skipped} unchanged, ${r.ms}ms`);
  }).catch((e) => console.error("[usage] initial sync failed", e));

  setInterval(() => {
    syncToDb(db).catch((e) => console.error("[usage] sync failed", e));
  }, SYNC_INTERVAL_MS).unref();
}

// ─── helpers exported for cheap lookups (used by sessions.js) ─────────────

// Per-session cost since start-of-today. Cheap: indexed scan.
export function costTodayBySession(db) {
  const rows = db.prepare(`
    SELECT session_id AS sessionId, COALESCE(SUM(cost_usd), 0) AS cost
    FROM usage WHERE ts >= ?
    GROUP BY session_id
  `).all(startOfTodayMs());
  const map = new Map();
  for (const r of rows) map.set(r.sessionId, Number(r.cost) || 0);
  return map;
}
