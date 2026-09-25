# Forge tests

Rules for tests in `packages/forge/test`. Worked examples are in [README.md](./README.md). Follow `server/AGENTS.md` for HTTP server tests.

## Fixtures

- Create temp directories with `tmpdir(...)` from `fixture/fixture.ts` and bind them with `await using` so cleanup is automatic. Options: `git`, `config` (writes `forge.json`), `init` (its return value is `tmp.extra`), `dispose`.
- In Effect tests, prefer the Effect-aware helpers from `fixture/fixture.ts` over building a runtime by hand: `tmpdirScoped`, `provideInstance(dir)`, `provideTmpdirInstance`, and `provideTmpdirServer` (adds the test LLM server). Yield `TestInstance` when a test needs the temp directory path.

## Effect tests

- Use `testEffect(...)` from `test/lib/effect.ts` and define `const it = testEffect(...)` near the top of the file. Keep the body inside `Effect.gen(function* () { ... })` and yield services directly.
- `it.effect(...)` runs with `TestClock` and `TestConsole`. `it.live(...)` is for real time, filesystem mtimes, child processes, git, locks, or other live OS behavior; most integration-style tests here use it. `it.instance(...)` is the default when a test needs one scoped temp instance.
- Use `provideTmpdirInstance(...)` or `tmpdirScoped()` with `provideInstance(...)` only when a test needs several directories, setup before binding, switching instance context, or tests instance disposal and reload.
- Avoid custom `ManagedRuntime`, `attach(...)`, or ad hoc `run(...)` wrappers, and prefer `it.instance(...)` over manual `Instance.provide(...)` in Promise-style tests.
- To override one or two service methods, use `Layer.mock(Service, { ... })` instead of stubbing every method; unexpected calls fail with `UnimplementedError`.

## Concurrency

- Never wait for forked work with `Effect.sleep(N)` or `setTimeout`; it races the scheduler and flakes on slow CI hosts. Wait on a published readiness signal: `pollWithTimeout` or `awaitWithTimeout` from `test/lib/effect.ts`, `llm.wait(n)` from `test/lib/llm-server.ts`, `SessionStatus.Service` `.get(sessionID)`, `BackgroundJob.wait({ id, timeout })` from `src/background/job.ts`, a bus subscription that opens a `Latch`, or `Deferred.await(...)` with `Effect.timeoutOrElse(...)`.
- Fixed sleeps are acceptable only when the sleep is the behavior under test (debounce, throttle), when real time must pass a timestamp-resolution boundary such as mtime granularity, or when simulating latency in ordering-regression tests.
