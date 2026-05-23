#!/usr/bin/env node
// Hook handler binary. Runs once per hook fire (Claude Code spawns it).
//
// Contract:
//   - reads JSON from stdin
//   - POSTs it to tower; for PreToolUse, blocks until the user decides
//   - prints Claude-Code-compatible JSON to stdout
//   - if tower is unreachable, exits 0 with empty stdout (fail open — we never
//     want the dashboard being down to block the user's actual work)
//
// Performance budget: <50ms for the non-blocking path. Hot path is just
// "POST and forget", no DB lookups, no module bloat.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const TOWER_DIR = path.join(os.homedir(), ".claude-tower");
const PORT_FILE = path.join(TOWER_DIR, "port");

async function resolvePort() {
  if (process.env.TOWER_PORT) return Number(process.env.TOWER_PORT);
  try {
    const txt = await fs.readFile(PORT_FILE, "utf8");
    const n = Number(txt.trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* fall through */ }
  return 7777;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    // Give Claude Code at most 2s to send the payload — otherwise we bail out.
    setTimeout(() => resolve(buf), 2000).unref();
  });
}

function towerRequest(port, method, urlPath, body, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: data
        ? { "Content-Type": "application/json", "Content-Length": data.length }
        : {},
    }, (res) => {
      let chunks = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        try {
          const parsed = chunks ? JSON.parse(chunks) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

async function awaitDecision(port, approvalId) {
  // Server long-polls up to 60s; we loop in case the user takes longer.
  while (true) {
    let r;
    try {
      r = await towerRequest(port, "GET", `/api/hook/await/${approvalId}`, null, 70_000);
    } catch {
      return { decision: "allow", reason: "tower unreachable while waiting" };
    }
    const d = r.body?.decision;
    if (d === "approve" || d === "allow") return { decision: "allow", reason: r.body.reason };
    if (d === "deny") return { decision: "deny", reason: r.body.reason };
    if (d === "timeout") continue;
    if (r.status === 404) return { decision: "allow", reason: "approval row missing" };
    // Anything else: bail out open.
    return { decision: "allow", reason: "unexpected response" };
  }
}

function emit(obj) {
  if (obj && Object.keys(obj).length) process.stdout.write(JSON.stringify(obj));
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    // Nothing on stdin — Claude Code wasn't actually calling us. Pass through.
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Garbage on stdin — can't decide, fail open.
    return;
  }

  const event = input.hook_event_name;
  const sessionId = input.session_id;
  if (!event || !sessionId) return;

  const port = await resolvePort();
  const forward = {
    event,
    sessionId,
    cwd: input.cwd || null,
    transcriptPath: input.transcript_path || null,
    toolName: input.tool_name || null,
    toolInput: input.tool_input || null,
    payload: {
      permissionMode: input.permission_mode || null,
      toolUseId: input.tool_use_id || null,
      toolResult: input.tool_result ?? undefined,
      toolResultType: input.tool_result_type ?? undefined,
      notificationType: input.notification_type ?? undefined,
      message: input.message ?? undefined,
      prompt: input.prompt ?? undefined,
      agentId: input.agent_id ?? undefined,
      agentType: input.agent_type ?? undefined,
    },
  };

  let posted;
  try {
    posted = await towerRequest(port, "POST", "/api/hook", forward, 3_000);
  } catch {
    // Tower not running — fail open silently.
    return;
  }

  if (event !== "PreToolUse") return;
  if (!posted.body?.requiresDecision) return;

  const approvalId = posted.body.approvalId;
  if (!approvalId) return;

  const { decision, reason } = await awaitDecision(port, approvalId);

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason || (decision === "deny" ? "blocked by claude-tower" : "approved via claude-tower"),
    },
  });
}

main().catch(() => {
  // Last-resort fail-open. Never crash with non-zero — Claude Code would
  // interpret it as a block.
  process.exit(0);
});
