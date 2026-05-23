// Discover running `claude` processes and resolve their cwd + tty via lsof.
// Result is indexed by cwd so the session scanner can match files to live processes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// "07-12:34:56" → seconds, "12:34:56" → seconds, "34:56" → seconds
function parseEtime(s) {
  if (!s) return null;
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const d = Number(m[1] || 0), h = Number(m[2] || 0), min = Number(m[3]), sec = Number(m[4]);
  return ((d * 24 + h) * 60 + min) * 60 + sec;
}

async function listClaudePids() {
  try {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,etime=,comm="]);
    const pids = [];
    const now = Date.now();
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const etimeS = parseEtime(m[2]);
      const comm = m[3].trim();
      // The `claude` CLI either reports itself as "claude" or as the bundled
      // versioned binary name like "2.1.141". Filter to the executable basename.
      const base = comm.split("/").pop();
      if (base === "claude" || /^\d+\.\d+\.\d+$/.test(base)) {
        const startedAt = etimeS != null ? now - etimeS * 1000 : null;
        pids.push({ pid, comm: base, startedAt });
      }
    }
    return pids;
  } catch {
    return [];
  }
}

async function inspectPid(pid) {
  // lsof -F gives a stable, parseable line-prefixed format.
  // -a AND-combines selectors. cwd + the tty fd (usually fd 0).
  try {
    const { stdout } = await exec("/usr/sbin/lsof", [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd,0,1,2",
      "-Fn",
    ]);
    let cwd = null;
    let tty = null;
    let currentFd = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("f")) currentFd = line.slice(1);
      else if (line.startsWith("n")) {
        const name = line.slice(1);
        if (currentFd === "cwd") cwd = name;
        else if (!tty && /^\/dev\/tty/.test(name)) tty = name;
      }
    }
    return { pid, cwd, tty };
  } catch {
    return { pid, cwd: null, tty: null };
  }
}

export async function processIndex() {
  const pids = await listClaudePids();
  const inspected = await Promise.all(pids.map(async (p) => {
    const info = await inspectPid(p.pid);
    return { ...info, startedAt: p.startedAt };
  }));
  const byCwd = new Map();
  const all = [];
  for (const p of inspected) {
    if (!p.cwd) continue;
    all.push(p);
    if (!byCwd.has(p.cwd)) byCwd.set(p.cwd, []);
    byCwd.get(p.cwd).push(p);
  }
  return { byCwd, all };
}
