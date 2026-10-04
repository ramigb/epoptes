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
      status.json  clock.json  control.json  runner.lock  DONE  WRAPUP  runner.log  bin/epoptes
    cycles/<NNNNNN>/       per-cycle records             runner                     ignored
      result.json  activity.jsonl  stream.jsonl  stderr.log
    .gitignore             run/ cycles/ snapshots.git/ *.tmp .feedback.lock
~/.epoptes/
  registry.json            registered goals
  config.json              dashboard port, LAN opt-in
  ui.json                  dashboard read cursors (for unread badges)
```
`cycles/` and `run/runner.log` may hold confidential code and transcripts; they never leave the machine. `stream.jsonl` is the raw adapter output, kept for debugging; deleting it loses nothing the dashboard or reports need.

## Codex adapter

Set `adapter.type` to `codex`. Its defaults are `model: ""` (use the CLI's configured model), `effort: "high"`, `permission_mode: "workspace-write"`, `prompt: "loop.md"` and `args: []`. Supported permission modes are `read-only`, `workspace-write` and `danger-full-access`; `cycle.max_budget_usd` must be `null`. Existing Claude defaults remain unchanged.

The adapter launches `codex exec --json --skip-git-repo-check --sandbox <mode> -c 'approval_policy="never"'`, optionally with `--model` and `model_reasoning_effort`, then extra arguments and `-`. The prompt goes on stdin. Every cycle starts a new thread; it never resumes another Codex conversation. It uses the installed CLI's authentication, user configuration, project instructions and rules. `EPOPTES_CODEX_BIN` overrides the executable for tests.

`thread.started`, `turn.completed`, `turn.failed`, `error` and `item.*` events feed the existing activity/result files. Commands, file changes, MCP calls, web searches and agent messages appear in the ticker. A zero process exit requires a completed turn and no error to count as success. Cached input is subtracted from Codex's total input before storing `models[].input`, so cache share is not double-counted. Unknown dollar costs remain `null` through report/dashboard totals; rate limits use text detection and the runner's backoff because reset timestamps are unavailable. Usage with no explicit model is labelled `codex-configured`.

Claude `.epoptes/settings.json` and agent frontmatter are not native Codex configuration. Codex harnesses omit settings.json and adapt loop.md for sequential work using role bodies as guidance. Native Codex subagents must be configured separately; Epoptes does not translate Claude tools, model aliases or maxTurns. The shared skill installs into `~/.agents/skills/epoptes` with `epoptes skill install --agent codex`; the default installation remains `~/.claude/skills/epoptes`.

References: official [non-interactive mode](https://developers.openai.com/codex/noninteractive), [configuration reference](https://developers.openai.com/codex/config-reference), and [skills](https://developers.openai.com/codex/skills). Command flags also checked against local `codex-cli 0.159.2` help; runtime tests use a fake CLI and make no inference calls.

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
| `adapter` | `type` (`claude-code` or `codex`), `prompt` (default `loop.md`), `model`, `effort`, `permission_mode`, `args[]` |
| `cycle` | `timeout_min` (clamped 20–180), `pause_between_s`, `max_budget_usd` (null = none) |
| `failures` | `cooldown_after`, `cooldown_min`, `give_up_after` (consecutive failed cycles) |
| `rate_limit` | `backoff_s`, `backoff_max_s` (doubles per consecutive hit) |
| `state_caps` | `{ "<state file>": max_lines }`; the runner emits a `warn` event when exceeded, never trims |
| `notify[]` | event types that raise desktop / push notifications |

## Processes
There is no daemon. `epoptes start` spawns one detached runner per goal (`setsid`, stdio to `run/runner.log`). The runner loops cycle after cycle and exits when the run ends or pauses. `epoptes ui` is a file watcher plus the same control functions the CLI uses; closing it never affects a run.

**Liveness.** The runner writes `status.json` on every state change and a `heartbeat_at` every 15 s. A reader treats a goal as live when `pid` is alive (`kill -0`) and the heartbeat is < 60 s old. If `state` says running but the pid is dead, the next reader (CLI or dashboard) rewrites the state as `crashed` and pauses the clock at `heartbeat_at`. Starting a runner when a live one exists is refused.

**States** (`status.json.state`): `idle` (never started / after reset), `running` (a cycle is in flight), `waiting` (between cycles), `rate_limited`, `cooldown`, `pausing` (pause requested, cycle finishing), `paused`, `needs_input` (paused because the orchestrator ran `epoptes wait-for-human`; `status.needs` says why), `stopped`, `crashed`, `failed` (gave up after `give_up_after` fails), `done`, `timeboxed` (hard stop reached).

**Follow-up runs.** After DONE (or a finished time box), `start --follow-up` (dashboard: "Follow up on N feedback items") begins a run whose clock has `kind: "followup"` and no time box (`timebox_s: 0`, mode `followup`, `TO_END=none`). It handles only the *follow-up items*: open feedback (`new | seen | in_progress`) that isn't an agent note, an unanswered approval, or marked `scope: new_run`. Before each cycle the runner puts a FOLLOW-UP note in front of the prompt listing them: minor items (a colour, a size, wording, a small bug) get done in place; major ones (a restart, a new version, a change of direction) are marked `blocked "needs a new run: …"`. The human can override per item with `{op: scope, scope: auto | tweak | new_run}`. The run ends when the orchestrator says DONE or no follow-up item is left (the runner then records `done` itself); after 3 cycles without that it pauses with a warning. `run.start` carries `followup: true`; the control action is `follow_up`.

**Runs.** `start` from `idle`, `done`, `timeboxed` or after `reset-clock` begins a new run `r<k>` with a fresh clock. `start` from `paused`, `stopped`, `crashed` or `failed` resumes the current run. Cycle numbers are monotonic per goal across runs; each record carries its `run`.

### Controls
| control | mechanism |
|---|---|
| start / resume | CLI spawns the runner; the clock resumes. If the run is over (DONE, or past the hard stop), `start` refuses unless given `--new-run` (dashboard: "Start new run…" with a confirm), because a new run spends tokens and only finds work if feedback or tasks were added. The `control` event says `start` for a new run and `resume` for a continuation |
| pause after this cycle | CLI writes `control.json {pause_after_cycle: true}`; runner finishes the cycle, pauses the clock, sets `paused`, exits |
| wait for the human | orchestrator runs `epoptes wait-for-human "<what>"`: `control.json {pause_after_cycle: true, for_human: {reason}}` plus a `needs_you` event. The run ends after the cycle as `needs_input` with `status.needs = {reason, since}` and the clock paused. Resume as usual; answering the last open approval (or "Send & resume" in the dashboard) resumes it by itself |
| steer | `epoptes feedback "<text>" --steer` (dashboard: ⚡ Steer now) adds `{op: add, steer: true}` and sends SIGUSR2 to a live runner. A running cycle is interrupted (`cycle.end {exit: interrupted, steered: true}`, not counted as a failure) and the next starts at once; a between-cycles wait is cut short, a rate-limit or cooldown wait is not. While a steering item is still `new`, the runner puts a STEERING note in front of the prompt (and `cycle.start` carries `steer: [ids]`) telling the orchestrator to replan the whole backlog around it first. With no live runner, the item waits for the next start |
| stop now | CLI sends SIGINT to the runner pid; the runner SIGINTs the adapter, kills it after 120 s, records the cycle as `interrupted`, pauses the clock, sets `stopped`, exits. The next cycle recovers interrupted work (loop.md orient step) |
| extend `<dur>` | CLI adds to `clock.json.timebox_s` (wrap-up and hard stop move with it) |
| reset-clock | only when no runner is live; clears `clock.json`, `DONE`, `WRAPUP`; next start is a new run |

`control.json` and `clock.json` are the two `run/` files the CLI may write; it does so atomically, and only these fields.

## run/clock.json — `clock.schema.json`
`{version, run, started_at, paused_s, paused_at, timebox_s, wrapup_s, grace_s}`

- `active_s = now − started_at − paused_s − (paused_at ? now − paused_at : 0)`
- Active time only accrues while a runner is live. Pause, stop and crash set `paused_at`; resume adds the gap to `paused_s` and clears it. Rate-limit waits pause the clock when `timebox.pause_on_rate_limit` is true.
- **Mode**, derived, never stored: `followup` for a follow-up clock (no time box); otherwise `build` while `active < timebox − wrapup`; `wrapup` until `timebox`; `overtime` until `timebox + grace`; then `stop`. `run/WRAPUP` turns `build` into `wrapup` (early finish). `run/DONE` ends the run after the current cycle.
- The runner keeps an in-memory copy and restores the file if something deletes it.
- `run --dry-run` never creates or changes the clock.

## run/status.json — `status.schema.json`
`{version, state, pid, run, cycle, mode, cycle_started_at, heartbeat_at, waiting_until, wait_reason, pause_requested, fails_in_row, limits, needs, updated_at}`

`limits` is the latest account usage report from the adapter (`{status, resets_at, windows: {five_hour: {utilization, resets_at}, …}, at}`). Every goal runs on the same account, so the dashboard shows the newest `limits` across goals as the shared rate-limit state. It costs no tokens: claude-code emits it in the stream.

## run/control.json — `control.schema.json`
`{version, pause_after_cycle, requested_at, by, for_human?: {reason}}`. The runner clears it when it acts on it.

## events.jsonl — `event.schema.json`
Envelope: `{ts, run, cycle, src: runner | orchestrator | user, type, ...payload}`. `run`/`cycle` are null outside a run.

| src | type | payload |
|---|---|---|
| runner | `run.start` | `timebox_s`, `resumed` (true when continuing a paused/stopped/crashed run) |
| runner | `run.end` | `reason: done \| timebox \| paused \| needs_you \| stopped \| failed \| crashed`. `run.start`/`run.end` bracket one runner process; a run id can span several |
| runner | `cycle.start` | `mode, model, effort, timeout_s` |
| runner | `cycle.end` | `exit, duration_s, cost_usd, turns` (full detail in `cycles/N/result.json`) |
| runner | `wait` | `reason: rate_limit \| cooldown \| between_cycles, seconds` |
| runner | `mode` | `from, to` |
| runner / user | `control` | `action: start \| resume \| pause \| stop \| extend \| reset \| steer, seconds?, ref?` |
| runner | `warn` | `text` (state cap exceeded, clock restored, feedback file unparsable, …) |
| orchestrator | `milestone`, `blocked`, `note` | `text`, `ref?` (task or feedback id). `epoptes approval` emits `blocked` with `text: "needs approval: …"` and `ref: F-<n>` |
| orchestrator / user | `needs_you` | `text`: what the human should do (`epoptes wait-for-human`) |
| orchestrator | `artifact` | `path`, `text?` (produced file worth showing in reports) |
| orchestrator | `round` | `n` |
| orchestrator | `wrapup`, `done` | `text` (the CLI also creates `run/WRAPUP` / `run/DONE`) |

`milestone`, `wrapup` and `done` events from the CLI also carry `active_s` (active time when recorded), so the dashboard can place them on the clock.

Feedback changes are **not** duplicated here; they live in `feedback.jsonl`.

## feedback.jsonl — `feedback.schema.json`
An append-only log of operations; the current state of each item is the fold of its lines in order.
```
{"ts":"…","op":"add","id":"F-3","text":"Arms clip into dresses","src":"dashboard"}
{"ts":"…","op":"status","id":"F-3","status":"in_progress","cycle":11,"by":"orchestrator"}
{"ts":"…","op":"status","id":"F-3","status":"done","cycle":12,"by":"orchestrator","note":"arms clear skirts/bags"}
{"ts":"…","op":"note","id":"F-3","text":"still clips with the big bag","by":"user"}
```
- **Approvals.** `epoptes approval "<what>" [--ref <task>]` adds `{op: add, kind: "approval", src: "orchestrator", ref?}`; an approval starts as `blocked` (waiting for the human). The human answers with `{op: decide, decision: approved | rejected, by: user, note?}`, followed by a `status → new` line so the next cycle acts on it; `epoptes feedback --open` prints `[approval: APPROVED "<note>"]`. An approval is *pending* while it has no decision and isn't closed.
- **Agent notes (auto feedback).** `epoptes feedback "<text>"` inside a cycle adds an item with `src: "orchestrator"`: something a later cycle must act on, typically a research finding that changes the plan. It shows to the human (toast, "agent note" chip, unread badge), who can edit it (`{op: edit, text, by}`) or dismiss it (`wont_do`); the next cycle triages it after the human's own feedback. `epoptes feedback --open` tags it `[agent note]`.
- Statuses: `new → seen → in_progress → done | blocked | wont_do`. Any transition is allowed and recorded; you reopen an item by setting it to `new`.
- `src` on add: `dashboard | cli | file | orchestrator`. `by` on status/note: `orchestrator | user`.
- Ids are `F-<n>`, next free number. Adds take `.epoptes/.feedback.lock` (created with O_EXCL, stale after 10 s) so two writers can't pick the same id.
- **Inbox.** Before each cycle, and whenever `epoptes status`, `epoptes feedback` or the dashboard reads feedback, Epoptes ingests new bullets from `.epoptes/FEEDBACK.md` as `add` with `src: file` and appends ` → F-<n>` to each bullet. No model tokens are spent on intake.

## cycles/NNNNNN/result.json — `cycle-result.schema.json`
Normalised by the adapter; the dashboard and reports use only this, never the raw stream.
```
{version, cycle, run, adapter, started_at, ended_at, duration_s,
 exit: ok | error | timeout | interrupted | rate_limited,
 turns, session_id, cost_usd, cost_basis: billed | estimate,
 models: { "<model id>": {input, output, cache_read, cache_write, cost_usd} },
 rate_limit: {retry_after_s} | null, error: string | null}
