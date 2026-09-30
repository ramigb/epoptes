# Epoptes as a companion to coding agents

Research and proposed action plan · 30 September 2026

## Recommendation

Epoptes should help a person delegate a long task and return to trustworthy results. Its strongest product promise is:

**Know what the agent is doing, whether it is making verified progress, what that progress costs, and when your intervention matters.**

The three proposed areas—visibility, a complete run history, and economic efficiency—reinforce each other. Reliable records make progress measurable; verified progress makes economics meaningful; actionable monitoring lets the human improve both.

Prioritize independent verification, a durable record of each cycle, and compact interfaces for agents. Then add progress-aware alerts and budgets. Test observe-only adoption before building richer orchestration.

This report distinguishes current implementation, external evidence, and product hypotheses. It examines the working checkout, including uncommitted Codex support, rather than assuming every feature is in the published package. It does not start a harness, invoke paid agent runs, or change the existing roadmap. Implementation findings are from source inspection, not a fresh runtime certification. Effort estimates and success targets below are proposals.

## 1. What exists today

| Area | Implemented in this checkout | Important limit |
|---|---|---|
| Execution | Detached runner; fresh Claude Code or Codex cycles; time box; wrap-up; cooldown and rate-limit backoff | A successful CLI exit says the cycle ran successfully, not that the goal is correct |
| Visibility | Local dashboard; SSE updates; tool/file activity; Claude subagent activity; cycle timeline; heartbeat | Normalized activity is a short summary, not a complete causal trace |
| Steering | Start/resume, pause after cycle, stop now, extend, feedback with status history | Feedback receipt and agent acknowledgement are different; prompt-based polling does not guarantee immediate application |
| History | Events, feedback operations, raw streams, stderr, cycle results, state files, reports | Configuration and memory can change; past reports read some current state rather than reconstructing a historical run |
| Recovery | Crash reconciliation; interrupted-cycle recovery instructions; git or shadow checkpoints | Restart means a new agent inspecting files, not exact replay or exactly-once execution |
| Economics | Token/cache counts by model; cycle costs; Claude API-equivalent subscription estimates; cycle outlier flags | No outcome-normalized economics, run-wide budget, or reliable live dollar ceiling across providers |
| Quality | Declared done checks; checker/reviewer instructions; optional score records | Runner does not independently execute `done[].verify` before accepting DONE |
| Guardrails | Harness interview and sign-off; dry-run lint; CLI permissions/sandbox; local web protections | Natural-language approval lists and round limits are instructions, not universally enforced policy |
| Agent access | Skill, CLI, compact `clock`, open feedback, semantic events | Human-oriented `status`; no dedicated versioned JSON status contract or bounded event query |

Source anchors: [skill](../plugin/skills/epoptes/SKILL.md), [spec](spec.md), [runner](../src/runner.ts), [adapter contract](../src/adapters/types.ts), [Claude parser](../src/adapters/claude-code.ts), [Codex parser](../src/adapters/codex.ts), [report builder](../src/report.ts), [dashboard views](../src/ui/views.ts), [status/reconciliation](../src/status.ts), [current roadmap](../ROADMAP.md).

Two concrete details matter for the plan:

- `src/runner.ts` accepts the DONE marker without running the declared checks. State caps produce warnings; they do not bound prompt tokens. The three-round limit is in the generated loop instructions.
- `src/report.ts` aggregates recorded results, but loads the current goal, backlog, and feedback. Git commits are selected by time, which does not prove the agent authored them. `src/status.ts` checks PID existence when reconciling; a stale heartbeat alone does not make a live PID unhealthy, despite the stricter liveness description in the spec.

These are opportunities to strengthen guarantees, not reasons to replace the architecture.

## 2. What external evidence says

### Persistent handoffs are valuable; context resets need evaluation

Anthropic's November 2025 harness work uses incremental tasks, persistent progress, and clean handoffs to bridge sessions. That supports Epoptes' existing files and cycle boundaries. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

Later experiments separate generation from evaluation and describe removing context resets for a model that no longer needed them. Resets can add orientation overhead and latency. Epoptes should benchmark fresh cycles against supported continuation/compaction before introducing another context strategy. Neither approach is universally superior. [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps).

Anthropic's Managed Agents work also argues that harness assumptions age as models improve. Stable session, execution, and environment boundaries are a better foundation than permanent model-specific tricks. For Epoptes, preserve the file contract while making cycle policy something that can be evaluated. [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents).

### Evaluate the outcome, not just the transcript

