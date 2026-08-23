# kclaw

English | [中文](./README.zh-CN.md)

A locally resident personal agent: a single daemon owns all state; the CLI and WebUI are just its clients.

```
                    127.0.0.1 (HTTP + WebSocket, Bearer token auth)
   ┌────────────────────────────────────────────────────────────┐
   │                                                            │
   │  kclaw CLI ──────┐          ┌── WebUI (statically hosted dist)
   │                  ▼          ▼                               │
   │           @kclaw/server (daemon, the only state authority) │
   │           ├─ RunManager: send_message → per-session serial run
   │           ├─ Confirmation gate: risky tools confirm over WS, logged to audit
   │           ├─ Scheduler tick: cron jobs open a new session on schedule
   │           └─ Event bus: 28 AgentEvent kinds broadcast to subscribed clients
   │                          │                                 │
   │                          ▼                                 │
   │           @kclaw/core (pure-library agent engine: loop/tools/memory/permissions)
   │                          │                                 │
   └──────────────────────────┼─────────────────────────────────┘
                              ▼
   ~/.kclaw/  config.yaml · AGENTS.md · token · daemon.json
              sessions/<id>/messages.jsonl (the conversation truth)
              memory/ (markdown notes + SQLite FTS5 index)
              jobs.db · attachments/ · logs/
```

---

## Installation

Requirements: Node >= 22 (checked at CLI startup; exits if unmet).

```bash
npm i -g kclaw

kclaw chat    # first run enters the setup wizard: pick provider → paste key → automatic connectivity check
kclaw web     # open the WebUI in your browser (carries the token, auto sign-in)
```

The wizard ships DeepSeek / OpenAI / Ollama / custom templates; key input is hidden; after a successful probe it writes `~/.kclaw/config.yaml` (mode 0600). You can also skip the wizard and edit the config by hand or use environment variables — see "Configuration".

> [!TIP]
> New to kclaw? Follow the step-by-step tutorial (in Chinese): [中文上手教程](./docs/tutorial.md) — from installation through jobs to the WebUI.

> [!NOTE]
> The daemon does not need to be started separately: `kclaw chat` / `kclaw web` start it automatically when they find it missing.

---

## Features

- **Streaming chat**: the CLI REPL and the WebUI share the same experience — replies render as a stream, multi-turn and new sessions supported (example: asking "what is the largest file in `~/Downloads`" triggers the exec tool).
- **Confirmation cards**: risky tools (exec, fs_edit, …) ask before executing (allow / deny); every decision is written to the audit log.
- **Sessions**: every message is persisted to `sessions/<id>/messages.jsonl`; history can be resumed at any time.
- **Memory**: entering "remember I live in Shanghai" stores a markdown note (with a SQLite FTS5 index); a later "where do I live?" hits the note.
- **Jobs**: cron-scheduled jobs (e.g. `0 9 * * *` for a daily briefing); the daemon opens a new session on schedule and logs results to audit.
- **Audit**: permission decisions leave a full trail, viewable in the WebUI "audit" tab.

---

## FAQ

| Symptom | Cause & fix |
|---------|-------------|
| `command not found: kclaw` | npm's global bin directory is not on PATH (`npm config get prefix` shows the install location) |
| `no llm provider configured` | No model configured: run `kclaw chat` once for the setup wizard, or write config / env vars by hand per "Configuration" |
| Page won't open / 401 | The port may change on each daemon start (check the current port with `kclaw daemon status`, or run `kclaw web` directly); the token stays the same across restarts, no need to re-fetch it |
| No confirmation prompt on a risky action | The command matched the `permissions.allow` whitelist (see "Configuration" below) |
| Where is my data | All under `~/.kclaw/`: config.yaml · token · daemon.json · sessions/ · memory/ · jobs.db · logs/ |

---

## Common Commands

| Command | Purpose |
|---------|---------|
| `kclaw` / `kclaw chat` | Enter the chat REPL (the default action) |
| `kclaw chat --session <id>` | Resume a specific session |
| `kclaw chat --think` | Show the thinking stream (hidden by default) |
| `kclaw web` | Open the WebUI in the browser (carries the token; starts the daemon if missing) |
| `kclaw daemon start \| stop \| status` | Daemon lifecycle (start is idempotent, writes `~/.kclaw/daemon.json`; stop sends SIGTERM) |
| `kclaw status` | Alias of `daemon status` |
| `kclaw jobs list` | List scheduled jobs (name/cron/enabled/nextRunAt/lastStatus) |

Inside the REPL: `/exit` to quit, `/sessions` to list sessions, `/new <title>` for a new session; Ctrl+C cancels the current run.

---

## WebUI

`packages/web` (React + Vite) is the daemon's official frontend; its build output is statically hosted by the daemon. Feature parity with the CLI (the same HTTP + WS API): streaming chat, confirmation cards, sessions, jobs, audit.

