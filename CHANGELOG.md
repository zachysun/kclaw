# Changelog

All notable changes to kclaw are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — note that the 0.x series makes no
compatibility promises.

## [0.2.0] - 2026-09-10

### Added

- **Permission modes** — each session now carries an independent permission mode
  (`readonly` / `default` / `acceptEdits` / `trusted` / `auto`), stored in
  session meta and switched from the CLI (Shift+Tab cycle or `/mode`) or the
  WebUI (always-on selector).
  `readonly` denies all write-class tools (fs_write / fs_edit / exec); in
  `acceptEdits` in-workspace file writes skip confirmation. The daemon-level
  readonly flag is gone — the mode is per-session, defaulting to `default`.
- **Four-way confirmation verdicts** — confirmation prompts now offer
  once / always-in-project / always-globally / reject (CLI: a four-item
  selector; WebUI: four buttons on the card). The "always" choices persist a
  narrowed allow rule — project rules in `<workspace>/.kclaw/permissions.yaml`
  (auto-gitignored, ignored when git-tracked), global rules in
  `~/.kclaw/permissions.yaml`, both 0600 with provenance — and apply from the
  next run. A new WebUI "permissions" tab lists and deletes these rules.
- **Learned / accept_edits grants** — the permission chain gained two allow
  steps (`learned` for persisted rules, `accept_edits` for the mode), each
  recorded in `grantedBy` for the audit trail.
- **Exec OS sandbox** — the `exec` child process runs inside an OS sandbox
  (macOS Seatbelt via `sandbox-exec`; Linux bubblewrap), as defense in depth
  under the permission gate: the workspace and temp dirs stay writable, the
  home directory is read-only with `~/.kclaw` masked (credentials unreachable),
  and extra write roots are configurable. Network stays open (a settled v1
  decision). In `default`/`acceptEdits` modes a command with no rule coverage
  auto-passes as `grantedBy: "sandboxed"` when the sandbox is available;
  otherwise it still goes to a human — fail-closed, never a bare run. New
  `sandbox: {enabled, writeRoots}` config section (on by default). Linux
  fallback chain: bwrap → manual confirmation; Landlock is a documented
  follow-up (pure Node cannot issue the syscall).
- **Trusted session mode** — a fifth permission mode (`trusted`) that
  auto-approves everything inside the sandbox/workspace boundary with no
  prompts and denies everything outside it (fail-closed: no human fallback).
  Deny blacklist rules still short-circuit first; exec requires the OS sandbox
  (denied with a `mode` reason when unavailable); sensitive tools without
  sandbox coverage (MCP adapters, unregistered tools) are denied outright.
- **Auto-learned rules** — a sixth permission mode (`auto`) that keeps the
  `default` decision chain and adds rule induction: when the same operation is
  approved with `once` N consecutive times (`permissions.autoLearnThreshold`,
  default 3, 0 disables), it is persisted as a `source: "auto"` project-scope
  decided rule that applies from the next run. Any `reject` or TIMEOUT resets
  the streak (per-session scoped keys — approvals in one session never help
  another cross the threshold);
  `project`/`global` verdicts and sandboxed auto-passes never count. Decided
  rule entries gained an optional `source` marker (`"auto" | "manual"`, absent
  reads as manual) for audit, with no engine-side behavior change.
- **Session grants wired (run-scoped)** — the pre-existing `SessionGrants`
  decision path is now actually wired: each run builds a fresh grant store
  (when `permissions.sessionGrants` is on), a `once` approval grants the same
  narrowed rule until the run ends, and repeated identical calls within that
  run stop re-prompting (`grantedBy: "session_grant"`). Cross-run persistence
  stays with decided rules — no long-lived exemption is ever created. `auto`
  sessions skip grants so induction still observes every human confirmation.
- **Config default permission mode** — `permissions.defaultMode` sets the
  initial mode for newly created sessions, frozen into `session.created` and
  `meta.mode` at creation (changing the config only affects sessions created
  afterwards; invalid values fall back to `default` with a warning).
- **Sandbox audit event** — each run appends one `sandbox.checked` session
  event (`enabled` / `attempted` / `available` / `unavailableReason`) right
  after the sandbox probe; the trail page renders it as a 沙箱 row (可用 /
  不可用（原因）/ 已关闭). Same contract as the system audit event: not
  broadcast, not projected, and a write failure fails the run.
- **Subagents** — the model can delegate focused work to a child session via
  a `subagent_run` tool (task text + label): each delegation spawns an
  independent session linked to its caller by `parentSessionId`, runs to
  completion, and returns the final answer to the parent run. Up to four
  subagents run concurrently; stopping the parent stops its children.
  Subagent sessions are isolated — no memory extraction, token usage billed
  to the parent — and strictly read-only to the user: messages cannot be
  sent to them directly, but they are fully visible in the audit trail, with
  a live one-line progress indicator (current tool + truncated text) on the
  chat page.
- **Audit view overhaul** — the audit page was rebuilt for scale and
  liveness: virtualized rendering over the full event stream, a dedicated
  websocket for live tailing under a single cursor, all six event-row types
  rendered (note rows badge their specific kind; per-run system-prompt and
  sandbox rows included), AND-combined keyword filtering, time-range
  presets, tab keep-alive and deep links. Two core/server additions back it:
  `session.appended` bus frames (emitted after each append lands, so live
  viewers never race the store) and a `?since=` cursor on
  `GET /sessions/:id/events` with tail reads that skip unneeded lines
  without parsing them. Assistant messages now record `latencyMs`.
