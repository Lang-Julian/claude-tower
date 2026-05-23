// Claude Control — local cockpit for all running Claude Code sessions.
// Zero external deps: native http + SSE + fs.
//
// Endpoints:
//   GET  /                  → dashboard
//   GET  /style.css         → static
//   GET  /app.js            → static
//   GET  /api/sessions      → JSON snapshot
//   GET  /api/events        → SSE stream (snapshot every POLL_MS)
//   POST /api/focus         → { tty } → focus iTerm tab via AppleScript
//   POST /api/notifier      → { enabled: bool } → toggle Telegram pings
//
// CLI:
//   node server.js [--port 7777] [--no-telegram] [--open]

import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import { snapshot } from "./lib/sessions.js";
import { processIndex } from "./lib/processes.js";
import { focusTty } from "./lib/iterm.js";
import { Notifier } from "./lib/notifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const args = process.argv.slice(2);
const PORT = Number(getArg("--port") || process.env.CLAUDE_CONTROL_PORT || 7777);
const TELEGRAM_ENABLED = !args.includes("--no-telegram");
const OPEN_IN_BROWSER = args.includes("--open");
const POLL_MS = Number(process.env.CLAUDE_CONTROL_POLL_MS || 2000);

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const notifier = new Notifier({ enabled: TELEGRAM_ENABLED });

let latest = { sessions: [], generatedAt: 0 };

async function refresh() {
  try {
    const procs = await processIndex();
    const sessions = await snapshot(procs);
    latest = { sessions, generatedAt: Date.now(), processCount: procs.all.length };
    await notifier.onSnapshot(sessions);
    broadcast({ type: "snapshot", ...latest });
  } catch (e) {
    console.error("refresh failed:", e);
  }
}

// --- SSE plumbing ---
const sseClients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { /* ignore */ }
  }
}

// --- static ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const safe = path.normalize(rel).replace(/^\/+/, "");
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden");
  try {
    const body = await fs.readFile(full);
    const ext = path.extname(full);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    send(res, 404, "not found");
  }
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// --- routes ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // bind only to localhost — never expose to the network
  if (req.socket.remoteAddress && !isLocalAddress(req.socket.remoteAddress)) {
    return send(res, 403, "forbidden: localhost only");
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/sessions") {
    return sendJson(res, 200, latest);
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ type: "snapshot", ...latest })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/focus") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const result = await focusTty(body.tty);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/notifier") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      notifier.enabled = Boolean(body.enabled);
      return sendJson(res, 200, { enabled: notifier.enabled });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e) });
    }
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res, url.pathname);
  }

  send(res, 404, "not found");
});

function isLocalAddress(addr) {
  if (!addr) return false;
  // Accept IPv4/IPv6 loopback only.
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`\n  ┌─ Claude Control`);
  console.log(`  │`);
  console.log(`  │  Dashboard:  http://localhost:${PORT}`);
  console.log(`  │  Telegram:   ${TELEGRAM_ENABLED ? "on (Branestormbot)" : "off"}`);
  console.log(`  │  Poll:       ${POLL_MS}ms`);
  console.log(`  └────────────────────────────────────\n`);

  await refresh();
  setInterval(refresh, POLL_MS);

  if (OPEN_IN_BROWSER) {
    execFile("/usr/bin/open", [`http://localhost:${PORT}`], () => {});
  }
});

process.on("SIGINT", () => { console.log("\nbye."); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));
