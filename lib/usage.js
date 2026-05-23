// STUB — replaced by Agent: Usage. Keeps server bootable in the meantime.
export function mountUsage(app, { db }) {
  app.route("GET", "/api/usage", ({ res }) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ totalCostUsd: 0, sessions: [] }));
  });
}
