// Idempotent installer for the Claude Code hook entries.
//
// We append our command to each matcher's `hooks` array rather than replacing
// the array, so user-configured hooks survive. Identification is by the
// `TOWER_HOOK_MARKER` substring in the command — that's how we find our own
// entries to update or remove later.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SETTINGS } from "../paths.js";

const TOWER_HOOK_MARKER = "claude-tower-hook";

// Events we register for. Matcher "*" = all tool names (only meaningful for
// PreToolUse/PostToolUse; the others ignore matcher).
const EVENTS = [
  { name: "PreToolUse",       matcher: "*" },
  { name: "PostToolUse",      matcher: "*" },
  { name: "Stop",             matcher: "" },
  { name: "Notification",     matcher: "" },
  { name: "SubagentStop",     matcher: "" },
  { name: "UserPromptSubmit", matcher: "" },
];

function defaultHandlerPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "handler.js");
}

function buildCommand(handlerPath) {
  // Marker keeps the command identifiable for uninstall.
  return `node ${JSON.stringify(handlerPath)} # ${TOWER_HOOK_MARKER}`;
}

async function readSettings(settingsPath) {
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

async function writeSettings(settingsPath, obj) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function backup(settingsPath) {
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const ts = Date.now();
    const dest = `${settingsPath}.tower-backup-${ts}`;
    await fs.writeFile(dest, raw, "utf8");
    return dest;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function installHooks(opts = {}) {
  const settingsPath = opts.settingsPath || CLAUDE_SETTINGS;
  const handlerPath = opts.handlerPath || defaultHandlerPath();
  const command = buildCommand(handlerPath);
  const backupPath = await backup(settingsPath);

  const settings = await readSettings(settingsPath);
  settings.hooks = settings.hooks || {};

  // First pass: sweep ALL existing tower entries across every matcher entry of
  // every event. This guarantees old installs (e.g. different handler path,
  // different matcher convention) get cleaned up — not just collisions in the
  // matcher we're about to write into.
  for (const evName of Object.keys(settings.hooks)) {
    const list = settings.hooks[evName];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      entry.hooks = entry.hooks.filter(
        (h) => !(h && typeof h.command === "string" && h.command.includes(TOWER_HOOK_MARKER)),
      );
    }
    // Drop matcher entries that became empty after the sweep.
    settings.hooks[evName] = list.filter((e) => Array.isArray(e?.hooks) && e.hooks.length > 0);
  }

  // Second pass: register our hook into the canonical matcher slot.
  for (const { name, matcher } of EVENTS) {
    const list = (settings.hooks[name] = settings.hooks[name] || []);
    let entry = list.find((m) => (m.matcher ?? "") === matcher);
    if (!entry) {
      entry = { matcher, hooks: [] };
      list.push(entry);
    }
    entry.hooks = entry.hooks || [];
    entry.hooks.push({ type: "command", command });
  }

  await writeSettings(settingsPath, settings);
  return { settingsPath, backupPath, handlerPath };
}

export async function uninstallHooks(opts = {}) {
  const settingsPath = opts.settingsPath || CLAUDE_SETTINGS;
  const backupPath = await backup(settingsPath);
  const settings = await readSettings(settingsPath);
  if (!settings.hooks) return { settingsPath, backupPath, removed: 0 };

  let removed = 0;
  for (const name of Object.keys(settings.hooks)) {
    const list = settings.hooks[name];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry?.hooks) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter(
        (h) => !(h && typeof h.command === "string" && h.command.includes(TOWER_HOOK_MARKER)),
      );
      removed += before - entry.hooks.length;
    }
    // Drop matcher entries that are now empty (only ones we created).
    settings.hooks[name] = list.filter((e) => Array.isArray(e?.hooks) && e.hooks.length > 0);
    if (settings.hooks[name].length === 0) delete settings.hooks[name];
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await writeSettings(settingsPath, settings);
  return { settingsPath, backupPath, removed };
}

export { TOWER_HOOK_MARKER };
