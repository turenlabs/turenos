# Electron Process Attribution Fixture

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

Full Electron execution remains unverified.
Both the Desktop worker and coordinator received an exact-command permission denial before launch.
No Electron fixture process or measurement artifact was created by those denied commands.
The factory task admission owner must grant the exact scratch command before execution.
The denial is not a missing Electron binary or a dependency-install requirement.
After a grant, the authorized executor must inspect the stopped files and run:

```sh
bun .team-repairs/electron-memory-attribution/packages/desktop/script/process-attribution.ts /Users/tom/turenos/.memory-dev/node_modules/.bun/electron@42.11.1+759ce506b1ed1a42/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron 4000
```

Run that command from the shared repository root.
Keep the resulting private root and source hashes in the qualification receipt.
Then repeat with a longer idle duration only under an applicable exact command grant.
