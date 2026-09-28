# Build Epoptes: a manager for long-running Claude Code harnesses

*Epoptes (Greek ἐπόπτης, "the overseer") was a title for Zeus and Helios, who watch over everything.*

## Context
I built an autonomous, time-boxed harness in `/mnt/d/web/dress2impress` that ran a 12 h game build overnight in fresh-context cycles. Study it before designing anything; it is the reference implementation:
- `harness/run.sh`: watchdog loop, runs `claude -p "$(cat loop.md)"` cycle after cycle, with timeouts, rate-limit backoff, a failure cooldown and a per-cycle budget
- `harness/clock.mjs`: active-time clock with modes (build / wrapup / overtime / stop) and pause
- `loop.md`: the orchestrator's per-cycle instructions (orient, triage, dispatch, verify, commit, record, exit)
- `.claude/agents/*.md`: role subagents with their own model and effort
- `harness/state/`: handoff, backlog, progress, lessons, decisions, scores. All memory lives in files.
- `FEEDBACK.md`: human inbox. Items are promoted to `F-<n>` and marked `→ F-<n>`.
- `harness/logs/cycle-*.json`: per-cycle result JSON (turns, cost, errors)

Epoptes turns this into an open-source product, so anyone can create, run, watch and steer harnesses like this for **any long-running goal** (code, research, content, data work), not only software.

## The product
1. **`SKILL.md` (the epoptes skill)** teaches Claude Code to interview me about a goal, design a harness for it, generate the files and register the goal with Epoptes.
2. **Runner + CLI (`epoptes`)** is a background service that starts, pauses, stops and supervises harness runs, plus a thin CLI used by Claude Code and by me.
3. **Web dashboard (localhost)** is a live view of all goals, with controls, feedback, notifications and reports.

## User flow
1. In Claude Code: "use the epoptes skill to build a harness for <goal>".
2. Claude interviews me until we agree on: the outcome, a done definition with checks it can verify, constraints, the time box, roles and models, checkpoints, and what needs my approval.
3. Claude generates the harness from the skill's templates, runs a dry run, and calls `epoptes add`.
4. The goal appears in the dashboard. From there (or the CLI) I start it, pause it, stop it, give feedback and watch it in real time.
5. When it finishes I generate a report.

## Architecture
- **Goal = a directory.** Everything lives in `<project>/.epoptes/`:
  - `goal.json`: name, objective, done criteria, time box, adapter, models, budgets
  - `loop.md` and agent definitions
  - `state/`: handoff, backlog, progress, lessons, decisions
  - `feedback.jsonl`, `events.jsonl`, `cycles/`

  A registry at `~/.epoptes/registry.json` lists goal paths. The file format is the contract: the UI, CLI and skill only read and write these files.
- **Runs are detached processes**, one per goal: a TypeScript port of `run.sh` and `clock.mjs`. Restarting or closing the dashboard never kills a run. The service finds live runs again from their pid and lock files on startup.
- **Unlimited parallel goals.** Every run is independent. The user is responsible for their account and usage limits. Epoptes assists: it shows a shared "rate-limited" state and backs off each run on its own.
- **Runner adapter interface.** v1 ships one adapter, the Claude Code CLI (`claude -p`, `--output-format stream-json`). The interface covers start cycle, stream events, interrupt, and parse the result (tokens, cost, turns, error). Other providers and models come later; design for them now but build only this adapter.
- **Observability costs no model tokens.** Live activity comes from parsing the stream-json output (tool calls, subagent dispatches, files touched), not from asking the model to report. The orchestrator writes a few semantic events through the CLI: `epoptes event milestone|blocked|note "..."`.
- **Controls:**
  - start / resume
  - pause after this cycle (the safe default)
  - stop now (SIGINT; the next cycle recovers interrupted work, like `loop.md` §1.2)
  - extend or reset the time box

  Pausing also pauses the clock.
- **Feedback lifecycle:** `new → seen → in progress → done | blocked | won't do`, with the cycle number and a note for each change. Feedback can be given from the dashboard, the CLI (`epoptes feedback "<text>"`) or the goal's feedback file. The orchestrator updates status through the CLI, and the dashboard shows every change live.
- **Stack:** Node + TypeScript, installable with `npx`/npm. One language for the runner, CLI and dashboard. Linux, macOS and WSL2 first.

