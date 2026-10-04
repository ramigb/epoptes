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

## 2026-09-28 · M5 polish
- **`bin/epoptes.mjs` launcher runs `src/` in a checkout and `dist/` in a package,** and checks Node ≥ 22.18. Why: `npm link` works for daily use with no build step, while the published package ships only compiled JS (Node won't strip types inside `node_modules`). Checked by installing the packed tarball into a clean folder and running a full (fake) run through it.
- **`epoptes start` checks that `claude` runs before spawning a runner.** Why: otherwise a missing CLI shows up as six failed cycles and a "failed" goal.
- **License: MIT.** Why: a permissive licence for a personal side project meant to help colleagues and anyone getting into long-horizon agent work; it contains no employer code or IP.
- **Package renamed to `@ramigbcom/epoptes`** (supersedes `@ramigb/epoptes`). Why: the npm account used for publishing is `ramigbcom`; the `@ramigb` scope belongs to another login. The binary stays `epoptes`.

## 2026-10-04 · Approvals and "waiting for you"
- **Approval requests are feedback items** (`kind: "approval"`, `src: "orchestrator"`), not a new log. Why: the orchestrator already reads `epoptes feedback --open` every cycle, so the answer reaches it with no new plumbing, and the dashboard and reports already show feedback.
- **An approval starts `blocked`; the human's answer is a `decide` op followed by `status → new`.** Why: "new" means "act on this" to the orchestrator; a waiting approval must not look like work.
- **The run keeps working while approvals wait** (user's choice). It only pauses when the orchestrator says nothing else can move: `epoptes wait-for-human "<what>"` ends the run as a distinct `needs_input` state, not a plain `paused`. Why: "paused" hid *why* it stopped; "waiting for you" with a reason is what the human needs to see.
- **Answering the last open approval resumes a `needs_input` run by itself**, and "Send & resume" does the same for open questions. A failed resume (e.g. time box over) is reported, but the answer is kept.
- **The orchestrator can't answer approvals** (`feedback F-n approve` refuses inside a cycle).

## 2026-10-04 · Agent notes (auto feedback)
- **`epoptes feedback "<text>"` inside a cycle files an agent note** (`src: "orchestrator"`), triaged by the next cycle after the human's feedback. Why: research findings and missing prerequisites used to vanish into a handoff the human never reads; as feedback they're visible, and the human can edit (`op: edit`) or dismiss (`wont_do`) them before the next cycle acts.
- **Agent notes are not tasks.** The loop template keeps ordinary work in the backlog, so the feedback list doesn't fill with routine items.

## 2026-10-04 · Steering feedback
- **Steering interrupts the running cycle** (user's choice) via SIGUSR2 to the runner, which interrupts the adapter like stop-now but starts the next cycle at once. SIGUSR1 is reserved by Node for its inspector. Work on disk survives; the next cycle's interrupted-work check recovers it. A steered cycle is not a failure.
- **The replan instruction comes from the runner, as a note in front of loop.md,** for as long as the steering item is `new`. Why: harnesses generated before this feature get it too, and the note can list the exact items. It asks for a ripple replan (every open task and milestone, not just one task), a decisions.md entry, and a `replanned: …` note on the item.
- **Rate-limit and cooldown waits are not cut short by steering;** a between-cycles wait is.

## 2026-10-04 · Follow-ups after DONE
- **Feedback on a finished goal runs as a follow-up, not a new run:** no time box, only the open feedback, and nothing else (no backlog, review fixes or leftover agent notes). Why: on 2026-09-28 one quick feedback item started a full 4 h run of open-ended polish.
- **The agent triages each item; the human can override** (user's choice). Minor → done in place. Major (restart, new version, change of direction, > ~1 cycle) → `blocked "needs a new run: …"`, and the human decides whether to start one. Overrides are a `scope` op: `tweak` forces in-place, `new_run` keeps it out of the follow-up.
- **The follow-up clock has no time box but two stops:** the runner records DONE itself once no follow-up item is left, and pauses with a warning after 3 cycles without DONE. Why: "follow the agent's judgement" shouldn't mean "can run all night".
- **The instructions come from the runner as a FOLLOW-UP note in front of loop.md** (like steering), so older harnesses get them too; loop.md templates also list the `followup` mode.

## 2026-10-04 · Milestones on the progress bars; early finish per milestone
- **Checked first:** before this, early finish only existed for the whole goal (`epoptes event wrapup`). Milestone headings carried `(target h:mm)`, but nothing read them, and the loop template never told the orchestrator to move on when a milestone finished early.
- **The loop template now has a per-milestone early finish:** done means tasks closed and checks passing, not target time reached; announce it, move the Current milestone line and start the next one at once; never pad. When ACTIVE is past `M_TARGET` by over half the milestone's length, shrink what's left. `epoptes clock` prints `MILESTONE=` / `M_TARGET=` so it can tell. Only harnesses generated from now on get the template text; older loop.md files need a manual edit.
- **The dashboard parses milestones from backlog headings** (`## M<n> · title (target h:mm)`). The clock bar gets a tick per target (on time / late / overdue / upcoming, with a text label for overdue and late) and a dot where the milestone was reached. The backlog bar splits into one segment per milestone. Milestone events carry `active_s`, because wall-clock time includes pauses.