```
- `cost_basis` is `billed` only when the adapter reports the cycle ran on an API key (claude-code: `apiKeySource` in the init event is not `"none"`; the key itself is never read, logged or stored). Otherwise it's `estimate`, and every UI and report shows the cost as "≈ $x (estimate)" with a tooltip "API-equivalent estimate, not billed". Phase 1 is always `estimate`.
- `rate_limit` is the last limit report the adapter saw: `{status, resets_at, windows: {"<name>": {utilization, resets_at}}}`, or null.
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
| `backlog.md` | task lines `- [ ] <ID> <text>`; markers `[ ]` todo, `[~]` in progress, `[x]` done, `[blocked: why]`, `[cut]`. A line `**Current milestone: <name>**` is optional. Milestone headings `## M<n> · <title> (target h:mm)` group the tasks below them until the next heading; the target is active time from the start of the run. The dashboard counts markers for backlog progress, splits the progress bar by milestone, and marks each target on the clock bar (reached on time, late, overdue, upcoming) with a dot where the `milestone` event that names it (`"M2: …"`) actually landed. `epoptes clock` adds `MILESTONE=<id> M_TARGET=<h:mm>` for the current one |
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
- `PATH` starting with `run/bin/`, which holds an `epoptes` shim for the exact CLI that started the runner (works without a global install). The Claude Code adapter always adds `Bash(epoptes *)` to the cycle's allow list.
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: in dress2impress, background subagents were killed 600 s after the orchestrator's turn ended. The cycle timeout still bounds the cycle.

