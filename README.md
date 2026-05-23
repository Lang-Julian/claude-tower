# claude-tower

> Air-traffic control for your Claude Code swarm. See every session, approve permissions remotely, track cost — all on localhost.

**Status:** WIP — bootstrapping. README placeholder; v0.1 lands shortly.

## What it does

When you run 5+ `claude` sessions in parallel, you lose track. Tower watches them all:

- **Live status board** — see which session is thinking, which needs you, which is idle
- **Remote approval** — approve/deny permission prompts without switching terminals
- **Cost tracking** — per-session and global token usage, $-amount, 5h-burn-rate
- **Mobile access** — scan a QR, approve from your phone
- **Telegram pings** — get notified with inline approve/deny buttons
- **History** — every session, every tool call, queryable forever

Local-first. Zero cloud. One native dependency (`better-sqlite3`).

## Install

```bash
npm install -g claude-tower
tower install-hooks   # one-time: register Claude Code hooks
tower start           # open http://localhost:7777
```

## License

MIT — see [LICENSE](./LICENSE).
