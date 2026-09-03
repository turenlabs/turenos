# In-Agent Code Review

When the built-in specialists and subagent tools are available, TurenOS's default guidance lets a parent agent use the
scoped worker, read-only adversarial reviewer, and qualification subagents before reporting completion. Adversarial
review is limited to one pass for changes that touch a concrete high-risk boundary; routine local changes,
documentation, tests, and low-risk refactors skip it. This is an advisory, prompt-driven handoff, not a repository-wide
review service. The intent contract is admitted durably as part of the ordinary child prompt, but there is no dedicated
structured or revision-bound intent record, drift score, review UI, or automatic feedback-to-patch conversion.

For the nonblocking delegation and incremental board protocol used by those
subagents, see [Durable Subagent Workstreams](./subagent-workstreams.md).

## Design

The workflow evaluates a change at two levels:

- **Intent alignment:** compare the behavior present in the changed code with the original requested outcomes and
  constraints. Look for omitted or partially implemented requirements and risky unrequested changes.
- **Risk spotlight:** concentrate review on the changed regions with the greatest behavioral consequence. Prioritize
  correctness and reliability, security, and performance over style, best-practice, or design preferences.

```text
parent gives a bounded assignment
        |
        v
worker edits only granted write roots
        |
        v
worker checks changed code against the assignment
and reports changed files, symbols, and regions
        |
        v
parent sends intent + changed regions or bounded diff
to the read-only adversarial reviewer
        |
        v
reviewer reconstructs behavior, checks alignment,
and reports severity-ordered evidence
        |
        v
parent confirms findings, repairs proven defects,
and delegates exact verification to qualification
```

The writer's plan and implementation summary are useful navigation aids, but they are not evidence that the code has
the claimed behavior. The review is grounded in the supplied changed regions or bounded diff and the current code.

The parent should invoke the reviewer only when the change affects authorization, persistence, concurrency, security
isolation, destructive host behavior, protocol compatibility, or another similarly consequential boundary. Run at
most one adversarial-review task for a parent task and do not automatically review the repairs again. The reviewer may
trace a direct dependency needed to prove or refute a finding, but it must not expand the assignment into a
repository-wide audit.

## Review Bundle

An adversarial-review assignment should contain:

- the original requested outcomes and constraints, kept separate from the implementation narrative;
- the exact changed paths and symbols or regions, or a bounded diff when that is clearer;
- relevant verification evidence and any known unverified boundary;
- the writer's report, clearly identified as a lead rather than the source of intent or correctness.

For example:

```text
Intent contract:
- Preserve one durable request across retries.
- Do not broaden filesystem authority.

Code under review:
- src/request.ts: admitRequest
- src/permission.ts: resolveWriteRoots
- Bounded diff: <only the relevant hunks>

Verification evidence:
- Focused request tests passed.
- Crash recovery was not exercised.

Writer report:
- Added retry reconciliation and retained canonical write-root checks.
```

Passing only file paths is often insufficient for a large or concurrently edited file because the reviewer cannot
reliably attribute pre-existing code to the current change. If changed regions or a bounded diff are unavailable, the
reviewer states that attribution is limited and does not widen the review beyond the supplied change surface.

## Writer Check

Before handoff, the stock built-in `worker` is prompted to:

- treats its bounded assignment as the intent contract;
- judges the implementation from changed code rather than its plan or summary;
- compares the code with every requested outcome and constraint;
- corrects omissions and risky unrequested changes that remain inside its granted scope;
- concentrates on the highest-risk changed regions instead of polishing low-value nits;
- reports changed files and symbols or regions plus unmet requirements, residual risks, and integration dependencies.

Under its stock permissions, the worker cannot run shell commands or delegate. Exact verification remains a separate
qualification task.

## Reviewer Check

The stock built-in `adversarial-review` agent is read-only and evidence-first. It:

- reconstructs the behavior of the code under review before comparing it with the intent contract;
- checks every requested outcome and constraint for omissions or partial implementation;
- flags unrequested work only when it creates concrete risk or review burden;
- triages changed regions by risk, prioritizing correctness, reliability, security, and performance;
- traces relevant state transitions and failure windows involving data loss, authorization, isolation, races, retries,
  cancellation, stranded work, and crash recovery when the changed behavior touches those boundaries;
- retains a finding only when the actual code, repository rules, actionability, and a senior-engineer acceptance bar
  support it;
- returns at most three findings, ordered by severity, and supplies a path, code behavior, and reproducible scenario
  for each one.

