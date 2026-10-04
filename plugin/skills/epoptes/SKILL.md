---
name: epoptes
description: Design, generate and register a long-running, time-boxed autonomous harness that the Epoptes runner executes as fresh-context Claude Code or Codex cycles, for any goal (code, research, content, data). Use when the user wants to build or set up a harness, an overnight or multi-hour autonomous run, or mentions Epoptes. Also use to check on or steer existing Epoptes goals (status, start, pause, stop, feedback, events, reports).
---

# Epoptes: harnesses for long-running goals

Epoptes runs a goal as a series of **cycles**. Each cycle is a fresh `claude -p` or `codex exec` orchestrator that reads the goal's files, does one slice of work (using subagents when configured), verifies it, records state and exits. All memory lives in files under `<project>/.epoptes/`. The runner, CLI and dashboard only read and write those files.

You do one of two jobs:
- **Check on or steer a goal:** use the CLI (reference at the bottom). Read `epoptes status <goal>` before anything else. Don't open `cycles/` transcripts unless the user asks.
- **Build a harness:** follow the process below. Do every step, in order.

## Building a harness

### 1. Interview
Work through [reference/interview.md](reference/interview.md) until every item has an answer the user agreed to. Ask in small batches (2–4 questions). Use the host's user-question tool when there are clear options, and always put your recommended default first. Look at the project directory yourself first, so you ask only what you can't find out.

Keep asking until you agree. Never fill a gap with a silent assumption; propose a default and get a yes.

### 2. Design
Use [reference/design.md](reference/design.md) to pick:
- the roles (and their models and effort)
- the cycle size and budgets
- the state files and their caps
- how each done check is verified
- the backlog's first milestones

Adapt the roles to the goal. Don't copy a software team onto a research goal.

### 3. Sign-off
Show the one-screen summary from interview.md. Wait for an explicit yes. If the user changes anything, update the summary and ask again.

### 4. Generate
1. Copy [templates/](templates/) into `<project>/.epoptes/`: `goal.json`, `loop.md`, `settings.json`, `FEEDBACK.md`, `agents/*.md` and `state/*.md`.
2. Adapt **every** file to this goal and the selected adapter (Claude Code or Codex):
   - Replace every `{{…}}` placeholder.
   - Delete the template notes (lines starting with `<!-- template:`).
   - For Claude Code, keep `adapter.type: "claude-code"` and its model aliases, role frontmatter and settings.json.
   - For Codex, set `adapter.type: "codex"`, `permission_mode: "workspace-write"`, and `cycle.max_budget_usd: null`. Use a Codex model id confirmed with the user, or `model: ""` to use their CLI configuration. Remove settings.json: Codex uses its own sandbox and native rules.
   - Rename, add or remove role files to match the design. Codex role files are guidance only: adapt loop.md to perform work and checks sequentially, reading role instructions when needed. Do not rely on Claude Agent, SendMessage, per-role models, tools or maxTurns. Native Codex subagents require separate user-configured Codex agents; Epoptes does not translate role frontmatter.
   - Seed `state/backlog.md` with the first milestones and tasks, and `state/decisions.md` with what the interview settled.
3. Apply [reference/guardrails.md](reference/guardrails.md): the permissions for this goal kind, no git push or history rewrites, and secrets kept out of every file.
4. For a new directory without git: set `checkpoints` to `shadow`, not `git`, unless the user wants a repo.

### 5. Check
Run `epoptes run --dry-run <project>`. Fix every problem **and** every warning it prints, then run it again until it prints `ok`. It never starts the clock.

