# Turen WASM Tools Contributor Guide

This directory produces reproducible, bounded WebAssembly runtimes for Turen
agent tools. Keep build provenance, licensing, runtime isolation, and artifact
bounds as first-class product requirements.

## Directory Layout

This directory is the former `turenio/wasm-tools` repository inside the Forge
monorepo. It contains only tool directories and these shared instructions; cross-tool decisions and target research
live in `docs/systems/offline-security-tools/targets.md`:

```text
../.github/workflows/build-<target>.yml  Trusted reproducible builds
<target>/                                One self-contained tool target
AGENTS.md                                Contributor and agent instructions
README.md                                Overview
```

Do not put target source, processor data, generated objects, test binaries, or
package artifacts loose in this directory. Each target owns its source, build
scripts, patches, tests, licenses, provenance, and generated output under
`tools/<target>/`.

The target inventory, with one line per target, is in `README.md`.

## Build And Provenance Rules

- Pin every upstream source to an immutable commit and record its repository,
  version, commit, toolchain, maintained patches, and workflow run in the
  packaged artifact.
- Pin compilers, package builders, and GitHub Actions by immutable versions or
  commits. Do not use floating branches, `latest`, or mutable major-version
  Action references.
- Self-hosted workflows may run only for trusted pushes or explicit manual
  dispatches. Never execute pull-request code on a persistent self-hosted
  runner.
- Keep Turen patches small, reviewable, and stored under the owning target.
  Verify that each patch applies cleanly to the pinned upstream commit.
- Produce SHA-256 manifests covering every distributed runtime file. Validate
  the complete manifest before importing an artifact into Forge.
- Preserve upstream license headers and distribute all required `LICENSE`,
  `NOTICE`, attribution, and modification notices with each artifact.
- Do not commit generated object directories, local caches, native test
  binaries, `.DS_Store`, or workflow download directories.
- Forge consumes checked-in workspace packages at `packages/<target>-wasm` so
  normal builds do not need the WASM toolchains. Build workflows pack into
  `packages/<target>-wasm` and open an update PR; locally run
  `bun run build:wasm <target>` from the repository root.

## Runtime Boundary

`wasm-tools` is for deterministic, bounded byte processing. A normal target
accepts bytes plus structured options and returns bounded JSON or one bounded
byte vector.

- Do not expose an upstream CLI, shell command, arbitrary argument list, host
  path, network socket, subprocess, or environment access through a WASM API.
- Do not execute or emulate analyzed machine code in a static WASM target.
- Use a fresh isolated worker when malformed input could poison runtime state.
- Enforce limits before expensive allocation or JavaScript serialization, not
  only after the full upstream result has been materialized.
- Terminate workers on cancellation or timeout and await termination before
  releasing concurrency permits.
- List archive or carving results first and retrieve one entry at a time. WASM
  must never extract untrusted paths to the host filesystem.
- Keep recursion in the host with hashing, deduplication, depth limits, and
  aggregate expansion limits.

Default maximums unless a target defines a narrower limit:

```text
input bytes             32 MiB
JSON output              4 MiB
results                  4,096
one transformed output 128 MiB
host recursion depth         4
worker wall time            60 s
```

## Target Rules

These targets have their own rules; follow the target's file when working in it:

- `ghidra-decompiler/AGENTS.md`
- `yara-x/AGENTS.md`
- `goblin/AGENTS.md`
- `stng-core/AGENTS.md`
- `libpcap/AGENTS.md`
- `static-unpack/AGENTS.md`
- `static-analysis/AGENTS.md`
- `protocol-inspect/AGENTS.md`
- `binwalk-scan/AGENTS.md`
- `monodis/AGENTS.md`

## Current Build Targets

These remain open for deeper replacements. Keep the public API typed and
narrower than the upstream application.

| Capability | Preferred implementation | Required boundary |
| --- | --- | --- |
| Broader archives | Minimal libarchive read build | Keep `list_archive` / `extract_archive_entry`; never extract paths to disk |
| Packer database | Reviewed declarative DIE subset | Replace marker matching; do not bundle Qt or its JavaScript engine |

Do not embed full 7-Zip because its LGPL and restricted RAR components do not
fit the target.

## Native And Service-Only Targets

The following tools are not WebAssembly targets. Do not add them to this
repository as embedded binaries or arbitrary command wrappers.

| Tool | Approved integration boundary |
| --- | --- |
| OWASP ZAP | Isolated, digest-pinned, non-root container service with loopback API, API key, and network access restricted to an authorized target. Expose typed scan/status/alert/report operations only. |
| TShark | Optional native sidecar for offline pcap/pcapng analysis. Disable plugins, Lua, extcap, and name resolution; use a fresh config directory and typed operations. |
| dumpcap | Separate narrowly privileged live-capture helper with approved interface, required BPF filter, and packet/time/byte limits. Never run TShark as root. |
| Nmap | Do not bundle without OEM and legal review of the NPSL. A future bring-your-own adapter may initially expose unprivileged TCP connect scans with controller-built argv and parsed XML. |
| x64dbg | Disposable Windows VM service only. Never attach to TurenOS host processes; destroy the VM on timeout and expose typed debugger operations rather than scripts or commands. |
| netcat | Do not expose the binary or an arbitrary byte stream. Implement typed outbound `tcp_connect`, `banner_read`, `tls_handshake`, and optionally fixed-payload bounded `udp_exchange` operations. |

See `docs/systems/offline-security-tools/targets.md` for licensing details, operation names, and the complete
reasoning behind these boundaries.

## Adding Or Updating A Target

1. Verify the upstream license, transitive runtime licenses, source
   provenance, and WebAssembly feasibility from primary sources.
2. Define the narrow typed operation and hard input, allocation, output,
   concurrency, and wall-clock limits before writing the wrapper.
3. Add a self-contained `tools/<target>` directory with a pinned source lock,
   maintained patches, build scripts, tests, licenses, and README.
4. Add a trusted self-hosted workflow
   (`.github/workflows/build-<target>.yml`) that builds from source, tests the
   real implementation, generates checksums and provenance, packs into
   `packages/<target>-wasm`, and opens an update PR.
5. Differential-test transformations against the same pinned native revision
   where a native implementation exists. Fuzz malformed input for parsers and
   unpackers.
6. Merge only a passing checksum-verified package update PR. Verify source,
   Node, compiled CLI, Desktop bundle, and packaged Desktop paths when the
   runtime ships in all of them.
7. Update this file, the target's own `AGENTS.md`, and `docs/systems/offline-security-tools/targets.md` when a
   target changes status or its security boundary changes.

## Review Checklist

Before merging, confirm:

- `tools/` still contains no target implementation files outside `tools/<target>/`.
- The upstream commit and toolchains are immutable and recorded.
- No persistent self-hosted workflow executes pull-request code.
- Required licenses and notices ship with the artifact.
- Checksums cover every distributed file and validate successfully.
- Limits apply before unbounded allocation or result serialization.
- Cancellation awaits worker termination and concurrency remains bounded.
- Tests execute the actual WebAssembly implementation, not duplicated logic or
  mocks.
- Forge packaging uses the same verified bytes in source, CLI, and Desktop
  distributions.
