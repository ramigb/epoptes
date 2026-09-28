# Epoptes spec (v1 draft)

The file format is the contract: the runner, CLI, dashboard and skill only read and write the files below. JSON Schemas live in `docs/schemas/`. Everything here is expected to change with use; bump `version` in a file when its shape changes incompatibly.

## Conventions
- Timestamps are ISO-8601 UTC strings (`ts`, `*_at`). Durations are integer seconds in `*_s` fields.
- **Snapshot files** (`*.json`) have exactly one writer and are written atomically (write `*.tmp`, then rename).
- **Log files** (`*.jsonl`) are append-only, one JSON object per line, each written with a single `appendFile` call so the runner, CLI and dashboard can write concurrently. Readers skip lines that fail to parse.
- A goal is identified by its `id` (slug, unique in the registry). CLI commands accept an id, a path, or nothing (then `$EPOPTES_GOAL_DIR`, then the nearest `.epoptes/` above the cwd).

## Layout
```
<project>/                 the cycle's working directory (a repo, or any workspace folder)
  .epoptes/
    goal.json              config                        writer: you / the skill    committed
    loop.md                orchestrator prompt           you / the skill            committed
    agents/*.md            role files                    you / the skill            committed
    settings.json          cycle permissions             you / the skill            committed
    FEEDBACK.md            optional hand-written inbox   you (+ runner marks → F-n) committed
    state/                 orchestrator memory           orchestrator               committed
    feedback.jsonl         feedback log                  append-only, anyone        committed
    events.jsonl           event log                     append-only, anyone        committed
    snapshots.git/         shadow checkpoints            runner (checkpoints=shadow) ignored
    run/                   live runner state             runner (+ CLI for control) ignored
      status.json  clock.json  control.json  DONE  WRAPUP  runner.log
    cycles/<NNNNNN>/       per-cycle records             runner                     ignored
      result.json  activity.jsonl  stream.jsonl  stderr.log
    .gitignore             run/ cycles/ snapshots.git/ *.tmp .feedback.lock
~/.epoptes/
  registry.json            registered goals
  config.json              dashboard port, LAN opt-in
  ui.json                  dashboard read cursors (for unread badges)
```
`cycles/` and `run/runner.log` may hold confidential code and transcripts; they never leave the machine. `stream.jsonl` is the raw adapter output, kept for debugging; deleting it loses nothing the dashboard or reports need.

## goal.json — schema `goal.schema.json`
Written by the skill, edited by you. The runner re-reads it before every cycle, so changes apply from the next cycle. The time box is copied into `run/clock.json` when a run starts; `extend` and `reset-clock` act on the clock, not on goal.json.

| field | meaning |
|---|---|
| `id`, `name`, `kind` | slug, display name, `code \| research \| content \| data \| other` |
| `objective` | one or two sentences |
| `done[]` | `{id, check, verify: {type: command \| file \| agent \| manual, run?, path?}}` |
| `non_goals[]`, `approval_required[]` | plain strings; the skill writes them into loop.md too |
| `timebox` | `total_min`, `wrapup_min`, `grace_min`, `pause_on_rate_limit` |
| `checkpoints` | `git` (orchestrator commits), `shadow` (runner commits the workspace to `.epoptes/snapshots.git` after each cycle, no tokens, never touches your repo), `none` |
| `adapter` | `type` (`claude-code`), `prompt` (default `loop.md`), `model`, `effort`, `permission_mode`, `args[]` |
| `cycle` | `timeout_min` (clamped 20–180), `pause_between_s`, `max_budget_usd` (null = none) |
| `failures` | `cooldown_after`, `cooldown_min`, `give_up_after` (consecutive failed cycles) |
| `rate_limit` | `backoff_s`, `backoff_max_s` (doubles per consecutive hit) |
| `state_caps` | `{ "<state file>": max_lines }`; the runner emits a `warn` event when exceeded, never trims |
| `notify[]` | event types that raise desktop / push notifications |

## Processes
There is no daemon. `epoptes start` spawns one detached runner per goal (`setsid`, stdio to `run/runner.log`). The runner loops cycle after cycle and exits when the run ends or pauses. `epoptes ui` is a file watcher plus the same control functions the CLI uses; closing it never affects a run.

**Liveness.** The runner writes `status.json` on every state change and a `heartbeat_at` every 15 s. A reader treats a goal as live when `pid` is alive (`kill -0`) and the heartbeat is < 60 s old. If `state` says running but the pid is dead, the next reader (CLI or dashboard) rewrites the state as `crashed` and pauses the clock at `heartbeat_at`. Starting a runner when a live one exists is refused.

**States** (`status.json.state`): `idle` (never started / after reset), `running` (a cycle is in flight), `waiting` (between cycles), `rate_limited`, `cooldown`, `pausing` (pause requested, cycle finishing), `paused`, `stopped`, `crashed`, `failed` (gave up after `give_up_after` fails), `done`, `timeboxed` (hard stop reached).