## Adapter interface
```ts
interface Adapter {
  id: string;                                   // "claude-code" or "codex"
  check(): Promise<{ ok: boolean; version?: string; problem?: string }>;
  command(spec: CycleSpec): { bin: string; args: string[]; env: Record<string, string>; stdin?: string }; // also --dry-run
  start(spec: CycleSpec, hooks: CycleHooks): Cycle;
}
interface CycleSpec {
  cwd: string; goalDir: string; cycleDir: string;
  prompt: string; model: string; effort: string; permissionMode: string; args: string[];
  budgetUsd: number | null; agentsDir: string; settingsFile: string | null; env: Record<string, string | undefined>;
}
interface CycleHooks {
  activity(a: Activity): void;                  // the runner appends it to activity.jsonl
  limits(l: Limits): void;                      // the runner stores it in status.json
  warn(text: string): void;                     // the runner emits a warn event
}
interface Cycle {
  pid: number | undefined;
  interrupt(): void;                            // SIGINT; the runner escalates to kill() after 120 s
  kill(): void;                                 // SIGKILL to the cycle's process group
  done: Promise<CycleResult>;                   // result.json minus version/cycle/run, which the runner adds
}
```
The runner owns timeouts: it calls `interrupt()` at the cycle timeout (capped by the hard stop) and on `stop`, and `kill()` 120 s later.
**claude-code (v1):** `claude -p <loop.md> --model --effort --permission-mode --permission-prompts none --output-format stream-json --verbose --settings <cycle>/settings.json --agents <cycle>/agents.json [--max-budget-usd] < /dev/null`.
- Role files in `.epoptes/agents/*.md` use Claude Code's agent frontmatter; the adapter converts them to `agents.json` in the cycle dir (the body becomes `prompt`).
- The adapter copies `.epoptes/settings.json` to the cycle dir with `permissions.defaultMode` set to `adapter.permission_mode`. **A `--settings` file without `defaultMode` silently overrides `--permission-mode` back to `default`** (verified on 2.1.283), and with `--permission-prompts none` that denies every tool outside the allow list. The runner also compares `permissionMode` in the init event with the requested one and emits a `warn` if they differ.
- stdin is `/dev/null`; otherwise `claude -p` waits 3 s for stdin every cycle.
- Stream facts (2.1.283): subagent messages carry `parent_tool_use_id`, `subagent_type` and `task_description`; `system/task_started` and `system/task_notification` bracket each subagent (with `task_id`, `usage`). Agent calls start in the background by default; the print session then runs extra turns and emits one `result` event per turn (`result_index`), each with cumulative totals, so the **last** `result` is the cycle result. `rate_limit_event` carries the account's `status`, `resetsAt` and per-window utilization.
- Rate limits: a `rate_limit_event` whose status isn't `allowed`/`allowed_warning` gives an exact `resets_at`, and the runner waits until then. Otherwise it falls back to the text match from `run.sh` (`rate limit`, `usage limit`, `overloaded`, `429`, `529`) with exponential backoff.

