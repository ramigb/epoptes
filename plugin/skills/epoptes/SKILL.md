---
name: epoptes
description: Design, generate and register a long-running, time-boxed autonomous harness that the Epoptes runner executes as fresh-context Claude Code or Codex cycles, for any goal (code, research, content, data). Use when the user wants to build or set up a harness, an overnight or multi-hour autonomous run, or mentions Epoptes. Also use to start a new job (feature, task) in a project that already has a harness, and to check on or steer existing Epoptes goals (status, start, pause, stop, feedback, events, reports).
---

# Epoptes: harnesses for long-running goals

Epoptes runs a goal as a series of **cycles**. Each cycle is a fresh `claude -p` or `codex exec` orchestrator that reads the goal's files, does one slice of work (using subagents when configured), verifies it, records state and exits. All memory lives in files under `<project>/.epoptes/`. The runner, CLI and dashboard only read and write those files.

You do one of three jobs:
- **Check on or steer a goal:** use the CLI (reference at the bottom). Read `epoptes status <goal>` before anything else. Don't open `cycles/` transcripts unless the user asks.
- **Build a harness:** follow the process below. Do every step, in order.
- **Start a new job in a project that already has a harness** (`.epoptes/goal.json` exists): don't build a second harness and don't overwrite this one. Follow "A new job in an existing harness" below.

## Building a harness

### 1. Interview
Work through [reference/interview.md](reference/interview.md) until every item has an answer the user agreed to. Ask in small batches (2–4 questions). Use the host's user-question tool when there are clear options, and always put your recommended default first. Look at the project directory yourself first, so you ask only what you can't find out.

Keep asking until you agree. Never fill a gap with a silent assumption; propose a default and get a yes.

### 2. Consult the brain
Run `epoptes brain` (it gathers every goal's numbers and lessons, no tokens), then read `~/.epoptes/brain/NOTES.md` if it exists and `~/.epoptes/brain/INDEX.md`: the harness lessons for the topics you are about to decide (roles, briefs, cycles, checks, tools), the numbers for this goal kind (typical cycle length and cost, timeout share), and the signals of similar goals. Apply what fits this goal and list it under LESSONS in the sign-off summary. Lessons are advice from past runs, not rules: the user's answers win.

### 3. Design
Use [reference/design.md](reference/design.md) to pick:
- the roles (and their models and effort)
- the cycle size and budgets
- the state files and their caps
- how each done check is verified
- the backlog's first milestones

Adapt the roles to the goal. Don't copy a software team onto a research goal.

### 4. Sign-off
Show the one-screen summary from interview.md. Wait for an explicit yes. If the user changes anything, update the summary and ask again.

### 5. Generate
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

### 6. Check
Run `epoptes run --dry-run <project>`. Fix every problem **and** every warning it prints, then run it again until it prints `ok`. It never starts the clock.

### 7. Register
Run `epoptes add <project>`. Then tell the user:
- the goal id
- how to start it (`epoptes start <id>`, or Start in the dashboard, `epoptes ui` → http://127.0.0.1:4747)
- how to give feedback while it runs

Offer to start it; don't start it without a yes.

## A new job in an existing harness
One project keeps one harness; each new piece of work (a feature, a fix sweep, a new chapter) is a **job** in it. What carries over: roles, models, permissions, `state/lessons.md`, `state/decisions.md`, and the harness's history. What's per job: the objective, done checks, time box, output, milestones and backlog.
1. **Look first.** `epoptes status` and `epoptes job` (the jobs so far). Read `goal.json`, the end of the last handoff, `state/lessons.md`, and `epoptes feedback --open`. If a run is live, stop here: ask whether to let it finish, pause it, or stop it.
2. **Short interview, only about what changes:** the new outcome and done checks, non-goals, time box, output, the first milestones, and whether the team, approval list or feedback setup should change. Ask what to do with open feedback from the last job (carry over, or close as `wont_do`). Run `epoptes brain` and apply lessons that fit, as in step 2 of building.
3. **Sign-off** with the usual summary plus two lines: `JOB <title> (job <n> in this harness)` and `KEEPS <roles, lessons, …> · CHANGES <what you'll change>`.
4. **Start the job:** `epoptes job new "<title>"`. It archives the finished job's backlog, handoff, progress and scores into `state/archive/<old job>/`, writes fresh ones, resets the clock and records the job. Then:
   - update `goal.json`: `objective`, `done`, `non_goals`, `timebox`, `output`, and anything the interview changed. Keep `id`.
   - update the job-specific parts of `loop.md`: the objective, quality bar, done checks, non-goals, approval list, review timing and wrap-up items. If loop.md predates the current template (no `epoptes approval`, `epoptes lesson` or the scope rule), refresh it from [templates/loop.md](templates/loop.md) while you're at it, keeping its goal-specific text.
   - seed `state/backlog.md` with the new milestones (`## M1 · … (target h:mm)`) and tasks. Milestone ids restart at M1.
   - close or keep open feedback as agreed.
5. **Check and hand over:** `epoptes run --dry-run` until it prints `ok`, then offer to start (`epoptes start`); no `--new-run` is needed.

For a small change to a finished job (a colour, a size, wording), don't start a job: add feedback and use `epoptes start --follow-up`.

## Distilling the brain
When the user asks you to "distill the brain" (or INDEX.md has grown past ~30 lessons), rewrite `~/.epoptes/brain/NOTES.md`: at most 60 lines of principles for designing harnesses, grouped by topic, merging duplicates and dropping ones later goals contradicted, each with the goals it came from. Keep it generic (no project secrets or client names). Never edit INDEX.md; it is rebuilt from the goals.

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
- **Every harness feeds the brain:** in wrap-up the orchestrator records 1–3 harness lessons with `epoptes lesson "<rule>" --topic <topic>`.

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
| `epoptes job [goal]` | the harness's jobs, the current one last |
| `epoptes job new "<title>" [--id slug]` | start the next job in this harness: archive the finished job's working state, keep roles/lessons/decisions, reset the clock |
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
| `epoptes event output <path\|url> ["text"]` | where the main deliverable is; the dashboard shows "Open the output" (overrides goal.json `output`) |
| `epoptes lesson "<rule>" [--topic t]` | (orchestrator, in wrap-up) a lesson about the harness itself for the brain; topics: roles, briefs, cycles, checks, tools, state, cost, steering, other |
| `epoptes brain` / `epoptes brain lessons [--kind k]` | gather every goal into `~/.epoptes/brain/INDEX.md` / print the harness lessons |
| `epoptes report [goal] [--all] [--stdout] [--job <id>\|all]` | Markdown + HTML report from recorded data into `.epoptes/reports/` (`--all`: every goal; `--stdout`: print the Markdown) |
| `epoptes import-runsh <project>` | import an older run.sh harness (dress2impress style) so it shows in reports and the dashboard |
| `epoptes ui` | the local dashboard on http://127.0.0.1:4747 |

When the user gives feedback on a **finished** goal, add it, then offer `epoptes start <goal> --follow-up` (no time box; only that feedback) rather than `--new-run`, unless they want a restart or a new version. When the user asks for a report, run `epoptes report <goal>` and give them the paths (or `--stdout` to summarise it). When the user asks how a goal is doing, run `epoptes status <goal>` and summarise it in a few lines: state, time left, progress and anything blocked. When they give feedback in chat, add it with `epoptes feedback <goal> "<their words>"` rather than editing files.
