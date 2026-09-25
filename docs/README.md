# TurenOS engineering documentation

This directory contains source-grounded engineering notes for TurenOS. Start with the architecture overview and the
systems catalog when you need the current product vocabulary, package/runtime model, or subsystem ownership. Pages are
grouped by section: whole-system [architecture](./architecture/README.md), individual [systems](./systems/README.md),
model [providers](./providers/README.md), [operations](./operations/README.md), and [experimental](./experimental/README.md)
work.

The rebrand changes product-facing prose to TurenOS. Technical identifiers remain exact: do not rename `FORGE_*`,
`.forge` paths, `forge` commands, package or namespace identifiers containing `forge`, URLs, serialized values, or
materially accurate historical findings. The [Branding](./architecture/branding.md) page is the reference when prose
and code appear together.

## Architecture

- [Architecture](./architecture/README.md): package and process topology, runtime and data-flow graphs, Location and
  trust boundaries, generated artifacts, and operational constraints.
- [Branding](./architecture/branding.md): TurenOS naming policy, Turen Labs company naming, and retained Forge
  compatibility seams.
- The Desktop's interactive [`/home/system-map`](../packages/app/src/pages/system-map.tsx) view: source-linked traces
  for prompt admission, tool settlement, live projection, and subagent work.

## Systems

The [systems catalog](./systems/README.md) lists every system and subsystem with its responsibilities, inputs and
outputs, ownership, failure behavior, and implementation links. These systems have their own pages:

- Agents and sessions
  - [Durable subagent workstreams](./systems/subagent-workstreams.md): nonblocking V2 delegation, shared-board
    updates, delivery/recovery semantics, tool availability, and verification.
  - [Swarm orchestration](./systems/swarm.md): `@swarm` investigations with a bounded worker budget, planning and
    authority rules, and evidence-based synthesis.
  - [Session whiteboard](./systems/whiteboard.md): the shared Excalidraw board per session, its merge rules, agent
    tools, and limits.
  - [Memory](./systems/memory.md): durable project memory, native agent tools, SQLite storage, and optional local
    Potion hybrid retrieval.
  - [Automations](./systems/automations/README.md): durable in-app workflows, reusable blueprints, ordered Agent and
    Skill steps, and TurenOS delivery, including interval/cron schedules, per-step `when`/`onFailure` conditions, and
    local file-change/session-end event triggers. [Automations internals](./systems/automations/internals.md) covers
    the scheduler, lease model, SQLite persistence, and local HTTP surface; event triggers fire via core-local
    `fireEvent`, and there is no `fireEvent` HTTP endpoint.
  - [Quality gate](./systems/quality-gate/README.md): TurenOS quality-gate architecture and operation.
  - [In-agent code review](./systems/agent-review.md): intent-aware worker checks, risk-ranked adversarial review,
    authority boundaries, and research limits.
- Tools and shell
  - [Shell tool routing](./systems/shell-tool-routing.md): specialized discovery/search/mutation tools and the
    deterministic routing benchmark.
  - [Background shell jobs](./systems/shell-jobs.md): nonblocking commands, session-owned output and cancellation,
    completion delivery, and restart semantics.
  - [Dangerous commands](./systems/dangerous-commands.md): recursive-delete guards, wrapper resistance, and limits of
    shell safety.
  - [Rosetta execution](./systems/rosetta-exec.md): experimental bounded local x86-64 Linux execution through Apple's
    virtualization path.
- Security
  - [Security browser and proxy](./systems/security-browser.md): the Desktop AppSec Proxy workspace, with cases, a
    sandboxed browser, Intercept, Repeater, and its boundaries.
  - [Offline security tools](./systems/offline-security-tools.md): bounded offline analysis of attachments, binaries,
    captures, macros, .NET IL, archives, and packer evidence.
  - [Secure storage](./systems/secure-storage.md): encrypting credentials and sensitive files with the OS-protected
    Secret Vault.
- Models and providers
  - [Model and provider layer](./systems/model-provider-layer.md): how a session request reaches a provider through
    the default AI SDK runtime or the opt-in native `@turenlabs/llm` runtime.
- Extensions
  - [Developer catalog runtime](./systems/developer-catalog-runtime.md): catalog validation and runtime projection
    rules.

