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

## 2026-09-28 · M1 probe findings (claude 2.1.283)
- **The cycle settings file always sets `permissions.defaultMode`.** Why: a `--settings` file without it silently overrides `--permission-mode auto` back to `default`. The runner also warns when the init event reports a different mode.
- **Cost basis comes from the init event's `apiKeySource`,** not from inspecting the environment. Why: the adapter knows what `claude` actually used, and Epoptes never has to look at env vars that might hold keys.
- **Rate-limit state comes from `rate_limit_event` in the stream** (exact reset time, per-window utilization), with the `run.sh` text match as a fallback. Why: precise waits instead of blind backoff, and a shared usage view for zero tokens.
- **The last `result` event is the cycle result.** Why: background subagents make the print session run extra turns, each ending in a `result` with cumulative totals.

## 2026-09-28 · M1 build
- **Source runs directly on Node ≥ 22.18 (type stripping); `tsc` only builds `dist/` for npm.** Tests use `node --test`. Why: no dev build step and no test framework dependency; `ajv` is the only runtime dependency.
- **`ajv` loads lazily.** Why: requiring it from `node_modules` on WSL's `/mnt/d` takes ~5 s (57 ms on ext4), and the commands orchestrators call inside cycles never validate.
- **The runner writes `run/bin/epoptes`, a shim for the exact CLI that started it, first on the cycle's PATH;** the adapter always allows `Bash(epoptes *)`. Why: orchestrators must be able to report without a global install, and always to the same version.
- **Runner tests use a fake `claude` (`test/fake-claude.mjs`, via `EPOPTES_CLAUDE_BIN`).** Why: start/stop/pause/fail paths get tested end to end without spending tokens.
- **`epoptes start` confirms on the runner's `run.start` event, not on a live status.** Why: a short run can finish before the first poll.

## 2026-09-28 · M2 dashboard
- **Preact through `htm/preact/standalone.module.js`, served from `node_modules`; plain JS modules in `ui/`; no bundler.** Why: keyed diffing keeps inputs focused and lets only new items animate, in a 13 KB file with no build step and no CDN (no external calls).
- **Polling (1 s) + incremental JSONL tails + SSE, not fs.watch.** Why: inotify doesn't fire on WSL's `/mnt` drives; a stat per file per second is cheap.
- **Local-only guards: Host allow-list, custom header + JSON for writes, Origin check, strict CSP.** Why: binding to 127.0.0.1 alone doesn't stop other websites (CSRF, DNS rebinding) from posting feedback, and feedback goes straight into agents' prompts.
- **The dashboard shows a pause request as soon as `control.json` exists.** Why: the runner only notices it on its 15 s heartbeat, and a short cycle can end first.
- **Starting a finished goal needs `--new-run` (dashboard: "Start new run…" + confirm).** Why: in the first real dashboard test, pressing Start on a DONE goal twice silently began runs r2 and r3, each spending a cycle to rediscover it was done, and the log called them "resume".

## 2026-09-28 · M3 skill
- **The skill ships as a Claude Code plugin in `plugin/`** (skill `epoptes:epoptes`); `epoptes skill install` symlinks it into `~/.claude/skills` for daily use. Why: `--plugin-dir` lets us test it without touching the user's config, and a symlink keeps it in step with the repo.
- **Claude copies and adapts templates; there is no `epoptes init` scaffolder.** Why: every file needs goal-specific judgement anyway; the dry-run lint catches leftovers deterministically.
- **Guardrails are checked, not just written down:** the dry-run lint (template leftovers, deny list, broad allows, secret-looking strings, loop wiring, caps).
- **Orchestrators use `epoptes clock` and `epoptes feedback --open`.** Why: one line and only-open items keep orient steps small; `status` is for humans.
- **Secrets point to a secret manager (e.g. the 1Password CLI or MCP).** The baseline deny list blocks `.env`, `~/.ssh`, `~/.aws`, `printenv`.

## 2026-09-28 · M4 reports
- **Active time in reports is rebuilt from events** (runner spans minus rate-limit waits), not read from `clock.json`. Why: a new run replaces the clock, so past runs would lose their active time.
- **HTML reports are self-contained and script-free** (inline CSS + SVG chart, native `<title>` tooltips, a table next to the chart). Why: they must open from disk, print, and be safe to pass around; the dashboard serves them under a CSP with no scripts.
- **The run.sh importer writes into the project's own `.epoptes/`** and refuses to overwrite records. Why: goal = directory, so git history, tags and paths just work. Checked on a clone of dress2impress: 19 cycles, ≈ $186.09, 273 turns and per-model costs match the raw logs exactly.
