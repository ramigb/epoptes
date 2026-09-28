# Roadmap

Short and current. New notes land in `NOTES.md` and get triaged here at the start of each session.

## Now
- **M2 Dashboard:** goal list, goal detail (ticker, timeline, backlog, handoff, costs), controls, feedback with statuses, notifications.
- **M3 Skill:** `SKILL.md` + templates. Check: a small non-code goal built end to end.
  - Template lessons from the M1 glossary run: parallel workers must own separate files (two writers appending to one file duplicated lines); milestone triggers should be "≥ n", not "the round that reaches n" (rounds skip numbers).
- **M4 Reports:** HTML + Markdown. Check: import dress2impress logs and state.
- **M5 Polish:** animation, empty and error states, README, install docs.

## Later / ideas
- Nicer ticker summaries for `SubagentHandback` / `ScheduleWakeup` tool calls (seen in the M1 run).
- Rate-limit wait is only tested at parser level; watch the first real one.
- The runner runs `done[].verify` command checks itself after each cycle (progress for zero tokens).
- Retention setting for `cycles/*/stream.jsonl`.

## Done
- **M1 Runner + CLI** (2026-09-28): detached runner, clock, controls, stream-json → `activity.jsonl` / `result.json`, feedback inbox, shadow snapshots, 12 tests with a fake `claude`. Checked with `examples/glossary` against real `claude`: DONE in 3 cycles / 4 min / ≈ $0.68 (estimate); stop-now interrupts a real cycle in < 1 s.
- **M0 Spec** (2026-09-28): `docs/spec.md`, `docs/schemas/`, `docs/decisions.md`.
