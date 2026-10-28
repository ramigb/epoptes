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
    FEEDBACK.md            optional hand-written inbox   you (+ marks → C-n)        committed
    state/                 orchestrator memory           orchestrator               committed
    board.jsonl            the board: every card         append-only, anyone        committed
    events.jsonl           event log                     append-only, anyone        committed
    snapshots.git/         shadow checkpoints            runner (checkpoints=shadow) ignored
    run/                   live runner state             runner (+ CLI for control) ignored
      status.json  clock.json  control.json  runner.lock  DONE  WRAPUP  runner.log  bin/epoptes
    cycles/<NNNNNN>/       per-cycle records             runner                     ignored
      result.json  activity.jsonl  stream.jsonl  stderr.log
    .gitignore             run/ cycles/ snapshots.git/ reports/ *.tmp .board.lock
~/.epoptes/
  registry.json            registered goals
  config.json              dashboard port, LAN opt-in
  ui.json                  dashboard read cursors (for unread badges)
```
`cycles/` and `run/runner.log` may hold confidential code and transcripts; they never leave the machine. `stream.jsonl` is the raw adapter output, kept for debugging; deleting it loses nothing the dashboard or reports need.

## Codex adapter

Set `adapter.type` to `codex`. Its defaults are `model: ""` (use the CLI's configured model), `effort: "high"`, `permission_mode: "workspace-write"`, `prompt: "loop.md"` and `args: []`. Supported permission modes are `read-only`, `workspace-write` and `danger-full-access`; `cycle.max_budget_usd` must be `null`. Existing Claude defaults remain unchanged.

The adapter launches `codex exec --json --skip-git-repo-check --sandbox <mode> -c 'approval_policy="never"'`, optionally with `--model` and `model_reasoning_effort`, then extra arguments and `-`. The prompt goes on stdin. Every cycle starts a new thread; it never resumes another Codex conversation. It uses the installed CLI's authentication, user configuration, project instructions and rules. `EPOPTES_CODEX_BIN` overrides the executable for tests.

`thread.started`, `turn.completed`, `turn.failed`, `error` and `item.*` events feed the existing activity/result files. Commands, file changes, MCP calls, web searches and agent messages appear in the ticker. A zero process exit requires a completed turn and no error to count as success. Cached input is subtracted from Codex's total input before storing `models[].input`, so cache share is not double-counted. Unknown dollar costs remain `null` through report/dashboard totals; rate limits use text detection and the runner's backoff because the stream gives no reset time. Plan usage (`limits`, `source: "codex"`) is read from the session log Codex writes for the thread (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread_id>.jsonl`, newest `rate_limits`: primary/secondary windows as `five_hour`/`seven_day`), at each turn's end and every 30 s while a turn runs. Usage with no explicit model is labelled `codex-configured`.

Claude `.epoptes/settings.json` is not native Codex configuration; Codex harnesses omit it. Role files become Codex custom agents for the cycle: `<cycle>/codex-agents/<role>.toml` holds `model`, `model_reasoning_effort` (from `effort`) and `developer_instructions` (the body), registered with `-c agents.<role>.description=…` and `-c agents.<role>.config_file=…` (role names: letters, digits, `-`, `_`). The orchestrator spawns them with `spawn_agent` by `agent_type`; a child thread runs on its role's model (verified on codex-cli 0.165.0: a gpt-6.1-sol checker under a gpt-6.1-terra orchestrator). `tools` and `maxTurns` aren't translated. Lint makes a Claude model (`haiku`, `sonnet`, `opus`, `claude-…`) on a Codex role a problem. Codex reports a role file it can't load as an `error` item, which becomes a `warn`; `collab_tool_call` items show in the ticker as `Agent`. The exec stream's usage is the parent thread's; subagent tokens aren't counted. The shared skill installs into `~/.agents/skills/epoptes` with `epoptes skill install --agent codex`; the default installation remains `~/.claude/skills/epoptes`.

