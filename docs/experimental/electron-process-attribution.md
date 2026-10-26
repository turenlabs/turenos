# Electron Process Attribution Fixture

Status: prototype, as of 2026-10-26. The synthetic fixture passes on macOS arm64 with Electron 42.11.16.

This diagnostic runs Electron main, a sandboxed renderer, and a synthetic Bun child.
It bundles the current production `createSidecarSupervisor` without changing runtime source.
It does not start the TurenOS backend, import the application, or open existing application data.
Fixture success does not qualify packaged application lifecycle or explain the reported 16 GB incident.

## Run

Inspect all three `packages/desktop/script/process-attribution*` launch files before execution.
Use an existing Electron binary. Do not install dependencies for this diagnostic.
From `packages/desktop`, run:

```sh
bun test script/process-attribution.test.ts src/main/sidecar-supervisor.test.ts
bun typecheck
bun script/process-attribution.ts /absolute/path/to/Electron 4000
```

The first argument selects the trusted local Electron binary.
The optional second argument sets idle duration, from 1000 through 60000 milliseconds.
The default is 4000 milliseconds. Samples use 500-millisecond intervals.
The runner emits one JSON summary with the private evidence root, row count, and Electron exit code.
A nonzero exit or missing process/lifecycle evidence fails the run.
Execution permissions must cover the exact command. Do not bypass an execution denial.

## Isolation And Bounds

Before launch, the runner creates a new mode-700 temporary root and six private directories.
It supplies an explicit environment instead of copying the parent environment.
HOME, TMPDIR, and all four XDG directories point inside that root.
The environment includes a fresh random 32-byte scratch key and a diagnostic-only key identifier.
The fixture does not use the key. The key never appears in output or evidence.
Electron `userData` and `sessionData` point inside the scratch root before app readiness.
The renderer loads only a fixed data URL with sandboxing and context isolation enabled.
The fixture uses no provider, remote endpoint, inspector network socket, profile capture, or heap snapshot.

The controller bounds output to 2 MiB and execution to idle duration plus 20 seconds.
It creates an owned detached process group and targets only that group for final cleanup.
The Electron fixture also has an independent deadline and stops its own Bun child.
It never selects processes by name, command text, or broad patterns.
The scratch evidence remains available after execution. Treat its generated Chromium files as private.

## Evidence Format

| File             | Content                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `isolation.json` | Prelaunch isolation assertions without key material                                       |
| `source.json`    | Git head, launch-file SHA-256 hashes, supervisor hash, workload size, and timing          |
| `metrics.ndjson` | UTC, source head, controller Bun version, target PID, role, phase, and supported counters |
| `supervisor.cjs` | Scratch bundle of the inspected production supervisor                                     |

The runner creates evidence files with mode 600.
Source hashes bind uncommitted diagnostic code separately from the recorded Git head.
Compare hashes before carrying evidence to a later committed head.

Main and Bun rows report `process.memoryUsage()` fields in bytes.
Electron process rows report `workingSetSize` multiplied by 1024, retaining Electron's platform meaning.
Renderer heap rows report CDP `Runtime.getHeapUsage` used and total sizes.
Renderer external memory and native allocation counters remain unavailable (`null`).
Native allocation counters remain unavailable for every process.
Do not sum heap, external, and RSS values as separate allocations.
Bun can report zero external bytes immediately after a Buffer allocation. Preserve that value without inferring no allocation.
Process rows include Electron creation time where supported. Main and Bun rows include parent PID.
The synthetic Bun child is labeled `bun-fixture`, never backend.

The renderer and Bun child each allocate 4 MiB of synthetic data.
The renderer releases its reference before the idle phase. The Bun child releases its buffer during teardown.
The fixture then destroys the renderer and stops the Bun child.
The child exit queues one production supervisor replacement timer.
The fixture stops the supervisor and observes 1200 milliseconds without a replacement.
The final lifecycle row requires one spawn, one exit, one queued replacement, and zero post-shutdown spawns.
No forced GC runs. Samples are observations, not true process peaks or long-lived retention limits.

## Remaining Application Scope

Actual backend attribution still requires a separate application fixture.
Its owner must inspect current `src/main/index.ts`, sidecar startup, vault selection, and profile paths first.
The owner must prove every application-specific path and key override before launching that fixture.
Do not reuse the user's dev profile or the historical diagnostic profile.
Do not claim this fixture's fresh key proves the full application's vault isolation.

Executable first inspection from the repository root:

```sh
git show c83dd98c41bff1a270228183510dc7089942e8a7:packages/desktop/src/main/index.ts
```

Continue with a dedicated scratch application launcher after that inspection.
Keep provider credentials absent and use only bounded synthetic workload data.
No runtime lifecycle repair is justified by this diagnostic alone.

## Initial Verification

On 2026-10-16, Bun 1.4.2 ran seven tests with 36 assertions and no failures.
These tests cover scratch preparation, owned Bun child release, and the production supervisor's existing regression suite.
`node --check script/process-attribution-electron.cjs` passed syntax validation.
Package-local `bun typecheck` failed because this worktree lacks existing workspace dependency declarations.
Reported missing modules include `bun:test`, `ghostty-web`, `solid-js`, and workspace packages.
The package TypeScript configuration includes `src`, not this diagnostic's `script` directory.
That attempted package check does not independently typecheck these new scripts.

The initial attempt did not verify full Electron execution.
On 2026-10-23, static inspection confirmed the committed controller, Electron fixture, Bun fixture, and production supervisor source.
Binary metadata inspection received an exact-command tool denial before execution. The executor stopped without a retry or Electron launch.
This denial does not prove the installed Electron binary is missing or unusable.
No new process measurements or lifecycle results are available from that attempt.
The existing unit evidence covers synthetic fixtures, not the actual backend or packaged application.

Use the committed runner in the Run section, not a private historical controller path.
Before execution, verify installed binary identities and source hashes under the current tool policy.
Obtain Security clearance and explicit serial execution ownership when required by the test coordinator.
For a 4000-millisecond idle run, apply an external deadline of at most 30 seconds and retain the 2 MiB output bound.
Record the exact process group, final process absence, and private scratch evidence in the qualification receipt.
Do not infer cleanup success from the controller exit alone.

## Runtime Verification

On 2026-10-26, the unchanged diagnostic at `0f71e9ee94b96002c2c5abd06ccef12af0aa6464` passed with official Electron 42.11.16 on macOS arm64.
An independent Quality repeat also passed. Each run produced 70 metric rows and exited zero.
The lifecycle recorded one spawn, one exit, one queued replacement, zero post-shutdown spawns, and a destroyed renderer.
Both runs used a four-second idle period, private scratch paths, a 30-second external deadline, and a 2 MiB output bound.
Independent process checks confirmed that all six observed process IDs and their owned groups were absent after execution.
The eight focused unit tests passed with 41 assertions. No source, installed dependency, signing setting, or application profile changed during these runs.

These results qualify only the synthetic main, renderer, and Bun-child fixture on the tested platform.
They do not qualify the actual backend, packaged application lifecycle, other platforms, or the reported 16 GB incident.
The earlier exact-command denial remains part of the historical record. The new run used a different, independently verified binary.
