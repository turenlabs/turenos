# TurenOS engineering documentation

This directory contains source-grounded engineering notes for TurenOS. Start with the three documents
below when you need the current product vocabulary, package/runtime model, or subsystem ownership.

## Architecture and naming

- [Architecture](./architecture.md): package and process topology, runtime and data-flow graphs,
  Location and trust boundaries, generated artifacts, and operational constraints.
- [Systems catalog](./systems.md): responsibilities, inputs/outputs, ownership, failure behavior,
  and implementation links for product systems and subsystems.
- The Desktop's interactive [`/home/system-map`](../packages/app/src/pages/system-map.tsx) view:
  source-linked traces for prompt admission, tool settlement, live projection, and subagent work.
- [Branding](./branding.md): TurenOS naming policy, Turen Labs company naming, and retained Forge
  compatibility seams.

The rebrand changes product-facing prose to TurenOS. Technical identifiers remain exact: do not
rename `FORGE_*`, `.forge` paths, `forge` commands, package or namespace identifiers containing `forge`, URLs,
serialized values, or materially accurate historical findings. The [Branding](./branding.md) page is
the reference when prose and code appear together.

## Runtime and operations

- [Claude Code](./claude-code.md): driving a local Claude Code subscription session.
- [Claude Code tool routing](./claude-code-tool-routing.md): routing `claude -p` tools through
  TurenOS policy and settlement boundaries.
- [Secure storage](./secure-storage.md): encrypting credentials and sensitive files with the
  OS-protected Secret Vault.
- [Release signing](./release-signing.md): native platform signatures, certificate handoff, and
  detached release verification.
- [Quality gate](./quality-gate/README.md): TurenOS quality-gate architecture and operation.
- [In-agent code review](./agent-review.md): intent-aware worker checks, risk-ranked adversarial
  review, authority boundaries, and research limits.
- [Durable subagent workstreams](./subagent-workstreams.md): nonblocking V2 delegation, shared-board
  updates, delivery/recovery semantics, tool availability, and verification.
- [Automations](./automations.md): durable in-app workflows, reusable blueprints, ordered Agent and
  Skill steps, and TurenOS delivery.
- [Automations internals](./automations-internals.md): scheduler, lease model, SQLite persistence,
  and local HTTP surface behind Automations.
- [Memory](./memory.md): durable project memory, native agent tools, SQLite storage, and optional
  local Potion hybrid retrieval.
- [Shell tool routing](./shell-tool-routing.md): specialized discovery/search/mutation tools and
  the deterministic routing benchmark.
- [Dangerous commands](./dangerous-commands.md): recursive-delete guards, wrapper resistance, and
  limits of shell safety.

## Research and prototypes

- [Developer catalog runtime](./developer-catalog-runtime.md): catalog validation and runtime
  projection rules.
- [Rosetta execution](./rosetta-exec.md): bounded local x86-64 Linux execution through Apple's
  virtualization path.
- [Zero-Mem prototype](./zero-mem.md): isolated graph/hierarchy retrieval prototype and benchmark
  methodology.
- [Token efficiency](./token-efficiency.md): measured context-token cost, benchmark method, and
  remaining overhead.

## Contracts and specs

The repository's deeper contracts live beside the implementation rather than
inside this directory. These are the best entry points when changing a public
boundary:

- [`../specs/v2/session.md`](../specs/v2/session.md): durable Session V2
  admission, execution, continuation, and recovery contract.
- [`../specs/v2/tools.md`](../specs/v2/tools.md): tool catalog and settlement
  contract.
- [`../specs/v2/provider-model.md`](../specs/v2/provider-model.md): provider
  and model resolution contract.
- [`../specs/storage.md`](../specs/storage.md): authoritative storage
  ownership and persistence rules.
