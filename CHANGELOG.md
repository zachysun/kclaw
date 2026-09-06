# Changelog

All notable changes to kclaw are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — note that the 0.x series makes no
compatibility promises.

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