### 6. Register
Run `epoptes add <project>`. Then tell the user:
- the goal id
- how to start it (`epoptes start <id>`, or Start in the dashboard, `epoptes ui` → http://127.0.0.1:4747)
- how to give feedback while it runs

Offer to start it; don't start it without a yes.

## Rules every generated harness follows
- **Fresh context every cycle.** All memory is in `state/`, and each state file has a cap in `goal.json` `state_caps`.
- **Targeted reads.** The orchestrator reads headers and slices (`grep -n`, `sed -n`), never whole large files or transcripts.
- **Use provider-appropriate models.** Claude Code checkers can use Haiku/low; judgement uses Sonnet or Opus. Codex uses the selected CLI model and effort for the cycle.
- **Reuse workers when available.** Use the host's follow-up tool; Codex without configured subagents does the work sequentially.
- **Caps per cycle:** at most 3 rounds, a soft time limit (usually 45–60 min), and optionally `cycle.max_budget_usd` for Claude Code only.
- **Parallel tasks own separate files.** Two workers never write the same file in one round.
- **Guardrails:**
  - Claude Code: a permissions allow/deny list; Codex: a workspace-write sandbox and native rules
  - no `git push`, no history rewrites, no destructive cleans
  - secrets never in goal files (point to the user's secret manager, e.g. the 1Password CLI or MCP)
- **Anything in the goal's approval list is never done autonomously.** The orchestrator runs `epoptes approval "…" --ref <task>`, marks the task `[blocked: needs approval F-<n>]` and moves on. The human answers with Approve / Disapprove in the dashboard (or `epoptes feedback F-<n> approve|reject`). When nothing else can move, the orchestrator runs `epoptes wait-for-human "…"` and the run waits, clock stopped, until the human answers.
- **Semantic events go through the CLI:** `epoptes event milestone|blocked|done …` (plus PushNotification when it's available).

## CLI reference
Inside a cycle, the runner sets `EPOPTES_GOAL_DIR`, `EPOPTES_RUN`, `EPOPTES_CYCLE` and `EPOPTES_MODE`, so the goal argument can be left out. `[goal]` is a registered id or a path.

| command | what it does |
|---|---|
| `epoptes add [dir]` | validate `<dir>/.epoptes/goal.json` and register the goal |
| `epoptes list` | all goals with state, cycle, mode and active time |
| `epoptes status [goal]` | one screen: state, clock, cycle, backlog, feedback, usage, last cycle, handoff |
| `epoptes clock` | one line for orchestrators: `CYCLE= RUN= MODE= ACTIVE= TO_WRAPUP= TO_END= TO_HARD_STOP= CYCLE_ELAPSED=` |
| `epoptes run [goal] --dry-run` | check the setup and guardrails, print the next cycle's command; never starts the clock |
| `epoptes start [goal]` | resume, or start a detached run; `--new-run` after DONE or when the time box is over |
| `epoptes start [goal] --follow-up` | after DONE: handle just the open feedback, with no time box. Minor items are fixed in place; ones that need a restart or new version are flagged for a new run |
| `epoptes feedback F-<n> scope auto\|tweak\|new_run` | the human's override for a follow-up (default: the agent triages) |
| `epoptes pause [goal]` | pause after the current cycle (the clock pauses too) |
| `epoptes stop [goal]` | stop now; the next cycle recovers interrupted work |
| `epoptes extend [goal] <dur>` | lengthen the time box, e.g. `2h`, `30m` |
| `epoptes reset-clock [goal]` | clear the clock; the next start is a new run |
| `epoptes feedback [goal] "<text>"` | add a feedback item (`F-<n>`) |
| `epoptes feedback [goal] "<text>" --steer` | steering: interrupt the running cycle now; a fresh cycle replans the whole backlog around it first |
| `epoptes feedback [goal] [--open]` | list feedback (`--open`: only new, seen, in progress, blocked) |
| `epoptes feedback F-<n> <status> ["note"]` | set a status: `new`, `seen`, `in_progress`, `done`, `blocked`, `wont_do` |
| `epoptes feedback F-<n> note "<text>"` | comment on an item |
| `epoptes feedback F-<n> edit "<text>"` | change an item's text (e.g. correct an agent note) |
| `epoptes feedback "<text>"` inside a cycle | an **agent note**: something the next cycle must act on (e.g. a research finding that changes the plan); the human sees it and can edit or dismiss it |
| `epoptes feedback F-<n> approve\|reject ["note"]` | the human's answer to an approval request; resumes a run that was waiting for it |
| `epoptes approval "<what>" [--ref <task>]` | (orchestrator) ask the human before doing something on the approval list |
| `epoptes wait-for-human "<what>"` | (orchestrator) end the run after this cycle as "waiting for you"; the clock stops |
| `epoptes event milestone\|blocked\|note\|artifact\|round\|wrapup\|done "<text>"` | record a semantic event; `wrapup` and `done` also set the run markers |
| `epoptes report [goal] [--all] [--stdout]` | Markdown + HTML report from recorded data into `.epoptes/reports/` (`--all`: every goal; `--stdout`: print the Markdown) |
| `epoptes import-runsh <project>` | import an older run.sh harness (dress2impress style) so it shows in reports and the dashboard |
| `epoptes ui` | the local dashboard on http://127.0.0.1:4747 |

When the user gives feedback on a **finished** goal, add it, then offer `epoptes start <goal> --follow-up` (no time box; only that feedback) rather than `--new-run`, unless they want a restart or a new version. When the user asks for a report, run `epoptes report <goal>` and give them the paths (or `--stdout` to summarise it). When the user asks how a goal is doing, run `epoptes status <goal>` and summarise it in a few lines: state, time left, progress and anything blocked. When they give feedback in chat, add it with `epoptes feedback <goal> "<their words>"` rather than editing files.
