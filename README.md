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
   │           ├─ HTTP + WS routes · Bearer auth · audit        │
   │           ├─ RunManager: send_message → per-session queue  │
   │           └─ Scheduler tick: cron jobs + memory schedule   │
   │                          │                                 │
   │                          ▼                                 │
   │           @kclaw/core (pure-library agent engine)          │
   │           ├─ run assembly: agent loop, tools, permissions  │
   │           ├─ confirmation broker: risky tools confirm      │
   │           ├─ Event bus: 40 AgentEvent kinds                │
   │           └─ memory · compaction                           │
   │                          │                                 │
   └──────────────────────────┼─────────────────────────────────┘
                              ▼
   ~/.kclaw/  config.json · AGENTS.md · token · daemon.json
              sessions/<id>/events.jsonl (the conversation truth)
              memory/ (markdown threads + derived FTS5/vector index)
              jobs.db · attachments/ · logs/
```

---

## Installation

Requirements: Node >= 22 (checked at CLI startup; exits if unmet).

kclaw is not published to npm yet, so install it locally from source:

```bash
# 1. clone the repo
git clone https://github.com/zachysun/kclaw
cd kclaw

# 2. install dependencies and build (needs pnpm)
pnpm install
pnpm build

# 3. install the aggregate package globally from the local directory
npm i -g ./packages/kclaw

kclaw chat    # first run enters the setup wizard: pick provider → paste key → automatic connectivity check
kclaw web     # open the WebUI in your browser (carries the token, auto sign-in)
```

The wizard ships DeepSeek / OpenAI / Ollama / custom templates; key input is hidden; after a successful probe it writes `~/.kclaw/config.json` (mode 0600). You can also skip the wizard and edit the config by hand or use environment variables — see "Configuration".

> [!TIP]
> New to kclaw? Follow the step-by-step tutorial (in Chinese): [中文上手教程](./docs/tutorial.md) — from installation through jobs to the WebUI.

> [!NOTE]
> The daemon does not need to be started separately: `kclaw chat` / `kclaw web` start it automatically when they find it missing.

---

## Features

- **Streaming chat**: the CLI REPL and the WebUI share the same experience — replies render as a stream, multi-turn and new sessions supported (example: asking "what is the largest file in `~/Downloads`" triggers the exec tool).
- **Confirmation cards**: risky tools (exec, fs_edit, …) ask before executing with a four-way verdict (once / always-in-project / always-globally / reject); the "always" choices persist as rule files you can revoke from the WebUI "permissions" tab, and every decision is written to the audit log.
- **Permission modes**: each session switches independently between readonly / default / acceptEdits / trusted / auto (CLI Shift+Tab or `/mode`, WebUI always-on selector). readonly denies all writes; acceptEdits skips confirmation for in-workspace file edits; trusted auto-approves everything inside the sandbox/workspace boundary and denies everything outside; auto inducts operations you keep approving with `once` into persistent rules.
- **Sessions**: every message is persisted as part of the session's event stream (`sessions/<id>/events.jsonl`); history can be resumed at any time.
- **Memory**: after each turn, new messages are extracted into per-topic markdown thread files (with a derived FTS5 index); a later related question gets the matching episode injected as a note.
- **Jobs**: cron-scheduled jobs (e.g. `0 9 * * *` for a daily briefing); the daemon opens a new session on schedule and logs results to audit.
- **Agent team**: a lead session can create a team and recruit members (each a persistent child session); work is coordinated through a shared task board (claim / dependencies / completion), you can talk to any member or stop them one by one, and all coordination lives in the workspace's `.agent-teams/` directory with a full audit trail.
- **Audit**: permission decisions leave a full trail, viewable in the WebUI "audit" tab.

---

## FAQ

| Symptom | Cause & fix |
|---------|-------------|
| `command not found: kclaw` | The local install step was skipped, or npm's global bin directory is not on PATH — from the repo run `npm i -g ./packages/kclaw` and check the install location with `npm config get prefix` |
| `no llm provider configured` | No model configured: run `kclaw chat` once for the setup wizard, or write config / env vars by hand per "Configuration" |
| Page won't open / 401 | The port may change on each daemon start (check the current port with `kclaw daemon status`, or run `kclaw web` directly); the token stays the same across restarts, no need to re-fetch it |
| No confirmation prompt on a risky action | The command matched the `permissions.allow` whitelist (see "Configuration" below) |
| Where is my data | All under `~/.kclaw/`: config.json · token · daemon.json · sessions/ · memory/ · jobs.db · logs/ |

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
| `kclaw mcp [list]` | List configured MCP servers with connection state and tool counts |

Inside the REPL: `/exit` to quit, `/sessions` to list sessions, `/new <title>` for a new session; Ctrl+C cancels the current run.

---

## WebUI

`packages/web` (React + Vite) is the daemon's official frontend; its build output is statically hosted by the daemon. Feature parity with the CLI (the same HTTP + WS API): streaming chat, confirmation cards, sessions, jobs, audit, usage, trash, memory, skills, permissions, and MCP server management.

The daily entry point is a single command:

```bash
kclaw web    # starts the daemon if needed, opens the browser with the token
```

Alternative (manual token): the port is in the daemon startup output or `kclaw daemon status`; the token is the content of `~/.kclaw/token`. Pick one:

1. **Token in the URL**: `http://127.0.0.1:<port>/?token=<token>`
2. **Type it in**: open `http://127.0.0.1:<port>/` without a token, paste it into the token input once; it is stored in localStorage and not needed again.

---

## Configuration (`~/.kclaw/config.json`)

The setup wizard writes exactly this file; a handwritten example looks like:

