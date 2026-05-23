<div align="center">

# claude-tower

**Air-traffic control for your Claude Code swarm.**

See every session. Approve permissions from anywhere. Track every dollar.
All on `localhost`.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)]()
[![Made for Claude Code](https://img.shields.io/badge/made_for-Claude_Code-D97757)](https://claude.com/claude-code)

</div>

---

## Why

You run `claude` in five terminals.
One is asking for a permission. Two are thinking. One finished an hour ago. One is silently burning $0.40/min.

You don't see any of it.

`claude-tower` watches them all. It runs on your laptop, talks to nothing on the internet, and turns the chaos into a single board you actually look at.

```
  ┌─ claude-tower ───────────────────────── 5 sessions ── $4.23 today ── $1.10/h ──┐
  │                                                                                │
  │   ● needs you      ai-in-the-box       "approve npm publish?"      pid 10901   │
  │   ● permission     brane-aif           "Bash: rm -rf node_modules"     [a/d]   │
  │   ◐ thinking       ai-z-website        editing landing.tsx           pid 7894  │
  │   ○ idle 4m        ki-schulungen       last: deploy to vercel        pid 9452  │
  │   ○ idle 22m       holding-docs        last: contract review         pid 5298  │
  │                                                                                │
  └────────────────────────────────────────────────────────────────────────────────┘
```

## What makes it different

| | claude-tower | other dashboards |
|---|---|---|
| **Remote permission approval** | ✅ Approve/Deny in the card | ❌ Switch to terminal |
| **Telegram inline buttons** | ✅ Approve from your phone | ❌ Just notifies |
| **Cost tracking** | ✅ Per session + 5h burn-rate | ⚠️ Sometimes |
| **Historic sessions** | ✅ SQLite, never lose a session | ❌ JSONL only |
| **Hooks-driven, not polled** | ✅ Sub-second updates | ❌ Polls every 2-5s |
| **Mobile-ready** | ✅ QR + token, runs over LAN | ❌ Localhost only |
| **Dependencies** | 1 native (`better-sqlite3`) | 50+ npm tree |

## Install

```bash
npm install -g claude-tower
tower install-hooks    # one-time: registers Claude Code hooks
tower start            # opens http://localhost:7777
```

For mobile access:

```bash
tower start --mobile   # binds 0.0.0.0, prints QR with token
```

Stop with `tower stop`. Logs at `~/.claude-tower/tower.log`.

## Features

### Live session board
Polls `~/.claude/projects/**/*.jsonl` and `ps`/`lsof`. Hooks (optional) push events in real time. Status model: `thinking` · `needs_input` · `needs_permission` · `running` · `idle` · `stopped` · `archived`.

### Remote permission approval
Claude Code about to `Bash: rm -rf`? You see it on the card. Click `[a]pprove` / `[d]eny` — or tap the Telegram button. No terminal switch.

### Cost & token tracking
Reads token usage from every assistant message. Computes cost via the public Anthropic price table. Aggregates into Anthropic's 5-hour billing windows. Shows per-session + global + burn-rate. Inspired by [`ccusage`](https://github.com/ryoppippi/ccusage).

### Click-to-focus
Click any card → tower brings the right iTerm tab to the front via AppleScript. Works with multiple windows, minimized state, separate Spaces.

### Telegram bridge
Get pinged when an agent needs you. Inline keyboard for approve/deny. Configure via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `~/.env.secrets`. Disable with `--no-telegram`.

### Mobile access
`tower start --mobile` binds to your LAN, generates a token, prints a QR. Scan with your phone, you're in. Token-auth via `Bearer` header or cookie. Bind to Tailscale for anywhere-access.

### Historic sessions
SQLite at `~/.claude-tower/tower.sqlite`. Every event lives forever. Query with `tower db` (or any SQLite tool).

## CLI

```
tower start [--port N] [--mobile] [--open]   start the daemon
tower stop                                    stop the daemon
tower restart                                 restart
tower status                                  is it running? what's the state?
tower sessions [--all] [--json]               list sessions
tower approve <id>                            approve a pending permission
tower deny <id> [reason]                      deny one
tower install-hooks                           register Claude Code hooks
tower uninstall-hooks                         remove them
tower logs [-f]                               tail the log
tower mobile                                  print QR for current instance
tower db                                      open SQLite shell
```

## Architecture

```
┌──────────────┐    hooks (real-time)    ┌──────────────┐
│  claude CLI  │ ───────────────────────▶│  tower server│──▶ SQLite
└──────────────┘                         └──────────────┘    events
       │                                         │           usage
       │  writes ~/.claude/projects/*.jsonl      │           approvals
       │                                         ▼
       │                                  ┌──────────────┐
       └────── polled every 2s ──────────▶│  Dashboard   │
                                          │  + Telegram  │
                                          └──────────────┘
```

Two ingest paths run side by side. Hooks give sub-second latency; polling is the safety net that works even before you've installed hooks.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full spec.

## Security

- Server binds to `127.0.0.1` by default. `--mobile` opens it to your LAN behind a Bearer token (regenerable with `rm ~/.claude-tower/auth.token`).
- No external calls except Telegram (opt-in).
- Hook payloads stay on-device. Nothing about your prompts, files, or commands leaves the box.
- SQLite DB at `~/.claude-tower/tower.sqlite` is yours. Delete it whenever.

## Prior art & inspiration

- [`bruceyxli/claude-code-monitor`](https://github.com/bruceyxli/claude-code-monitor) — pioneered remote approval & anomaly detection
- [`ryoppippi/ccusage`](https://github.com/ryoppippi/ccusage) — gold standard for cost calculation, we re-implement its math
- [`disler/claude-code-hooks-multi-agent-observability`](https://github.com/disler/claude-code-hooks-multi-agent-observability) — hook-driven event architecture
- [`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad) — multi-agent orchestration pattern
- [`k9s`](https://github.com/derailed/k9s) — keyboard-first dashboard ergonomics

## Roadmap

- [x] v0.1 — live board, click-to-focus, telegram, cost tracking, remote approval, hooks
- [ ] v0.2 — historic session replay, per-tool latency histograms, anomaly detection
- [ ] v0.3 — Linux support (replace iTerm/AppleScript with tmux/wezterm bridge)
- [ ] v0.4 — workspaces, multi-machine federation, OTel export

## Contributing

PRs welcome. Stack is intentionally boring: pure Node ESM, vanilla JS frontend, one native dep. No build step, no framework lock-in.

```bash
git clone https://github.com/julianlang/claude-tower.git
cd claude-tower
npm install
node server.js
```

Tests: `npm test`. Style: see existing code — comments only when the *why* is non-obvious; no narration of *what* the code does.

## License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

Built by [Julian Lang](https://github.com/julianlang) · [AI-Z Group](https://ai-z-group.com)

If this saves you 10 minutes a day, [drop a ⭐ on the repo](https://github.com/julianlang/claude-tower).

</div>