References: official [non-interactive mode](https://developers.openai.com/codex/noninteractive), [configuration reference](https://developers.openai.com/codex/config-reference), and [skills](https://developers.openai.com/codex/skills). Command flags also checked against local `codex-cli 0.159.2` help; runtime tests use a fake CLI and make no inference calls.

## pi adapter

Set `adapter.type` to `pi`. Its defaults are `model: ""` (pi's configured default), `effort: "high"` (passed as `--thinking`), `permission_mode: "default"` (the only value: pi has no sandbox or approval modes), `prompt: "loop.md"` and `args: []`. `cycle.max_budget_usd` is allowed.

The adapter launches `pi --mode json --session-dir <cycle dir> -e <epoptes>/adapters/pi-guard.(ts|js)`, optionally with `--model` and `--thinking`, then extra arguments. The prompt goes on stdin (pi uses piped stdin as the first prompt). Every cycle starts a new session whose file lands in the cycle directory. It uses pi's own credentials, settings, context files and skills. `EPOPTES_PI_BIN` overrides the executable for tests.

The guard is a pi extension. The adapter writes the `.epoptes/settings.json` deny entries pi has tools for (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `LS`) into `<cycle>/pi-guard.json` and points `EPOPTES_PI_GUARD` at it; a `tool_call` handler blocks matches with a reason the model sees. Bash patterns are tested against the whole command and each part split on `&&`, `||`, `;`, `|` and newlines, after dropping leading `VAR=value`; a trailing ` *` also matches the bare command. Path patterns follow Claude's forms (`./` project-relative, `~/` home, `//` absolute, `*` and `**`). Allow entries are ignored. A blocked call shows up as a `warn` event.

Events used: `session` (id), `tool_execution_start` (ticker; pi tool names map to `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `LS`), `tool_execution_end` (guard blocks), assistant `message_end` (usage, cost, text, `stopReason`, `errorMessage`), `turn_end` (turns), `auto_retry_start`/`auto_retry_end` and `agent_settled`. JSON mode exits 0 even when the final response failed, so a cycle is `ok` only with exit 0, a settled, non-aborted run, and a last assistant response that isn't `error`/`aborted`; an error followed by a successful retry is fine. pi's `usage.input` already excludes `cacheRead`. `cost_usd` is the sum of pi's per-response `usage.cost.total` with `cost_basis: "estimate"`; the running total goes to `status.json` `live_usage` as it grows. pi bills the provider per token, so it has no plan `limits`. When it passes `cycle.max_budget_usd`, the adapter interrupts pi and the cycle ends as `error`. Rate limits are detected from the error text; pi gives no reset time, so the runner's backoff applies. Usage with no explicit model is keyed by the model id pi reports.

Verified against local pi 1.3.0 (`@earendil-works/pi-coding-agent`) with a local OpenAI-compatible fake server: the stdin prompt, the event shapes, cached-token accounting, the guard blocking `cd . && git push`, 429 retries ending as `rate_limited`, and the budget stop. Runner tests use a fake CLI and make no inference calls.

## Antigravity adapter

Set `adapter.type` to `antigravity`. Its defaults are `model: ""` (agy's configured model), `effort: ""` (passed as `--effort` when set; agy rejects it with a model id that names an effort, such as `gemini-3.8-flash-low`), `permission_mode: "accept-edits"`, `prompt: "loop.md"` and `args: []`. `cycle.max_budget_usd` must be `null`.

The adapter launches `agy --output-format stream-json`, then `--mode accept-edits|auto` or `--dangerously-skip-permissions` (`permission_mode: skip-permissions`), optionally `--model` and `--effort`, extra arguments, and `-p=<prompt>` last: in text mode agy reads no prompt from stdin, and a bare `-p` would take the next flag as the prompt. Every cycle starts a new conversation. It uses agy's own login, settings, permissions, rules and skills; `.epoptes/settings.json` is not translated. `EPOPTES_AGY_BIN` overrides the executable for tests.

Events used: `init` (`conversation_id`, `init.model`), `step_update` with `step_type: "tool"` and `state: "ACTIVE"` (ticker; `run_command` → `Bash`, `read_file`/`view_file` → `Read`, `write_file`/`write_to_file` → `Write`, `replace_file_content`/`multi_replace_file_content`/`sed_file` → `Edit`, `grep_search` → `Grep`, `find_by_name` → `Glob`, `list_dir` → `LS`, `invoke_subagent` → `Agent`), `step_type: "agent_response"` (`text_delta` joined into one text line per response; `state: "DONE"` carries per-response `usage`, sent as `live_usage` and counted as turns), and the final `result` (`status` `SUCCESS`/`ERROR`, `error`, whole-conversation `usage`, `denied_actions`). The result's usage replaces the per-step sums. `cache_read_tokens` is taken to be part of `input_tokens`, as in the Gemini API, and subtracted; `thinking_tokens` count as output. Headless agy auto-denies a tool needing a permission it can't ask for, ends the turn and still reports `SUCCESS` (exit 0): a result with `denied_actions` is an `error` cycle and each denial a `warn`. A bad model exits 1 with `status: "ERROR"`. Quota and rate-limit errors are detected from the text (`quota`, `RESOURCE_EXHAUSTED`, `429`); no reset time is given, so the runner's backoff applies. agy reports no cost (`cost_usd: null`) and no plan usage.

Role files become agy custom subagents for the cycle: `<cycle>/.agents/agents/<role>.md` (frontmatter `name`, `description`, `model` if set, `mainAgent: false`, `tools`; the body as the system prompt), with `--add-dir <cycle>` so agy discovers them. agy gives a subagent no tools unless listed, so a role without `tools` gets all mapped ones, as in Claude Code: `Read` → `view_file`, `read_file`; `LS` → `list_dir`; `Glob` → `find_by_name`; `Grep` → `grep_search`; `Bash(…)` → `run_command`; `Edit` → `replace_file_content`, `multi_replace_file_content`; `Write` → `write_to_file`, `write_file`; `WebSearch` → `search_web`; `WebFetch` → `read_url_content`. A name outside agy's subagent tool registry stops the subagent from starting (`command_status` and `send_command_input` are outside it). `model` is an agy tier (`inherit`, `flash`, `pro`; lint warns otherwise); `effort` and `maxTurns` aren't translated. `invoke_subagent` shows in the ticker as `Agent` with the role name. The result's usage includes subagents.

Verified against local agy 1.4.9 with Gemini 3.8 Flash: role files as subagents (a checker that read a file and ran an allowed `git --version`), the event shapes, a multi-line prompt in `-p=`, file tools under `accept-edits`, a denied `run_command`, and the model/effort conflict. Runner tests use a fake CLI and make no inference calls.

## goal.json — schema `goal.schema.json`
Written by the skill, edited by you. The runner re-reads it before every cycle, so changes apply from the next cycle. The time box is copied into `run/clock.json` when a run starts; `extend` and `reset-clock` act on the clock, not on goal.json.

| field | meaning |
|---|---|
| `id`, `name`, `kind` | slug, display name, `code \| research \| content \| data \| other` |
| `objective` | one or two sentences |
| `done[]` | `{id, check, verify: {type: command \| file \| agent \| manual, run?, path?}}` |
| `non_goals[]`, `approval_required[]` | plain strings; the skill writes them into loop.md too |
| `job` | set by `epoptes job new`: `{id, title}` of the current job (see Jobs) |
| `output` | optional: the main deliverable, a project-relative path (file or folder) or an http(s) URL. `epoptes event output <path\|url>` overrides it at run time (latest wins) |
| `timebox` | `total_min`, `wrapup_min`, `grace_min`, `pause_on_rate_limit` |
| `checkpoints` | `git` (orchestrator commits), `shadow` (runner commits the workspace to `.epoptes/snapshots.git` after each cycle, no tokens, never touches your repo), `none` |
| `adapter` | `type` (`claude-code`, `codex`, `pi` or `antigravity`), `prompt` (default `loop.md`), `model`, `effort`, `permission_mode`, `args[]` |
| `cycle` | `timeout_min` (clamped 20–180), `pause_between_s`, `max_budget_usd` (null = none) |
| `failures` | `cooldown_after`, `cooldown_min`, `give_up_after` (consecutive failed cycles) |
| `rate_limit` | `backoff_s`, `backoff_max_s` (doubles per consecutive hit) |
| `state_caps` | `{ "<state file>": max_lines }`; the runner emits a `warn` event when exceeded, never trims |
| `notify[]` | event types that raise desktop / push notifications |

## Processes
There is no daemon. `epoptes start` spawns one detached runner per goal (`setsid`, stdio to `run/runner.log`). The runner loops cycle after cycle and exits when the run ends or pauses. `epoptes ui` is a file watcher plus the same control functions the CLI uses; closing it never affects a run.

**Liveness.** The runner writes `status.json` on every state change and a `heartbeat_at` every 15 s. A reader treats a goal as live when `pid` is alive (`kill -0`) and the heartbeat is < 60 s old. If `state` says running but the pid is dead, the next reader (CLI or dashboard) rewrites the state as `crashed` and pauses the clock at `heartbeat_at`. Starting a runner when a live one exists is refused.

**States** (`status.json.state`): `idle` (never started / after reset), `running` (a cycle is in flight), `waiting` (between cycles), `rate_limited`, `cooldown`, `pausing` (pause requested, cycle finishing), `paused`, `needs_input` (paused because the orchestrator ran `epoptes wait-for-human`; `status.needs` says why), `stopped`, `crashed`, `failed` (gave up after `give_up_after` fails), `done`, `timeboxed` (hard stop reached).

**Follow-up runs.** After DONE (or a finished time box), `start --follow-up` (dashboard: "Follow up on N cards") begins a run whose clock has `kind: "followup"` and no time box (`timebox_s: 0`, mode `followup`, `TO_END=none`). It handles only the *follow-up cards* of the current epic: the human's open cards that aren't blocked, and any card *waiting* for a reply (below), minus unanswered approvals and cards marked `scope: new_run`. Before each cycle the runner puts a FOLLOW-UP note in front of the prompt listing them: minor items (a colour, a size, wording, a small bug) get done in place; major ones (a restart, a new version, a change of direction) are blocked with `"needs a new run: …"`; questions get a reply. The human can override per card with `{op: set, scope: auto | tweak | new_run}`. The run ends when the orchestrator says DONE or no follow-up item is left (the runner then records `done` itself); after 3 cycles without that it pauses with a warning. `run.start` carries `followup: true`; the control action is `follow_up`.

**Runs.** `start` from `idle`, `done`, `timeboxed` or after `reset-clock` begins a new run `r<k>` with a fresh clock. `start` from `paused`, `stopped`, `crashed` or `failed` resumes the current run. Cycle numbers are monotonic per goal across runs; each record carries its `run`.

### Controls
| control | mechanism |
|---|---|
| start / resume | CLI spawns the runner; the clock resumes. If the run is over (DONE, or past the hard stop), `start` refuses unless given `--new-run` (dashboard: "Start new run…" with a confirm), because a new run spends tokens and only finds work if cards were added. The `control` event says `start` for a new run and `resume` for a continuation |
| pause after this cycle | CLI writes `control.json {pause_after_cycle: true}`; runner finishes the cycle, pauses the clock, sets `paused`, exits |
| wait for the human | orchestrator runs `epoptes wait-for-human "<what>"`: `control.json {pause_after_cycle: true, for_human: {reason}}` plus a `needs_you` event. The run ends after the cycle as `needs_input` with `status.needs = {reason, since}` and the clock paused. Resume as usual; answering the last open approval (or "Send & resume" in the dashboard) resumes it by itself |
| steer | `epoptes feedback "<text>" --steer` (dashboard: ⚡ Steer now) adds a backlog card `{op: add, steer: true}`, and `epoptes card <id> comment "<text>" --steer` (dashboard: the ⚡ box under a card's comment) adds `{op: comment, steer: true}`; either sends SIGUSR2 to a live runner. A running cycle is interrupted (`cycle.end {exit: interrupted, steered: true}`, not counted as a failure) and the next starts at once; a between-cycles wait is cut short, a rate-limit or cooldown wait is not. While a steering card is unanswered, the runner puts a STEERING note in front of the prompt (and `cycle.start` carries `steer: [ids]`) telling the orchestrator to replan the whole board around it first. With no live runner, it waits for the next start |
| board clear | not a control, a runner guard: in build mode, when the current epic has cards but none open in todo/doing/review apart from `low`/`med` priority ones (blocked and cut don't count), nothing sits untriaged in the backlog, no card waits for a reply and nothing is steering, the runner puts a BOARD CLEAR note in front of the prompt (`cycle.start {backlog_clear: true}`): run the done checks; all pass → wrap up; one fails → add only the tasks for it; no other new tasks (ideas go in the handoff). Why: an orchestrator with hours left tends to invent work |
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
`{version, state, pid, run, cycle, mode, cycle_started_at, heartbeat_at, waiting_until, wait_reason, pause_requested, fails_in_row, limits, live_usage, needs, updated_at}`

`limits` is the latest plan usage report from the adapter (`{status, resets_at, windows: {five_hour: {utilization, resets_at}, …}, at, source}`); `source` is `claude-code` (emitted in the stream; older files without `source` are Claude Code's) or `codex` (read from its session log). Goals on the same CLI share an account, so the dashboard keeps the newest `limits` per source: a goal's page shows its own CLI's plan, the goal list shows every source that has reported, and a pi goal shows its job's API spend instead. It costs no tokens.

`live_usage` (`{models, cost_usd, at}`) is the running cycle's usage so far, written at most every 2 s and cleared when the cycle ends, so cost and cache share show before the first result. Claude Code's comes from per-message `usage` (each API message id counted once; input and cache exact, output lags, `cost_usd` null until the result); pi's includes its cost. Codex reports usage only at the end of a turn.

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
| orchestrator | `milestone`, `blocked`, `note` | `text`, `ref?` (card id). `epoptes approval` emits `blocked` with `text: "needs approval: …"` and `ref: <card id>` |
| orchestrator / user | `needs_you` | `text`: what the human should do (`epoptes wait-for-human`) |
| orchestrator | `artifact` | `path`, `text?` (produced file worth showing in reports) |
| orchestrator | `output` | `path` (project-relative path or URL of the main deliverable), `text?` |
| orchestrator | `round` | `n` |
| orchestrator | `wrapup`, `done` | `text` (the CLI also creates `run/WRAPUP` / `run/DONE`) |

`milestone`, `wrapup` and `done` events from the CLI also carry `active_s` (active time when recorded), so the dashboard can place them on the clock.

Card changes are **not** duplicated here; they live in `board.jsonl`.

## board.jsonl — `board.schema.json`
The board: every piece of work is a card, the human's feedback included. One board per harness; each job is an **epic** (`epic` = the job id). Columns: `backlog` (untriaged: the human's feedback, agent notes) → `todo` → `doing` → `review` (being verified) → `done`. An append-only log of operations; a card's state is the fold of its lines in order.
```
{"ts":"…","op":"milestone","id":"M2","epic":"job-1","title":"Templates","target_s":4800}
{"ts":"…","op":"add","id":"C-3","title":"Arms clip into dresses","src":"dashboard","epic":"job-1","column":"backlog"}
{"ts":"…","op":"set","id":"C-3","by":"orchestrator","cycle":11,"column":"todo","milestone":"M2"}
{"ts":"…","op":"set","id":"C-3","by":"orchestrator","cycle":11,"column":"doing","assignee":"builder"}
{"ts":"…","op":"comment","id":"C-3","text":"still clips with the big bag","by":"user"}
{"ts":"…","op":"comment","id":"C-3","text":"fixed for every bag","by":"builder","cycle":12}
{"ts":"…","op":"set","id":"C-3","by":"orchestrator","cycle":12,"column":"done"}
```
- **Ops.** `add {title, src, epic, column, milestone?, assignee?, priority?, steer?, cycle?}`; `set {by, cycle?, …fields}` with any of `title, column, epic, milestone, assignee, priority (high|med|low), blocked (reason | null), cut (reason, with column done), scope`; `comment {text, by, cycle?, steer?}`; `ask {text, by}` (an approval request); `decide {decision: approved | rejected, by: user, note?}`; `milestone {id: M<n>, epic, title, target_s}`.
- `src` on add: `dashboard | cli | file | orchestrator`; a card from anything but `orchestrator` is the human's. `by`: `user` (the human), `orchestrator`, or the role acting for it (`epoptes card … --as builder`).
- **Whose turn it is.** A card is *waiting* when the human added it, commented on it or answered its approval, and no agent has acted on the card since (any op with `by` other than `user` answers it; so does the human moving it to done). A waiting card with a steering add or comment is *steering*. `epoptes board` tags them `[new: triage it]` / `[the human commented: read it]` / `[STEERING …]`.
- **Comments.** The human comments on any card; the next cycle acts on it (changes, moves or adds cards) or just replies. A human comment on a card in `done` also moves it back to `todo`.
- **Blocked and cut.** `blocked` keeps a card in its column, marked; `cut` moves it to `done` with a reason, and any later move clears it. A card with an unanswered approval counts as blocked.
- **Approvals.** `epoptes approval "<what>" --ref <card>` appends `ask` to that card (without `--ref`, or when it isn't a card id, to a new TODO card); it's blocked until the human's `decide`, which also shows in its thread and makes it wait for the next cycle.
- **Agent notes.** `epoptes feedback "<text>"` inside a cycle adds a backlog card with `src: "orchestrator"`: something a later cycle must act on. It shows to the human (toast, "agent note" chip, unread badge), who can edit (`set title`) or cut it.
- **Milestones** belong to an epic, in the order they were added, plus any milestone a card names without one. The current one is the first whose cards aren't all done, cut or blocked (or that has no cards yet). `epoptes clock` adds `MILESTONE=<id> M_TARGET=<h:mm>`.
- Ids are `C-<n>`, next free number (`F-<n>` for feedback imported from before the board). Adds take `.epoptes/.board.lock` (created with O_EXCL, stale after 10 s) so two writers can't pick the same id.
- **Ingest** (no model tokens). Before each cycle, and whenever the CLI or the dashboard reads the board: new bullets in `.epoptes/FEEDBACK.md` become backlog cards (`src: file`, the bullet gets ` → C-<n>`); a `state/backlog.md` (the seed format the skill writes: `## M<n> · <title> (target h:mm)` headings, `- [ ] <task>` lines with `[~]`, `[x]`, `[blocked: why]`, `[cut]`) becomes milestones and cards in the current epic and is renamed `backlog.md.imported`. A goal from before the board is migrated once, when `board.jsonl` doesn't exist yet: `feedback.jsonl` ops become card ops (ids kept, each item in the epic of the job it was added in; renamed `feedback.jsonl.imported`), and every archived job's `backlog.md` is imported into its epic.
- **For old loop.md files** (no `epoptes board` or `epoptes card` in them) the runner puts a THE BOARD note in front of the prompt that maps backlog.md and `epoptes feedback` onto the board.

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
| `backlog.md` | only a seed, imported onto the board and renamed (see board.jsonl). Milestones and their targets (active time from the start of the run) then live on the board. The dashboard splits the progress bar by milestone, and marks each target on the clock bar (reached on time, late, overdue, upcoming) with a dot where the `milestone` event that names it (`"M2: …"`) actually landed. `epoptes clock` adds `MILESTONE=<id> M_TARGET=<h:mm>` for the current one. **Projected finish:** the pace of the latest milestone reached this run (its active time / its target), or of the current milestone if it's already past its target and slower, applied to the last milestone's target. Shown as a dashed marker and "on pace to finish at ~h:mm" on the clock bar, and as a `pace` line in `epoptes status` |
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
- `EPOPTES_GOAL_DIR`, `EPOPTES_RUN`, `EPOPTES_CYCLE`, `EPOPTES_MODE`, so `epoptes event …`, `epoptes board` and `epoptes card …` need no arguments inside a cycle.
- `PATH` starting with `run/bin/`, which holds an `epoptes` shim for the exact CLI that started the runner (works without a global install). The Claude Code adapter always adds `Bash(epoptes *)` to the cycle's allow list.
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: in dress2impress, background subagents were killed 600 s after the orchestrator's turn ended. The cycle timeout still bounds the cycle.

## Adapter interface
```ts
interface Adapter {
  id: string;                                   // "claude-code", "codex", "pi" or "antigravity"
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
- **Updates:** the server polls each goal every second (inotify doesn't work on WSL's `/mnt` drives), tails the JSONL files incrementally, and pushes `update` events over SSE (`/api/stream`): `{id, parts, events, board, activity, cycle}`. After a write it polls that goal at once.
- **API:** `GET /api/state` (all goal summaries + newest `limits` per source), `GET /api/goals/<id>` (detail), `GET /api/goals/<id>/cycles/<n>` (one cycle's result and activity), `GET /api/goals/<id>/time` (where the time went, below), `POST /api/goals/<id>/control {action: start|pause|stop|extend|reset, seconds?}`, `POST /api/goals/<id>/cards {title, steer?, resume?}` (a backlog card; `resume`: also resume a `needs_input` run), `POST /api/goals/<id>/cards/<card id>` with `{column?, title?, milestone?, assignee?, priority?, blocked?, cut?, scope?}`, `{comment, steer?}` or `{decision: approved|rejected, note?}`, `POST /api/goals/<id>/seen`.
- **Waiting for you:** a goal that is `needs_input` or has pending approvals shows a ⚑ line on its card, a highlighted panel at the top of its page (the reason, Approve / Disapprove with an optional note, and a reply box with "Send & resume"), and `⚑ <n>` in the page title.
- **Where the time went** (`src/timeuse.ts`, panel under the cycles): *phases* from events: cycle durations, waits by reason (cut at the run's next event when a wait ended early), and gaps between runs when the human held the run (after `needs_you` → waiting for you; after `paused | stopped | crashed | failed` → paused; gaps after DONE or the time box don't count). *Roles* from activity: agent time per subagent type (start→end; parallel subagents add up) and `orchestrator (alone)` = the cycle minus the union of subagent spans. *Tools*: each call's time runs to the same agent's next step (capped at 15 min); background shell tasks (`agent#…` with no subagent type) count as `background commands`. Finished cycles are cached. The chart shows four phases (running = cycles + between-cycles gaps; rate limits + cooldowns; waiting for you; paused), bar lists for roles and tools, hover tooltips, and a table view.
- **Output link:** "Output ↗" in the controls and "Open the output ↗" in the done banner. URLs open as they are. Project files are served by a second, read-only server on the next free port after the dashboard's (`src/ui/output.ts`, `http://127.0.0.1:<port+1>/<goal id>/<path>`): a separate origin, so an agent-built page runs normally but can't call the dashboard API. It serves only files inside a registered project (symlinks resolved), never a path with a dot segment (`.epoptes`, `.git`, `.env`), lists folders without an index.html, shows Markdown and text as plain text, and is off in `--lan` mode.
- **Favicon:** drawn on a canvas and swapped as a `data:` PNG (allowed by the CSP). On a goal's page it follows that goal; on the list, the most urgent goal: needs you (amber, blinking `!`) > failed or crashed (red `!`) > running (green arcs turning) > rate-limited or cooling down (amber, slow pulse) > between cycles (green pulse) > done (purple check) > idle (grey). Static under `prefers-reduced-motion`.
- **Unread badges:** agent notes and agents' comments on the board, and `milestone | blocked | needs_you | done | warn | run.end` events newer than the goal's cursor in `~/.epoptes/ui.json`. Opening a goal moves the cursor; a goal seen for the first time starts at "now".
- **Notifications:** toasts and the activity feed for the same events plus rate-limit waits and failed cycles; desktop notifications (browser Notification API, opt-in button) for the types in `goal.notify`. Milestones and DONE get a small confetti burst, skipped under `prefers-reduced-motion`, which also turns off every animation.

## CLI
```
epoptes add [dir]                      validate .epoptes/goal.json and register it
epoptes list
epoptes status [goal]                  one screen: state, mode, clock, cycle, board, approvals, steering, handoff head
epoptes clock [goal]                   one line for orchestrators: CYCLE RUN MODE ACTIVE TO_WRAPUP TO_END TO_HARD_STOP CYCLE_ELAPSED
epoptes start | pause | stop [goal]       start: --new-run after DONE; --follow-up to handle the human's open cards and comments only, no time box
epoptes extend [goal] <dur>            e.g. 2h, 30m
epoptes reset-clock [goal]
epoptes run [goal] --dry-run           check claude + files + guardrails (lint), print the next cycle's command; never starts the clock
epoptes board [goal] [--open] [--all]          the current epic's cards by column (--open: hide done; --all: every epic)
epoptes feedback [goal] "<text>" [--steer]     a backlog card; --steer: interrupt the running cycle and replan around it now
epoptes card add "<title>" [--column c] [--milestone M] [--assign role] [--priority p]
epoptes card <id>                              one card with its comments
epoptes card <id> backlog|todo|doing|review|done ["note"]   move (takes the set flags too)
epoptes card <id> cut|block "<why>" | unblock
epoptes card <id> comment "<text>" [--steer] [--as role]
epoptes card <id> set [--title t] [--milestone M] [--assign r] [--priority p|none] [--epic e] [--scope auto|tweak|new_run]
epoptes card <id> approve|reject ["note"]      the human's answer to an approval
epoptes milestone [goal] | milestone add M<n> "<title>" [--target h:mm]
epoptes feedback <id> new|seen|in_progress|done|blocked|wont_do|note|edit|scope …   the old item commands, mapped onto cards
epoptes approval "<what>" [--ref <card>]       (orchestrator) ask before doing something on the approval list
epoptes wait-for-human "<what>"                 (orchestrator) end the run after this cycle as needs_input
epoptes event <milestone|blocked|note|artifact|round|wrapup|done> "<text>"
epoptes job [goal] | job new "<title>" [--id s]  list jobs | start the next job in this harness
epoptes lesson "<rule>" [--topic t]              (orchestrator) a harness lesson for the brain
epoptes brain | brain lessons [--kind k]          gather goals into ~/.epoptes/brain/INDEX.md | print lessons
epoptes report [goal | --all] [--md | --html] [--stdout] [--out <dir>]
epoptes import-runsh <project> [-g <id>]  import a dress2impress-style run.sh harness into <project>/.epoptes
epoptes ui [--port N] [--lan]
epoptes skill install | path           link plugin/skills/epoptes into ~/.claude/skills
```

## Jobs (`src/jobs.ts`)
One project keeps one harness; each new piece of work in it is a **job**.
- `epoptes job new "<title>" [--id slug]` (refused while a runner is live): moves the current job's working state (`handoff.md`, `progress.md`, `scores.jsonl`) into `state/archive/<previous job id>/`, writes a fresh handoff and progress, opens a new epic on the board, resets the clock (the next `start` is a new run, no `--new-run`), sets `goal.json` `job: {id, title}`, and emits `{type: job, id, title, previous, previous_title, archived}`. Harness memory stays: goal settings, roles, permissions, `state/lessons.md`, `state/decisions.md`, and the board: the old epic's cards stay in it, and its untriaged backlog cards move to the new epic (the CLI lists them).
- **A job is a window of history** from its `job` event to the next; history before the first one is the first job (named by `previous` / `previous_title`, default `job-1` and the goal's name). `run.start` also records `job`.
- **Scoping:** goal cards, `epoptes status` and the dashboard's numbers count the current job; with several jobs the goal page has a "This job / All jobs" switch (`GET /api/goals/<id>?jobs=all`, `…/time?jobs=all`). `epoptes report` covers the current job by default (`--job <id>` or `all`; the dashboard: Report / Report: all jobs, `?job=`); a job's report reads its epic's cards and its archived scores; the human's cards in the epic are its feedback. `epoptes report --all` (every goal) covers whole histories.
- `epoptes job` lists the jobs with cycles and cost. The skill's "new job in an existing harness" path runs a short interview about what changes, `job new`, then updates goal.json, the job-specific parts of loop.md and seeds the new epic.

## Brain (`src/brain.ts`, `~/.epoptes/brain/`)
What past harnesses taught, for designing the next one. Token-free and local only.
- **Lessons:** `epoptes lesson "<rule>" --topic <roles|briefs|cycles|checks|tools|state|cost|steering|other>` emits a `lesson` event (`text`, `topic`) in the goal's events.jsonl. Loop templates ask for 1–3 in wrap-up.
- **Digest per goal:** `brain/goals/<id>.json`: kind, adapter, model, roles and their models, time box, stats (runs, follow-ups, cycles by exit, active time, median cycle length and cost, rate-limit waits, steers, approvals, waits for the human, feedback, milestones reached / on time / late, done), automatic *signals* from those numbers (frequent timeouts, rate limits, late milestones, repeated steering or follow-ups, finishing far under the time box…), the lessons, and the goal's `state/lessons.md` rules as *work lessons*.
- **Index:** `brain/INDEX.md` (and `index.json`): lessons by topic with near-duplicates merged across goals, a table by goal kind, and one block per goal. Rebuilt; never hand-edited. Curated principles live in `brain/NOTES.md`, written by the skill when asked to "distill the brain".
- **When:** the runner gathers its goal and rebuilds the index whenever a run ends (errors only log); `epoptes brain` gathers every registered goal. The skill runs it and reads NOTES.md + INDEX.md before designing (step 2), and lists the lessons it applied in the sign-off summary.
- **Dashboard:** "Brain" on the goal list (`#/brain`, `GET /api/brain`, `POST /api/brain` to gather first).

## Reports (`src/report.ts`)
Built only from recorded files: `events.jsonl`, `cycles/*/result.json`, `board.jsonl`, `state/scores.jsonl`, and git (commits since the first run for `git`, snapshot count for `shadow`). Markdown and a self-contained HTML page (inline CSS and SVG, no scripts, light/dark, printable). `epoptes report` writes both to `.epoptes/reports/` (gitignored); `--all` writes an across-goals report to `~/.epoptes/reports/`. The dashboard serves them at `/goals/<id>/report.html` and `/report.html` with a CSP that allows inline styles and nothing else.
- **Wall time:** first `run.start` to last `run.end` (or now). **Active time:** each runner process's `run.start`→`run.end` span, minus rate-limit waits when `pause_on_rate_limit` is set; this matches the clock and survives past runs' clocks being replaced.
- **What's in it:** totals, tokens and cost by model, runs, cost per cycle (⚠ over 2× median), milestones/wrap-up/done, cards done, commits or snapshots, artifacts, the human's cards with the cycle and note that closed them, blocked and cut cards, scores (both `{scores:{…}}` and flat lines), cycles, and deduplicated warnings.
- Costs carry `≈` and "API-equivalent estimate, not billed" whenever any cycle's `cost_basis` is `estimate`.

**Importer** (`src/importers/runsh.ts`): reads `harness/logs/watchdog.log` (run boundaries, times, rc, timeouts, rate-limit waits), `harness/logs[/run<k>]/cycle-*.json`, `harness/state/*`, `FEEDBACK.md` (`→ F-n`) and git tags (`m<k>-done` → milestones, others → releases), and writes one monotonic cycle sequence into `<project>/.epoptes/`. It refuses to import into a goal that already has records.

## Skill (`plugin/`)
A Claude Code plugin (`plugin/.claude-plugin/plugin.json`) with one skill, `plugin/skills/epoptes/`: `SKILL.md` (process + CLI reference), `reference/{interview,design,guardrails}.md`, and `templates/` (`goal.json`, `loop.md`, `settings.json`, `FEEDBACK.md`, `agents/{worker,checker,reviewer}.md`, `state/*.md`). Templates use `{{placeholders}}` and `<!-- template: … -->` notes; the dry-run lint rejects any that are left. Load it with `claude --plugin-dir plugin` (shows as `epoptes:epoptes`) or `epoptes skill install` (a symlink, so it tracks the repo).

**Dry-run lint** (`src/lint.ts`): problems (exit 1) for template leftovers and role files without a description; warnings for credential-looking strings (reported by file, never printed), a deny list missing `git push` / `reset --hard` / `clean -fdx`, broad allows (`Bash(*)`), a loop that never runs `epoptes event done` or reads `epoptes board`, roles without a model, state files over their caps, an empty approval list, and all-manual done checks.
The npm package is `@ramigbcom/epoptes`; the binary is `epoptes`.
