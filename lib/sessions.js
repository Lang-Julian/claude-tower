// Scans ~/.claude/projects/*/*.jsonl and extracts per-session state.
//
// Status model:
//   thinking          — Claude is actively processing (mtime fresh, last user msg unanswered)
//   needs_input       — Claude finished a turn, waiting for the user
//   needs_permission  — Tool call without matching tool_result (likely permission prompt)
//   idle              — Process alive but no activity for a while
//   running           — Process alive, recent activity, indeterminate state
//   stopped           — No matching live process, last seen recently
//   archived          — No process, stale

import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const TAIL_BYTES = 64 * 1024; // last 64 KB per file is enough to find recent events
const NOW = () => Date.now();

// projectKey looks like "-Users-jal-ai-in-the-box" → "/Users/jal/ai-in-the-box"
export function projectKeyToCwd(key) {
  if (!key.startsWith("-")) return key;
  return key.replace(/^-/, "/").replace(/-/g, "/");
}

export function cwdToProjectKey(cwd) {
  return cwd.replace(/\//g, "-");
}

export function projectDisplayName(cwd) {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~/" + cwd.slice(home.length + 1);
  return cwd;
}

async function readTail(filePath, bytes = TAIL_BYTES) {
  const stat = await fs.stat(filePath);
  const size = stat.size;
  const start = Math.max(0, size - bytes);
  const fd = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fd.read(buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), size, mtimeMs: stat.mtimeMs, start };
  } finally {
    await fd.close();
  }
}

function parseLines(text, dropFirst = false) {
  const lines = text.split("\n");
  // If we read from the middle of the file, the first line is likely partial.
  if (dropFirst && lines.length > 1) lines.shift();
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip partial / corrupt lines
    }
  }
  return events;
}

function extractStateFromEvents(events) {
  let title = null;
  let lastPrompt = null;
  let lastUserAt = null;
  let lastAssistantAt = null;
  let lastAssistantStopReason = null;
  let pendingToolUse = false;
  let lastAssistantHadToolUse = false;
  const pendingToolUseIds = new Set();
  let permissionMode = null;
  let lastGoalStatus = null;
  let lastPrLink = null;
  let cwdFromEvents = null;
  let gitBranch = null;
  let version = null;
  const toolEvents = []; // recent tool_use events for the timeline strip

  // Walk in order; the last interesting event wins.
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (typeof ev.cwd === "string") cwdFromEvents = ev.cwd;
    if (typeof ev.gitBranch === "string") gitBranch = ev.gitBranch;
    if (typeof ev.version === "string") version = ev.version;
    switch (ev.type) {
      case "ai-title":
        if (typeof ev.aiTitle === "string") title = ev.aiTitle;
        break;
      case "last-prompt":
        if (typeof ev.lastPrompt === "string") lastPrompt = ev.lastPrompt;
        break;
      case "permission-mode":
        if (typeof ev.permissionMode === "string") permissionMode = ev.permissionMode;
        break;
      case "goal_status":
        lastGoalStatus = ev;
        break;
      case "pr-link":
        lastPrLink = { number: ev.prNumber, url: ev.prUrl, repo: ev.prRepository };
        break;
      case "user": {
        // user messages can be plain text OR tool_result wrappers
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          let hadToolResult = false;
          for (const c of content) {
            if (c?.type === "tool_result" && c.tool_use_id) {
              pendingToolUseIds.delete(c.tool_use_id);
              hadToolResult = true;
            }
          }
          if (!hadToolResult) {
            lastUserAt = ev.timestamp || lastUserAt;
            lastAssistantHadToolUse = false;
          }
        } else {
          lastUserAt = ev.timestamp || lastUserAt;
          lastAssistantHadToolUse = false;
        }
        break;
      }
      case "assistant": {
        lastAssistantAt = ev.timestamp || lastAssistantAt;
        const msg = ev.message;
        lastAssistantStopReason = msg?.stop_reason ?? lastAssistantStopReason;
        lastAssistantHadToolUse = false;
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "tool_use" && c.id) {
              pendingToolUseIds.add(c.id);
              lastAssistantHadToolUse = true;
              toolEvents.push({ name: c.name, at: ev.timestamp || null });
              if (toolEvents.length > 40) toolEvents.shift();
            }
          }
        }
        break;
      }
      case "tool_result":
        if (ev.tool_use_id) pendingToolUseIds.delete(ev.tool_use_id);
        break;
      default:
        break;
    }
  }
  pendingToolUse = pendingToolUseIds.size > 0;

  return {
    title,
    lastPrompt,
    lastUserAt,
    lastAssistantAt,
    lastAssistantStopReason,
    lastAssistantHadToolUse,
    pendingToolUse,
    permissionMode,
    lastGoalStatus,
    lastPrLink,
    cwdFromEvents,
    gitBranch,
    version,
    toolEvents,
  };
}

