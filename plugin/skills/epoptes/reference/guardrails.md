# Guardrails (every generated harness)

## Permissions
Claude Code cycles run with `--permission-mode auto` (or what `goal.json` says) and `--permission-prompts none`, so any tool call that isn't allowed is denied without asking. `templates/settings.json` is the baseline:
- **Never remove its deny rules.**
- Add allow rules for the goal kind. Keep them as narrow as possible.

| kind | add to `allow` |
|---|---|
| code | `Bash(npm *)`, `Bash(npx *)`, `Bash(node *)`, or the project's own runner (`pnpm`, `cargo`, `pytest`, `make` …); `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git restore *)`, `Bash(git stash push *)`, `Bash(git tag *)` |
| research | `WebSearch`, `WebFetch` |
| content | usually nothing |
| data | `Bash(python *)`, `Bash(python3 *)`, `Bash(duckdb *)`, or the project's own tools |

Epoptes adds `Bash(epoptes *)` to every cycle's allow list itself.

### Codex
Set `adapter.type` to `codex` and `permission_mode` to `workspace-write` (or `read-only` for inspection). The adapter sets `approval_policy="never"`, so commands needing escalation fail instead of waiting for a human. Codex does not read .epoptes/settings.json or enforce its Claude allow/deny syntax: omit that file and keep command restrictions in native Codex rules and loop.md. Do not claim prompt instructions enforce filesystem secrecy; use native policy for read denials. Never select danger-full-access without explicit user consent. Set max_budget_usd to null.

## Git
- Never `git push`, rewrite history (`rebase`, `reset --hard`, `commit --amend`, `filter-branch`, force anything), or clean destructively (`git clean -fdx`, `git stash -a`). These are in the deny list, and `loop.md` repeats them.
- Reverting a failed task means `git restore -- <its paths>` and `git clean -fd -- <its new paths>`. Never `-x`.
- Kill processes by pid (`pgrep -af …` then `kill <pid>`), never `pkill -f <pattern>`: the pattern matches the shell running the command and kills it.
- A 0-byte `.git/index.lock` with no git process running was left by a killed worker. Remove it, then commit.

## Secrets
- Secrets never go in `goal.json`, `loop.md`, role files, state files, feedback or briefs. `epoptes run --dry-run` warns when a file looks like it contains one.
- When a goal needs credentials, point at the user's secret manager (for example the 1Password CLI, `op read op://…`, or its MCP server) and add only the narrow allow rule for it. Better still, have the human provide the value at run time through the environment.
- Tell workers not to print environment variables or read `.env` files, `~/.ssh`, `~/.aws` or similar. The baseline deny list blocks the common paths.

## Approval list
Every item in `goal.json` `approval_required` is copied into `loop.md` §Rules. The orchestrator never does these. It runs `epoptes approval "<what>" --ref <task>`, marks the task `[blocked: needs approval F-<n>]`, and continues with other work. The human answers with Approve / Disapprove; the next cycle sees APPROVED or REJECTED in `epoptes feedback --open`. When nothing else can move, it runs `epoptes wait-for-human "<what>"`.

## Data stays local
Cycle transcripts and logs (`.epoptes/cycles/`, `run/`) can contain confidential material. They're gitignored and never leave the machine. Don't tell workers to upload, paste or post them anywhere.
