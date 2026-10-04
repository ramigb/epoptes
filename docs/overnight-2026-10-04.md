# Overnight build: 2026-10-04

The eleven items from your list, each built, checked and committed separately. Every feature has tests (38 pass, up from 30), and each UI piece was checked in a real browser (Chromium via Playwright) against fake runs. All of it costs no tokens. The reasoning behind each choice is in [decisions.md](decisions.md) under 2026-10-04; this page is the short version.

| # | your item | commit | how to try it |
|---|---|---|---|
| 1, 3 | Approve / Disapprove; say clearly when it waits for you | `d339c62` | dashboard ⚑ panel, `epoptes feedback F-n approve\|reject ["note"]` |
| 2 | Auto feedback for the next cycle | `d044686` | in a cycle: `epoptes feedback "<finding>"` → "agent note" |
| 7 | Steerable feedback with a ripple effect | `ab3ee1f` | **⚡ Steer now**, or `epoptes feedback <goal> "<text>" --steer` |
| 8 | Post-run feedback by agent judgement, not the time box | `8ced6b0` | **Follow up on N feedback items**, or `epoptes start <goal> --follow-up` |
| 5, 6 | Milestone segments; early finish per milestone | `63a1606` | clock bar ticks + per-milestone backlog bar; loop template |
| 4 | Chart of where the time went | `6d87a35` | "Where the time went" panel on a goal page |
| 9 | Animated favicon | `bc3965c` | any dashboard tab |
| 10 | Link to the output | `6dde3ca` | "Output ↗" / "Open the output ↗" when done |
| 11 | The brain | `59c63a0` | `epoptes brain`, the **Brain** page, `~/.epoptes/brain/INDEX.md` |

## What I decided, per item

**Approvals and "waiting for you"** (your choice: keep working). `epoptes approval "<what>" --ref <task>` files the request as a feedback item of kind `approval`, and the run carries on with other work. Approve / Disapprove (with an optional note) reopens it as `new`, so the next cycle acts on it; `--open` shows `[approval: APPROVED "note"]`. When nothing else can move, the orchestrator runs `epoptes wait-for-human "<what>"`. The run then ends in a **new state, `needs_input`** (label: "waiting for you"), with the reason and the clock stopped. You see it in the goal card's ⚑ line, a highlighted panel on the goal page, `⚑ n` in the tab title and the favicon. Answering the last open approval resumes the run by itself; "Send & resume" does the same for an open question. The loop template's pause-for-review points use `wait-for-human` too.

**Agent notes** (your choice). Inside a cycle, `epoptes feedback "<text>"` adds an item from the orchestrator. You get a toast and an "agent note" chip, with Edit and Dismiss buttons. The next cycle triages it after your own feedback. Ordinary tasks still go in the backlog.

**Steering** (your choice: interrupt now). Steer sends SIGUSR2 to the runner, which interrupts the cycle like Stop but starts the next one immediately (it isn't counted as a failure). The replan instructions come from the **runner**, as a note in front of loop.md while the item is new. That way harnesses generated before this feature get it too. The note asks for a ripple replan (every open task and milestone, not just one), a decisions.md entry, and a "replanned: …" note on the item. Rate-limit and cooldown waits are not cut short.

**Follow-ups after DONE** (your choice: agent triages, you can override). These handle only your open feedback (never leftover agent notes, review fixes or backlog polish), with **no time box**. Minor items are done in place; restarts, new versions or changes of direction are marked `blocked "needs a new run: …"` for you to decide on. A per-item dropdown overrides this (agent decides / quick tweak / needs a new run). There are two safety stops I added: the runner records DONE itself once nothing is left, and it pauses a follow-up after 3 cycles without DONE. Instructions again come from a runner note, so older harnesses get them.

**Milestones.** I checked first: early finish only existed for the whole goal; milestone targets `(target h:mm)` were never read, and nothing said "move on early". Now:
- the loop template finishes milestones early and never pads them to their target
- it shrinks a milestone that runs past its target by more than half
- `epoptes clock` prints `MILESTONE=` and `M_TARGET=`
- the clock bar shows a tick per target (on time, late, overdue, upcoming, with text for overdue and late) and a dot where each milestone was reached
- the backlog bar splits into one segment per milestone

**Where the time went.** A part-to-whole bar (running, rate limits and cooldowns, waiting for you, paused), agent time per role (plus the orchestrator alone), and tool time with call counts, with tooltips and a table view. It's computed from existing files, so it works for past runs too: about 100 ms on a copy of pipo's 12 cycles. Background shell tasks are reported like subagents in the stream, so I moved them under tools as "background commands"; otherwise they'd dwarf the real roles. Colours were validated with the dataviz palette checker, in light and dark.

**Favicon.** Drawn on a canvas. The priority is needs you (amber, blinking `!`) > failed (red) > running (turning arcs) > rate-limited (slow pulse) > between cycles (green pulse) > done (purple check) > idle. On a goal page it follows that goal; on the list, the most urgent goal. It's static under reduced motion.

**Output link.** goal.json gets an optional `output` (a path or URL); the skill asks for it in the interview, and `epoptes event output <path|url>` overrides it. Project files are served from a **separate local origin (dashboard port + 1)**. A game or app then runs normally but can't reach the dashboard's controls. It's read-only, serves only registered projects, refuses dotfiles (`.env`, `.epoptes`, `.git`) and symlink escapes, and is off in `--lan` mode. I added `output: "index.html"` to the tower-defense example and checked the game loads from the done banner.

**The brain.** Orchestrators record 1–3 harness lessons in wrap-up (`epoptes lesson "<rule>" --topic roles|briefs|cycles|checks|tools|state|cost|steering`). They're stored as events, so they're committed with each goal. When any run ends, and on `epoptes brain`, a digest per goal goes to `~/.epoptes/brain/goals/`. It holds the numbers, automatic **signals** (e.g. "3 of 12 cycles hit the timeout", "steered twice: the interview missed something") and the goal's `state/lessons.md` rules as "work lessons". `INDEX.md` is rebuilt from the digests. None of this spends tokens. The skill now has a step 2, "Consult the brain", and a LESSONS line in the sign-off summary. Model-written summaries are opt-in: ask the skill to "distill the brain" and it writes `NOTES.md` (curated, at most 60 lines). There's a Brain page in the dashboard too. Everything stays on this machine.

## Things to know

- **Your existing harnesses (pipo, epoptes-video, glossary) still use their old loop.md.** Steering and follow-ups work for them, because the runner adds those instructions. They won't call `epoptes approval`, `wait-for-human`, `lesson` or `event output`, or do per-milestone early finish, until their loop.md is updated. I didn't touch your projects; I can patch them on request.
- **Restart the dashboard** (`epoptes ui`) to get the new UI. No runs were live when I finished.
- **One mistake on my side:** while testing auto-resume I answered an approval from a shell that didn't point at the fake `claude`. A real Opus cycle ran for 16 s (≈ $0.25 API-equivalent) before I stopped it. It ran in the scratch demo folder and only ran read-only `epoptes` commands. After that, every demo command used an env file that always sets the fake binary.
- **Approving from the CLI resumes the run with that shell's environment.** That's how `start` already worked; it's just easier to trigger now.
- **Not pushed, not published.** Everything is local commits on `main`; the version is still 0.2.0. `npm run build` compiles, and I smoke-tested the compiled CLI.
- `ROADMAP.md` has the follow-ups I noticed but left alone.
