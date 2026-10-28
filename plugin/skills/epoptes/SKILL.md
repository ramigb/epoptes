---
name: epoptes
description: Design, generate and register a long-running, time-boxed autonomous harness that the Epoptes runner executes as fresh-context Claude Code, Codex or pi cycles, for any goal (code, research, content, data). Use when the user wants to build or set up a harness, an overnight or multi-hour autonomous run, or mentions Epoptes. Also use to start a new job (feature, task) in a project that already has a harness, and to check on or steer existing Epoptes goals (status, start, pause, stop, the board, feedback, events, reports).
---

# Epoptes: harnesses for long-running goals

Epoptes runs a goal as a series of **cycles**. Each cycle is a fresh `claude -p`, `codex exec` or `pi --mode json` orchestrator that reads the goal's files, does one slice of work (using subagents when configured), verifies it, records state and exits. All memory lives in files under `<project>/.epoptes/`. The runner, CLI and dashboard only read and write those files.

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
- the board's first milestones and cards

Adapt the roles to the goal. Don't copy a software team onto a research goal.

### 4. Sign-off
Show the one-screen summary from interview.md. Wait for an explicit yes. If the user changes anything, update the summary and ask again.

### 5. Generate
1. Copy [templates/](templates/) into `<project>/.epoptes/`: `goal.json`, `loop.md`, `settings.json`, `FEEDBACK.md`, `agents/*.md` and `state/*.md`.
2. Adapt **every** file to this goal and the selected adapter (Claude Code, Codex or pi):
   - Replace every `{{…}}` placeholder.
   - Delete the template notes (lines starting with `<!-- template:`).
   - For Claude Code, keep `adapter.type: "claude-code"` and its model aliases, role frontmatter and settings.json.
   - For Codex, set `adapter.type: "codex"`, `permission_mode: "workspace-write"`, and `cycle.max_budget_usd: null`. Use a Codex model id confirmed with the user, or `model: ""` to use their CLI configuration. Remove settings.json: Codex uses its own sandbox and native rules.
   - For pi, set `adapter.type: "pi"` and `permission_mode: "default"`. Use `model: ""` for the user's pi default, or a model they confirmed in pi's `provider/id` form (e.g. `openrouter/<vendor>/<model>`; `pi --list-models <search>` lists them). `effort` is pi's thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Keep settings.json for its **deny** list: pi has no sandbox or approvals, so Epoptes enforces the deny rules with a guard extension, and allow rules have no effect. `cycle.max_budget_usd` works (Epoptes stops the cycle when pi's cost estimate passes it); suggest one for pay-per-token providers like OpenRouter.
   - Rename, add or remove role files to match the design. Codex and pi role files are guidance only: adapt loop.md to perform work and checks sequentially, reading role instructions when needed. Do not rely on Claude Agent, SendMessage, per-role models, tools or maxTurns. Native Codex subagents require separate user-configured Codex agents, and pi has no built-in subagents; Epoptes does not translate role frontmatter.
   - Seed `state/backlog.md` with the first milestones and tasks, and `state/decisions.md` with what the interview settled. backlog.md is only a seed: Epoptes imports it onto the board the first time it reads the goal, and from then on every task, feedback item and comment is a card on the board (`epoptes board`).
   - Leave `FEEDBACK.md` exactly as the template has it. Every bullet in it becomes a backlog card for the orchestrator when the run starts, so never seed ideas, examples or review questions there.
3. Apply [reference/guardrails.md](reference/guardrails.md): the permissions for this goal kind, no git push or history rewrites, and secrets kept out of every file.
4. For a new directory without git: set `checkpoints` to `shadow`, not `git`, unless the user wants a repo.

### 6. Check
Run `epoptes run --dry-run <project>`. Fix every problem **and** every warning it prints, then run it again until it prints `ok`. It never starts the clock.

