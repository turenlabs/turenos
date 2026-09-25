# Forge test fixtures

Worked examples for the test fixtures and patterns used in `packages/forge` tests. Fixtures live in
[`packages/forge/test/fixture/fixture.ts`](../../packages/forge/test/fixture/fixture.ts); Effect helpers live in [`packages/forge/test/lib/effect.ts`](../../packages/forge/test/lib/effect.ts).

## Temporary directories

### Basic usage

```typescript
import { tmpdir } from "./fixture/fixture"

test("example", async () => {
  await using tmp = await tmpdir()
  // tmp.path is the temp directory path
  // automatically cleaned up when test ends
})
```

### Options

- `git?: boolean` - Initialize a git repo with a root commit
- `config?: Partial<Config.Info>` - Write an `forge.json` config file
- `init?: (dir: string) => Promise<T>` - Custom setup function, returns value accessible as `tmp.extra`
- `dispose?: (dir: string) => Promise<T>` - Custom cleanup function

### Examples

**Git repository:**

```typescript
await using tmp = await tmpdir({ git: true })
```

**With config file:**

```typescript
await using tmp = await tmpdir({
  config: { model: "test/model", username: "testuser" },
})
```

**Custom initialization (returns extra data):**

```typescript
await using tmp = await tmpdir<string>({
  init: async (dir) => {
    await Bun.write(path.join(dir, "file.txt"), "content")
    return "extra data"
  },
})
// Access extra data via tmp.extra
console.log(tmp.extra) // "extra data"
```

**With cleanup:**

```typescript
await using tmp = await tmpdir({
  init: async (dir) => {
    const specialDir = path.join(dir, "special")
    await fs.mkdir(specialDir)
    return specialDir
  },
  dispose: async (dir) => {
    // Custom cleanup logic
    await fs.rm(path.join(dir, "special"), { recursive: true })
  },
})
```

### Returned object

- `path: string` - Absolute path to the temp directory (realpath resolved)
- `extra: T` - Value returned by the `init` function
- `[Symbol.asyncDispose]` - Enables automatic cleanup via `await using`

### Notes

- Directories are created in the system temp folder with prefix `forge-test-`
- Use `await using` for automatic cleanup when the variable goes out of scope
- Paths are sanitized to strip null bytes (defensive fix for CI environments)

## Effect tests

### Core pattern

```typescript
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(MyService.defaultLayer))

describe("my service", () => {
  it.instance("does the thing", () =>
    Effect.gen(function* () {
      const svc = yield* MyService.Service
      const out = yield* svc.run()
      expect(out).toEqual("ok")
    }),
  )
})
```

### Temp directory path inside `it.instance`

```typescript
import { TestInstance } from "../fixture/fixture"

it.instance("uses the temp directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    expect(test.directory).toContain("forge-test-")
  }),
)
```

### Partial service stubs

```typescript
import { Effect, Layer } from "effect"
import { Account } from "@/account/account"

const failingAccountLayer = Layer.mock(Account.Service, {
  orgsByAccount: () => Effect.fail(new Account.AccountServiceError({ message: "simulated upstream failure" })),
})
```

## Waiting on concurrent work

### Readiness signal instead of a sleep

```ts
// Antipattern — race
yield * prompt.shell({ command: "sleep 30" }).pipe(Effect.forkChild)
yield * Effect.sleep(50)
yield * prompt.cancel(chat.id)

// Fix — wait for a published readiness signal
yield * prompt.shell({ command: "sleep 30" }).pipe(Effect.forkChild)
yield *
  pollWithTimeout(
    Effect.gen(function* () {
      const s = yield* (yield* SessionStatus.Service).get(chat.id)
      return s.type === "busy" ? (true as const) : undefined
    }),
    "session never became busy",
  )
yield * prompt.cancel(chat.id)
```
