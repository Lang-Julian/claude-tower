# Contributing to claude-tower

Thanks for considering it. The repo is intentionally small and boring — that's a feature.

## Ground rules

- **No build step.** No bundler, no transpiler. Plain ESM Node + vanilla JS frontend. If your patch needs Webpack, it's the wrong patch.
- **One dependency.** `better-sqlite3` is the only runtime dep. Add more only if there is no reasonable alternative (and bring it up in an issue first).
- **No frameworks on the frontend.** Custom Elements + ES modules are enough.
- **Comments only when "why" is non-obvious.** Don't narrate what the code does — names should do that. Comments explain hidden constraints, surprising behavior, or workarounds.
- **No emoji in code or docs.** Use them only when the user explicitly asks.

## Dev setup

```bash
git clone https://github.com/Lang-Julian/claude-tower.git
cd claude-tower
npm install
node server.js          # http://localhost:7777
# or for live reload:
npm run dev
```

For working on hooks, point Claude Code at a dev install:

```bash
TOWER_PORT=7798 node server.js          # dev instance
node lib/hooks/install.js --port 7798   # writes hook config
```

Undo with `node lib/hooks/install.js --uninstall`.

## Tests

```bash
npm test                  # node:test, no runner
node --test test/usage.test.js   # single file
```

Add a test for any non-trivial change. Tests live in `test/`. Use `node:test` and a tmp SQLite per test.

## Code review checklist

Before opening a PR:

- [ ] `npm test` passes
- [ ] Server boots: `node server.js` shows the banner, `curl localhost:7777/api/version` returns JSON
- [ ] Dashboard loads in a browser, sessions render
- [ ] No new runtime dep (or you have a good reason)
- [ ] No `console.log` debug noise left in
- [ ] Comments explain *why*, not *what*

## Architecture decisions

If your change touches data model, request flow, or security: read `docs/ARCHITECTURE.md` first. Update it in the same PR if you change anything it describes.

## Reporting issues

Please include:
- macOS version + Node version (`node -v`)
- Output of `tower status`
- Last 50 lines of `~/.claude-tower/tower.log`
- Steps to reproduce

## Scope

In:
- Anything that helps a developer running multiple Claude Code sessions in parallel
- macOS first; Linux PRs welcome if they don't break macOS
- Local-first; nothing that requires a cloud service

Out:
- Cloud sync, team mode, multi-user (different product)
- Editor integration (use Claude Code's own integrations)
- Model proxying or LLM calls of our own

## License

By contributing, you agree your contributions are licensed under MIT, same as the project.
