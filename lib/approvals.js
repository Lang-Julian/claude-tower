// STUB — replaced by Agent: Approval. Keeps server bootable in the meantime.
export function mountApprovals(app, { db, notifier }) {
  app.route("GET", "/api/approvals", ({ res }) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pending: [] }));
  });
}
