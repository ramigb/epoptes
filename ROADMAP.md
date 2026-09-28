# Roadmap

Short and current. New notes land in `NOTES.md` and get triaged here at the start of each session.

## Now
- **M1 Runner + CLI:** TypeScript port of `run.sh` + `clock.mjs`, detached runs, controls, stream-json capture into `activity.jsonl` / `result.json`. Check: a tiny 15-minute test goal runs end to end.
  - First, confirm the real stream-json shape (subagent messages, `parent_tool_use_id`, result event) and what `--agents` accepts.

## Next
- **M2 Dashboard:** goal list, goal detail (ticker, timeline, backlog, handoff, costs), controls, feedback with statuses, notifications.
- **M3 Skill:** `SKILL.md` + templates. Check: a small non-code goal built end to end.
- **M4 Reports:** HTML + Markdown. Check: import dress2impress logs and state.
- **M5 Polish:** animation, empty and error states, README, install docs.

## Later / ideas
- The runner runs `done[].verify` command checks itself after each cycle (progress for zero tokens).
- Retention setting for `cycles/*/stream.jsonl`.

## Done
- **M0 Spec** (2026-09-28): `docs/spec.md`, `docs/schemas/`, `docs/decisions.md`.