## Providers

- [Claude Code](./providers/claude-code/README.md): driving a local Claude Code subscription session.
  [Claude Code tool routing](./providers/claude-code/tool-routing.md) covers routing `claude -p` tools through TurenOS
  policy and settlement boundaries.
- [Muse Code](./providers/muse-code.md): using the signed-in local Muse CLI with host-routed tools.
- [Local models](./providers/local-models.md): running Bonsai 2 with its supported local runtime and connecting the
  loopback API.

## Operations

- [SSH remote servers](./operations/ssh-remote.md): driving the system `ssh` client to install, supervise, and tunnel a
  remote TurenOS backend from Desktop.
- [Releases](./operations/releases/README.md): the operator checklist for cutting a release (version bump, dispatch,
  verification, and recovery), with [automated releases](./operations/releases/automation.md) and
  [release signing](./operations/releases/signing.md).

## Experimental

Prototypes and benchmarks that explore or measure rather than document shipped behavior. Each page states its status.

- [Zero-Mem prototype](./experimental/zero-mem.md): isolated graph/hierarchy retrieval prototype and benchmark methodology.
- [Token efficiency](./experimental/token-efficiency.md): measured context-token cost, benchmark method, and remaining
  overhead.

## Contracts and specs

The repository's deeper contracts live beside the implementation rather than inside this directory. These are the best
entry points when changing a public boundary:

- [`../specs/v2/session.md`](../specs/v2/session.md): durable Session V2 admission, execution, continuation, and
  recovery contract.
- [`../specs/v2/tools.md`](../specs/v2/tools.md): tool catalog and settlement contract.
- [`../specs/v2/provider-model.md`](../specs/v2/provider-model.md): provider and model resolution contract.
- [`../specs/v2/provider-policy.md`](../specs/v2/provider-policy.md): policy evaluation for named resources, starting
  with provider availability.
- [`../specs/v2/subagent-fleet.md`](../specs/v2/subagent-fleet.md): admitting and reconciling large durable subagent
  fleets.
- [`../specs/v2/instructions.md`](../specs/v2/instructions.md): working rules for `packages/core` during the V2 port.
- [`../specs/storage.md`](../specs/storage.md): authoritative storage ownership and persistence rules.

## Elsewhere in the repo

- [`tools/README.md`](../tools/README.md): the built-in WebAssembly security tools, their builds, and provenance.
- [`services/catalog/README.md`](../services/catalog/README.md): the built-in extension catalog and how to add sources,
  skills, and MCP packages.
- Package READMEs, for example [`packages/forge`](../packages/forge/README.md),
  [`packages/app`](../packages/app/README.md), [`packages/desktop`](../packages/desktop/README.md), and
  [`packages/llm`](../packages/llm/README.md).

## How these docs are organized

- **One home per page.** [Architecture](./architecture/README.md) covers the whole-system shape and naming,
  [systems](./systems/README.md) covers one named system each, [providers](./providers/README.md) covers driving one model
  provider or agent CLI, [operations](./operations/README.md) covers hosting and releases, and
  [experimental](./experimental/README.md) holds prototypes and benchmarks with a status line. Images and diagram sources
  go in `assets/`. Contracts stay in `specs/`, area docs stay beside `tools/`, `services/catalog/` and each package, and
  HTML prototypes go in `mockups/`.
- **The systems catalog is the index of systems.** Every system page has a row in the
  [catalog](./systems/README.md) that links it. A new system adds its row in the same change.
- **Source-grounded.** System pages end with a `## Source` list of the files that implement them. Those links are
  checked, so a renamed or deleted source file shows up as a broken link instead of a silently stale page.
- **Names.** Prose says TurenOS; technical identifiers keep their exact `forge` spelling. See
  [Branding](./architecture/branding.md).
- **Checks.** After any docs change, run `bun .agents/skills/turen-documentation/scripts/check.ts docs`. To move or rename
  pages, use `bun .agents/skills/turen-documentation/scripts/move.ts <moves-file>`, which rewrites every link the move
  would break.

The complete method, including where a new page goes, page conventions, and templates, is
[`.agents/skills/turen-documentation/SKILL.md`](../.agents/skills/turen-documentation/SKILL.md). Coding agents load it as
a skill; people can read it directly.
