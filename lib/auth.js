// Token-based auth for --mobile mode.
//
// Local (127.0.0.1) requests always pass. Non-local requests must present
// `Authorization: Bearer <token>` OR `?token=<token>` OR a `tower_token` cookie.
//
// The token lives in TOKEN_PATH (chmod 600). The CLI prints it as a QR on
// `tower start --mobile`.

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { TOKEN_PATH, ensureTowerDir } from "./paths.js";

let _token = null;

export async function getOrCreateToken() {
  if (_token) return _token;
  await ensureTowerDir();
  try {
    _token = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    if (_token) return _token;
  } catch { /* file missing */ }
  _token = randomBytes(24).toString("base64url");
  await fs.writeFile(TOKEN_PATH, _token, { mode: 0o600 });
  return _token;
}

export function isLocalAddress(addr) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// Returns true if the request is allowed.
export function authorize(req, { mobile, token }) {
  const remote = req.socket.remoteAddress;
  if (isLocalAddress(remote)) return true;
  if (!mobile) return false; // not exposed to LAN
  if (!token) return false;

  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === token) return true;

  const cookie = req.headers["cookie"] || "";
  const m = cookie.match(/(?:^|;\s*)tower_token=([^;]+)/);
  if (m && decodeURIComponent(m[1]) === token) return true;

  try {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    if (url.searchParams.get("token") === token) {
      // Issue cookie so subsequent requests don't need the query param
      // (handled by the caller, which has the response object).
      return "set-cookie";
    }
  } catch { /* malformed url */ }

  return false;
}