- **System-reminder injection** — note blocks are wrapped in
  `<system-reminder kind="...">` tags, and the compaction summary moved to a
  `<compacted-summary>` tag at the head of the next user message; the system
  prompt states the convention up front so tagged content reads as context,
  not instructions. Closing-tag escapes keep a note from forging its own
  reminder tags.
- **Frozen system prompt (prefix-cache friendly)** — a session freezes its
  assembled system prompt after the first run (`meta.systemBaseline`);
  later runs reuse it byte-for-byte, so provider prefix caches hit. A
  compaction is the re-freeze boundary (the cache is cold there anyway);
  skill-list, AGENTS.md and hook-section changes take effect at the next
  epoch instead of mid-conversation. Every run still audits the full prompt
  it ran with.
- **Tool-output spill** — when a tool result is truncated to fit the
  context, the full output is written to `<home>/spill` (mode 0600) and the
  truncation marker names the file and byte range, so `fs_read` can pull
  exact slices afterwards. exec without a spill directory no longer buffers
  output it would never use.
- **Tool-loop guard** — five structurally identical tool calls in a row
  append a reminder to change strategy; the loop itself does not abort.
- **Sandbox network switch** — `sandbox.network: "deny"` cuts the exec child
  process off the network (Seatbelt denies `network-outbound` and
  `network-inbound`; bubblewrap adds `--unshare-net`); the default stays
  `"allow"` and web tools are unaffected either way.
- **Compaction trigger accuracy** — the trigger now counts the fixed
  per-request overhead (system prompt + tool schemas) against the context
  budget, and optional per-model `contextWindow` / `maxOutput` entries in
  the model config tighten the per-model budget instead of a global
  estimate.
- **Compaction summary quality** — summary prompts now require verbatim
  preservation of exact identifiers (file paths, commands, error strings,
  code identifiers, versions), and the post-compaction context tells
  `session_search` that full text lives in earlier segments it can query.

### Changed

- **Session endpoints** — `POST /sessions/:id/readonly` was replaced by
  `POST /sessions/:id/mode`; legacy `readonly` projections still read back as
  `mode: "readonly"`.
- **Confirmation wire protocol** — `confirmation.resolve` now takes a
  `decision` (`"once" | "project" | "global" | "reject"`) instead of a boolean
  `approved`, and `confirmation.resolved` reports that decision.
- **Per-entry hook timeouts** — a hook may override the chain budget with its
  own `timeoutMs`; the three compaction builtins run untimed, since a real
  compaction needs two LLM calls and can never fit a short chain budget.
- **Compact note kind removed** — compaction summaries no longer exist as
  `kind: "compact"` note blocks (the `<compacted-summary>` user-channel tag
  replaced them); existing `compact` notes in old event streams render as
  plain notes.

## [0.1.0] - 2026-09-06

First tagged version. kclaw is a local personal agent: one daemon owns all
state, and the CLI and the WebUI are its clients.

### Added

- **Daemon core** — a single daemon per home directory owns sessions, memory
  and jobs; HTTP + WebSocket API on 127.0.0.1 with token auth; state survives
  restarts.
- **Agent engine** — tool loop with 11 builtin tools (filesystem, exec, web
  fetch, session introspection, memory, skills); a permission gate that derives
  each tool's treatment from its risk and parameters (allow / deny / confirm);
  a hook system covering the engine's behavior seams (builtin chain plus user
  hook files).
- **Skills** — Agent Skills-format skill directories with frontmatter metadata,
  exposed as an extra tool and invocable implicitly from user messages.
- **Memory system** — three-layer memory: global cognitions (L2), per-project
  episode threads (L1) and the live conversation. Markdown files are the source
  of truth; SQLite FTS5 (and optional vector) indexes are derived and can be
  rebuilt from them. Extraction runs on six triggers (manual, immediate,
  interval, end-turn follow, clear, nightly consolidation) with per-session
  watermarks so nothing gets extracted twice.
- **Context compaction** — automatic layered compaction as the context
  approaches its budget, plus manual `/compact` with an optional focus; every
  compaction is audited as an event.
- **Event-sourced persistence** — each session is an append-only `events.jsonl`
  (the single source of truth) with a `meta.json` projection and a `queue.jsonl`
  runtime queue; the WebUI timeline and `session_search` read the event stream.
- **Message queueing** — busy sessions queue incoming messages under three
  dispositions (steer / wait / interrupt); persisted queues are re-enqueued
  after a crash.
- **CLI** — streaming interactive chat with slash commands, three-stage Ctrl+C
  escalation, session resume, and daemon lifecycle commands (start / stop /
  status).
- **WebUI** — offline-capable single-page shell: chat with queue and disposition
  controls, a session timeline rendered from the event stream, a memory
  manager, the job list and hook management.
- **Tests** — a four-package suite (core, server, web, cli) covering the engine,
  the daemon routes, the WebUI, and end-to-end CLI scenarios against a real
  daemon.
