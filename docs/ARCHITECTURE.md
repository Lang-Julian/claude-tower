# claude-tower architecture

This document is the spec multiple parallel coding agents work from. Keep it short and current.

## Layout

```
claude-tower/
├── bin/tower               # CLI entry
├── server.js               # http+sse server (entry)
├── lib/
│   ├── paths.js            # filesystem constants (DB, hooks, queue dirs)
│   ├── config.js           # runtime config + model pricing table
│   ├── db.js               # SQLite event store (better-sqlite3)
│   ├── sessions.js         # scans ~/.claude/projects/**/*.jsonl → session state
│   ├── processes.js        # ps+lsof → live claude processes (cwd, tty, startedAt)
│   ├── iterm.js            # AppleScript: focus iTerm tab by tty
│   ├── notifier.js         # Telegram bot push (incl. inline approve/deny buttons)
│   ├── usage.js            # token+cost aggregation (ccusage-style)
│   ├── approvals.js        # permission decision queue (web/telegram/cli)
│   ├── hooks/
│   │   ├── install.js      # writes hook entries into ~/.claude/settings.json
│   │   ├── handler.js      # the binary the hook actually runs; posts to /api/hook
│   │   └── pre-tool-use.js # decision logic (block / approve / passthrough)
│   └── auth.js             # token-based auth for mobile/LAN access
├── public/                 # static dashboard assets (vanilla js + custom elements)
└── test/                   # node:test
```

## Data model

Single SQLite DB at `~/.claude-tower/tower.sqlite`:

- `sessions` — one row per claude session id ever seen
- `events` — append-only event log (every tool_use, tool_result, hook fire, status change)
- `usage` — extracted token usage per assistant message; cost computed via `config.priceFor()`
- `approvals` — pending + decided permission decisions

`events` is the source of truth. Other tables are projections. Re-derivable.

## Event flow

```
┌──────────────┐     hooks       ┌──────────────┐
│ claude CLI   │ ───────────────▶│ /api/hook    │──▶ events table
└──────────────┘                 └──────────────┘
       │                                 │
       │  writes .jsonl                  │ broadcast (SSE)
       ▼                                 ▼
~/.claude/projects/                ┌──────────────┐
       │                           │ Dashboard    │
       │  poll 2s                  │ + Telegram   │
       └─────▶ sessions.js ───────▶└──────────────┘
              processes.js
```

Two ingest paths:
1. **Hook-driven (preferred)** — real-time, but only works after `tower install-hooks`
2. **Polling JSONL + ps/lsof (fallback)** — always works, ~2s latency

When both fire for the same event, hook wins (de-duped by session_id + ts).

## Approval flow

1. Claude Code fires `PreToolUse` hook for a sensitive tool
2. Hook handler creates an approval row (`decision = NULL`), broadcasts SSE
3. Dashboard / Telegram show Approve / Deny buttons
4. User clicks → `POST /api/approvals/:id` writes decision
5. Hook handler (blocked in step 2 on file-based wait) reads decision, exits with `{permissionDecision: "allow"|"deny"}`
6. Claude Code proceeds or skips the tool

Wait mechanism: handler polls `approvals` table every 200ms (timeout configurable, default infinite). For Telegram, the bot's webhook updates the same row.

## Status derivation

`lib/sessions.js#deriveStatus` is the brain. Output is one of:
- `thinking` (fresh activity, no pending response)
- `needs_input` (assistant ended turn, waiting on user)
- `needs_permission` (pending tool_use OR pending approval row)
- `running` (recent activity, indeterminate)
- `idle` (process alive, quiet >90s)
- `stopped` / `archived` (no process)

## Endpoints (current + planned)

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/sessions`       | snapshot JSON |
| GET    | `/api/events`         | SSE stream |
| POST   | `/api/focus`          | focus iTerm tab by tty |
| POST   | `/api/notifier`       | toggle Telegram |
| POST   | `/api/hook`           | hook callback ingress |
| GET    | `/api/approvals`      | list pending |
| POST   | `/api/approvals/:id`  | decide |
| GET    | `/api/usage`          | aggregated tokens/cost |
| GET    | `/api/usage/:sessionId` | per-session |

## Security model

- Server binds 127.0.0.1 only by default
- `--mobile` flag binds 0.0.0.0 + requires Bearer token (printed as QR on stdout)
- No external network calls except Telegram (opt-in)
- Hook payloads are local-only; no PII leaves the box

## Non-goals (v1)

- No cloud sync, no team mode, no multi-user
- No editor integration (use Claude Code itself)
- No model proxy or LLM calls of our own
- No Linux/Windows yet (macOS first because iTerm focus + ps are macOS-tuned)