function deriveStatus({ state, ageMs, hasProcess }) {
  const SECONDS = 1000;
  const fresh = ageMs < 8 * SECONDS;
  const recent = ageMs < 90 * SECONDS;

  if (!hasProcess) {
    return ageMs < 30 * 60 * SECONDS ? "stopped" : "archived";
  }

  // Pending tool_use without result → very likely a permission prompt or a long-running tool.
  if (state.pendingToolUse) {
    return ageMs > 12 * SECONDS ? "needs_permission" : "thinking";
  }

  // Last assistant message ended cleanly → waiting on user.
  if (state.lastAssistantStopReason === "end_turn" && !state.lastAssistantHadToolUse) {
    // If user hasn't replied since → waiting.
    const userAfter = state.lastUserAt && state.lastAssistantAt && state.lastUserAt > state.lastAssistantAt;
    if (!userAfter) return "needs_input";
  }

  if (fresh) return "thinking";
  if (recent) return "running";
  return "idle";
}

export async function listProjects() {
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function listSessionFiles(projectKey) {
  const dir = path.join(PROJECTS_DIR, projectKey);
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function readSession(filePath, { processIndex } = {}) {
  const stat = await fs.stat(filePath);
  const { text, start } = await readTail(filePath);
  const events = parseLines(text, start > 0);
  const state = extractStateFromEvents(events);

  const id = path.basename(filePath, ".jsonl");
  const projectKey = path.basename(path.dirname(filePath));
  // Prefer cwd from event payloads — projectKey is ambiguous when dir names contain dashes.
  const cwd = state.cwdFromEvents || projectKeyToCwd(projectKey);
  const ageMs = NOW() - stat.mtimeMs;

  return {
    id,
    projectKey,
    cwd,
    project: projectDisplayName(cwd),
    title: state.title,
    lastPrompt: state.lastPrompt,
    permissionMode: state.permissionMode,
    pr: state.lastPrLink,
    goal: state.lastGoalStatus,
    gitBranch: state.gitBranch,
    version: state.version,
    mtimeMs: stat.mtimeMs,
    ageMs,
    sizeBytes: stat.size,
    // status, pid, tty are filled in by snapshot() once it knows the cohort per cwd.
    status: null,
    pid: null,
    tty: null,
    processCount: 0,
    stopReason: state.lastAssistantStopReason,
    pendingToolUse: state.pendingToolUse,
    lastAssistantHadToolUse: state.lastAssistantHadToolUse,
    lastUserAt: state.lastUserAt,
    lastAssistantAt: state.lastAssistantAt,
    tools: state.toolEvents.slice(-30), // last 30 tool calls for the strip
  };
}

export async function snapshot(processIndex) {
  const projects = await listProjects();
  const raw = [];
  for (const key of projects) {
    const files = await listSessionFiles(key);
    for (const f of files) {
      try {
        const s = await readSession(f);
        if (s.ageMs > 12 * 60 * 60 * 1000) continue; // cap at 12h
        raw.push(s);
      } catch {
        /* skip unreadable */
      }
    }
  }

  // Group by cwd and assign live processes to the most recent sessions per cwd.
  // Reason: multiple .jsonl files can belong to the same project; older ones are
  // history, the newest N (= process count) are the live ones.
  const byCwd = new Map();
  for (const s of raw) {
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    byCwd.get(s.cwd).push(s);
  }

  for (const [cwd, sessions] of byCwd) {
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const procs = (processIndex?.byCwd.get(cwd) || []).slice();
    // Pair newest session ↔ youngest process. Use startedAt when known,
    // fall back to pid (monotonic on macOS, modulo wraparound).
    procs.sort((a, b) => {
      if (a.startedAt != null && b.startedAt != null) return b.startedAt - a.startedAt;
      return b.pid - a.pid;
    });
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const proc = procs[i] || null;
      s.processCount = procs.length;
      s.pid = proc?.pid || null;
      s.tty = proc?.tty || null;
      s.status = deriveStatus({
        state: {
          pendingToolUse: s.pendingToolUse,
          lastAssistantStopReason: s.stopReason,
          lastAssistantHadToolUse: s.lastAssistantHadToolUse,
          lastUserAt: s.lastUserAt,
          lastAssistantAt: s.lastAssistantAt,
        },
        ageMs: s.ageMs,
        hasProcess: Boolean(proc),
      });
    }
  }

  raw.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return raw;
}
