# Things to Look Out For

Common pitfalls, subtle behaviors, and practical tips learned from real multi-hour runs.

---

## 1. WSL2 Performance (`/mnt/c` and `/mnt/d`)
- On WSL2, running Node.js projects from Windows-mounted drives (`/mnt/c`, `/mnt/d`) is noticeably slower for `node_modules` loading and git operations. Keep Epoptes checkouts and active workspaces on the Linux filesystem (`~/…`) whenever possible.
- File-system watchers (`inotify`) do not fire reliably on `/mnt/*`, which is why the dashboard polls every second.

## 2. Permissions & Headless Failures
Autonomous cycles cannot answer interactive permission prompts.
- **Claude Code:** Always keep `.epoptes/settings.json` clean and run `epoptes run --dry-run` before starting. Remember that Epoptes sets `permissions.defaultMode` automatically from `adapter.permission_mode`.
- **Antigravity (`agy`):** Uses its own `~/.gemini/antigravity-cli/settings.json` (ignores `.epoptes/settings.json`). In `accept-edits` mode, any unlisted shell command is auto-denied and fails the cycle. Make sure `command(epoptes)`, `command(git)`, and your build/test commands are in `permissions.allow`.
- **pi:** Has **no OS sandbox** — Epoptes attaches a guard extension that blocks `settings.json` deny patterns as a tripwire, not a security boundary. For untrusted work, run pi inside a container or VM.
- **Codex:** Uses its own sandbox (`workspace-write` by default); `.epoptes/settings.json` is not used.

## 3. Costs & Usage Limits
- **Estimates (`≈`):** On subscription plans (Claude Code, pi estimates), dollar figures are API-equivalent estimates, not bills.
- **Unknown costs:** Codex and Antigravity streams do not emit dollar costs, so `cycle.max_budget_usd` must be `null` and costs display as `–`.
- **Plan usage freshness:** Epoptes only observes Claude/Codex plan usage while its own cycles run. Usage from outside Epoptes won't show until the next cycle.
- **Hard budget caps:** For pay-per-token providers (especially pi / OpenRouter), always set `cycle.max_budget_usd` so a stuck loop cannot run up a surprise bill.

## 4. Paused Milestones While Later Milestones Keep Running
- If a card in an earlier milestone (e.g. `M1`) requires your approval or is blocked, the orchestrator intentionally continues working on unblocked cards in `M2` so your time box isn't wasted.
- Watch for the amber **⚑ Milestone paused · waiting on you** banner on Overview, Board, and the **Milestones** tab so an earlier milestone doesn't silently sit blocked while later work finishes.

## 5. Task-Level Pause vs. Stop Now
- **Pause after task (default):** Safe and quick — the orchestrator sees `PAUSE_REQUESTED=task` at its next `epoptes clock` / `epoptes card` call, finishes its in-flight task, checkpoints, and exits. If a single long command or subagent is mid-flight, it still waits for that task to finish.
- **Stop now (`epoptes stop`):** Interrupts immediately with `SIGINT`. Verified commits are never lost, and the next cycle recovers uncommitted work, but any in-progress subagent turn is discarded.

## 6. Hooks Safety & Timeouts
- Hooks (`onStart`, `onEnd`, `onPause`, `onStop`) execute via `sh -c` in your project directory with a **60-second timeout**.
- A failing or timed-out hook logs a `warn` event and never crashes the runner, but slow hooks delay cycle transitions. Keep hooks fast and non-interactive.
- Never hardcode secrets inside `goal.json` hooks — read them from environment variables or a secret manager CLI (like `op read`).

## 7. `FEEDBACK.md` & `state/backlog.md`
- Every bullet you add to `.epoptes/FEEDBACK.md` automatically becomes a backlog card (`→ C-<n>`). Don't write scratch notes or examples there unless you want the orchestrator to triage them.
- `state/backlog.md` is only a seed format. Once Epoptes reads it, it imports the cards into `board.jsonl` and renames it to `backlog.md.imported`. Always use the dashboard or `epoptes board` / `epoptes card` afterwards.

## 8. Network Safety (`--lan`)
- By default `epoptes ui` binds strictly to `127.0.0.1` with DNS-rebinding and CSRF guards.
- `--lan` binds `0.0.0.0` with **no authentication**. Only use `--lan` on a trusted private network, because anyone who can reach the dashboard can start/stop runs and inject cards into agent prompts.

## 9. Vague Comments on Cards
- If you leave a quick or ambiguous comment on a card, the orchestrator may reply with a clarifying question instead of guessing (which means your comment takes effect on the next cycle after you answer). Being concrete saves a cycle!