Style, best-practice, and design preferences are omitted unless they have a concrete behavioral consequence. If no
defect is confirmed, the reviewer says so and identifies the boundaries it inspected.

## Default Authority

Prompt guidance does not replace tool authority. With the stock built-in definitions and a review task spawned without
write roots:

- a worker can edit only inside the canonical `write_roots` granted when its task is spawned;
- the adversarial reviewer cannot edit, run shell commands, or delegate;
- reviewer output is presented as evidence for the parent, not an automatic approval or patch request;
- default parent guidance says to repair only confirmed findings, not launch a second adversarial pass after repairs,
  and delegate bounded verification to `qualification`.

Agent configuration and plugins can replace a built-in system prompt, mode, or effective permissions. Subagent hard
authority still confines edits to write roots granted at spawn time and qualification shell calls to exact granted
command strings, but those mechanisms do not make an arbitrary configured agent read-only. A qualification command can
also mutate the host filesystem or processes if the exact granted command requests that behavior. Callers must omit
write roots for a read-only review and grant only verification commands whose side effects they intend.

Review output describes only the code that the reviewer inspected. TurenOS does not currently attach a base/head revision
to a review or automatically invalidate it after another write. A later edit can therefore make an earlier result stale;
this workflow does not automatically review repairs again, so the parent must establish final confidence through its own
inspection and bounded qualification.

## Quality Gate

In-agent review and the [quality gate](./quality-gate/README.md) are complementary but separate.

| Provider boundary | Quality ratchet                          | In-agent review                                     |
| ----------------- | ---------------------------------------- | --------------------------------------------------- |
| Trigger           | Automatic after each successful mutation | Advisory parent workflow after a handoff            |
| Input             | Current mutation text                    | Intent, changed regions or diff, code, and evidence |
| Mechanism         | Local deterministic lexical checks       | Existing reviewer in a separate child Session       |
| Focus             | Placeholders, duplication, branching     | Alignment and consequential behavioral defects      |
| Output            | One advisory tool-result note            | Severity-ordered, evidence-backed findings          |
| Provider work     | None                                     | Separate reviewer subagent; one or more model turns |

The ratchet remains quiet and cheap enough to run after every write. Semantic review remains outside the mutation
settlement path because it needs intent, repository context, and model judgment.

## Research Boundary

This workflow borrows prompt-level ideas from [From Code Review to Code Critique: Intent, Drift, and Spotlight for
AI-Generated Diffs at Scale](https://arxiv.org/abs/2607.29516): keep intent separate from the implementation narrative,
compare actual changes with that intent, prioritize consequential regions, and critic-filter low-value findings.

TurenOS does not implement the paper's intent-prediction service, backtranslation and numeric drift pipeline, separate
Spotlight generation and critic calls, taxonomy-mining system, self-attestation UI, or landing policy. The paper's
"self-review" result concerns human authors viewing signals and attesting their diffs; it does not establish that the
same model reliably detects defects in its own writes. This workflow should therefore be treated as a pragmatic review
discipline, not a reproduction of the paper's reported accuracy or safety results.

## Known Limits

- The workflow is advisory and can be unavailable, ignored by the model, disabled, or changed by agent configuration.
  Tests verify the stock prompts and permissions, not defect-detection accuracy.
- Review attribution depends on the parent supplying changed regions or a bounded diff.
- Reviewer and writer models can share blind spots even when they run in separate Sessions.
- The intent contract persists only as ordinary prompt data; there is no dedicated structured intent snapshot, drift
  score, review revision, or production-calibrated recall measurement.
- An empty finding set is not proof that the change is correct.

## Source and Verification

Source:

- [`packages/core/src/plugin/agent.ts`](../packages/core/src/plugin/agent.ts)
- [`packages/core/src/agent/guidance.ts`](../packages/core/src/agent/guidance.ts)
- [`packages/core/src/tool/subagent.ts`](../packages/core/src/tool/subagent.ts)

Tests:

- [`packages/core/test/agent.test.ts`](../packages/core/test/agent.test.ts)
- [`packages/core/test/agent-guidance.test.ts`](../packages/core/test/agent-guidance.test.ts)
- [`packages/core/test/subagent-authority-tools.test.ts`](../packages/core/test/subagent-authority-tools.test.ts)
- [`packages/core/test/permission.test.ts`](../packages/core/test/permission.test.ts)

Run the focused checks from the package directory:

```bash
cd packages/core
bun test test/agent.test.ts test/agent-guidance.test.ts test/subagent-authority-tools.test.ts test/permission.test.ts
bun typecheck
```
