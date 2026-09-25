# Desktop sidecar profiler

Development builds of the Desktop can record a V8 CPU profile of the local sidecar, the process that runs the agent
loop, tools, projection, compaction, and MCP. It profiles only that process: the renderer and the Electron main process
are not sampled. It exists only in dev-channel builds (`IS_DEV`); in any other channel the controller rejects every
start.

## Record a profile

1. Run a dev-channel Desktop, for example `bun --cwd packages/desktop dev`, or a packaged dev-channel build.
2. Open **Settings > Developer**, and in the **Profiler** section turn on the **Record CPU profile** toggle. The
   Developer page exists only in dev-channel builds.
3. Reproduce the slow behavior, then turn the toggle off to stop the recording. A run that is left armed stops itself after 10 minutes
   (`AUTO_STOP_MS`).
4. Open the resulting `sidecar.cpuprofile` in Chrome DevTools (Performance panel) or any `.cpuprofile` viewer.

Each run writes to a new directory, `<userData>/profiles/<timestamp>/`, holding `sidecar.cpuprofile` and a
`manifest.json` describing the run. The manifest is written even when capture fails, so a failed run still records what
happened.

## How it works

- `createProfilerController` (`packages/desktop/src/main/profiler.ts`) owns arming, the auto-stop timer, and the run
  directory. The `IS_DEV` check (`CHANNEL === "dev"`) folds to a constant at build time, so in other channels the controller
  and its IPC channels (`profiler-status`, `profiler-start`, `profiler-stop`) are unreachable.
- The sidecar starts the V8 inspector only when armed (`sidecar-profiler.ts`, `v8-cpu-profiler.ts`). While disarmed there
  is no timer, no inspector session, and the profiler module is not even imported.
- Sampling defaults to 1 ms (`DEFAULT_SAMPLE_INTERVAL_US = 1_000`), V8's default. A requested interval must be between
  10 µs and 1 s.

## Verification

```sh
cd packages/desktop
bun test src/main/profiler.test.ts src/main/profiler/run.test.ts src/main/profiler/sidecar-profiler.test.ts
```

## Limits

- One process only; time spent in the renderer or Electron main process does not appear.
- Sampling adds overhead. At 1 ms it measured at or below noise on a CPU-bound workload, while 100 µs cost about 3%.
- Ten minutes at 1 ms is roughly half a million samples, near the limit of what DevTools loads comfortably.

## Source

- [`packages/desktop/src/main/profiler.ts`](../../packages/desktop/src/main/profiler.ts)
- [`packages/desktop/src/main/profiler/run.ts`](../../packages/desktop/src/main/profiler/run.ts)
- [`packages/desktop/src/main/profiler/sidecar-profiler.ts`](../../packages/desktop/src/main/profiler/sidecar-profiler.ts)
- [`packages/desktop/src/main/profiler/v8-cpu-profiler.ts`](../../packages/desktop/src/main/profiler/v8-cpu-profiler.ts)
- [`packages/app/src/components/settings-v2/profiler.tsx`](../../packages/app/src/components/settings-v2/profiler.tsx)