**Runs.** `start` from `idle`, `done`, `timeboxed` or after `reset-clock` begins a new run `r<k>` with a fresh clock. `start` from `paused`, `stopped`, `crashed` or `failed` resumes the current run. Cycle numbers are monotonic per goal across runs; each record carries its `run`.

### Controls
| control | mechanism |
|---|---|
| start / resume | CLI spawns the runner; the clock resumes |
| pause after this cycle | CLI writes `control.json {pause_after_cycle: true}`; runner finishes the cycle, pauses the clock, sets `paused`, exits |
| stop now | CLI sends SIGINT to the runner pid; the runner SIGINTs the adapter, kills it after 120 s, records the cycle as `interrupted`, pauses the clock, sets `stopped`, exits. The next cycle recovers interrupted work (loop.md orient step) |
| extend `<dur>` | CLI adds to `clock.json.timebox_s` (wrap-up and hard stop move with it) |
| reset-clock | only when no runner is live; clears `clock.json`, `DONE`, `WRAPUP`; next start is a new run |

`control.json` and `clock.json` are the two `run/` files the CLI may write; it does so atomically, and only these fields.

## run/clock.json — `clock.schema.json`
`{version, run, started_at, paused_s, paused_at, timebox_s, wrapup_s, grace_s}`

- `active_s = now − started_at − paused_s − (paused_at ? now − paused_at : 0)`
- Active time only accrues while a runner is live. Pause, stop and crash set `paused_at`; resume adds the gap to `paused_s` and clears it. Rate-limit waits pause the clock when `timebox.pause_on_rate_limit` is true.
- **Mode**, derived, never stored: `build` while `active < timebox − wrapup`; `wrapup` until `timebox`; `overtime` until `timebox + grace`; then `stop`. `run/WRAPUP` turns `build` into `wrapup` (early finish). `run/DONE` ends the run after the current cycle.
- The runner keeps an in-memory copy and restores the file if something deletes it.
- `run --dry-run` never creates or changes the clock.

## run/status.json — `status.schema.json`
`{version, state, pid, run, cycle, mode, cycle_started_at, heartbeat_at, waiting_until, wait_reason, pause_requested, fails_in_row, updated_at}`

## run/control.json — `control.schema.json`
`{version, pause_after_cycle, requested_at, by}`. The runner clears it when it acts on it.

## events.jsonl — `event.schema.json`
Envelope: `{ts, run, cycle, src: runner | orchestrator | user, type, ...payload}`. `run`/`cycle` are null outside a run.

| src | type | payload |
|---|---|---|
| runner | `run.start` | `timebox_s` |
| runner | `run.end` | `reason: done \| timebox \| paused \| stopped \| failed \| crashed` |
| runner | `cycle.start` | `mode, model, effort, timeout_s` |
| runner | `cycle.end` | `exit, duration_s, cost_usd, turns` (full detail in `cycles/N/result.json`) |
| runner | `wait` | `reason: rate_limit \| cooldown \| between_cycles, seconds` |
| runner | `mode` | `from, to` |
| runner / user | `control` | `action: start \| resume \| pause \| stop \| extend \| reset, seconds?` |
| runner | `warn` | `text` (state cap exceeded, clock restored, feedback file unparsable, …) |
| orchestrator | `milestone`, `blocked`, `note` | `text`, `ref?` (task or feedback id) |
| orchestrator | `artifact` | `path`, `text?` (produced file worth showing in reports) |
| orchestrator | `round` | `n` |
| orchestrator | `wrapup`, `done` | `text` (the CLI also creates `run/WRAPUP` / `run/DONE`) |

Feedback changes are **not** duplicated here; they live in `feedback.jsonl`.

## feedback.jsonl — `feedback.schema.json`
An append-only log of operations; the current state of each item is the fold of its lines in order.
```
{"ts":"…","op":"add","id":"F-3","text":"Arms clip into dresses","src":"dashboard"}
{"ts":"…","op":"status","id":"F-3","status":"in_progress","cycle":11,"by":"orchestrator"}
{"ts":"…","op":"status","id":"F-3","status":"done","cycle":12,"by":"orchestrator","note":"arms clear skirts/bags"}
{"ts":"…","op":"note","id":"F-3","text":"still clips with the big bag","by":"user"}
```
- Statuses: `new → seen → in_progress → done | blocked | wont_do`. Any transition is allowed and recorded; you reopen an item by setting it to `new`.
- `src` on add: `dashboard | cli | file`. `by` on status/note: `orchestrator | user`.
- Ids are `F-<n>`, next free number. Adds take `.epoptes/.feedback.lock` (created with O_EXCL, stale after 10 s) so two writers can't pick the same id.
- **Inbox.** Before each cycle (and when the dashboard sees it change) the runner ingests new bullets from `.epoptes/FEEDBACK.md` as `add` with `src: file` and appends ` → F-<n>` to each bullet. No model tokens are spent on intake.

