// CLI smoke tests. We spawn bin/tower in a subprocess with a temp TOWER_DIR so
// the daemon control commands don't touch the user's real state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOWER_BIN = path.resolve(__dirname, "..", "bin", "tower");

function run(args, env = {}) {
  return spawnSync(process.execPath, [TOWER_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, NO_COLOR: "1" },
  });
}

async function tmpDir(prefix = "tower-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("--help prints command list", () => {
  const res = run(["--help"]);
  assert.equal(res.status, 0);
  const out = res.stdout;
  for (const cmd of ["start", "stop", "restart", "status", "sessions", "approve", "deny", "logs", "mobile", "db"]) {
    assert.ok(out.includes(cmd), `help should mention "${cmd}"`);
  }
});

test("no args prints help", () => {
  const res = run([]);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("USAGE"));
});

test("--version prints semver", () => {
  const res = run(["--version"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("unknown command exits 1", () => {
  const res = run(["bogus-command"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown command/);
});

test("status when stopped (isolated TOWER_DIR)", async () => {
  const dir = await tmpDir();
  try {
    const res = run(["status"], { TOWER_DIR_OVERRIDE: dir });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /stopped/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("stop when not running prints friendly message", async () => {
  const dir = await tmpDir();
  try {
    const res = run(["stop"], { TOWER_DIR_OVERRIDE: dir });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /not running/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sessions without server exits 1", async () => {
  const dir = await tmpDir();
  try {
    const res = run(["sessions"], { TOWER_DIR_OVERRIDE: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not running/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("install-hooks fails gracefully when subsystem missing", () => {
  // Only run this if lib/hooks/install.js really doesn't exist.
  const installPath = path.resolve(__dirname, "..", "lib", "hooks", "install.js");
  if (existsSync(installPath)) {
    return; // skip — subsystem is bundled
  }
  const res = run(["install-hooks"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /hooks subsystem not yet bundled/);
});

test("logs prints friendly message when no log yet", async () => {
  const dir = await tmpDir();
  try {
    const res = run(["logs"], { TOWER_DIR_OVERRIDE: dir });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no log file/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