Anthropic's evaluation guidance distinguishes the agent's statements from the resulting environment. Deterministic graders, calibrated subjective evaluation, and multiple trials serve different purposes. Epoptes can apply this immediately: a completion claim should link to fresh evidence, while subjective and manual requirements remain explicit. [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

### Observability platforms provide patterns, not a reason to rebuild them

Langfuse organizes steps into traces and sessions, and tracks usage and cost with explicit model definitions. Phoenix connects tracing to evaluations and experiments. Their useful lesson is to correlate execution, outcome, and configuration. Epoptes can export to these systems later instead of duplicating a general prompt platform. [Langfuse trace structure](https://langfuse.com/docs/observability/best-practices), [Langfuse cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking), [Phoenix overview](https://arize.com/docs/phoenix/quickstart).

OpenTelemetry's GenAI attributes include agent/workflow operations, conversation identity, and usage fields, with evolving conventions and warnings about sensitive content. Align an optional exporter with a pinned convention version; keep the internal contract independent. The former agent-spans page now redirects readers to a separate GenAI repository. [GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/), [current GenAI conventions repository](https://github.com/open-telemetry/semantic-conventions-genai).

### Native provider telemetry can improve fidelity

Claude Code documents opt-in telemetry with nested interaction, model, tool, and subagent spans, including execution and permission-wait timing. Some detail requires additional tracing settings. Prefer native evidence when available, while keeping the current stream parser as the baseline. [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage).

Codex documents JSONL lifecycle/item events and structured final output. Its App Server provides active-turn steering and interruption; OpenTelemetry export is separately configurable and disabled by default. These are different integration surfaces: improve `codex exec` first, then prototype App Server only if measured feedback latency justifies it. Do not infer billing, actual model identity, or quotas from fields the integration did not observe. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive), [Codex App Server](https://developers.openai.com/codex/app-server), [Codex telemetry configuration](https://developers.openai.com/codex/config-advanced).

## 3. Expand visibility into supervision

The dashboard should answer five questions without requiring a transcript:

1. What is the current task, and why is it being worked on?
2. What was last verified, and on which workspace revision?
3. Is the process alive, is activity arriving, and is useful progress happening?
4. What resources have been consumed, and what is known about the remainder?
5. What can I do now, and when will that action take effect?

Use three separate signals: **runner health**, **agent/tool activity**, and **verified outcome progress**. A heartbeat is not evidence of progress; a quiet stream may be a legitimate build or model call. Display the last evidence and its age, plus an explicit unknown state.

Add a small attention queue: missing/stale verification, repeated failures, unacknowledged feedback, declared blocks, and budget boundaries. Each entry needs evidence, an age, and a useful action. Deduplicate repeated alerts and notify on meaningful transitions, not every poll. Keep milestones as optional notifications and provide a return-to-work digest.

For suspected stalls, start with transparent rules at cycle boundaries. For example, two cycles with no new verified milestone and a recurring failure can produce a warning. Do not automatically kill an active task merely because files or tool events were quiet. Expose the rule, supporting cycles, and an override.

Make steering latency visible: received → acknowledged → applied → verified. Show whether feedback waits for a poll, the next cycle, or is supported by active-turn steering. Offer pause after cycle when immediate steering is unavailable.

**Desired experience:** “The runner is healthy. D2 still fails on this revision. The same failure occurred in two cycles. F-4 is queued for the next cycle. Pause, review evidence, or let it continue.”

## 4. Expand `.epoptes` into a trustworthy run record

Preserve three layers:

| Layer | Purpose | Retention |
|---|---|---|
| Run manifest and normalized records | Historical configuration, lifecycle, usage, verification, feedback, controls | Durable; sufficient for reports |
| Checkpoints and artifacts | Inspect what actually changed and what can be handed off | User-configured; exclude sensitive/unrelated material |
| Raw provider stream and stderr | Diagnose parser gaps and provider behavior | Optional, bounded, with explicit completeness status |

At cycle start capture the resolved goal, prompt and role content or immutable references, permission settings, Epoptes/CLI version, configured model and effort, workspace baseline, and state inputs. Record configuration changes between cycles. A configured model must remain distinct from an observed model. Hashes detect change but cannot recover deleted content; small configuration snapshots should accompany hashes.

At cycle end capture checkpoint references, changed paths, task/milestone deltas, fresh checks, and handoff state. For old runs without this data, label historical detail unavailable rather than projecting today's backlog backward.

Extend normalized activity with optional source item/call IDs, parent IDs, start/end, duration, status, and exit code. Preserve unknown and unpaired events. The Codex parser currently summarizes command starts without retaining command-completion details in normalized activity; the Claude parser summarizes tool uses without a complete result pairing. Improve each according to observed provider fields.

Support bounded search by run, cycle, task, path, tool, failure, and feedback. Paginate history instead of returning only a trailing slice as though it were complete. Separate deterministic timeline reconstruction from execution replay: a checkpoint and transcript cannot safely reproduce arbitrary external side effects.

Before a shareable export, provide a preview and selective redaction. Apply retention only to closed cycles; preserve manifests/results/checks, label missing raw detail, and use atomic writes. Gitignored logs are still sensitive local data. Explicitly define snapshot excludes, symlink handling, large-file limits, and credential exclusions.

## 5. Expand economics into efficiency with a quality bar

Use resource accounting and outcomes together. Maintain three distinct concepts:

- **Reported monetary usage:** provider-reported cost, with its documented basis.
- **API-equivalent estimate:** tokens multiplied by known model/pricing rates; not a subscription bill.
- **Unknown:** unavailable model, price, usage, or provider detail; never zero.

If a total mixes known and unknown costs, keep the total unknown and optionally show a clearly labelled known subtotal and coverage. Subscription quotas and API-equivalent dollars should not be converted into each other.

Add run-wide limits in stages: elapsed time and cycle count first, observed token limits next, known-cost limits where supported. Evaluate totals across resume operations using the run ID. Preserve provider per-cycle caps; don't claim that a boundary check caps in-flight spending. Live enforcement requires live usage plus an interrupt policy and still needs an overshoot allowance. Codex usage arriving at turn completion supports a next-cycle gate, not a precise in-flight token ceiling.

Useful economic measures:

| Measure | Definition and limit |
|---|---|
| Cost per accepted milestone | Resource cost through acceptance / accepted milestones within the same task suite; not comparable across arbitrary milestone sizes |
| Tokens per accepted task | Total observed input/cache/output tokens / accepted tasks; cache categories remain visible |
| Rework burden | Recorded time/tokens/cost in explicitly tagged repair attempts; untagged work remains unattributed |
| Human intervention | Active review/steering minutes and meaningful interventions; do not equate fewer interventions with better outcomes |
| Time to trustworthy handoff | Wall time until required checks and handoff are accepted, including waits |
| Orientation overhead | Observed reads/time before task start; approximate unless provider call-level usage supports attribution |
| Quality | Fixed acceptance suite, regression checks, and calibrated human/rubric review |

A business-value scenario can estimate `manual hours avoided × chosen hourly value − agent resource cost − supervision/rework cost`. Show assumptions and ranges; this is a scenario, not measured ROI. Compare completion quality and review effort before calling a run economical.

Start optimization with deterministic checks outside model calls, smaller orientation reads, bounded retry loops, and explicit scope. Measure reviewer frequency, model/effort selection, worker reuse, and reset policy in controlled trials. Avoid automatic model changes until the user has authorized a policy and quality is protected. High cache share, low output tokens, and low cycle cost are diagnostic signals, not success metrics.

## 6. Additional opportunities

| Opportunity | Smallest useful version | Why it matters | Priority |
|---|---|---|---|
| Agent-readable companion | Versioned `status --json`, bounded events, check results, structured blocks | Agents can diagnose and steer runs without expensive transcript reads | High |
| Verification and handoff | Acceptance evidence plus changed files, unresolved checks, checkpoint and next steps | Makes delegated work reviewable | High |
| Experiment ledger | Compare fixed tasks across harness/prompt/model versions | Turns usage history into improvement evidence | Medium |
| Observe-only adoption | Explicitly ingest one supported CLI stream or session export without owning execution | Lets people keep their preferred harness | Prototype after core fidelity |
| Multi-goal oversight | Attention queue across goals; warn on overlapping workspaces and shared quota pressure | Prevents interference and helps allocate human attention | Medium |
| Budget allocation | Simple maximum concurrent goals and user priority | Helps where concurrent runs compete; no general scheduler yet | Conditional |
| Reusable memory | Promote a reviewed lesson into the next harness | Avoids recurring errors without unbounded memory | Later |
| Interoperability | Explicit normalized JSON/OTel export to an existing platform | Reuses established analysis tools | Later |

Observe-only mode needs an explicit capability table: observation does not automatically confer pause, interrupt, feedback, or approval control. Never discover and ingest unrelated private sessions automatically. A skill improves agent behavior but is not telemetry plumbing.

Structured approval requests should describe the proposed action and evidence, preserve pending state, and pause dependent work. Native sandbox/hook enforcement remains responsible for blocking tool execution; an approval inbox alone cannot enforce arbitrary natural-language restrictions.

For code handoff, prepare a local review bundle before adding PR automation. For subjective outputs, record rubric versions and reviewer evidence. For manual checks, show “awaiting acceptance” rather than letting the model approve its own result.

## 7. Positioning and scope

| Category | Existing strength | Epoptes' proposed focus |
|---|---|---|
| CLI/IDE agents | Execute and edit within their native harness | Long-run continuity, return-to-work summary, cross-cycle evidence |
| Langfuse/Phoenix | Tracing, evaluation, experimentation | Local CLI delegation with controls and workspace checkpoints |
| Durable workflow frameworks | State persistence and resumable steps | Coarse agent cycles without requiring workflow rewrites |
| Hosted agent services | Managed execution infrastructure | User-owned local files and installed agent CLIs |

LangGraph provides persisted checkpoints and interrupt/resume primitives, but resumption and side effects still require careful execution semantics. Epoptes can adopt the principle of explicit recovery boundaries without promising equivalent durable execution or introducing a graph runtime. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

This positioning is a hypothesis to validate with users. The source review establishes technical overlap, not market demand or a competitive moat. Ask users to demonstrate their last long run, how they judged completion, when they intervened, and what their existing tool failed to show.

Preserve local-first storage, the file contract, no mandatory daemon, and zero model calls for routine monitoring. Defer hosted accounts, team billing, arbitrary plugin systems, vector memory, automatic model routing, and a workflow language until concrete usage requires them.

## 8. Sequenced action plan

Assume one maintainer. Effort ranges are working-day estimates excluding paid experiment duration, user availability, and provider-specific surprises. Release after each useful slice; do not wait for the whole plan.

### Phase 0 — Establish evidence and boundaries (2–3 days)

- Create a capability matrix for the current Claude and Codex integrations: observed events, usage availability, cost basis, model identity, sandbox, steering, and control latency.
- Inspect a small explicitly selected set of existing runs; interview 3–5 users about real delegation and review failures. Keep transcripts private and findings anonymous.
- Define 6–10 reproducible acceptance tasks: bug fix, multi-file feature, research/data work, feedback change, rate-limit recovery, interrupted work, false DONE, and no-progress loop. Separate deterministic fake-CLI cases from live quality trials.
- Record baseline outcomes, resource usage, wall time, review effort, and setup friction. Existing README/roadmap examples are historical observations, not a controlled baseline.

**Exit:** agreed success criteria, versioned task inputs, provider limits documented, and a baseline template. No improvement percentages claimed yet.

### Phase 1 — Make completion credible (4–6 days)

- Reuse `done[].verify`: runner executes explicitly configured command/file checks after the agent exits and before honoring DONE. Require a timeout, bounded output, workspace revision and config fingerprint.
- Execute checks under a documented restricted permission boundary; never give runner-side shell checks more authority than the agreed harness. Treat checks as untrusted code, not intrinsically safe read operations.
- Preserve agent/manual checks as separate evidence or pending acceptance. File existence only proves existence; stronger content checks remain user-defined.
- Snapshot effective cycle configuration and workspace baseline; persist verification and checkpoint references. Protect immutable acceptance configuration from unnoticed changes during a run.
- Expose “agent claims complete,” “checks passed,” and “awaiting acceptance” distinctly in CLI/dashboard/report.

**Likely touch points:** runner, goal/schema, paths, events, reports, dashboard views, fake-CLI runner tests. Add only the minimal check records and manifest needed.

**Exit:** false DONE cannot bypass failing or pending requirements; stale check evidence is rejected; timeout/interruption remain explicit; old records still render; report evidence points at the checked revision.

### Phase 2 — Make history usable by people and agents (4–6 days)

- Extend adapter activity with source IDs, completion status and timing where supported. Add parser fixtures for failed tools, unpaired starts, unknown events and truncated streams.
- Add versioned `status --json` and bounded event/history queries. Reuse existing summary builders; read-only access must not start runs. Preserve existing CLI behavior.
- Show cycle delta, verification, checkpoint, blockers and pending feedback in a compact digest. Use historical manifests for historical views.
- Add cursor-based history browsing and opt-in sanitized export/closed-cycle retention. Large logs must not be loaded in full for routine views.

**Likely touch points:** adapter types/parsers, summary/CLI, UI views/server/tails, report, JSON Schemas and skill reference.

**Exit:** an agent can identify the last failed check and next task without raw transcripts; tool failures survive normalization; historical views don't change when today's goal/backlog changes; retention preserves summary evidence.

### Phase 3 — Add attention and economic controls (4–7 days)

- Display separate runner/activity/progress ages and reconcile stale heartbeat behavior with the documented contract.
- Add deduplicated attention rules with evidence and configurable thresholds; start in warning mode. Add feedback acknowledgement age and expected effect boundary.
- Enforce run-wide cycle/time/observed-usage limits at safe boundaries, with explicit unknown and overshoot behavior. Reserve configured time/resources for wrap-up where measurable.
- Add outcome/resource measures and cost coverage to reports. Keep a known subtotal separate from unknown totals.

**Exit:** repeated failures create one actionable alert; legitimate quiet tools do not trigger stop; run limits survive pause/resume; missing usage never becomes free usage; the UI states whether current-cycle spending is observable.

### Phase 4 — Prove improvements and broaden adoption (5–8 days plus trials)

- Run paired, repeated trials on unchanged task inputs and base revisions; vary one policy at a time. Fix CLI/model versions where possible, record actual observed versions, and identify cache/environment effects.
- Evaluate deterministic checks vs model-mediated checking, reviewer cadence, model/effort policy, and fresh vs supported continuation contexts. Continue only improvements that preserve quality.
- Prototype one observe-only input. Measure setup time and lost fidelity. If passive monitoring solves users' needs, do not force them into Epoptes-owned cycles.
- Prototype Codex App Server steering only if queued feedback latency is a demonstrated issue. Keep it optional and capability-specific.
- Export to an existing observability system only when a pilot user needs it; start with normalized JSON before an always-on collector.

**Exit:** publish task-level outcomes, failed trials, resource coverage and limitations; choose the next feature from observed user value. No savings claim based on one successful run.

### Ordered implementation backlog

| ID | Deliverable | Dependency | Acceptance |
|---|---|---|---|
| R1 | Baseline task suite and provider matrix | None | Reproducible inputs; unknown capabilities labelled |
| R2 | Restricted deterministic verification | R1 | False/stale DONE rejected; pending manual checks preserved |
| R3 | Cycle manifest and evidence references | R1; supports R2 | Old/current state distinguished; inputs recoverable |
| R4 | Tool lifecycle normalization | R1 | Failure/duration retained when emitted |
| R5 | JSON status and bounded history | R2–R4 | Stable version; cursor; no transcript orientation |
| R6 | Trustworthy dashboard/report digest | R2–R5 | Progress tied to fresh evidence and checkpoint |
| R7 | Retention and sanitized export | R3–R5 | Closed cycles only; completeness explicit |
| R8 | Attention and feedback latency | R4–R6 | Deduplicated alert; delivery boundary visible |
| R9 | Run budgets and outcome economics | R2–R6 | Resume-safe totals; unknown/overshoot explicit |
| R10 | Paired policy experiments | R1, R9 | Quality bar preserved; repeated results reported |
| R11 | Observe-only pilot | R4–R7 | Read-only capabilities clear; setup measured |
| R12 | Optional live steering/export | Pilot evidence | Ship only for demonstrated demand |

## 9. How to decide whether this worked

Primary outcome: **more tasks reach accepted completion within their agreed limits, with less human supervision and no quality regression.**

Suggested pilot gates, not established performance claims:

- All deterministic false-DONE and stale-evidence fixtures are caught.
- At least 4 of 5 pilot users can identify the current task, latest evidence, and required action within 30 seconds.
- At least 90% of reviewed alerts are actionable; report sample size and missed incidents as well as precision.
- Lower median cost or tokens per accepted task, with unchanged acceptance requirements and no observed regression; show distributions and failures. A small pilot supports a direction, not statistical certainty.
- Reduced median review/steering time and feedback acknowledgement delay, measured separately from agent runtime.
- Restart tests cover interruption during writes/tools, missing results, orphan children, stale PID/heartbeat, and rate-limit waits. Distinguish recoverable local work from external actions that need human reconciliation.

Monitoring must remain useful with unknown dollar costs, missing provider events, a closed dashboard, and no model calls. A failing agent should leave better evidence, not just a longer log.

The next implementation slice should be **R2 plus the minimal R3 evidence needed to support it**: independently verified completion and a recorded revision/configuration. That creates the foundation for trustworthy monitoring, historical reports, and economic optimization.
