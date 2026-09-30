# Tower Defense: one Codex cycle

Build a polished, playable browser tower defense game within a 15-minute active run. The deliverable is this working directory, examples/tower-defense. Use only native HTML, CSS, JavaScript, Canvas and Node standard libraries. No downloads or dependencies. Work sequentially yourself: role files are guidance, not configured subagents. Read builder instructions when implementing and checker instructions when verifying.

## Rules
- Only write inside this working directory. The parent repository has unrelated uncommitted changes: never modify, stage, restore or commit them. The runner takes shadow snapshots automatically.
- Never git push, rewrite history, git reset --hard, git clean -x, broad process kills, install dependencies or publish. Do not read .env, credentials, SSH/AWS files, or print environment variables. Codex uses workspace-write and disabled approvals; blocked commands cannot be escalated.
- Human approval is needed for spending money, paid services, external writes other than this Codex run, changing the model/time box/done definition, installing dependencies, or deleting unrelated data. Record a blocked task and `epoptes event blocked "needs approval: ..."`, then continue independent work.
- All done checks in goal.json must actually pass. Never mark a smoke test green without running a real browser. Record unavailable checks honestly.
- Keep code simple. Reuse existing code in this deliverable. No abstractions for speculative features. Nontrivial game logic needs a small runnable assert-based test using Node standard libraries. Do not spend time building a framework or a large test harness.
- Target a satisfying complete game: tower placement with clear costs and ranges, enemy waves on a visible path, automatic attacks, money, tower upgrades, remaining lives, clear win/loss, restart, and pause. Distinct tower choices and speed control are welcome only after the basic loop works.
- Visual bar: readable HUD, deliberate colors, clear path/towers/enemies, useful hover/selection feedback, obvious controls, and a responsive layout that fits a laptop. Native buttons must be accessible. A casual player should understand the opening screen without reading source code.

## 1. Orient in at most six tool calls
1. `epoptes clock`; run it again before each work slice.
2. Read `.epoptes/state/handoff.md` and check interrupted files if listed.
3. `epoptes feedback --open`; new feedback outranks optional features. Mark items seen/in_progress/done through the CLI, using stable F-n tasks in the backlog.
4. Read `.epoptes/state/backlog.md`, `.epoptes/state/lessons.md` and `.epoptes/goal.json` (all are small).
Do not read cycle transcripts. Read source only when needed for the selected task.

## 2. Select one round
At most one round per cycle, soft cap 5 minutes. Finish a coherent slice and exit so the next cycle has fresh context. Milestones: M1 playable core by 5 active minutes; M2 tested and polished by 10; M3 browser proof and docs by 13. Keep checking the clock: in wrapup freeze features; in overtime/stop record handoff and finish current verification immediately.

## 3. Implement, verify, record
- Implement 1–3 related backlog tasks yourself. Own only files in this deliverable.
- Verify changed logic with `node test.mjs` once the test exists. Allow at most two repair rounds per failing task, then record the blocker and preserve working code.
- Use an explicit testable game API with deterministic simulation (for example a game.js class/state used by browser UI and test.mjs), without overengineering.
- For browser verification create a small `browser-test.mjs` using only Node standard libraries and existing `/usr/bin/google-chrome`. Preferred approach: spawn headless Chrome with a unique profile under `.epoptes/run`, `--no-sandbox --disable-dev-shm-usage --headless --disable-gpu --allow-file-access-from-files --dump-dom --virtual-time-budget=5000` and a `file://` test URL. A `?test=1` mode can run explicit browser-side assertions, exercise controls and expose PASS/FAIL in a DOM marker. Validate that marker, not just process exit or initial markup. Save a 1440x1000 screenshot using Chrome in a separate invocation. Avoid external browser/network dependencies. `--no-sandbox` is a Chrome container compatibility flag and does not change the Codex workspace sandbox. Use a local ephemeral HTTP server instead if browser module/file restrictions require it. Add timeouts and close only processes you started. If Chrome fails in the Codex sandbox, document the actual failure and leave the browser script runnable for the supervising chat to execute; do not waste repeated cycles on unavailable infrastructure.
- Tick completed tasks and record failed checks honestly. Emit `epoptes event milestone "M1/M2/M3: ..."` once each milestone passes, and `epoptes event artifact <relative-path> "..."` for the game and screenshot.
- Append one fresh row to `.epoptes/state/progress.md`: `| cN | elapsed | tasks | ok/blocked | brief evidence |`.
- Overwrite `.epoptes/state/handoff.md` (at most 25 lines) with existing artifact, runnable commands, check results, unfinished work and next 3 tasks.
- Keep lessons at most 30 lines; add only useful recurring lessons. Record decisions append-only. Do not change goal.json or this time box.
- EXIT after one round even if more remains. Never leave tools or workers running.

## 4. Wrap-up and early finish
Early finish is allowed only after all done checks pass. Run `epoptes event wrapup "all acceptance checks passed"`, rerun final game and browser checks if repairs changed code, write README with `python3 -m http.server 8080` and direct-file launch if supported, review UI against the visual bar, and append scores to `.epoptes/state/scores.jsonl` with `{"cycle":N,"milestone":"M3","scores":{"playability":1,"clarity":1,"visuals":1}}` using honest 1–10 values. A 5 means functional but unclear/unpolished; a 9 means complete, obvious and cohesive. Record any limitations and the final handoff. Then `epoptes event done "playable tower defense; tests and real browser verification passed"`.
When time runs out with failing checks, preserve the playable subset, clearly list unmet checks in handoff, and exit; never emit done unless all checks passed. The runner's hard stop is 15 active minutes with no overtime.

## 5. Feedback and reporting
Dashboard/CLI/chat feedback is accepted throughout. No review pause. Use epoptes events for milestones, blocks and finish; no external notifications. Costs are unknown for Codex; token use is captured by Epoptes.
