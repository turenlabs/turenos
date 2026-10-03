# Desktop sidecar profiler

The Desktop sidecar runs under Bun and does not support the V8 CPU profiler.
Electron remains the UI runtime. Its main-process V8 profiler helper does not profile the Bun sidecar.

## Record a profile

The dev-channel **Settings > Developer > Profiler** control still exists.
Starting a sidecar recording returns `CPU profiling is unsupported by the Bun sidecar`.
It does not produce a usable `sidecar.cpuprofile`.
The controller removes the empty run directory when the sidecar rejects startup.

## How it works

- `createProfilerController` (`packages/desktop/src/main/profiler.ts`) owns arming, the auto-stop timer, and the run
  directory. The `IS_DEV` check (`CHANNEL === "dev"`) folds to a constant at build time, so in other channels the controller
  and its IPC channels (`profiler-status`, `profiler-start`, `profiler-stop`, `profiler-subscribe`,
  `profiler-unsubscribe`) are unreachable.
- The Bun sidecar rejects profile start and stop commands without opening a V8 inspector session.
- The V8 helper remains available for Electron's Node main process, not the Bun backend.

## Verification

```sh
cd packages/desktop
bun test src/main/profiler.test.ts src/main/profiler/run.test.ts src/main/profiler/sidecar-profiler.test.ts
```

## Limits

- The dev-channel control cannot capture Bun CPU profiles.
- Built bundles (packaged and `bun run build`) are minified, and function names in the profile are shortened. `bun dev` keeps main and preload output readable. JavaScript source maps are never packed into `app.asar`; the third-party wasm maps ship as extra resources.

## Sidecar memory

The sidecar uses Bun's runtime-reported heap statistics, not Electron's fixed V8 heap ceiling.
A heap watchdog (`packages/forge/src/cli/heap.ts`), which every `forge` command and the
server's `listen` start, checks every 60 seconds and logs one `heap watchdog: level=<60|75|90>` line the first time
usage crosses 60%, 75% and 90% of the reported limit, with used, total, limit, RSS, external and array-buffer megabytes
plus the old, new, large-object and code space sizes. A level logs again only after usage drops 5 points below it. The
watchdog never triggers when the limit is under 1 GiB.

- Find the lines with `grep "heap watchdog:" server.log`. The startup line `heap watchdog: limit=<MB>` reports the limit.
- Snapshots are opt-in: launch with `FORGE_AUTO_HEAP_SNAPSHOT=1` and one is written to the log directory at 90%. It is
  best-effort, because serializing a heap at its limit can itself run out of memory.
- Snapshot files are created with mode 0600. At startup the sidecar deletes all but the newest `heap-*.heapsnapshot` or
  `Heap.*.heapsnapshot` file, and any older than 7 days, skipping files modified in the last 10 minutes.
- Snapshots contain keys, passwords and prompts. Never attach one to a bug report; the support bundle skips them.

## Source

- [`packages/desktop/src/main/profiler.ts`](../../packages/desktop/src/main/profiler.ts)
- [`packages/desktop/src/main/profiler/run.ts`](../../packages/desktop/src/main/profiler/run.ts)
- [`packages/desktop/src/main/profiler/sidecar-profiler.ts`](../../packages/desktop/src/main/profiler/sidecar-profiler.ts)
- [`packages/desktop/src/main/profiler/v8-cpu-profiler.ts`](../../packages/desktop/src/main/profiler/v8-cpu-profiler.ts)
- [`packages/desktop/src/main/sidecar.ts`](../../packages/desktop/src/main/sidecar.ts)
- [`packages/forge/src/cli/heap.ts`](../../packages/forge/src/cli/heap.ts)
- [`packages/app/src/components/settings-v2/profiler.tsx`](../../packages/app/src/components/settings-v2/profiler.tsx)
