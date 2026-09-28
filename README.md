<p align="center"><img src="docs/assets/epoptes-logo.png" alt="epoptes: autonomous work, under watch" width="600"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ramigbcom/epoptes"><img src="https://img.shields.io/npm/v/@ramigbcom/epoptes?color=e8a23a&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@ramigbcom/epoptes?color=101114" alt="MIT license"></a>
</p>

# Epoptes

*Epoptes (Greek ἐπόπτης, "the overseer") was a title for Zeus and Helios, who watch over everything.*

Epoptes runs **long, autonomous Claude Code sessions** (an overnight build, a research sweep, a stack of documents, a data clean-up) and lets you watch and steer them. You describe the goal in a Claude Code chat, and Claude interviews you and writes the harness. Epoptes then runs it as a series of fresh-context cycles until the goal is done or its time box ends, with a live dashboard, feedback while it runs, and a report at the end.

It grew out of a 12-hour autonomous game build. Its rules for keeping long runs cheap and on track are built in:
- a fresh context every cycle
- small state files with size caps
- cheap models for mechanical work
- a time and round cap per cycle

> **Status:** early (0.1). A personal tool that's improved from daily use. File formats may still change; see [ROADMAP.md](ROADMAP.md).

## What you need
- **Node.js 22.18 or newer**
- **[Claude Code](https://docs.claude.com/claude-code), installed and logged in.** Epoptes runs your own `claude` CLI and never handles logins or keys.
- **Linux, macOS or WSL2**

## Install
```sh
npm install -g @ramigbcom/epoptes
epoptes --version
```
The package is on npm as [`@ramigbcom/epoptes`](https://www.npmjs.com/package/@ramigbcom/epoptes). You can also try single commands without installing: `npx @ramigbcom/epoptes <command>`.

**From a checkout** (to hack on it):
```sh
git clone https://github.com/ramigb/epoptes.git && cd epoptes
npm install
npm link            # puts `epoptes` on your PATH; runs the source directly, so no build step
```
On WSL2, keep the checkout on the Linux side (`~/…`), not under `/mnt/c` or `/mnt/d`, if you can. Loading `node_modules` from Windows drives is slow.

## Quick start
1. **Give Claude Code the skill:**
   ```sh
   epoptes skill install     # links the skill into ~/.claude/skills (all projects)
   ```
   Run this from a global install (or a checkout), not through `npx`: `npx` runs from npm's temporary cache, and the link would break when that cache is cleared. To try the skill for one session only: `claude --plugin-dir "$(epoptes skill path)/../.."`.
2. **Describe the goal.** In Claude Code, in the folder the work should happen in:
   > use the epoptes skill to build a harness for *writing a 20-page field guide to our internal APIs*
   
   Claude interviews you about:
   - the outcome, and a done definition it can check
   - non-goals and the time box
   - the team (roles, models and effort)
   - checkpoints, and what always needs your approval
   - how you'll give feedback

   It shows a one-screen summary for sign-off. Then it generates `.epoptes/`, runs `epoptes run --dry-run`, and registers the goal with `epoptes add`.
3. **Open the dashboard:**
   ```sh
   epoptes ui                # http://127.0.0.1:4747
   ```
4. **Press Start** (or run `epoptes start <goal>`). Watch the live ticker, give feedback, pause or stop at any time.
5. **When it's done:** `epoptes report <goal>`, or the Report button in the dashboard.

To try Epoptes before building your own goal, a 15-minute example writes a small glossary. It costs well under $1 of API-equivalent usage.
```sh
cp -r examples/glossary /tmp/glossary && epoptes add /tmp/glossary && epoptes start glossary
```

## How it works
- **A goal is a directory.** Everything lives in `<project>/.epoptes/`: `goal.json` (objective, done checks, time box, models), `loop.md` (the orchestrator's per-cycle instructions), role files in `agents/`, and memory in `state/`. It also holds the logs of events, feedback and cycles. The file format is the contract: the CLI, runner, dashboard and skill only read and write these files ([docs/spec.md](docs/spec.md)).
- **A run is a detached process,** one per goal. It starts `claude -p` with `loop.md`, cycle after cycle:
  - Each cycle orients from the state files, dispatches work to subagents, verifies it, records it and exits.
  - Between cycles, the runner checks the time box, your controls, rate limits and failures.
  - Closing the dashboard or the terminal never stops a run.
- **The clock counts active time.** It doesn't count pauses, stops or (by default) rate-limit waits. Near the end the goal switches to *wrap-up* (feature freeze), then *overtime*, then stops. A goal can also finish early once its checks pass.
- **Observability costs no tokens.** The live ticker comes from Claude Code's `stream-json` output: which agent is doing what, and which files it touched. Orchestrators add a few semantic events through the CLI (milestones, blocks, done).

## Everyday use
| you want to… | dashboard | CLI (also usable from a Claude Code chat) |
|---|---|---|
| see how it's going | goal card or page | `epoptes status <goal>` |
| start or resume | **Start** / **Resume** | `epoptes start <goal>` |
| pause safely | **Pause after cycle** | `epoptes pause <goal>` |
| stop right now | **Stop now** | `epoptes stop <goal>` (the next start recovers the interrupted work) |
| give it more time | **+30m / +1h / +2h** | `epoptes extend <goal> 2h` |
| give feedback | the Feedback box | `epoptes feedback <goal> "the intro is too long"`, or a bullet in `.epoptes/FEEDBACK.md` |
| see what it did | the Report button | `epoptes report <goal>` (Markdown + HTML) |

Feedback items get an id (`F-3`) and go through `new → seen → in progress → done | blocked | won't do`. Each change records its cycle and a note, and the dashboard shows it live with an unread badge. Desktop notifications are optional: use the 🔔 button.

Once a goal is done, **Start new run…** begins a fresh run with a new time box. Epoptes asks first, because a new run spends tokens and only finds work if you added feedback or tasks since.

## CLI reference
```
epoptes add [dir]                      register a goal (validates .epoptes/goal.json)
epoptes list                           all goals
epoptes status [goal]                  one screen: state, clock, cycle, backlog, feedback, last cycle, handoff
epoptes run [goal] --dry-run           check setup and guardrails, print the next cycle's command (never starts the clock)
epoptes start [goal] [--new-run]       start or resume (--new-run after DONE / time box over)
epoptes pause [goal] · stop [goal]     pause after this cycle · stop now
epoptes extend [goal] <dur>            e.g. 2h, 30m
epoptes reset-clock [goal]             the next start is a new run
epoptes feedback [goal] "<text>"       add feedback      · epoptes feedback [goal] [--open]  list it
epoptes feedback F-3 <status> [note]   new | seen | in_progress | done | blocked | wont_do
epoptes event <type> "<text>"          milestone | blocked | note | artifact | round | wrapup | done (used by orchestrators)
epoptes clock                          one line with the time left (used by orchestrators)
epoptes report [goal] [--all]          Markdown + HTML report
epoptes import-runsh <project>         import an older run.sh harness (dress2impress style)
epoptes ui [--port N] [--lan]          the dashboard
epoptes skill install | path           the Claude Code skill
```
`[goal]` is a registered id or a path. Leave it out inside a goal's folder.

## Costs and usage limits
- The dashboard and reports show **tokens by model, cache-read share and cost per cycle**, and flag cycles that cost more than twice the median.
- On a Claude subscription, costs are **API-equivalent estimates, not bills**, and are always shown with `≈`.
- You're responsible for your account and its usage limits. When Claude Code reports a rate limit, Epoptes waits until the limit resets (and pauses the clock), then continues. It never works around limits or switches accounts.
- For hard caps per cycle, set `cycle.max_budget_usd` in `goal.json`.

## Safety and privacy
- **Local only.** The dashboard binds to `127.0.0.1`. It rejects other hosts (DNS rebinding) and cross-site writes (CSRF), because feedback ends up in agents' prompts. `--lan` is an explicit opt-in with a warning and no login.
- **No telemetry,** no accounts, no keys. Epoptes runs the `claude` you're already logged into.
- **Transcripts and logs stay on your machine,** gitignored under `.epoptes/cycles/` and `.epoptes/run/`.
- **Guardrails in every generated harness:**
  - a permissions allow/deny list
  - no `git push`, no history rewrites, no destructive cleans
  - secrets never in goal files (use your secret manager, e.g. the 1Password CLI)
  - an approval list the orchestrator must never act on by itself

  `epoptes run --dry-run` checks these, and warns about anything that looks like a credential.

## Development
```sh
npm test            # node --test: unit tests, end-to-end runner tests with a fake `claude`, server and report tests
npm run typecheck
npm run build       # dist/ for the npm package (the checkout runs src/ directly)
```
- `src/`: the CLI, runner, adapter (`adapters/claude-code.ts`), dashboard server (`ui/`), reports and the importer.
- `ui/`: the dashboard (Preact via `htm`, no build step).
- `plugin/`: the Claude Code skill and templates.
- `docs/`: the spec, JSON Schemas and decisions.

Usage notes go in [NOTES.md](NOTES.md), and are triaged into [ROADMAP.md](ROADMAP.md).

## License
[MIT](LICENSE).
