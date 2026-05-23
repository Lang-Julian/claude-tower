// Minimal router built on top of the native http server.
// Routes register themselves via `app.route(method, path, handler)`.
// Path supports `:param` and `*` (rest). No regex, no deps.

import path from "node:path";
import { promises as fs } from "node:fs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export function createApp({ publicDir }) {
  const routes = [];
  const sseClients = new Set();

  const app = {
    route(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), pattern, parts: splitPath(pattern), handler });
    },
    broadcast(payload) {
      const data = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of sseClients) {
        try { res.write(data); } catch { /* ignore */ }
      }
    },
    addSseClient(res) {
      sseClients.add(res);
      return () => sseClients.delete(res);
    },
    sseClientCount: () => sseClients.size,
    async handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const reqParts = splitPath(url.pathname);
      for (const r of routes) {
        if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) continue;
        const params = matchPath(r.parts, reqParts);
        if (!params) continue;
        try {
          await r.handler({ req, res, url, params, app, body: () => readBody(req) });
        } catch (e) {
          console.error(`[${r.method} ${r.pattern}]`, e);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e.message || e) });
        }
        return;
      }
      // Fallback to static
      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(res, publicDir, url.pathname);
      }
      send(res, 404, "not found");
    },
  };

  return app;
}

function splitPath(p) {
  return p.split("/").filter(Boolean);
}

// Returns params object if match, else null.
function matchPath(routeParts, reqParts) {
  if (routeParts.length === 1 && routeParts[0] === "*") return {};
  if (routeParts.length !== reqParts.length) return null;
  const params = {};
  for (let i = 0; i < routeParts.length; i++) {
    const rp = routeParts[i];
    const xp = reqParts[i];
    if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(xp);
    else if (rp !== xp) return null;
  }
  return params;
}

async function serveStatic(res, publicDir, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const safe = path.normalize(rel).replace(/^\/+/, "");
  const full = path.join(publicDir, safe);
  if (!full.startsWith(publicDir)) return send(res, 403, "forbidden");
  try {
    const body = await fs.readFile(full);
    const ext = path.extname(full);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    send(res, 404, "not found");
  }
}

export function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

export function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(obj));
}

export async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function readJson(req) {
  return readBody(req).then((b) => (b ? JSON.parse(b) : {}));
}
