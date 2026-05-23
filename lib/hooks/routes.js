// STUB — replaced by Agent: Hooks. Keeps server bootable in the meantime.
export function mountHooks(app, { db, notifier }) {
  app.route("POST", "/api/hook", async ({ res }) => {
    res.writeHead(501); res.end("hooks not yet implemented");
  });
}