### 7. Register
Run `epoptes add <project>`. Then tell the user:
- the goal id
- how to start it (`epoptes start <id>`, or Start in the dashboard, `epoptes ui` → http://127.0.0.1:4747)
- how to give feedback while it runs

Offer to start it; don't start it without a yes. Then see [Starting a run](#starting-a-run).

## A new job in an existing harness
One project keeps one harness; each new piece of work (a feature, a fix sweep, a new chapter) is a **job** in it. What carries over: roles, models, permissions, `state/lessons.md`, `state/decisions.md`, and the harness's history. What's per job: the objective, done checks, time box, output, milestones and cards. The board is shared: each job is an epic on it.
1. **Look first.** `epoptes status` and `epoptes job` (the jobs so far). Read `goal.json`, the end of the last handoff, `state/lessons.md`, and `epoptes board --open`. If a run is live, stop here: ask whether to let it finish, pause it, or stop it.
2. **Short interview, only about what changes:** the new outcome and done checks, non-goals, time box, output, the first milestones, and whether the team, approval list or feedback setup should change. Ask what to do with the last job's open cards: untriaged backlog cards move to the new epic by themselves (cut any that belonged to the old job); open TODO/DOING cards stay in the old epic unless moved (`epoptes card <id> set --epic <new job id>`). Run `epoptes brain` and apply lessons that fit, as in step 2 of building.
3. **Sign-off** with the usual summary plus two lines: `JOB <title> (job <n> in this harness)` and `KEEPS <roles, lessons, …> · CHANGES <what you'll change>`.
4. **Start the job:** `epoptes job new "<title>"`. It archives the finished job's handoff, progress and scores into `state/archive/<old job>/`, writes fresh ones, opens a new epic on the board, resets the clock and records the job. Then:
   - update `goal.json`: `objective`, `done`, `non_goals`, `timebox`, `output`, and anything the interview changed. Keep `id`.
   - update the job-specific parts of `loop.md`: the objective, quality bar, done checks, non-goals, approval list, review timing and wrap-up items. If loop.md predates the current template (no `epoptes board`, `epoptes approval`, `epoptes lesson` or the scope rule), refresh it from [templates/loop.md](templates/loop.md) while you're at it, keeping its goal-specific text.
   - seed `state/backlog.md` with the new milestones (`## M1 · … (target h:mm)`) and tasks; it's imported into the new epic. Milestone ids restart at M1.
   - move or cut the old job's open cards as agreed.
5. **Check and hand over:** `epoptes run --dry-run` until it prints `ok`, then offer to start (`epoptes start`); no `--new-run` is needed. See [Starting a run](#starting-a-run).

## Starting a run
`epoptes start` launches a detached runner and returns at once; the run goes on without you, even if this chat ends. After starting:
1. Run `epoptes status <id>` once to confirm it is running.
2. Tell the user the dashboard (`epoptes ui` → http://127.0.0.1:4747) and how to give feedback, then **end your turn**.

Don't sleep, poll or tail the run to watch it, and don't triage, move, close or answer cards yourself: the orchestrator handles the board, and approvals are the human's. Check in only when the user asks.

For a small change to a finished job (a colour, a size, wording), don't start a job: add feedback (or comment on the card) and use `epoptes start --follow-up`.

## Distilling the brain
When the user asks you to "distill the brain" (or INDEX.md has grown past ~30 lessons), rewrite `~/.epoptes/brain/NOTES.md`: at most 60 lines of principles for designing harnesses, grouped by topic, merging duplicates and dropping ones later goals contradicted, each with the goals it came from. Keep it generic (no project secrets or client names). Never edit INDEX.md; it is rebuilt from the goals.

## Rules every generated harness follows
- **Fresh context every cycle.** All memory is in `state/` and on the board, and each state file has a cap in `goal.json` `state_caps`.
- **Everything goes through the board.** Feedback lands in the backlog column; the orchestrator triages it into TODO, moves cards through DOING and REVIEW (verification) to DONE, cuts or blocks them with a reason, and answers the human's comments on cards.
- **Targeted reads.** The orchestrator reads headers and slices (`grep -n`, `sed -n`), never whole large files or transcripts.
- **Use provider-appropriate models.** Claude Code checkers can use Haiku/low; judgement uses Sonnet or Opus. Codex and pi use the selected model and effort for the whole cycle.
- **Reuse workers when available.** Use the host's follow-up tool; Codex without configured subagents, and pi, do the work sequentially.
- **Caps per cycle:** at most 3 rounds, a soft time limit (usually 45–60 min), and optionally `cycle.max_budget_usd` (Claude Code and pi; not Codex).
- **Parallel tasks own separate files.** Two workers never write the same file in one round.
- **Guardrails:**
  - Claude Code: a permissions allow/deny list; Codex: a workspace-write sandbox and native rules; pi: the settings.json deny list, enforced by the Epoptes guard (a tripwire, not a sandbox)
  - no `git push`, no history rewrites, no destructive cleans
  - secrets never in goal files (point to the user's secret manager, e.g. the 1Password CLI or MCP)
- **Anything in the goal's approval list is never done autonomously.** The orchestrator runs `epoptes approval "…" --ref <card>`, which blocks that card, and moves on. The human answers with Approve / Disapprove in the dashboard (or `epoptes card <id> approve|reject`). When nothing else can move, the orchestrator runs `epoptes wait-for-human "…"` and the run waits, clock stopped, until the human answers.
- **Semantic events go through the CLI:** `epoptes event milestone|blocked|done …` (plus PushNotification when it's available).
- **Every harness feeds the brain:** in wrap-up the orchestrator records 1–3 harness lessons with `epoptes lesson "<rule>" --topic <topic>`.

## CLI reference
Inside a cycle, the runner sets `EPOPTES_GOAL_DIR`, `EPOPTES_RUN`, `EPOPTES_CYCLE` and `EPOPTES_MODE`, so the goal argument can be left out. `[goal]` is a registered id or a path.

| command | what it does |
|---|---|
| `epoptes add [dir]` | validate `<dir>/.epoptes/goal.json` and register the goal |
| `epoptes list` | all goals with state, cycle, mode and active time |
| `epoptes status [goal]` | one screen: state, clock, cycle, board, approvals, usage, last cycle, handoff |
| `epoptes clock` | one line for orchestrators: `CYCLE= RUN= MODE= ACTIVE= TO_WRAPUP= TO_END= TO_HARD_STOP= CYCLE_ELAPSED=` |
| `epoptes run [goal] --dry-run` | check the setup and guardrails, print the next cycle's command; never starts the clock |
| `epoptes start [goal]` | resume, or start a detached run; `--new-run` after DONE or when the time box is over |
| `epoptes start [goal] --follow-up` | after DONE: handle just the human's open cards and unanswered comments, with no time box. Minor items are fixed in place; ones that need a restart or new version are flagged for a new run |
| `epoptes card <id> set --scope auto\|tweak\|new_run` | the human's override for a follow-up (default: the agent triages) |
| `epoptes pause [goal]` | pause after the current cycle (the clock pauses too) |
| `epoptes stop [goal]` | stop now; the next cycle recovers interrupted work |
| `epoptes extend [goal] <dur>` | lengthen the time box, e.g. `2h`, `30m` |
| `epoptes reset-clock [goal]` | clear the clock; the next start is a new run |
| `epoptes job [goal]` | the harness's jobs, the current one last |
| `epoptes job new "<title>" [--id slug]` | start the next job in this harness (a new epic on the board): archive the finished job's working state, keep roles/lessons/decisions, reset the clock |
| `epoptes board [goal] [--open] [--all]` | the board: the current epic's cards by column (`--open`: hide done; `--all`: every epic) |
| `epoptes feedback [goal] "<text>"` | add a card to the backlog column |
| `epoptes feedback [goal] "<text>" --steer` | steering: interrupt the running cycle now; a fresh cycle replans the whole board around it first |
| `epoptes feedback "<text>"` inside a cycle | an **agent note** in the backlog: something the next cycle must act on (e.g. a research finding that changes the plan); the human sees it and can edit or cut it |
| `epoptes card add "<title>" [--column c] [--milestone M1] [--assign role] [--priority high\|med\|low]` | add a card (inside a cycle it goes to TODO by default) |
| `epoptes card <id>` | one card with its comment thread |
| `epoptes card <id> backlog\|todo\|doing\|review\|done ["note"]` | move a card (takes `--milestone`, `--assign`, `--priority` too); the note becomes a comment |
| `epoptes card <id> cut\|block "<why>"`, `unblock` | drop it (into done) / block it, with a reason |
| `epoptes card <id> comment "<text>" [--steer] [--as role]` | comment; the human's comment on a done card reopens it, and the next cycle acts on it or replies |
| `epoptes card <id> set [--title t] [--milestone M] [--assign r] [--priority p\|none] [--epic e]` | change a card |
| `epoptes card <id> approve\|reject ["note"]` | the human's answer to an approval request; resumes a run that was waiting for it |
| `epoptes milestone [goal]` / `epoptes milestone add M<n> "<title>" [--target h:mm]` | the current epic's milestones / add or rename one |
| `epoptes approval "<what>" [--ref <card>]` | (orchestrator) ask the human before doing something on the approval list; blocks the card until answered |
| `epoptes wait-for-human "<what>"` | (orchestrator) end the run after this cycle as "waiting for you"; the clock stops |
| `epoptes event milestone\|blocked\|note\|artifact\|round\|wrapup\|done "<text>"` | record a semantic event; `wrapup` and `done` also set the run markers |
| `epoptes event output <path\|url> ["text"]` | where the main deliverable is; the dashboard shows "Open the output" (overrides goal.json `output`) |
| `epoptes lesson "<rule>" [--topic t]` | (orchestrator, in wrap-up) a lesson about the harness itself for the brain; topics: roles, briefs, cycles, checks, tools, state, cost, steering, other |
| `epoptes brain` / `epoptes brain lessons [--kind k]` | gather every goal into `~/.epoptes/brain/INDEX.md` / print the harness lessons |
| `epoptes report [goal] [--all] [--stdout] [--job <id>\|all]` | Markdown + HTML report from recorded data into `.epoptes/reports/` (`--all`: every goal; `--stdout`: print the Markdown) |
| `epoptes import-runsh <project>` | import an older run.sh harness (dress2impress style) so it shows in reports and the dashboard |
| `epoptes ui` | the local dashboard on http://127.0.0.1:4747 |

When the user gives feedback on a **finished** goal, add it (or comment on the card it's about), then offer `epoptes start <goal> --follow-up` (no time box; only their cards and comments) rather than `--new-run`, unless they want a restart or a new version. When the user asks for a report, run `epoptes report <goal>` and give them the paths (or `--stdout` to summarise it). When the user asks how a goal is doing, run `epoptes status <goal>` and summarise it in a few lines: state, time left, progress and anything blocked. When they give feedback in chat, add it with `epoptes feedback <goal> "<their words>"` (or `epoptes card <id> comment` when it's about one card) rather than editing files.
