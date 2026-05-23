import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installHooks, uninstallHooks, TOWER_HOOK_MARKER } from "../lib/hooks/install.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.join(__dirname, "..", "lib", "hooks", "handler.js");

async function tmp(name) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `tower-hooks-${name}-`));
  return d;
}

test("install adds tower hook entries to settings.json", async () => {
  const dir = await tmp("install");
  const settingsPath = path.join(dir, "settings.json");

  const r = await installHooks({ settingsPath, handlerPath: "/fake/handler.js" });
  assert.equal(r.settingsPath, settingsPath);

  const s = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  for (const event of ["PreToolUse", "PostToolUse", "Stop", "Notification", "SubagentStop", "UserPromptSubmit"]) {
    assert.ok(Array.isArray(s.hooks[event]), `${event} should be an array`);
    const found = s.hooks[event].some((entry) =>
      entry.hooks?.some((h) => h.command?.includes(TOWER_HOOK_MARKER)),
    );
    assert.ok(found, `${event} should contain a tower hook`);
  }
});

test("install preserves existing user hooks", async () => {
  const dir = await tmp("preserve");
  const settingsPath = path.join(dir, "settings.json");
  const userHook = { type: "command", command: "echo user" };
  await fs.writeFile(settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [userHook] }] },
  }));

  await installHooks({ settingsPath, handlerPath: "/x" });
  const s = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const pre = s.hooks.PreToolUse[0];
  assert.equal(pre.hooks.length, 2, "should have user hook + tower hook");
  assert.ok(pre.hooks.find((h) => h.command === "echo user"));
});

test("install is idempotent (re-runs don't duplicate)", async () => {
  const dir = await tmp("idempotent");
  const settingsPath = path.join(dir, "settings.json");
  await installHooks({ settingsPath, handlerPath: "/x" });
  await installHooks({ settingsPath, handlerPath: "/x" });
  const s = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const towerEntries = s.hooks.PreToolUse[0].hooks.filter((h) => h.command?.includes(TOWER_HOOK_MARKER));
  assert.equal(towerEntries.length, 1);
});

test("install writes a backup when settings already existed", async () => {
  const dir = await tmp("backup");
  const settingsPath = path.join(dir, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({ foo: 1 }));
  const r = await installHooks({ settingsPath, handlerPath: "/x" });
  assert.ok(r.backupPath, "should return a backup path");
  const backup = JSON.parse(await fs.readFile(r.backupPath, "utf8"));
  assert.deepEqual(backup, { foo: 1 });
});

test("uninstall removes tower entries but leaves user hooks", async () => {
  const dir = await tmp("uninstall");
  const settingsPath = path.join(dir, "settings.json");
  const userHook = { type: "command", command: "echo user" };
  await fs.writeFile(settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [userHook] }] },
  }));
  await installHooks({ settingsPath, handlerPath: "/x" });
  const r = await uninstallHooks({ settingsPath });
  assert.ok(r.removed >= 6, "should remove at least one entry per event");

  const s = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(s.hooks.PreToolUse[0].hooks.length, 1);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "echo user");
  for (const ev of ["PostToolUse", "Stop", "Notification", "SubagentStop", "UserPromptSubmit"]) {
    assert.ok(!s.hooks?.[ev], `${ev} should be cleared`);
  }
});

test("handler exits 0 when tower is unreachable", async () => {
  const result = await new Promise((resolve) => {
    const proc = spawn("node", [HANDLER], {
      env: { ...process.env, TOWER_PORT: "1" }, // port 1 = unreachable
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.on("close", (code) => resolve({ code, stdout }));
    proc.stdin.end(JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "down-test",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "", "no stdout means defer to default permission flow");
});

test("handler exits 0 on empty stdin", async () => {
  const result = await new Promise((resolve) => {
    const proc = spawn("node", [HANDLER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.on("close", (code) => resolve({ code, stdout }));
    proc.stdin.end("");
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("handler creates approval and waits for decision", async () => {
  // Stand up a fake tower server with just the two hook endpoints.
  const approvals = new Map();
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/hook") {
      let buf = "";
      req.on("data", (c) => { buf += c; });
      req.on("end", () => {
        const data = JSON.parse(buf);
        if (data.event === "PreToolUse" && data.toolName === "Bash") {
          const id = "approval-1";
          approvals.set(id, { decision: null });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, approvalId: id, requiresDecision: true }));
          // Approve 150ms after the hook posts (simulates user clicking approve).
          setTimeout(() => {
            approvals.set(id, { decision: "approve", reason: "test ok" });
          }, 150);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, requiresDecision: false }));
        }
      });
    } else if (req.method === "GET" && req.url.startsWith("/api/hook/await/")) {
      const id = req.url.split("/").pop();
      const tick = setInterval(() => {
        const a = approvals.get(id);
        if (a?.decision) {
          clearInterval(tick);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ decision: a.decision, reason: a.reason }));
        }
      }, 50);
      req.on("close", () => clearInterval(tick));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const result = await new Promise((resolve) => {
    const proc = spawn("node", [HANDLER], {
      env: { ...process.env, TOWER_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (c) => { stdout += c; });
    proc.on("close", (code) => resolve({ code, stdout }));
    proc.stdin.end(JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "wait-test",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    }));
  });

  server.close();
  assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /test ok/);
});
