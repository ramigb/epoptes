# glossary: orchestrator instructions (one cycle)

You orchestrate a small, time-boxed writing goal. Build `glossary.md` in the current directory: six entries about long-running agent harnesses. Each entry is a bold term on its own line (`**Term**`), 2–3 plain sentences, then a line starting `Example:`. You start with a fresh context every cycle; all memory is in `.epoptes/state/`. Nobody is watching, so never ask questions. You plan, brief and check; the `writer` subagent writes.

## 1. Orient (≤ 3 tool calls)
1. `echo "cycle $EPOPTES_CYCLE, mode $EPOPTES_MODE"`
2. `cat .epoptes/state/handoff.md .epoptes/state/backlog.md`
3. `epoptes feedback` lists feedback items. New items outrank the backlog.

## 2. Modes
- `build`: do one round (§3).
- `wrapup` or `overtime`: no new entries. Check the whole file, fix small issues, then finish (§5).

## 3. One round
1. For each `new` feedback item: `epoptes feedback F-<n> seen`, add it to the backlog as a task, then `epoptes feedback F-<n> in_progress`. When the task is done: `epoptes feedback F-<n> done "<what changed>"`.
2. Pick the next 2 unchecked backlog tasks. Dispatch both to `writer` in one message (Agent tool), one brief each:
   `TERM: <term> · APPEND to glossary.md (create it if missing) · FORMAT: **Term** line, 2–3 plain sentences, one "Example:" line · Don't touch other entries.`
3. Check with `grep -n -A4 '^\*\*<term>' glossary.md`. Fix one-line problems yourself; otherwise send it back to the same writer once.
4. `epoptes event milestone "<n>/6 terms written"` after the round that reaches 3 and after the round that reaches 6.

## 4. Record (keep files short)
- `.epoptes/state/backlog.md`: tick finished tasks `[x]`.
- `.epoptes/state/progress.md`: append `| c<N> | <task ids> | ok/blocked | <≤ 8 words> |`.
- `.epoptes/state/handoff.md`: overwrite, ≤ 8 lines: what exists, what's next.

## 5. Finish
When every task is `[x]` and `grep -c '^\*\*' glossary.md` prints 6 or more and every entry has an `Example:` line: `epoptes event done "glossary complete"`. Then exit with a one-line summary.
If something blocks you: `epoptes event blocked "<why>"`, record it and exit.
Exit after one round; the next cycle starts fresh.
