# Epoptes Glossary

Plain-English definitions of the terms used across Epoptes, its dashboard, and its CLI.

---

### Core Concepts

- **Goal:** A project directory containing a `.epoptes/` folder with an objective, done checks, time box, and board. Registered in `~/.epoptes/registry.json`.
- **Harness:** The setup inside `.epoptes/` that drives a goal: `goal.json` (settings), `loop.md` (orchestrator instructions), `agents/*.md` (specialist roles), and `settings.json` (permissions).
- **Job (Epic):** One distinct piece of work inside a harness (for example, "Initial build" or "Add dark mode"). One project keeps one harness; each new feature is a new **job**, which opens a fresh **epic** on the board while keeping your roles, lessons, and decisions.
- **Run (`r1`, `r2`, …):** A continuous effort toward a job with a single active-time clock. Pausing and resuming continues the same run; starting fresh after `DONE` or `reset-clock` begins a new run.
- **Cycle (`c1`, `c2`, …):** A single fresh-context invocation of your agent CLI (`claude`, `codex`, `pi`, or `agy`). Each cycle orients from `state/` and the board, runs 1–3 rounds of work, verifies, checkpoints, updates handoff, and exits.
- **Round:** One batch of 1–3 tasks dispatched and verified inside a single cycle.
- **Adapter:** The bridge between Epoptes and a specific agent CLI (`claude-code`, `codex`, `pi`, or `antigravity`).

---

### The Board & Milestones

- **Board (`board.jsonl`):** The kanban board where all planned tasks, your feedback, and agent notes live. Columns:
  - **Backlog:** Untriaged items (your new feedback and agent notes).
  - **Todo:** Triaged, ranked work ready to be picked up.
  - **Doing:** Currently being worked on.
  - **Review:** Finished by a worker and being verified by a checker/reviewer.
  - **Done:** Verified complete (or **Cut** with a reason).
- **Card (`C-1`, `C-2`, …):** A single task, feedback item, or approval request on the board. Cards support comments, assignees, priorities (`high`, `med`, `low`), milestones, and `blocked` / `cut` states.
- **Milestone (`M1`, `M2`, …):** A checkable stage of a job with a human-readable label, optional description, and planned active-time target. Agents refer to milestones by short ID (`M1`) internally; the dashboard displays their human labels and highlights any milestone paused waiting on you.
- **Agent Note:** A backlog card filed by the orchestrator (`src: "orchestrator"`) for a future cycle — for example, a research finding that changes the plan. You can edit or cut it before the next cycle triages it.

---

### Controls & States

- **Active Time (Clock):** Time counted only while a runner is actively working. Pauses, stops, crashes, and (by default) rate-limit waits do not burn your time box.
- **Mode:** The current phase of the clock:
  - `build` — normal feature/task work.
  - `wrapup` — feature freeze; only fixes, verification, and final checks.
  - `overtime` — grace period after the time box ends to finish in-flight wrap-up and exit cleanly.
  - `stop` — hard stop reached; runner ends the run.
  - `followup` — no time box; handles only your open feedback and unanswered comments after a goal is `DONE`.
- **Pause after task (default pause):** Signals the running cycle via `epoptes clock` and CLI notices to finish its current task/round, checkpoint, and exit cleanly instead of waiting for the entire cycle to finish.
- **Pause after cycle (`--after-cycle`):** Lets the current cycle complete all of its rounds before pausing.
- **Steer (`--steer` / ⚡ Steer now):** Interrupts the running cycle immediately (keeping work on disk) and starts a fresh cycle that replans the whole board around your new instruction first.
- **Approval:** A gate for actions listed in `approval_required` (like spending money or sending external messages). The card is blocked until you click **Approve** or **Disapprove**; the run keeps working on unrelated cards in the meantime.
- **Waiting for you (`needs_input`):** State entered when the orchestrator runs `epoptes wait-for-human` because nothing else can move without your answer. The clock stops until you reply or answer the last approval.
- **Follow-up (`--follow-up`):** A quick, un-timeboxed run after `DONE` that addresses only your open cards and comments (fixing minor tweaks in place and flagging big changes as `needs a new run`).

---

### Memory, Hooks & Learning

- **Handoff (`state/handoff.md`):** A short (≤ 25 lines) note overwritten at the end of every cycle telling the next fresh-context cycle what exists, what's half-done, and what's next.
- **Shadow Checkpoints (`checkpoints: "shadow"`):** Automatic git snapshots stored in `.epoptes/snapshots.git/` after each cycle without touching your project's own git repository.
- **Hooks (`onStart`, `onEnd`, `onPause`, `onStop`):** Optional shell commands configured in `goal.json` (or the Setup tab) that run automatically before/after each cycle or when a run pauses/stops.
- **Brain (`~/.epoptes/brain/`):** A local, token-free knowledge base of metrics, signals, and harness lessons gathered from your past runs so new harnesses avoid past mistakes.
