// claude-tower — local cockpit for all running Claude Code sessions.
//
// CLI:
//   node server.js [--port 7777] [--no-telegram] [--mobile] [--open]

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import { createApp, sendJson, send } from "./lib/router.js";
import { snapshot } from "./lib/sessions.js";
import { processIndex } from "./lib/processes.js";
import { focusTty } from "./lib/iterm.js";
import { Notifier } from "./lib/notifier.js";
import { getDb } from "./lib/db.js";
import { mountHooks } from "./lib/hooks/routes.js";
import { mountApprovals } from "./lib/approvals.js";
import { mountUsage } from "./lib/usage.js";
import { VERSION } from "./lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const args = process.argv.slice(2);
const PORT = Number(getArg("--port") || process.env.TOWER_PORT || 7777);
const TELEGRAM_ENABLED = !args.includes("--no-telegram");
const OPEN_IN_BROWSER = args.includes("--open");
const MOBILE = args.includes("--mobile");
const POLL_MS = Number(process.env.TOWER_POLL_MS || 2000);
const BIND = MOBILE ? "0.0.0.0" : "127.0.0.1";

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const notifier = new Notifier({ enabled: TELEGRAM_ENABLED });
const app = createApp({ publicDir: PUBLIC_DIR });

let latest = { sessions: [], generatedAt: 0 };

async function refresh() {
  try {
    const procs = await processIndex();
    const sessions = await snapshot(procs);
    latest = { sessions, generatedAt: Date.now(), processCount: procs.all.length };
    await notifier.onSnapshot(sessions);
    app.broadcast({ type: "snapshot", ...latest });
  } catch (e) {
    console.error("refresh failed:", e);
  }
}

// --- core routes ---

app.route("GET", "/api/sessions", ({ res }) => sendJson(res, 200, latest));

app.route("GET", "/api/events", ({ req, res }) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify({ type: "snapshot", ...latest })}\n\n`);
  const remove = app.addSseClient(res);
  req.on("close", remove);
});

app.route("POST", "/api/focus", async ({ res, body }) => {
  try {
    const data = JSON.parse((await body()) || "{}");
    const result = await focusTty(data.tty);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e) });
  }
});

app.route("POST", "/api/notifier", async ({ res, body }) => {
  try {
    const data = JSON.parse((await body()) || "{}");
    notifier.enabled = Boolean(data.enabled);
    sendJson(res, 200, { enabled: notifier.enabled });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e) });
  }
});

app.route("GET", "/api/version", ({ res }) => sendJson(res, 200, { version: VERSION }));

// --- feature modules mount their own routes ---

const db = await getDb();
mountHooks(app, { db, notifier });
mountApprovals(app, { db, notifier });
mountUsage(app, { db });

// --- server ---

const server = http.createServer((req, res) => {
  if (req.socket.remoteAddress && !isAllowedAddress(req.socket.remoteAddress)) {
    return send(res, 403, "forbidden");
  }
  app.handle(req, res);
});

function isAllowedAddress(addr) {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
  return MOBILE; // --mobile opens to LAN; auth middleware (not impl yet) guards it
}

server.listen(PORT, BIND, async () => {
  console.log(`\n  ┌─ claude-tower v${VERSION}`);
  console.log(`  │`);
  console.log(`  │  Dashboard:  http://${BIND === "0.0.0.0" ? "localhost" : BIND}:${PORT}`);
  console.log(`  │  Mobile:     ${MOBILE ? "ON (LAN bind)" : "off"}`);
  console.log(`  │  Telegram:   ${TELEGRAM_ENABLED ? "on" : "off"}`);
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
