# Examples of Usage

Practical, end-to-end recipes for common Epoptes workflows.

---

## 1. Try the 15-Minute Glossary Example

The fastest way to see Epoptes end-to-end (costs well under $1 in API-equivalent usage):

```sh
cp -r examples/glossary /tmp/glossary
epoptes add /tmp/glossary
epoptes run glossary --dry-run   # verify setup without starting the clock
epoptes ui                       # open http://127.0.0.1:4747
epoptes start glossary           # or press Start in the dashboard
```

---

## 2. Build a New Harness Interactively

Install the skill for your preferred agent CLI:

```sh
epoptes skill install                    # Claude Code (default)
epoptes skill install --agent codex      # Codex
epoptes skill install --agent pi         # pi
epoptes skill install --agent antigravity # Antigravity (agy)
```

Then open your agent in your project folder and say:

> Use the epoptes skill to build a harness for building a CLI tool that converts OpenAPI specs into typed TypeScript clients, with full test coverage and a 3-hour time box.

The skill will interview you, consult your local brain (`~/.epoptes/brain/`), show a one-screen sign-off summary, generate `.epoptes/`, validate with `epoptes run --dry-run`, and register the goal.

---

## 3. Steer, Comment, and Pause While a Run Is Live

```sh
# Check status at a glance
epoptes status my-goal

# Add a non-urgent task to the backlog (picked up next cycle)
epoptes feedback my-goal "Support YAML input files in addition to JSON"

# Comment on a specific card (the agent acts on it or asks to clarify)
epoptes card C-7 comment "Keep the generated types in a single file"

# Change direction immediately (interrupts current cycle and replans)
epoptes feedback my-goal "Switch from Axios to native fetch" --steer

# Pause cleanly after the current task/round finishes (quicker than full cycle)
epoptes pause my-goal

# Or wait for the entire current cycle to finish before pausing
epoptes pause my-goal --after-cycle

# Give the run more time
epoptes extend my-goal 1h
```

---

## 4. Label Milestones Clearly for Humans

Agents can refer to milestones as `M1`, `M2` internally, while you see clear labels and descriptions in the **Milestones** tab:

```sh
epoptes milestone add M1 "Core parser" --desc "Reads OpenAPI 3.1 JSON/YAML into an internal AST with unit tests" --target 1:00
epoptes milestone add M2 "Client generator" --desc "Emits typed fetch functions and request/response interfaces" --target 2:15
epoptes milestone my-goal
```

---

## 5. Customize Cycle Timeouts and Lifecycle Hooks

You can configure cycle timing and hooks in the dashboard (**Setup → Cycle customization & hooks**) or directly in `.epoptes/goal.json`:

```json
{
  "cycle": {
    "timeout_min": 45,
    "pause_between_s": 10,
    "max_budget_usd": 3.0
  },
  "hooks": {
    "onStart": "echo \"Starting cycle $EPOPTES_CYCLE ($EPOPTES_MODE)\" >> .epoptes/hooks.log",
    "onEnd": "npm test -- --reporter=dot || true",
    "onPause": "notify-send \"Epoptes\" \"$EPOPTES_GOAL_ID paused ($EPOPTES_END_REASON)\"",
    "onStop": "./scripts/stop-dev-services.sh"
  }
}
```

Hooks run in the project directory with `EPOPTES_HOOK`, `EPOPTES_GOAL_ID`, `EPOPTES_GOAL_DIR`, `EPOPTES_RUN`, `EPOPTES_CYCLE`, and `EPOPTES_MODE` set (plus `EPOPTES_CYCLE_EXIT` / `EPOPTES_CYCLE_DURATION_S` on `onEnd`, and `EPOPTES_END_REASON` on `onPause` / `onStop`).

---

## 6. Follow Up on a Finished Goal (Quick Tweaks)

After a goal reaches `DONE`, add feedback or comment on a card, then run a lightweight follow-up (no time box):

```sh
epoptes feedback my-goal "Make the error messages include the line number"
epoptes start my-goal --follow-up
```

Small tweaks are fixed in place; anything that requires a redesign is flagged `needs a new run` for your decision.

---

## 7. Start a Next Feature in the Same Project (Jobs)

Don't create a second harness for the same repo. Start a new **job** to archive the previous job's working state while keeping your roles, permissions, lessons, and decisions:

```sh
epoptes job new "Add OAuth2 auth support"
```

Or simply ask the Epoptes skill in chat: *"Start a new Epoptes job for adding OAuth2 auth support."*

---

## 8. Generate Reports & Review the Brain

```sh
# Generate Markdown + HTML report for the current job
epoptes report my-goal

# Report across all jobs in a harness, or all registered goals
epoptes report my-goal --job all
epoptes report --all

# Refresh and inspect lessons learned across all your runs
epoptes brain
epoptes brain lessons --kind code
```