## Main features (acceptance-level)
1. **Low token use on long runs.** The skill builds in the dress2impress rules:
   - a fresh context every cycle
   - small, capped state files
   - targeted reads
   - a cheap model for mechanical roles
   - reusing workers through SendMessage
   - a round and time cap per cycle
   - an optional per-cycle budget

   The dashboard shows per cycle: tokens by model, cache-read share and cost, and flags cycles that cost far more than the median.
2. **Observability.**
   - Per goal: mode, clock, current cycle and round, and a live activity ticker (which agent is doing what).
   - Cycle timeline, backlog progress, latest handoff, recent commits or artifacts, errors and rate-limit waits.
3. **Easy feedback** with the status changes above. Unread status changes show as badges.
4. **Liveliness.** Animated cycle timeline, a heartbeat pulse while a cycle is working, smooth status transitions, and a small celebration on milestones and DONE. Respect `prefers-reduced-motion`.
5. **Reports** per goal (and across goals), in HTML and Markdown, built only from recorded data:
   - wall time and active time
   - cycles
   - tokens and cost by model
   - what was done (milestones, tasks, commits or artifacts)
   - feedback handled
   - blocked and cut items
   - scores

   On a subscription, label cost as "API-equivalent estimate, not billed".
6. **Notifications:** in-dashboard toasts and activity feed, desktop notifications (browser Notification API), and Claude Code's PushNotification from inside cycles for milestone, blocked and DONE.

## SKILL.md requirements
- **Interview checklist:**
  - the outcome
  - a done definition with checks that can be verified
  - non-goals
  - time box and wrap-up
  - roles, models and effort
  - checkpoints (git commits for repos, snapshots for everything else)
  - what always needs human approval
  - the feedback cadence
- Keep asking until we agree, then show a one-screen summary for sign-off.
- **Templates:** `loop.md` phases (orient → triage → dispatch → verify → record → exit), the brief format, role files, state files with size caps, and a wrap-up checklist. Adapt them per goal type; don't reuse the dress2impress roles as-is.
- **Guardrails in every generated harness:**
  - a permissions allow/deny list
  - no `git push`, no history rewrites, no destructive cleans
  - secrets never in goal files (point to a secret manager)
- **CLI reference:** Claude should know `add`, `status`, `start`, `pause`, `stop`, `feedback`, `event` and `report`, so I can also check on and steer goals from a Claude Code chat.
- Finish with `epoptes run --dry-run` and `epoptes add`.

## Terms and safety constraints
- Epoptes never handles login or tokens. It runs the user's own installed and logged-in `claude` CLI. No OAuth, no key storage in v1.
- Never work around usage limits (no account rotation). Back off on rate limits.
- The dashboard binds to `127.0.0.1` by default. LAN access is an explicit opt-in flag with a warning. No telemetry.
- Transcripts and logs can contain confidential code, so they stay local.

## How we'll develop it
This is a long-lived personal tool that I'll improve over months from my own daily use, not a product to polish in one push. Build it in interactive sessions with me, not with an autonomous harness.
- Every milestone must leave something I can use every day. Get to a working tool fast rather than a complete one.
- Choose simple pieces that are easy to replace over clever abstractions. Expect the file formats and UI to change as I use it.
- Keep a `NOTES.md` inbox for my usage notes and a short `ROADMAP.md`. At the start of each session, triage new notes into the roadmap.
- Record design decisions briefly in `docs/decisions.md`, so later sessions don't re-argue them.

## Build plan (milestones, each ending in something usable)
- **M0 Spec:** goal directory format, event and feedback schemas, adapter interface. Short `docs/` with JSON schemas.
- **M1 Runner + CLI:** the TypeScript port of `run.sh` and `clock.mjs`, detached runs, controls, and stream-json event capture. Check it by running a tiny 15-minute test goal.
- **M2 Dashboard:** goal list, goal detail (live ticker, timeline, backlog, handoff, costs), controls, feedback with statuses, notifications.
- **M3 Skill:** `SKILL.md` + templates. Check it by building a harness for a small non-code goal end to end.
- **M4 Reports:** HTML and Markdown. Check them against the dress2impress run by importing its existing logs and state.
- **M5 Polish:** animation, empty and error states, README, install docs.

## Out of scope for v1
Other model providers (interface only), hosted or multi-user mode, dashboard auth beyond localhost, native desktop app, TUI.

## Before writing code
Read the reference harness, then ask me anything still unclear. Propose the M0 spec (file layout + schemas) for my approval first.
