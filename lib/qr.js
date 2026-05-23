// QR rendering for the mobile flow.
//
// Strategy (pragmatism > purity):
//   1. If `qrencode` is on PATH, shell out (`qrencode -t ANSIUTF8 -m 1`).
//   2. Otherwise print a loud boxed fallback with the URL + token in plain text —
//      the user can still type it on their phone, just not as quick.
//
// Token: 24 random bytes, base64url-encoded. Persisted to TOKEN_PATH (chmod 600).

import { promises as fs, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import { TOKEN_PATH, ensureTowerDir } from "./paths.js";
import { box, c } from "./cli/output.js";

export async function getOrCreateToken() {
  await ensureTowerDir();
  try {
    const existing = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    if (existing) return existing;
  } catch { /* file missing → create */ }
  const token = crypto.randomBytes(24).toString("base64url");
  await fs.writeFile(TOKEN_PATH, token + "\n", { mode: 0o600 });
  try { await fs.chmod(TOKEN_PATH, 0o600); } catch {}
  return token;
}

function hasBin(name) {
  // PATH lookup without shelling out to `which` (which may not exist on some shells).
  const PATH = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const full = dir + "/" + name;
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Render a URL as a QR code on stdout (no return value — prints directly).
 * Always also prints the plain URL+token as a fallback below the QR.
 */
export function renderQr(url, { token } = {}) {
  const qrencode = hasBin("qrencode");
  if (qrencode) {
    const res = spawnSync(qrencode, ["-t", "ANSIUTF8", "-m", "1", url], {
      encoding: "utf8",
    });
    if (res.status === 0 && res.stdout) {
      process.stdout.write(res.stdout);
      process.stdout.write("\n");
    } else {
      printFallback(url);
    }
  } else {
    printFallback(url);
  }
  printDetails(url, token);
}

function printFallback(url) {
  const tip = c.dim("install `qrencode` for a scannable QR:  brew install qrencode");
  console.log();
  console.log(box(c.bold("Scan from your phone (or type the URL)") + "\n" + url));
  console.log(tip);
}

function printDetails(url, token) {
  console.log();
  console.log("  " + c.bold("URL:   ") + url);
  if (token) console.log("  " + c.bold("Token: ") + c.dim(token));
  const ip = lanIp();
  if (ip) console.log("  " + c.dim(`LAN:   http://${ip}:${urlPort(url)}/`));
  console.log();
}

function urlPort(url) {
  try { return new URL(url).port || "7777"; } catch { return "7777"; }
}

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const it of list || []) {
      if (it.family === "IPv4" && !it.internal && !it.address.startsWith("169.254.")) {
        return it.address;
      }
    }
  }
  return null;
}
