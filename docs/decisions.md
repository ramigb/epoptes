# Decisions

Append-only. Each entry: date · decision · why. To change one, add a new entry that supersedes it.

## 2026-09-28 · M0 spec
- **The file format is the contract.** Runner, CLI, dashboard and skill share nothing but the files in `docs/spec.md`. Why: any piece can be replaced, and goals can be inspected and fixed by hand.
- **No daemon.** `epoptes start` spawns one detached runner per goal; the dashboard only watches files and calls the same control code as the CLI. Why: closing or restarting the dashboard can never kill a run, and there's one fewer process to supervise.
- **Snapshots are atomic single-writer JSON; logs are append-only JSONL.** Why: the runner, the CLI (inside cycles) and the dashboard write concurrently without locks. Feedback ids are the one exception and take a tiny O_EXCL lock.
- **Feedback is an operation log** (`add` / `status` / `note`), folded into current state by readers. Why: the full history of each item is needed for badges and reports anyway, and appends can't clobber each other.
- **`FEEDBACK.md` stays as an optional inbox,** ingested by the runner (no model tokens) and marked `→ F-n`. Why: writing a bullet in a file is the easiest way to give feedback, and dress2impress proved it works.
- **Role files live in `.epoptes/agents/`** and the adapter passes them to `claude` with `--agents`. Why: keeps the project's own `.claude/` untouched. Cost: these roles don't show up in your interactive sessions in that project. If `--agents` turns out not to support a frontmatter field we need (e.g. `effort`), fall back to copying them into `<project>/.claude/agents/` and note it here.
- **Runs have ids (`r<k>`); cycle numbers are monotonic per goal.** Why: in dress2impress run 2 restarted at cycle 1 and overwrote run 1's logs.
- **Active time only accrues while a runner is live.** Pause, stop and crash set `paused_at`; `--dry-run` never touches the clock. Why: dress2impress only paused for rate limits, and its dry run started the clock.
- **Runner sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.** Why: background subagents were killed 600 s after the turn ended in c1–c4 of dress2impress; the cycle timeout still bounds the cycle.
- **Cost is labelled `estimate` unless the cycle ran with an API key.** The UI shows "≈ $x (estimate)" with a tooltip "API-equivalent estimate, not billed". Phase 1 has no API key, so it's always an estimate. The runner checks that a key is present and never reads or stores it.
- **Non-code checkpoints use a shadow git repo** (`.epoptes/snapshots.git`, committed by the runner after each cycle). Why: diffable, cheap, no tokens, and it never touches the user's own repo.
- **Package `@ramigb/epoptes`, binary `epoptes`.** Why: scoped name; an unrelated Debian `epoptes` binary is an acceptable clash.
