# Designing the harness

These rules come from a 12 h autonomous build (dress2impress) and the first Epoptes test runs. They keep long runs cheap and on track.

## Team by goal kind
Name roles after the work. Each role file sets `model`, `effort`, `maxTurns` and `tools`, and caps its report length.

| kind | workers | checker | reviewer |
|---|---|---|---|
| code | `builder` (sonnet or opus / medium), maybe a `designer` for UI or visuals (opus / high) | `qa` (haiku / low): runs tests, lint and build | `critic` (opus / high), read-only, when looks or UX matter |
| research | `researcher` (sonnet / medium) with WebSearch and WebFetch | `factcheck` (haiku / low): links resolve, quotes appear in their sources, citations are formatted | `editor` (opus / high): argument, gaps, bias |
| content | `writer` (sonnet / medium or opus / high for voice) | `lint` (haiku / low): word counts, required sections, links, spelling | `editor` (opus / high) against the rubric |
| data | `analyst` (sonnet / medium) | `validate` (haiku / low): runs the scripts, compares schemas and row counts | `reviewer` (opus / high): methods and conclusions |

- **Orchestrator:** sonnet / medium for small or mechanical goals; opus / high when judgement across many moving parts matters.
- **Keep the team small.** 1–2 workers + a checker is plenty for most goals. Every extra role is context the orchestrator has to manage.
- **Reviewer:** add one only when quality is subjective, and call it at milestones and every few cycles, not every round.

## Cycle size
- **A round** is 1–3 tasks of about 20–60 min of agent work in total. **A cycle** is at most 3 rounds, with a soft cap of about 45–60 min (`CYCLE_ELAPSED` from `epoptes clock`).
- `cycle.timeout_min` is the hard kill: 1.5–2 × the soft cap, at least 20. The runner caps it at the hard stop.
- Short goals (≤ 1 h) do better with 1 round per cycle and a 20–30 min soft cap.
- `cycle.max_budget_usd`: offer it for API-key users, and for anyone worried about runaway cycles.

## Tasks and the backlog
- **Split the work into milestones,** each ending in something checkable. Give each a target time so the orchestrator can cut scope when it's behind.
- **Task IDs are stable** (`M1-3`, `F-2`, `R-4`). Tasks look like `- [ ] M1-3 <what>`, with the markers `[ ]`, `[~]`, `[x]`, `[blocked: why]` and `[cut]`. The dashboard counts these, so keep the format exact.
- **Parallel tasks must own separate files or folders.** Two writers appending to one file duplicated its content in a test run. If two tasks touch one file, run them in sequence.
- **Milestone events** should trigger on "≥ n done", never on "the round that reaches n": rounds can skip numbers.

## State files (all under `.epoptes/state/`)
| file | written | cap |
|---|---|---|
| `handoff.md` | overwritten every cycle: state, half-done work, the next 3 tasks, gotchas | 25 lines |
| `backlog.md` | tick, add or cut tasks; move the current-milestone line | the header and current milestone stay short; old milestones collapse to one line |
| `progress.md` | one table row per round | 1 line per round |
| `lessons.md` | a rule only when a mistake cost more than one fix round and could recur | 30 lines |
| `decisions.md` | append-only `date · decision · why` | — |
| `scores.jsonl` | optional; one line per reviewer run | — |

Set `state_caps` in `goal.json` to match; the runner warns when a file goes over.

## Verification
- **Deterministic checks beat opinions.** If the orchestrator catches itself re-judging something by reasoning, it should ask a worker to add a script or test for it.
- **The checker only runs commands and reports JSON facts;** it never edits files.
- **Check that results are fresh.** Haiku once copied numbers from an old results file. Have the check write a timestamp, and have the orchestrator compare it.
- **At most 2 fix rounds per task.** After that, revert just that task's files, mark it `[blocked: reason]` and move on.

## Cost habits (write these into loop.md)
- Orient in 6 tool calls or fewer, with targeted reads (`grep -n`, `sed -n`, `head`).
- Never paste file contents into briefs; point at paths.
- Reuse a worker with SendMessage for its fixes.
- Only give reviewers ≤ 8 images per review: each image costs about 1.5k tokens.
- Exit when the round or time cap is hit; a fresh cycle is cheaper than a bloated one.

## Early finish
In build mode, when every task except `low` fixes is `[x]`, `[cut]` or `[blocked…]` and every done check passes: `epoptes event wrapup "<why>"` (this sets the WRAPUP marker), then run the wrap-up checklist and finish with `epoptes event done "<summary>"`.
