# Designing the harness

These rules come from a 12 h autonomous build (dress2impress) and the first Epoptes test runs. They keep long runs cheap and on track.

## Adapter
Confirm whether the harness runs Claude Code, Codex or pi. The table below is for Claude Code. Codex uses its selected CLI model and effort; role files are instructions only, not registered subagents. Adapt loop.md so the cycle performs tasks, checks and reviews sequentially and reads role bodies as needed. Remove Claude-specific tool names and frontmatter claims. Only use native Codex subagents if the user has configured them separately. pi works the same way as Codex here: one model and thinking level for the whole cycle, no subagents, so loop.md does the work sequentially. With pi, pick a model that is reliable at long tool-calling sessions; weak models drift on long loops, so prefer smaller cycles (fewer tasks per round) and a strict checker step.

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
- `cycle.max_budget_usd`: Claude Code only; offer it for API-key users, and for anyone worried about runaway cycles.

## Tasks and the board
- **Every task is a card on the board**: backlog (untriaged feedback and agent notes) → TODO → DOING → REVIEW (being verified) → DONE. Each job is an epic; each card carries a milestone, and optionally an assignee (role) and a priority. The human comments on cards; the orchestrator acts on a comment or replies.
- **Split the work into milestones,** each ending in something checkable. Give each a target time so the orchestrator can cut scope when it's behind. A milestone is current until its cards are done, cut or blocked.
- **Seed the board with `state/backlog.md`:** `## M1 · <title> (target h:mm)` headings, then `- [ ] M1-1 <what>` lines (`[~]`, `[x]`, `[blocked: why]`, `[cut]` work too). Epoptes imports it into the current epic and renames it; keep the task label (`M1-1`) at the start of the title so humans can refer to it.
- **Parallel tasks must own separate files or folders.** Two writers appending to one file duplicated its content in a test run. If two tasks touch one file, run them in sequence.
- **Milestone events** should trigger on "≥ n done", never on "the round that reaches n": rounds can skip numbers.

## State files (all under `.epoptes/state/`; the board lives in `.epoptes/board.jsonl`, changed only through `epoptes card`)
| file | written | cap |
|---|---|---|
| `handoff.md` | overwritten every cycle: state, half-done work, the next 3 tasks, gotchas | 25 lines |
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
