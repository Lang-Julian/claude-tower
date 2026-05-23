import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, "settings.json");

// Tower-specific state lives in ~/.claude-tower/
// TOWER_DIR_OVERRIDE env var lets tests / sandboxed runs use a temp dir.
export const TOWER_DIR = process.env.TOWER_DIR_OVERRIDE || path.join(HOME, ".claude-tower");
export const DB_PATH = path.join(TOWER_DIR, "tower.sqlite");
export const TOKEN_PATH = path.join(TOWER_DIR, "auth.token");
export const PID_FILE = path.join(TOWER_DIR, "tower.pid");
export const LOG_FILE = path.join(TOWER_DIR, "tower.log");
export const APPROVAL_QUEUE = path.join(TOWER_DIR, "approvals");
export const PORT_FILE = path.join(TOWER_DIR, "port");

export async function ensureTowerDir() {
  await fs.mkdir(TOWER_DIR, { recursive: true });
  await fs.mkdir(APPROVAL_QUEUE, { recursive: true });
}