The daily entry point is a single command:

```bash
kclaw web    # starts the daemon if needed, opens the browser with the token
```

Alternative (manual token): the port is in the daemon startup output or `kclaw daemon status`; the token is the content of `~/.kclaw/token`. Pick one:

1. **Token in the URL**: `http://127.0.0.1:<port>/?token=<token>`
2. **Type it in**: open `http://127.0.0.1:<port>/` without a token, paste it into the token input once; it is stored in localStorage and not needed again.

---

## Configuration (`~/.kclaw/config.yaml`)

The setup wizard writes exactly this file; a handwritten example looks like:

```yaml
providers:
  default: my-provider
  entries:
    my-provider:
      baseUrl: https://api.example.com/v1   # any OpenAI-compatible endpoint
      apiKey: sk-...
      model: some-model
```

| Field | Description |
|-------|-------------|
| `providers` | As above. When absent, the `KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL` environment variables also work (config wins over env). Local Ollama works: `baseUrl: http://127.0.0.1:11434/v1`, `apiKey: ollama`. |
| `workspace` | Sandbox root for file tools (fs_read/fs_edit, …); access outside it is denied. |
| `permissions.allow / deny` | Prefix-matching rules (e.g. `exec:git *`): allow skips confirmation, deny rejects outright, everything else asks. |
| `exec.timeoutMs / maxOutputBytes` | Timeout and output truncation for the exec tool. |
| `web.tavilyApiKey` | Optional; enables web_search. |
| `web.timeoutMs` | Timeout for web tool requests (default 20000ms; both `web_search` and `web_fetch` are bound by it — a hung site no longer stalls the whole run). |
| `web.allowPrivateNetworks` | Default `false`: `web_fetch` refuses addresses that resolve to private/loopback networks (checked on every redirect hop). Set `true` to allow them — e.g. fetching from local services such as an on-host Ollama. |
| `~/.kclaw/AGENTS.md` | Agent persona, injected into the system prompt. |

`exec:` rules match a normalized command — whitespace collapsed to single spaces, command token reduced to its basename (`/bin/rm` ≡ `rm`). A command containing continuations (`;` `&&` `||` `|`, newlines, command substitution `$(...)`/backticks) never matches `allow` or a session grant — it falls back to confirmation — while `deny` is matched against each sub-command separately. Exec rules are a best-effort fence, not a sandbox.

> [!NOTE]
> The data directory can be redirected with `KCLAW_HOME` or `--home <dir>` (test friendly).

---

## Development

Building from source. Regular users only need `npm i -g kclaw` above; skip this section. Platforms: macOS and Linux; Windows is not a supported target.

monorepo (pnpm workspace):

| Package | Role |
|---------|------|
| `packages/core` | The agent engine, a pure library (loop / tools / memory / permissions) |
| `packages/server` | The daemon (HTTP + WS + scheduling + audit) |
| `packages/cli` | The CLI client (source form) |
| `packages/web` | The WebUI frontend (React + Vite) |
| `packages/kclaw` | The npm release package (aggregates the other packages' build output; `npm i -g kclaw` installs this one) |

```bash
pnpm install
pnpm build
pnpm typecheck   # tsc --noEmit for every package
pnpm test        # vitest for every package (cli/server smoke tests need pnpm build first)
```

Docs:

- [architecture — the big picture](docs/architecture.md): module map, process model, data flow; the entry point to every other doc
- core/ (agent engine, pure library)
  - [agent-loop](docs/core/agent-loop.md) — the run loop
  - [protocol](docs/core/protocol.md) — the message / block / event three-layer protocol
  - [provider](docs/core/provider.md) — the OpenAI-compatible LLM access layer
  - [tools](docs/core/tools.md) — the built-in tool system and registration
  - [permissions](docs/core/permissions.md) — the permission gate
  - [jobs](docs/core/jobs.md) — cron job scheduling
  - [memory](docs/core/memory.md) — memory storage (SQLite FTS5)
  - [storage](docs/core/storage.md) — paths, config, and session persistence
- server/ (the daemon)
  - [daemon](docs/server/daemon.md) — lifecycle and auth
  - [http-api](docs/server/http-api.md) — HTTP routes
  - [realtime](docs/server/realtime.md) — the WS protocol and event bus
  - [run-manager](docs/server/run-manager.md) — per-session serial runs and the confirmation gate
- cli/ (terminal client)
  - [cli](docs/cli/cli.md) — commands, the REPL, slash commands
  - [onboarding](docs/cli/onboarding.md) — first-run experience (provider detection / wizard / web command)
- web/ (browser client)
  - [webui](docs/web/webui.md) — views, token bootstrap, the WS client
- [extending — extension guide](docs/extending.md): which files to change when adding a new feature
- [tutorial](docs/tutorial.md): hands-on walkthrough for first-time users (in Chinese, 中文上手教程)
