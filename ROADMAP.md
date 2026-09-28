# Roadmap

Short and current. New notes land in `NOTES.md` and get triaged here at the start of each session.

## Now
- **Try the skill interactively** (`epoptes skill install`, then in Claude Code: "use the epoptes skill to build a harness for …") and note what the interview gets wrong in NOTES.md.
- **M5 Polish:** animation, empty and error states, README, install docs.

## Later / ideas
- The FAQ run did 5 task rows in one cycle against the 3-round cap (harmless on a 20 min goal); watch whether longer goals respect it.
- Dashboard: a theme toggle; "add goal" from the UI; open a cycle's raw stream.
- Nicer ticker summaries for `SubagentHandback` / `ScheduleWakeup` tool calls (seen in the M1 run).
- Rate-limit wait is only tested at parser level; watch the first real one.
- The runner runs `done[].verify` command checks itself after each cycle (progress for zero tokens).
- Retention setting for `cycles/*/stream.jsonl`.

## Done
- **M4 Reports** (2026-09-28): `epoptes report` (Markdown + script-free HTML, per goal and `--all`), dashboard Report links, `epoptes import-runsh`. Checked by importing a clone of dress2impress: every total matches its raw logs.
- **M3 Skill** (2026-09-28): plugin `plugin/` with the `epoptes` skill (process, interview checklist, design rules, guardrails, templates), `epoptes skill install`, `epoptes clock`, `feedback --open`, and a guardrail lint in `--dry-run`. Checked end to end: Claude built a FAQ harness from written interview answers (≈ $0.53, dry run clean), and it ran to DONE in 1 cycle / 7 min / ≈ $0.84 with editor scores 9/9.
- **M2 Dashboard** (2026-09-28): `epoptes ui`: goal list with badges, goal detail (clock, controls, live ticker, cycle timeline + cost table with outlier flags, feedback with statuses, backlog, handoff, snapshots/commits, activity feed), toasts, desktop notifications, confetti, dark mode, phone layout. 16 tests. Checked in a real browser: start/resume, feedback, status change, live milestone toast, pause.
- **M1 Runner + CLI** (2026-09-28): detached runner, clock, controls, stream-json → `activity.jsonl` / `result.json`, feedback inbox, shadow snapshots, 12 tests with a fake `claude`. Checked with `examples/glossary` against real `claude`: DONE in 3 cycles / 4 min / ≈ $0.68 (estimate); stop-now interrupts a real cycle in < 1 s.
- **M0 Spec** (2026-09-28): `docs/spec.md`, `docs/schemas/`, `docs/decisions.md`.
