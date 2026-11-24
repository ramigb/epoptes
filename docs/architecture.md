# Epoptes Architecture Overview

Epoptes is a **file-first, daemon-free** orchestrator for long-running autonomous agent sessions (Claude Code, Codex, pi, and Antigravity). Its core design principle is simple: **the files in `<project>/.epoptes/` are the contract**. The CLI, detached runner, dashboard, adapters, and skill all communicate strictly by reading and writing those files (plus standard OS signals for immediate interrupts).

---

## High-Level Data Flow

```
  You (Dashboard / CLI / Chat)
        │
        ├─ writes board.jsonl, control.json, goal.json, FEEDBACK.md
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │                 <project>/.epoptes/                      │
  │  goal.json · loop.md · agents/*.md · board.jsonl         │
  │  events.jsonl · state/* · run/{status,clock,control}.json│
  │  cycles/<NNNNNN>/{result.json, activity.jsonl, stream}   │
  └──────────────┬───────────────────────────┬───────────────┘
                 │ reads/writes              │ polls (1s) + SSE
                 ▼                           ▼
      ┌──────────────────┐         ┌──────────────────┐
      │ Detached Runner  │         │  Local Dashboard │
      │  (src/runner.ts) │         │ (src/ui/server.ts│
      │  1 proc per goal │         │  + ui/app.js)    │
      └────────┬─────────┘         └──────────────────┘
               │ spawns fresh CLI each cycle
               ▼
      ┌─────────────────────────────────────────────┐
      │  Adapter (src/adapters/*.ts)                │
      │  claude-code · codex · pi · antigravity     │
      │  Normalizes JSON stream → activity & result │
      └─────────────────────────────────────────────┘
```

---

## Core Components

### 1. File Contract & Schemas (`docs/schemas/`, `src/fsx.ts`, `src/schema.ts`)
- **Snapshot JSON files** (`goal.json`, `run/status.json`, `run/clock.json`, `run/control.json`) have a single writer and are written atomically (`*.tmp` → rename).
- **Append-only JSONL logs** (`board.jsonl`, `events.jsonl`, `cycles/<N>/activity.jsonl`) allow concurrent writers (runner, CLI, dashboard, orchestrator) without corruption.
- **Board locking** (`.epoptes/.board.lock`) uses `O_EXCL` only when allocating new sequential card IDs (`C-<n>`).

### 2. Detached Runner (`src/runner.ts`, `src/control.ts`, `src/clock.ts`)
- There is no global background daemon. `epoptes start` spawns one detached process per goal (`setsid`). Closing your terminal or dashboard never stops a run.
- **Cycle loop:** Before each cycle, the runner reloads `goal.json`, checks `control.json` and the active-time clock, ingests `FEEDBACK.md` / `state/backlog.md` onto `board.jsonl`, builds any runner preambles (steering, follow-up, board-clear), fires the `onStart` hook, and launches the adapter.
- **After each cycle:** Writes normalized `result.json`, fires the `onEnd` hook, takes a shadow snapshot if configured, checks state file line caps, handles rate-limit backoff or failure cooldowns, and updates the local **brain** (`~/.epoptes/brain/`) when the run ends.
- **Pausing & stopping:**
  - `epoptes pause` (default: task-level) writes `control.json { pause_after_cycle: true, pause_mode: "task" }`. The running orchestrator sees `PAUSE_REQUESTED=task` in `epoptes clock` and CLI notices, finishes its in-flight task cleanly, checkpoints, and exits. `--after-cycle` waits for the full cycle. Fires `onPause`.
  - `epoptes stop` sends `SIGINT` immediately (escalating to `SIGKILL` after 120s). Fires `onStop`.
  - `epoptes feedback --steer` sends `SIGUSR2` to interrupt the current cycle and immediately start a fresh replanning cycle.

### 3. Adapters (`src/adapters/`)
Every supported CLI implements the same `Adapter` interface (`src/adapters/types.ts`):
- `claude-code.ts`: runs `claude -p --output-format stream-json`, converts `agents/*.md` to `--agents` JSON, enforces `settings.json`, streams subagent activity and plan usage.
- `codex.ts`: runs `codex exec --json`, converts `agents/*.md` to per-cycle TOML custom agents, reads plan usage from Codex session logs.
- `pi.ts`: runs `pi --mode json` with an Epoptes guard extension (`pi-guard.ts`) that enforces `settings.json` deny rules and stops cycles on `max_budget_usd`.
- `antigravity.ts`: runs `agy --output-format stream-json -p=<prompt>`, maps `agents/*.md` into `<cycle>/.agents/agents/`.

All four normalize their native output into the exact same `activity.jsonl` and `result.json` formats so the dashboard, time analyzer, and reports remain adapter-agnostic.

### 4. The Board & Milestones (`src/board.ts`)
- One append-only `board.jsonl` per harness; each **job** is an **epic**.
- Columns: `backlog` → `todo` → `doing` → `review` → `done` (plus `blocked` and `cut` states).
- Milestones carry a short internal ID (`M1`, `M2`) for agents and a human-readable label + description for the UI, plus active-time targets and `paused_for_user` detection.

### 5. Dashboard & Output Server (`src/ui/`, `ui/`)
- **Dashboard (`127.0.0.1:4747`):** Zero-build Preact + `htm` SPA served by Node's `http` module. Polls goal files every second (WSL-safe), tails JSONL incrementally, and pushes updates over Server-Sent Events (`/api/stream`).
- **Security:** Host-header DNS-rebinding guard, `X-Epoptes: 1` + `Origin` CSRF guard, strict CSP.
- **Output server (`127.0.0.1:4748`):** Separate read-only origin serving project deliverables so agent-built web pages cannot access dashboard APIs.

### 6. Observability, Time Use & Brain (`src/timeuse.ts`, `src/summary.ts`, `src/report.ts`, `src/brain.ts`)
- **Zero-token observability:** Everything in the dashboard (live ticker, cost/cache charts, time breakdown with grouped Bash/background command drilldowns, humanized general status, and HTML/Markdown reports) is computed directly from recorded files.
- **Brain (`~/.epoptes/brain/`):** Aggregates metrics, automatic signals, and orchestrator-recorded harness lessons across all your goals so future harnesses start smarter.
