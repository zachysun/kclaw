# kclaw

English | [中文](./README.zh-CN.md)

A personal AI assistant, iterated continuously from the experience of other agent harnesses and my own usage needs.

---

## Installation

Requirements: Node >= 22

Local deployment:

```bash
# 1. clone the repo
git clone https://github.com/zachysun/kclaw
cd kclaw

# 2. install dependencies and build
pnpm install
pnpm build

# 3. install the aggregate package globally from the local directory
npm i -g ./packages/kclaw

# web ui (recommended)
kclaw web
# cli (work in progress)
kclaw chat
```

> [!TIP]
> [Full hands-on tutorial](./docs/tutorial.md) (in Chinese)

> [!NOTE]
> The daemon needs no separate start: `kclaw chat` / `kclaw web` start it automatically when they find it missing.

---

## Features

- **Streaming output**: the LLM streams back over SSE; text deltas are forwarded to the frontend over WebSocket and rendered token by token; the CLI prints the same way.
- **Event persistence & full audit**: tool calls with arguments, permission decisions, context injection, retrieved memory — all appended as persistent events; the audit page is a timeline view of that event stream.
- **Context compaction**: four thresholds on context occupancy: past 70% old tool outputs are replaced with omission placeholders; past 75% a summary is pre-compacted in the background as a standby; past 80% compaction runs when a run ends; past 90% it is forced between two step calls mid-run. Compaction has the LLM summarize old messages into one summary placed at the top; the most recent messages stay verbatim.
- **Three-tier memory**: L0 is the raw conversation, kept in the session event stream; L1 is per-project episodes, mostly extracted by the LLM from new messages at the end of each run and archived by topic into the project's topic files; L2 is global knowledge, mostly distilled by the LLM into `persona` / `wiki` / `rule` once a topic is no longer active. L2 stays resident in the context; L1 is retrieved on demand.
- **Skills & tools**: 22 built-in tools covering file read/write/edit (`fs_read` / `fs_write` / `fs_edit`), shell command execution (`exec`), web search and fetch (`web_search` / `web_fetch`), memory and team coordination, and more; skills already installed by existing agents such as Claude Code can be reused directly.
- **Permissions & sandbox**: five permission modes: readonly (all writes and commands denied), default (each risky action confirmed one by one), acceptEdits (file writes inside the workspace allowed), trusted (no confirmation inside the sandbox and workspace), auto (judged from the user's repeated approval behavior; currently rule-based). An approval can be granted "just this once" / "for this project" / "globally"; the next similar operation is then allowed automatically.
- **Subagent**: two types: (1) blocking — the lead agent waits for the result; (2) background — the lead agent can keep working in the meantime and is notified when the subagent finishes. A subagent is an independent session: it inherits the lead agent's working directory, uses a lean system prompt, and receives only the task description, not the lead agent's message history.
- **Agent team**: the lead and the teammates are each independent sessions, communicating point-to-point via mailboxes, with a shared task board.
- **IM channel**: Feishu (Lark) is currently supported.

---


## Common Commands

| Command | Purpose |
|---------|---------|
| `kclaw` / `kclaw chat` | Enter the chat |
| `kclaw chat --session <id>` | Resume a specific session |
| `kclaw chat --think` | Show the thinking stream (hidden by default) |
| `kclaw web` | Open the WebUI in the browser |
| `kclaw daemon start \| stop \| status` | Daemon lifecycle |
| `kclaw status` | Alias of `daemon status` |
| `kclaw jobs list` | List scheduled jobs |

Inside the REPL: `/exit` to quit, `/sessions` to list sessions, `/new <title>` for a new session; Ctrl+C cancels the current run.

---


## Configuration (`~/.kclaw/config.json`)

Model configuration:

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

| Field | Description |
|-------|-------------|
| `providers.default` | The default provider entry |
| `format` | API protocol: `openai` (OpenAI-compatible) or `anthropic`; defaults to `openai` when omitted |
| `baseUrl` | API endpoint URL |
| `apiKey` | API key |
| `model` | Model name |
| `contextWindow` | Optional: the model's context window |
| `maxOutput` | Optional: max output tokens per reply |

---


## Development

monorepo (pnpm workspace):

| Package | Role |
|---------|------|
| `packages/core` | The agent engine, the core library (loop / tools / permissions / memory) |
| `packages/server` | The daemon (HTTP + WS + queueing + scheduling + audit) |
| `packages/cli` | The CLI client |
| `packages/web` | The WebUI frontend (React + Vite) |
| `packages/kclaw` | The aggregate package |

```bash
pnpm install
pnpm build
pnpm typecheck   # tsc --noEmit for every package
pnpm test        # vitest for every package (cli/server quick checks need pnpm build first)
```

Docs:

- [architecture](docs/architecture.md): overall architecture
- core/
  - [agent-loop](docs/core/agent-loop.md): the agent loop
  - [agent-team](docs/core/agent-team.md): agent teams (lead + teammates, mailbox, task board)
  - [client-http](docs/core/client-http.md): the shared HTTP request layer
  - [compaction](docs/core/compaction.md): context compaction
  - [hooks](docs/core/hooks.md): the hook system
  - [jobs](docs/core/jobs.md): cron job scheduling
  - [mcp](docs/core/mcp.md): MCP integration
  - [memory](docs/core/memory.md): the three-tier memory system
  - [permissions](docs/core/permissions.md): permissions and user approval
  - [protocol](docs/core/protocol.md): the message / block / event three-layer internal protocol (data model)
  - [provider](docs/core/provider.md): the OpenAI-compatible LLM access layer
  - [sandbox](docs/core/sandbox.md): the sandbox
  - [skills](docs/core/skills.md): skills
  - [storage](docs/core/storage.md): persistence
  - [subagents](docs/core/subagents.md): the subagent mechanism
  - [tools](docs/core/tools.md): built-in tools and registration
- server/ (the daemon)
  - [daemon](docs/server/daemon.md): lifecycle and auth
  - [http-api](docs/server/http-api.md): HTTP routes
  - [realtime](docs/server/realtime.md): the WS protocol and the event bus
  - [run-manager](docs/server/run-manager.md): per-session serial runs, message queueing, and the confirmation gate
- cli/ (the terminal client)
  - [cli](docs/cli/cli.md): commands, the REPL, and slash commands
  - [onboarding](docs/cli/onboarding.md): the first-run experience
- web/ (the browser client)
  - [webui](docs/web/webui.md): the web UI
- [extending](docs/extending.md): guide for adding new features
- [tutorial](docs/tutorial.md): the hands-on tutorial