## cycles/NNNNNN/result.json — `cycle-result.schema.json`
Normalised by the adapter; the dashboard and reports use only this, never the raw stream.
```
{version, cycle, run, adapter, started_at, ended_at, duration_s,
 exit: ok | error | timeout | interrupted | rate_limited,
 turns, session_id, cost_usd, cost_basis: billed | estimate,
 models: { "<model id>": {input, output, cache_read, cache_write, cost_usd} },
 rate_limit: {retry_after_s} | null, error: string | null}
```
- `cost_basis` is `billed` only when the cycle ran with an API key in its environment (the runner checks presence only; it never reads, logs or stores the key). Otherwise it's `estimate`, and every UI and report shows the cost as "≈ $x (estimate)" with a tooltip "API-equivalent estimate, not billed". Phase 1 is always `estimate`.
- Cache-read share = `cache_read / (input + cache_read + cache_write)`, computed by readers.

## cycles/NNNNNN/activity.jsonl — `activity.schema.json`
The live ticker, normalised from the adapter's stream so the dashboard stays adapter-agnostic.
`{ts, agent, kind: init | tool | agent.start | agent.end | text | result, tool?, path?, summary}`
- `agent` is `orchestrator` or `<subagent type>#<short id>`; `summary` ≤ 120 chars; `path` is set for file tools.

## state/ (orchestrator memory)
The skill generates these with caps in `goal.json.state_caps`. The dashboard reads them; only the orchestrator writes them.

| file | contract |
|---|---|
| `handoff.md` | overwritten each cycle, ≤ 25 lines; the dashboard shows it verbatim |
| `backlog.md` | task lines `- [ ] <ID> <text>`; markers `[ ]` todo, `[~]` in progress, `[x]` done, `[blocked: why]`, `[cut]`. A line `**Current milestone: <name>**` is optional. The dashboard counts markers for backlog progress |
| `progress.md` | table, one row per round: `\| c<N> \| <elapsed> \| <task ids> \| ok/blocked \| <note> \|` |
| `lessons.md` | ≤ 30 lines of rules |
| `decisions.md` | append-only `date · decision · why` |
| `scores.jsonl` | optional: `{cycle, milestone?, scores: {name: number \| null}, gates?: {name: pass \| fail}}` |

## ~/.epoptes/
- `registry.json` (`registry.schema.json`): `{version, goals: [{id, path, added_at}]}`. `path` is the project directory (parent of `.epoptes/`).
- `config.json`: `{version, port, lan}`. `lan: true` binds `0.0.0.0` and prints a warning; default is `127.0.0.1`.
- `ui.json`: `{version, seen: {"<goal id>": {feedback_at, events_at}}}`. Unread badges = records newer than these.

## Cycle environment
The runner starts each cycle in `<project>/` with:
- `EPOPTES_GOAL_DIR`, `EPOPTES_RUN`, `EPOPTES_CYCLE`, `EPOPTES_MODE`, so `epoptes event …` and `epoptes feedback …` need no arguments inside a cycle.
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: in dress2impress, background subagents were killed 600 s after the orchestrator's turn ended. The cycle timeout still bounds the cycle.

## Adapter interface
```ts
interface Adapter {
  id: string;                                   // "claude-code"
  check(): Promise<{ ok: boolean; version?: string; problem?: string }>;
  command(spec: CycleSpec): { bin: string; args: string[]; env: Record<string, string> }; // --dry-run
  start(spec: CycleSpec): Cycle;
}
interface CycleSpec {
  cwd: string; goalDir: string; cycleDir: string;
  prompt: string; model: string; effort: string; permissionMode: string; args: string[];
  timeoutS: number; budgetUsd: number | null;
  agentsDir: string; settingsFile: string | null; env: Record<string, string>;
}
interface Cycle {
  activity: AsyncIterable<Activity>;            // also appended to activity.jsonl by the runner
  interrupt(): void;                            // SIGINT; the runner escalates to kill after 120 s
  done: Promise<CycleResult>;                   // result.json minus cycle/run, which the runner adds
}
```
**claude-code (v1):** `claude -p <loop.md> --model --effort --permission-mode --permission-prompts none --output-format stream-json --verbose --settings .epoptes/settings.json --agents <generated json> [--max-budget-usd]`. Role files in `.epoptes/agents/*.md` use Claude Code's agent frontmatter; the adapter converts them to the `--agents` JSON file in the cycle dir. Rate limits are detected from the result/error text (`rate limit`, `usage limit`, `overloaded`, `429`, `529`), as in `run.sh`.

## CLI
```
epoptes add [dir]                      validate .epoptes/goal.json and register it
epoptes list
epoptes status [goal]                  one screen: state, mode, clock, cycle, backlog, handoff head, open feedback
epoptes start | pause | stop [goal]
epoptes extend [goal] <dur>            e.g. 2h, 30m
epoptes reset-clock [goal]
epoptes run [goal] --dry-run           check claude + files, print the next cycle's command; never starts the clock
epoptes feedback [goal] "<text>"
epoptes feedback <F-n> <status> ["note"]
epoptes event <milestone|blocked|note|artifact|round|wrapup|done> "<text>"
epoptes report [goal | --all] [--md | --html]
epoptes ui [--port N] [--lan]
```
The npm package is `@ramigb/epoptes`; the binary is `epoptes`.
