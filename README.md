<p align="center"><img src="docs/assets/epoptes-logo.png" alt="epoptes: autonomous work, under watch" width="600"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ramigbcom/epoptes"><img src="https://img.shields.io/npm/v/@ramigbcom/epoptes?color=e8a23a&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@ramigbcom/epoptes?color=101114" alt="MIT license"></a>
</p>

# Epoptes

*Epoptes (Greek ἐπόπτης, "the overseer") was a title for Zeus and Helios, who watch over everything.*

Epoptes runs **long, autonomous Claude Code, Codex, pi or Antigravity sessions** (an overnight build, a research sweep, a stack of documents, a data clean-up) and lets you watch and steer them. You describe the goal in a chat, and the agent interviews you and writes the harness. Epoptes then runs it as a series of fresh-context cycles until the goal is done or its time box ends, with a live dashboard, a kanban board you steer it through, and a report at the end.

It grew out of a 12-hour autonomous game build. Its rules for keeping long runs cheap and on track are built in:
- a fresh context every cycle
- small state files with size caps
- cheap models for mechanical work
- a time and round cap per cycle

> **Status:** early (0.3). A personal tool that's improved from daily use. File formats may still change; see [ROADMAP.md](ROADMAP.md).

## What you need
- **Node.js 22.18 or newer**
- **[Claude Code](https://docs.claude.com/claude-code), [Codex CLI](https://developers.openai.com/codex/cli) [pi](https://pi.dev) or [Antigravity CLI](https://antigravity.google) (`agy`), installed and logged in.** Epoptes runs your own CLI and never handles logins or keys.
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
   - where the deliverable lives (so the dashboard can link to it)
   - how you'll give feedback

   It also reads the brain (lessons from your past harnesses, below) and shows a one-screen summary for sign-off, including which lessons it applied. Then it generates `.epoptes/`, runs `epoptes run --dry-run`, and registers the goal with `epoptes add`.
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

### Using Codex

Install the same skill for Codex:
```sh
epoptes skill install --agent codex    # links into ~/.agents/skills
```
Then, in Codex, ask: "use the epoptes skill to build a Codex harness for <goal>". Use a global install or checkout for the skill link, as with Claude Code. Run Epoptes and the Codex CLI in Linux, macOS or WSL2; native Windows runners are not supported.

In `.epoptes/goal.json`, use:
```json
"adapter": {
  "type": "codex",
  "model": "",
  "effort": "high",
  "permission_mode": "workspace-write"
}
```
An empty model uses your Codex CLI configuration; you can also specify a Codex model id. Each cycle runs a fresh `codex exec --json`, sends `loop.md` on stdin, and uses saved CLI authentication. Approval prompts are disabled; commands requiring escalation fail. Non-git directories work too.

Codex uses its native sandbox, configuration and rules. `.epoptes/settings.json` is Claude-only: omit it for Codex goals. Role files in `.epoptes/agents/` become native Codex custom agents each cycle (a TOML per role in the cycle folder, registered with `-c agents.<role>.config_file=…`; nothing is written to your project): `model` and `effort` apply per role, so a role needs a Codex model id (`gpt-6.1-terra`) or no model to inherit. Tool lists and turn caps have no Codex equivalent. The orchestrator spawns a role by its name. Adapt an existing Claude loop, and its role models, before changing its adapter.

The dashboard and reports show Codex commands, file changes, messages and token usage. Codex JSONL provides no dollar costs or reset timestamps: costs display as unknown, rate limits use the configured backoff, and `cycle.max_budget_usd` must be `null`. Your Codex plan usage (5h and 7d windows) is read from the session log Codex writes for each cycle and shown on Codex goals. With an empty model, token usage is labelled `codex-configured` because the stream doesn't identify the actual model. See the official [non-interactive mode documentation](https://developers.openai.com/codex/noninteractive) and [skill locations](https://developers.openai.com/codex/skills).

### Using pi

[pi](https://pi.dev) reads the same Agent Skills location as Codex:
```sh
epoptes skill install --agent pi       # links into ~/.agents/skills
```
Then, in pi, ask: "use the epoptes skill to build a pi harness for <goal>" (or force it with `/skill:epoptes`).

In `.epoptes/goal.json`, use:
```json
"adapter": {
  "type": "pi",
  "model": "openrouter/<vendor>/<model>",
  "effort": "high",
  "permission_mode": "default"
},
"cycle": { "max_budget_usd": 2 }
```
An empty model uses pi's `defaultProvider`/`defaultModel`; otherwise use pi's `provider/id` form (`pi --list-models <search>`). `effort` becomes `--thinking`. Each cycle runs a fresh `pi --mode json` with `loop.md` on stdin, using pi's own credentials: for OpenRouter, `/login openrouter` in pi or `OPENROUTER_API_KEY`. To keep the key out of plain files, set the provider's key in `~/.pi/agent/auth.json` to a secret-manager command such as `!op read op://…` (1Password CLI). Each cycle's pi session file is kept in its `.epoptes/cycles/<n>/` folder, so `pi --session <file>` reopens any cycle.

pi has **no sandbox and no approval prompts**: its tools run with your permissions. Keep `.epoptes/settings.json` for its deny list. The adapter loads a small Epoptes guard extension that blocks `Bash(…)`, `Read(…)`, `Edit(…)` and `Write(…)` deny matches, including inside `&&`, `;` and `|` chains, and reports each blocked attempt as a warning. Allow rules have no effect. The guard is a tripwire, not a boundary: for untrusted goals, run pi in a container or VM. Extra pi flags (for example `["--exclude-tools", "write"]`) go in `adapter.args`.

pi reports tokens and a cost estimate from its model catalog, so the dashboard and reports show dollar estimates (`≈`), live while a cycle runs. pi bills per token, so a pi goal's top bar shows the job's API spend instead of plan usage. `cycle.max_budget_usd` works: Epoptes stops the cycle when the estimate passes it, which is worth setting for pay-per-token providers. Rate-limit errors (429, "rate limit", overloaded) that pi's own retries don't clear use the runner's backoff. Like Codex, pi has no subagents, so the skill writes `loop.md` to work sequentially.
### Using Antigravity

The Antigravity CLI (`agy`) reads global skills from `~/.gemini/config/skills`:
```sh
epoptes skill install --agent antigravity
```
In `.epoptes/goal.json`, use:
```json
"adapter": {
  "type": "antigravity",
  "model": "gemini-3.8-flash",
  "effort": "low",
  "permission_mode": "accept-edits"
}
```
An empty model uses agy's configured model; `agy models` lists the ids. A model id that already names an effort (`gemini-3.8-flash-low`) needs an empty `effort`: agy rejects both together. Each cycle runs a fresh `agy --output-format stream-json -p=<loop.md>` (agy reads no prompt from stdin) with its saved login.

agy uses its **own** permissions, in `~/.gemini/antigravity-cli/settings.json`; `.epoptes/settings.json` is ignored. `permission_mode` is `accept-edits` (workspace edits approved; commands need an allow rule), `auto` (agy's sandboxed auto mode, a preview) or `skip-permissions` (`--dangerously-skip-permissions`: every tool call approved, only agy's deny rules apply). A cycle can't answer a prompt: agy auto-denies an unlisted command and ends the turn, and Epoptes records the cycle as an error naming what was denied. With `accept-edits`, add at least `command(epoptes)` and the commands loop.md runs (`command(git)`, `command(npm test)`) to `permissions.allow`.

agy reports tokens but no dollar costs or plan usage, so costs show as unknown and `cycle.max_budget_usd` must be `null`. Quota and rate-limit errors use the runner's backoff. Role files become agy custom subagents each cycle (`<cycle>/.agents/agents/<role>.md`, added to the workspace with `--add-dir`). A role's `model` is an agy tier (`inherit`, `flash` or `pro`), its Claude tool names map to agy's tools, and `effort` and `maxTurns` have no agy equivalent. A subagent's commands follow the same allow list.

## How it works
- **A goal is a directory.** Everything lives in `<project>/.epoptes/`: `goal.json` (objective, done checks, time box, models), `loop.md` (the orchestrator's per-cycle instructions), role files in `agents/`, and memory in `state/`. It also holds the board (`board.jsonl`) and the logs of events and cycles. The file format is the contract: the CLI, runner, dashboard and skill only read and write these files ([docs/spec.md](docs/spec.md)).
- **A run is a detached process,** one per goal. It starts `claude -p`, `codex exec`, `pi --mode json` or `agy -p` with `loop.md`, cycle after cycle:
  - Each cycle orients from the state files and the board, does a slice of work (through subagents when configured), verifies it, records it and exits.
  - Between cycles, the runner checks the time box, your controls, rate limits and failures.
  - Closing the dashboard or the terminal never stops a run.
- **Everything goes through the board.** One kanban board per harness, and each job is an epic on it. Your feedback lands in the **backlog**; the orchestrator triages each card into **TODO** (or cuts it with a reason), works it in **DOING**, verifies it in **REVIEW** and moves it to **DONE**. Cards carry their milestone, the role working on them and a priority. Comment on any card: the next cycle acts on it or just replies, and a comment on a done card reopens it.
- **The clock counts active time.** It doesn't count pauses, stops or (by default) rate-limit waits. Near the end the goal switches to *wrap-up* (feature freeze), then *overtime*, then stops.
- **The time box is a limit, not a target.** A goal finishes early once its checks pass, and each milestone moves on as soon as it's done rather than waiting for its target time. The harness doesn't invent work to fill the time:
  - a card only goes on the board if a done check, a milestone or one of your cards needs it; ideas go in the handoff for you
  - when the board has no real work left, the runner tells the next cycle to run the done checks and wrap up
  - the dashboard shows a projected finish from the milestone pace so far (for example, a 2-hour milestone done in 30 minutes puts a 10-hour plan on pace for about 2h30m)
- **You stay in the loop without watching.** Anything on the goal's approval list waits for your Approve / Disapprove while the run carries on with other work. When nothing else can move, the run pauses as **waiting for you**, with the reason, until you answer. The orchestrator can also leave you *agent notes* (findings the next cycle must act on), which land in the backlog for you to edit or cut.
- **Every harness makes the next one better.** Orchestrators record harness lessons in wrap-up. When a run ends, Epoptes gathers them, plus each goal's numbers and automatic signals, into a local **brain** (`~/.epoptes/brain/INDEX.md`). Signals are things like frequent timeouts, late milestones or repeated steering. This costs no tokens. The skill reads the brain before designing a new harness. Ask it to "distill the brain" to get a short curated `NOTES.md`.
- **Observability costs no tokens.** The live ticker comes from the CLI's JSON stream: which tools ran and which files changed (plus agent activity for Claude Code). Orchestrators add a few semantic events through the CLI (milestones, blocks, done).

## Everyday use
| you want to… | dashboard | CLI (also usable from a Claude Code or Codex chat) |
|---|---|---|
| see how it's going | goal card or page | `epoptes status <goal>` |
| start or resume | **Start** / **Resume** | `epoptes start <goal>` |
| pause safely | **Pause after cycle** | `epoptes pause <goal>` |
| stop right now | **Stop now** | `epoptes stop <goal>` (the next start recovers the interrupted work) |
| give it more time | **+30m / +1h / +2h** | `epoptes extend <goal> 2h` |
| give feedback | **Add to backlog** on the board | `epoptes feedback <goal> "the intro is too long"`, or a bullet in `.epoptes/FEEDBACK.md` |
| say something about one task | open the card and comment | `epoptes card C-12 comment "use the brand blue"` |
| see the plan | the **Board** (drag cards between columns) | `epoptes board <goal>` |
| change direction now | **⚡ Steer now** | `epoptes feedback <goal> "use SQLite instead" --steer` (interrupts the cycle; the next one replans the whole board around it). A comment can steer too: `--steer` |
| answer an approval | **Approve / Disapprove** | `epoptes card C-4 approve "test mode only"` (or `reject`) |
| start a new feature in the same project | ask the skill: "a new epoptes job: …" | `epoptes job new "<title>"`, then update goal.json, loop.md and seed the new epic (the skill does this for you) |
| tweak a finished goal | **Follow up on N cards** | `epoptes start <goal> --follow-up` (no time box; minor items fixed in place, big ones flagged for a new run) |
| open what it made | **Open the output ↗** | goal.json `output`, or `epoptes event output <path or URL>` |
| see where time went | the "Where the time went" panel (running vs rate limits vs waiting for you vs paused, time per role, time per tool) | dashboard only |
| see if it'll finish early | milestone ticks and the dashed "on pace to finish" marker on the clock bar | the `pace` line in `epoptes status` |
| see what past runs taught | **Brain** | `epoptes brain` (writes `~/.epoptes/brain/INDEX.md`) |
| see what it did | the Report button | `epoptes report <goal>` (Markdown + HTML) |

Cards get an id (`C-12`) and move `backlog → todo → doing → review → done`, or get cut or blocked with a reason. Each move records its cycle; agents' replies show live with an unread badge and a toast. A card you added or commented on says "waiting for the agent" until the orchestrator has read it. An approval request blocks its card until you answer, and notes the orchestrator files for the next cycle are marked "agent note". Desktop notifications are optional: use the 🔔 button.

The board's progress bar is split into one segment per milestone. The clock bar marks each milestone's target (on time, late, overdue) and where it was actually reached.

Once a goal is done, feedback goes through a **follow-up**: only your open cards and unanswered comments, with no time box, and nothing else. The agent fixes minor items in place (a colour, a size, wording). Anything that needs a restart or a new version is flagged "needs a new run" for you to decide on, and you can override how each card is treated. **Start new run…** begins a fresh run with a new time box. Epoptes asks first, because a new run spends tokens.

**One harness, many jobs.** When the project needs its next feature, don't build a second harness: ask the skill for a new job. It interviews you only about what changes, then runs `epoptes job new "<title>"`. That opens a new epic on the board, archives the finished job's handoff and progress into `.epoptes/state/archive/`, keeps the roles, permissions, lessons and decisions, and resets the clock. Untriaged backlog cards move to the new epic; the board's epic picker shows the old ones. The goal page, `epoptes status` and reports show the current job, with a switch to all jobs (`epoptes report --job all`, `epoptes job` to list them).

The dashboard's tab icon shows the state at a glance: arcs turn while a cycle runs, a badge blinks when the run needs you, and it turns red on failure.

## CLI reference
```
epoptes add [dir]                      register a goal (validates .epoptes/goal.json)
epoptes list                           all goals
epoptes status [goal]                  one screen: state, clock, pace, cycle, board, approvals, output, last cycle, handoff
epoptes run [goal] --dry-run           check setup and guardrails, print the next cycle's command (never starts the clock)
epoptes start [goal] [--new-run]       start or resume (--new-run after DONE / time box over)
epoptes start [goal] --follow-up       after DONE: just your open cards and comments, no time box
epoptes pause [goal] · stop [goal]     pause after this cycle · stop now
epoptes extend [goal] <dur>            e.g. 2h, 30m
epoptes reset-clock [goal]             the next start is a new run
epoptes board [goal] [--open] [--all] the board: the current epic's cards by column (--all: every epic)
epoptes feedback [goal] "<text>"       add a card to the backlog · --steer: interrupt the running cycle and replan around it
epoptes card add "<title>"             add a card [--column c] [--milestone M1] [--assign role] [--priority high|med|low]
epoptes card C-3                       one card and its comments
epoptes card C-3 todo|doing|review|done|backlog ["note"]   move it · cut|block "<why>" · unblock
epoptes card C-3 comment "<text>"      comment (--steer to interrupt and replan) · approve|reject [note] an approval
epoptes card C-3 set --title t --milestone M2 --assign r --priority p --scope auto|tweak|new_run
epoptes milestone [goal]               the milestones · milestone add M3 "<title>" --target 2:00
epoptes event <type> "<text>"          milestone | blocked | note | artifact | output | round | wrapup | done (used by orchestrators)
epoptes approval "<what>" [--ref C-n] ask the human first (orchestrators) · wait-for-human "<what>": pause until they answer
epoptes lesson "<rule>" [--topic t]    a harness lesson for the brain (orchestrators, in wrap-up)
epoptes brain [lessons [--kind k]]     gather every goal into ~/.epoptes/brain/INDEX.md · print the lessons
epoptes job [goal]                     the harness's jobs · job new "<title>": start the next one (archive, keep memory, reset clock)
epoptes clock                          one line with the time left and the current milestone's target (used by orchestrators)
epoptes report [goal] [--all] [--job <id>|all]   Markdown + HTML report (default: the current job)
epoptes import-runsh <project>         import an older run.sh harness (dress2impress style)
epoptes ui [--port N] [--lan]          the dashboard (outputs are served on the next port)
epoptes skill install [--agent codex|pi|antigravity]   install the skill (Claude Code by default)
epoptes skill path                     print the shared skill directory
```
`[goal]` is a registered id or a path. Leave it out inside a goal's folder.

## Upgrading to the board
The first time Epoptes reads a goal from before the board, it moves `feedback.jsonl` and every job's `backlog.md` onto the board (renamed `*.imported`; feedback keeps its `F-3` ids). The runner tells an old `loop.md` how the board replaces backlog.md and the feedback list, and `epoptes feedback F-3 done` still works. For the full flow (triage, REVIEW, replying to comments), refresh `loop.md` from the template: ask the skill, or Claude, to update it.

## Upgrading from 0.2
Harnesses generated before 0.3 keep working. Some of the new behaviour comes from the runner, so they get it right away:
- steering
- follow-ups after DONE
- the backlog-clear nudge
- the dashboard features

The rest comes from the loop template: approval requests, "waiting for you", harness lessons, the output event, the scope rule and per-milestone early finish. To get these, regenerate the harness with the skill, or ask Claude to update that goal's `.epoptes/loop.md` from the current template. You can also add `"output"` to an old `goal.json` by hand.

## Costs and usage limits
- The dashboard and reports show **tokens by model, cache-read share and cost per cycle**, and flag cycles that cost more than twice the median. Cache share (and, on pi, cost) count the running cycle too.
- The top bar shows the plan usage of the CLI a goal runs on (Claude or Codex). Epoptes only reads it during its own cycles, so an older reading is dimmed and says how old it is.
- On a Claude subscription, costs are **API-equivalent estimates, not bills**, and are always shown with `≈`.
- You're responsible for your account and its usage limits. When Claude Code reports a rate limit, Epoptes waits until the limit resets (and pauses the clock), then continues. It never works around limits or switches accounts.
- For hard caps per cycle, set `cycle.max_budget_usd` in `goal.json` (Claude Code, and pi, where Epoptes enforces it from pi's estimate). Codex requires `null` and reports token usage without dollar estimates.

## Safety and privacy
- **Local only.** The dashboard binds to `127.0.0.1`. It rejects other hosts (DNS rebinding) and cross-site writes (CSRF), because feedback ends up in agents' prompts. `--lan` is an explicit opt-in with a warning and no login.
- **No telemetry,** no accounts, no keys handled by Epoptes. It runs the `claude`, `codex`, `pi` or `agy` you're already logged into; the CLI's own data settings still apply.
- **Transcripts and logs stay on your machine,** gitignored under `.epoptes/cycles/` and `.epoptes/run/`. So does the brain (`~/.epoptes/brain/`).
- **Outputs open on a separate local origin** (the dashboard's port + 1, read-only): an agent-built page runs normally but can't reach the dashboard's controls. It serves only files inside registered projects, never dotfiles such as `.env` or `.epoptes/`, and it's off in `--lan` mode.
- **Guardrails in every generated harness:**
  - Claude Code's permissions allow/deny list, Codex's native sandbox and rules, Antigravity's own permission rules, or for pi the deny list enforced by the Epoptes guard
  - no `git push`, no history rewrites, no destructive cleans
  - secrets never in goal files (use your secret manager, e.g. the 1Password CLI)
  - an approval list the orchestrator must never act on by itself

  `epoptes run --dry-run` checks these, and warns about anything that looks like a credential.

## Development
```sh
npm test            # node --test: unit tests, runner tests with fake Claude/Codex/pi/agy CLIs, server and report tests
npm run typecheck
npm run build       # dist/ for the npm package (the checkout runs src/ directly)
```
- `src/`: the CLI, runner, adapters (`adapters/`), dashboard and output servers (`ui/`), reports, the importer, time use (`timeuse.ts`) and the brain (`brain.ts`).
- `ui/`: the dashboard (Preact via `htm`, no build step).
- `plugin/`: the shared Claude Code/Codex/pi/Antigravity skill and templates.
- `docs/`: the spec, JSON Schemas and decisions.

Usage notes go in [NOTES.md](NOTES.md), and are triaged into [ROADMAP.md](ROADMAP.md).

## License
[MIT](LICENSE).