## Dashboard (`epoptes ui`)
A local web server (`src/ui/`) plus static files (`ui/`, Preact via `htm`'s standalone build, no build step). It only reads and writes the goal files, and it calls the same control code as the CLI.
- **Binding:** `127.0.0.1:4747` by default (`--port`, or `port` in `~/.epoptes/config.json`). `--lan` binds `0.0.0.0` after a warning; there is no login in v1.
- **Guards:** requests must carry `Host: 127.0.0.1|localhost|[::1]:<port>` (DNS-rebinding guard; skipped with `--lan`). Every write needs `X-Epoptes: 1` and a JSON body, and a present `Origin` must match; that forces a CORS preflight the server never answers, so other sites can't post feedback (which ends up in prompts) or start runs. A strict CSP allows only `'self'`.
- **Updates:** the server polls each goal every second (inotify doesn't work on WSL's `/mnt` drives), tails the JSONL files incrementally, and pushes `update` events over SSE (`/api/stream`): `{id, parts, events, feedback, activity, cycle}`. After a write it polls that goal at once.
- **API:** `GET /api/state` (all goal summaries + newest `limits`), `GET /api/goals/<id>` (detail), `GET /api/goals/<id>/cycles/<n>` (one cycle's result and activity), `POST /api/goals/<id>/control {action: start|pause|stop|extend|reset, seconds?}`, `POST /api/goals/<id>/feedback {text, resume?}` (`resume`: also resume a `needs_input` run), `POST /api/goals/<id>/feedback/<F-n> {status?, note?}`, `{text}` (edit) or `{decision: approved|rejected, note?}`, `POST /api/goals/<id>/seen`.
- **Waiting for you:** a goal that is `needs_input` or has pending approvals shows a ⚑ line on its card, a highlighted panel at the top of its page (the reason, Approve / Disapprove with an optional note, and a reply box with "Send & resume"), and `⚑ <n>` in the page title.
- **Unread badges:** feedback updates by the orchestrator and `milestone | blocked | needs_you | done | warn | run.end` events newer than the goal's cursor in `~/.epoptes/ui.json`. Opening a goal moves the cursor; a goal seen for the first time starts at "now".
- **Notifications:** toasts and the activity feed for the same events plus rate-limit waits and failed cycles; desktop notifications (browser Notification API, opt-in button) for the types in `goal.notify`. Milestones and DONE get a small confetti burst, skipped under `prefers-reduced-motion`, which also turns off every animation.

## CLI
```
epoptes add [dir]                      validate .epoptes/goal.json and register it
epoptes list
epoptes status [goal]                  one screen: state, mode, clock, cycle, backlog, handoff head, open feedback
epoptes clock [goal]                   one line for orchestrators: CYCLE RUN MODE ACTIVE TO_WRAPUP TO_END TO_HARD_STOP CYCLE_ELAPSED
epoptes start | pause | stop [goal]       start: --new-run after DONE; --follow-up to handle open feedback only, no time box
epoptes feedback <F-n> scope auto|tweak|new_run   how a follow-up treats the item
epoptes extend [goal] <dur>            e.g. 2h, 30m
epoptes reset-clock [goal]
epoptes run [goal] --dry-run           check claude + files + guardrails (lint), print the next cycle's command; never starts the clock
epoptes feedback [goal] "<text>" [--steer]     --steer: interrupt the running cycle and replan around it now
epoptes feedback [goal] [--open]       list (--open: new, seen, in progress, blocked)
epoptes feedback <F-n> <status> ["note"]
epoptes feedback <F-n> approve|reject ["note"]   the human's answer to an approval
epoptes approval "<what>" [--ref <task>]        (orchestrator) ask before doing something on the approval list
epoptes wait-for-human "<what>"                 (orchestrator) end the run after this cycle as needs_input
epoptes event <milestone|blocked|note|artifact|round|wrapup|done> "<text>"
epoptes report [goal | --all] [--md | --html] [--stdout] [--out <dir>]
epoptes import-runsh <project> [-g <id>]  import a dress2impress-style run.sh harness into <project>/.epoptes
epoptes ui [--port N] [--lan]
epoptes skill install | path           link plugin/skills/epoptes into ~/.claude/skills
```

## Reports (`src/report.ts`)
Built only from recorded files: `events.jsonl`, `cycles/*/result.json`, `feedback.jsonl`, `state/backlog.md`, `state/scores.jsonl`, and git (commits since the first run for `git`, snapshot count for `shadow`). Markdown and a self-contained HTML page (inline CSS and SVG, no scripts, light/dark, printable). `epoptes report` writes both to `.epoptes/reports/` (gitignored); `--all` writes an across-goals report to `~/.epoptes/reports/`. The dashboard serves them at `/goals/<id>/report.html` and `/report.html` with a CSP that allows inline styles and nothing else.
- **Wall time:** first `run.start` to last `run.end` (or now). **Active time:** each runner process's `run.start`→`run.end` span, minus rate-limit waits when `pause_on_rate_limit` is set; this matches the clock and survives past runs' clocks being replaced.
- **What's in it:** totals, tokens and cost by model, runs, cost per cycle (⚠ over 2× median), milestones/wrap-up/done, tasks done (`[x]`), commits or snapshots, artifacts, feedback with the cycle and note that closed it, blocked and cut tasks, scores (both `{scores:{…}}` and flat lines), cycles, and deduplicated warnings.
- Costs carry `≈` and "API-equivalent estimate, not billed" whenever any cycle's `cost_basis` is `estimate`.

**Importer** (`src/importers/runsh.ts`): reads `harness/logs/watchdog.log` (run boundaries, times, rc, timeouts, rate-limit waits), `harness/logs[/run<k>]/cycle-*.json`, `harness/state/*`, `FEEDBACK.md` (`→ F-n`) and git tags (`m<k>-done` → milestones, others → releases), and writes one monotonic cycle sequence into `<project>/.epoptes/`. It refuses to import into a goal that already has records.

## Skill (`plugin/`)
A Claude Code plugin (`plugin/.claude-plugin/plugin.json`) with one skill, `plugin/skills/epoptes/`: `SKILL.md` (process + CLI reference), `reference/{interview,design,guardrails}.md`, and `templates/` (`goal.json`, `loop.md`, `settings.json`, `FEEDBACK.md`, `agents/{worker,checker,reviewer}.md`, `state/*.md`). Templates use `{{placeholders}}` and `<!-- template: … -->` notes; the dry-run lint rejects any that are left. Load it with `claude --plugin-dir plugin` (shows as `epoptes:epoptes`) or `epoptes skill install` (a symlink, so it tracks the repo).

**Dry-run lint** (`src/lint.ts`): problems (exit 1) for template leftovers and role files without a description; warnings for credential-looking strings (reported by file, never printed), a deny list missing `git push` / `reset --hard` / `clean -fdx`, broad allows (`Bash(*)`), a loop that never runs `epoptes event done` or reads `epoptes feedback`, roles without a model, state files over their caps, an empty approval list, and all-manual done checks.
The npm package is `@ramigbcom/epoptes`; the binary is `epoptes`.