```json
{
  "providers": {
    "default": "my-provider",
    "entries": {
      "my-provider": {
        "baseUrl": "https://api.example.com/v1",
        "apiKey": "sk-...",
        "model": "some-model"
      }
    }
  }
}
```

`baseUrl` may point at any OpenAI-compatible endpoint. A pre-JSON `config.yaml` is still read while `config.json` is absent, so an existing setup keeps working; the first program write (wizard or WebUI) lands in `config.json` and renames a leftover `config.yaml` to `config.yaml.bak`, which is no longer read.

| Field | Description |
|-------|-------------|
| `providers` | As above. When absent, the `KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL` environment variables also work (config wins over env). Local Ollama works: `baseUrl: http://127.0.0.1:11434/v1`, `apiKey: ollama`. |
| `workspace` | Sandbox root for file tools (fs_read/fs_edit, …); access outside it is denied. |
| `permissions.allow / deny` | Prefix-matching rules (e.g. `exec:git *`): allow skips confirmation, deny rejects outright, everything else asks. |
| `permissions.defaultMode` | Default permission mode for newly created sessions (`readonly` / `default` / `acceptEdits` / `trusted` / `auto`), frozen into each session at creation; changing it only affects sessions created afterwards. |
| `exec.timeoutMs / maxOutputBytes` | Timeout and output truncation for the exec tool. |
| `web.tavilyApiKey` | Optional; enables web_search. |
| `web.timeoutMs` | Timeout for web tool requests (default 20000ms; both `web_search` and `web_fetch` are bound by it — a hung site no longer stalls the whole run). |
| `web.allowPrivateNetworks` | Default `false`: `web_fetch` refuses addresses that resolve to private/loopback networks (checked on every redirect hop). Set `true` to allow them — e.g. fetching from local services such as an on-host Ollama. |
| `~/.kclaw/AGENTS.md` | Agent persona, injected into the system prompt. |

`exec:` rules match a normalized command — whitespace collapsed to single spaces, command token reduced to its basename (`/bin/rm` ≡ `rm`). Continuation splitting is quote-aware (`echo "a;b"` is one segment), and `deny` matching adds token-set coverage on top — reordered or aggregated flags (`rm -r -f` ≡ `rm -rf`) hit the blacklist too. A command containing continuations (`;` `&&` `||` `|`, newlines, command substitution `$(...)`/backticks) never matches `allow` or a session grant — it falls back to confirmation. Exec rules are a best-effort fence, not a sandbox.

> [!NOTE]
> The data directory can be redirected with `KCLAW_HOME` or `--home <dir>` (test friendly).

---

## Development

The Installation section above already builds from source (the only installation path for now); this section is for running the tests or hacking on the code directly. Platforms: macOS and Linux; Windows is not a supported target.

monorepo (pnpm workspace):

| Package | Role |
|---------|------|
| `packages/core` | The agent engine, a pure library (run assembly / agent loop / tools / permissions / memory) |
| `packages/server` | The daemon (HTTP + WS + run queueing + scheduling + audit) |
| `packages/cli` | The CLI client (source form) |
| `packages/web` | The WebUI frontend (React + Vite) |
| `packages/kclaw` | The aggregate package (bundles the other packages' build output; the local install in the Installation section installs this one) |

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
  - [agent-team](docs/core/agent-team.md) — agent teams (lead + members, mailbox delivery, task board)
  - [client-http](docs/core/client-http.md) — the shared HTTP request layer (Bearer auth, JSON, error envelope)
  - [compaction](docs/core/compaction.md) — context compaction
  - [file-mentions](docs/core/file-mentions.md) — @ file mentions in user messages
  - [hooks](docs/core/hooks.md) — the user hook system
  - [jobs](docs/core/jobs.md) — cron job scheduling
  - [mcp](docs/core/mcp.md) — MCP client integration
  - [memory](docs/core/memory.md) — the memory system (markdown threads + FTS5 index)
  - [permissions](docs/core/permissions.md) — the permission gate
  - [protocol](docs/core/protocol.md) — the message / block / event three-layer protocol
  - [provider](docs/core/provider.md) — the OpenAI-compatible LLM access layer
  - [sandbox](docs/core/sandbox.md) — the exec OS sandbox (Seatbelt / bubblewrap)
  - [skills](docs/core/skills.md) — the skill mechanism (progressive disclosure)
  - [storage](docs/core/storage.md) — paths, config, and session persistence
  - [subagents](docs/core/subagents.md) — subagent delegation (child sessions, one-level dispatch)
  - [tools](docs/core/tools.md) — the built-in tool system and registration
- server/ (the daemon)
  - [daemon](docs/server/daemon.md) — lifecycle and auth
  - [http-api](docs/server/http-api.md) — HTTP routes
  - [realtime](docs/server/realtime.md) — the WS protocol and event bus
  - [run-manager](docs/server/run-manager.md) — per-session serial runs, message queueing, and the confirmation gate
- cli/ (terminal client)
  - [cli](docs/cli/cli.md) — commands, the REPL, slash commands
  - [onboarding](docs/cli/onboarding.md) — first-run experience (provider detection / wizard / web command)
- web/ (browser client)
  - [webui](docs/web/webui.md) — views, token bootstrap, the WS client
- reference/ (enumeration quick-reference, in Chinese)
  - [reference index](docs/reference/README.md) — value-by-value listings sourced from the code: events, session events, wire frames, messages, blocks, tools, hooks, misc enums
- [extending — extension guide](docs/extending.md): which files to change when adding a new feature
- [tutorial](docs/tutorial.md): hands-on walkthrough for first-time users (in Chinese, 中文上手教程)
