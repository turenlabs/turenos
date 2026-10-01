# Agent improvement proposals

Agents can propose a revised definition for an agent, record the result of a regression check against it, and only
then write it to the workspace. A proposal is durable and cannot be applied until a validation has passed. Applying
writes `.forge/agent/<agent>.md` in the current directory, which future runs load.

## How it works

The three tools ship with the subagent tool set, so they are available wherever an agent can spawn, supervise, or run
as a subagent (`packages/core/src/tool/subagent.ts`).

1. `propose_agent_improvement` takes an agent ID, the proposed replacement definition, a rationale, and failure-trace
   evidence. `AgentImprovement.propose` snapshots the current definition as the baseline and stores a row in
   `agent_improvement_proposal` with status `proposed`, tied to the root session.
2. `adjudicate_agent_improvement` takes a proposal ID, `pass`, and the regression-run output. A passing result moves the
   proposal to `validated`; a failing one moves it to `rejected`. Only a `proposed` proposal can be adjudicated.
3. `apply_agent_improvement` requires `edit` permission for the definition file. Only a `validated` proposal can be
   applied. It becomes `accepted`, and `.forge/agent/<agent>.md` is overwritten with the proposal.

Every status change is a compare-and-set on the row's revision, so a concurrent change fails with a conflict instead of
overwriting. The proposal and adjudication tools also check their own tool permissions, with the agent ID or proposal
ID as the resource.

## Verification

```sh
bun test --cwd packages/core test/tool-subagent-self-improvement.test.ts
```

## Limits

- The regression evidence is whatever the adjudicating agent supplies; TurenOS does not run the regression check itself.
- Nothing requires a different agent or a person to adjudicate. Under the default permissions (the default agent allows
  everything, and _Enforce permission checks_ is off, so `ask` resolves to `allow`), one agent can propose, pass, and
  apply a change to its own definition without a prompt. Deny `apply_agent_improvement` or turn on enforcement to
  require review.
- Applying replaces the whole definition file; there is no merge with edits made after the baseline was taken.
- In a Lobby session with the default `workspace` profile, `apply_agent_improvement` is denied (see [Lobby](./lobby.md)).

## Source

- [`packages/core/src/agent/improvement.ts`](../../packages/core/src/agent/improvement.ts)
- [`packages/core/src/agent/improvement.sql.ts`](../../packages/core/src/agent/improvement.sql.ts)
- [`packages/core/src/tool/agent-improvement.ts`](../../packages/core/src/tool/agent-improvement.ts)
- [`packages/schema/src/agent-improvement.ts`](../../packages/schema/src/agent-improvement.ts)
- Tests: [`packages/core/test/tool-subagent-self-improvement.test.ts`](../../packages/core/test/tool-subagent-self-improvement.test.ts)
