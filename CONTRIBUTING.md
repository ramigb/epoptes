# Contributing to Epoptes

Thank you for wanting to help make Epoptes better! Contributions are welcome from **both technical and non-technical people** — Epoptes is shaped just as much by real-world usage, clear communication, and good UX as by TypeScript code.

---

## Ways to Contribute (Non-Technical)

You don't need to write a single line of code to make a big impact:

1. **Share real-world run reports & friction notes**
   - Try running Epoptes on a real goal (writing, research, data cleanup, or code) and open an issue describing what confused you, what felt noisy, or where the dashboard didn't tell you what you needed to know.
   - Screenshot-annotated UX feedback (e.g. "I couldn't tell which milestone was waiting on me") is gold.
2. **Improve documentation & examples**
   - Spot jargon in the [Glossary](docs/glossary.md), [README](README.md), or [Examples](docs/examples.md)? Open a PR or issue suggesting clearer wording.
   - Contribute new example goals (writing, research, planning, data) so people can see Epoptes beyond software projects.
3. **Improve human-facing copy & prompts**
   - Review the messages Epoptes shows in the dashboard or the instructions in `plugin/skills/epoptes/templates/loop.md` to make agent-to-human updates clearer and more digestible.
4. **Triage & test**
   - Reproduce bugs reported in Issues, test new features on macOS / Linux / WSL2, and share what worked or broke.

---

## Ways to Contribute (Technical)

### Prerequisites
- **Node.js >= 22.18** (Epoptes runs TypeScript directly via Node's built-in type stripping, with zero runtime bundler)
- **Git**

### Local Setup

```sh
git clone https://github.com/ramigb/epoptes.git
cd epoptes
npm install
npm link          # puts `epoptes` on your PATH, running src/ directly
```

### Everyday Development Commands

```sh
npm run typecheck # strict TypeScript check (tsc --noEmit)
npm test          # runs all unit, adapter, runner, server and report tests (uses fake CLIs, no API tokens spent)
npm run build     # builds dist/ for packaging
```

### Codebase Map

| Path | What lives there |
|---|---|
| `src/runner.ts` | Detached per-goal cycle loop, signals, timeouts, hooks |
| `src/board.ts` | Append-only kanban board (`board.jsonl`), milestones, ingest |
| `src/control.ts` | Shared start/pause/stop/steer/extend/approval controls |
| `src/timeuse.ts` | Phase, role, tool, and grouped command time analysis |
| `src/summary.ts` | Humanized general status, milestone pace projections, outputs |
| `src/adapters/` | `claude-code`, `codex`, `pi`, and `antigravity` CLI adapters |
| `src/ui/` | Local HTTP/SSE dashboard server and read-only output server |
| `ui/` | Preact + `htm` dashboard (`app.js`, `style.css`, `index.html`, no build step) |
| `plugin/skills/epoptes/` | Shared skill instructions, interview guide, guardrails, and templates |
| `docs/schemas/` | JSON Schemas for every `.epoptes/` file |
| `test/` | Node test runner suites with fake CLIs and recorded stream fixtures |

### Design Principles to Follow
- **The file format is the contract:** Any new field in `.epoptes/*.json` or `*.jsonl` must be added to `docs/schemas/` and stay backwards-compatible with existing goals.
- **Zero-token observability:** Dashboard views, time tables, and reports should derive from recorded files without extra LLM calls.
- **Minimal dependencies:** Prefer Node built-ins over new npm packages.
- **Test with fake CLIs:** Never require live API keys or network calls in `npm test`.
- **Keep human communication clear:** Separate terse agent-to-agent instructions from plain, digestible user-facing text.

### Submitting a Pull Request
1. Fork the repo and create a focused branch (`git checkout -b fix/milestone-pause-badge`).
2. Make your changes and add/update tests in `test/`.
3. Run `npm run typecheck && npm test` and make sure everything passes cleanly.
4. Open a PR with a short summary of **what changed**, **why**, and (for UI changes) a quick screenshot.
