# Interview checklist

Before asking anything, look at the project directory yourself: `ls`, the README, `package.json` or similar, `git status`, any existing `.epoptes/`. Ask only what you can't find out. Ask in batches of 2–4 questions. Where there are options, use the host's user-question tool with your recommended default first.

Every item below needs an answer the user agreed to. "Sensible default, confirmed" counts; silence doesn't.

## 1. Outcome
- What exists at the end that doesn't exist now? Name the artifact: an app, a report, a dataset, a set of documents.
- Who is it for, and what is the quality bar? Anchor it with a comparison ("reads like a McKinsey brief", "a 6-year-old can play it without help").
- Where does it live? The project directory, and which files or folders are the deliverable.

## 2. Done definition, with checks that can be verified
Turn "done" into 2–6 checks. Prefer checks a machine can run:
- `command`: a shell command that exits 0 (`npm run verify`, `python check.py`, `test -f report.pdf`).
- `file`: a file that must exist.
- `agent`: a reviewer scores against a rubric you write together (use when quality is subjective).
- `manual`: only the human can judge it (keep this to a minimum; the harness can't finish on its own).

Ask "how would you check this in 2 minutes?" for each fuzzy criterion. If a rubric is needed, write it now: 3–6 criteria, each with what a 5 and a 9 look like.

## 3. Non-goals
What should it explicitly **not** do or touch? Examples: other folders, production systems, paid services, redesigning X, languages or tools it must not use.

## 4. Time box and wrap-up
- Total active time: rate-limit waits and pauses don't count.
- Wrap-up length: the feature freeze at the end, usually 10–15 % of the total with at least 10 min.
- Grace: extra time to finish in-flight wrap-up work, usually 5–10 %.
- Early finish: should the run end as soon as every check passes? (Usually yes.)

## 5. Roles, models and effort
Confirm the runtime (Claude Code or Codex). Propose a team from design.md for this goal kind, then confirm or adjust:
- **orchestrator:** the model and effort for the per-cycle planner.
- **workers:** 1–3 doer roles named for the work (builder, researcher, writer, analyst…).
- **checker:** a mechanical role that runs checks and reports facts (Haiku/low for Claude Code; the cycle model for Codex).
- **reviewer (optional):** a read-only role that scores against the rubric.
- Claude Code only: any per-cycle budget cap (`--max-budget-usd`)? Codex reports tokens but no dollar costs or dollar caps. Mention that on a subscription, costs are API-equivalent estimates, not bills.

## 6. Checkpoints
- **Code in a git repo:** the orchestrator commits each verified task (`git`). Never push.
- **Anything else:** the runner snapshots the workspace after each cycle into a private shadow repo (`shadow`).
- **`none`:** only if the user insists.

## 7. What always needs human approval
The actions the harness must never take on its own. Suggest the common ones and ask for more:
- spending money or adding paid services
- sending anything outside the machine (email, posts, API writes, publishing)
- deleting or overwriting user data outside the deliverable
- changing the done definition or the time box
- adding dependencies with licences the user hasn't approved

## 8. Feedback cadence
- Will the user check in? How often, and how: the dashboard, `epoptes feedback`, `.epoptes/FEEDBACK.md`, or a chat with Claude Code or Codex.
- What should reach them right away (milestone, blocked, done)? This sets `notify` and when the orchestrator sends PushNotification.
- Is there a checkpoint where the run should **pause for review** (e.g. after the first milestone)? If so, the orchestrator runs `epoptes pause` at that point.

## Sign-off summary (show exactly this shape; keep it to one screen)

```
GOAL      <id> · <name> · <kind>
OUTCOME   <one sentence> → <deliverable paths>
BAR       <quality bar in one line>
DONE WHEN D1 <check> [command|file|agent|manual]
          D2 …
NOT       <non-goals, comma-separated>
TIME      <total> active · wrap-up <x> · grace <y> · early finish <yes/no>
TEAM      orchestrator <model>/<effort> · <role> <model>/<effort> · … · checker <model>/<effort>
CYCLE     ≤ <n> rounds, ~<m> min soft cap, timeout <t> min, budget <$ or none>
SAVES     <git commits | shadow snapshots | none>
ASK FIRST <approval list>
FEEDBACK  <cadence and channel> · notify on <milestone, blocked, done> · <pause-for-review points>
FIRST     M1 <milestone> → M2 <milestone> → …
```

Then ask: "Shall I generate the harness with this?" Generate only after a clear yes.
