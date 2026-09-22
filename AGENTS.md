- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The canonical development branch is `main`. `turenio/turen` consumes it for signing and release only.
- `tools/` holds the imported wasm-tools bounded WASM tool targets; follow `tools/AGENTS.md` when working there. `.github/workflows/build-<target>.yml` rebuilds and opens a PR updating `packages/<target>-wasm`; locally run `bun run build:wasm <target>` (recipes live in `script/build-wasm.ts`) and `bun run verify:wasm` checks package checksums.
- `services/catalog/manifests` is the canonical built-in extension catalog (data, skills, MCP, tools); follow `services/catalog/AGENTS.md` when editing it. Run `bun run generate` in `packages/extensions` to update `src/generated.ts`. There is no remote catalog.

## Releases

- Use the committed orchestration in `docs/release-automation.md`. Do not recreate manual artifact-copy or public-mirror procedures from old session notes.
- Prepare and merge the version change with normal CI first. From clean, synchronized `main`, run `./script/release <version>`; GitHub Actions builds/signs privately, verifies and publishes the public release, then updates Homebrew.
- If the private release already exists, use `./script/release <version> --publish-existing`. Never rebuild/re-sign a published version or overwrite published assets.
- Keep build/signing credentials in `turenio/turen`. `PUBLIC_RELEASE_TOKEN` is a dedicated fine-grained token for `turenlabs/turenos` and `turenlabs/homebrew-turenos`; never upload a developer's general-purpose local login token.
- Preserve the pinned signing identity, exact source exclusions, public-only Git ancestry, non-force pushes, draft verification, and downgrade/concurrency guards.
- A release is complete only after the workflow's public release, anonymous update-feed checks, and Homebrew verification succeed. Prefer quiet periodic status checks over streaming workflow logs.

## Dev Builds

- Packaged dev app (unsigned, dev channel, `com.turenlabs.forge.dev` data): from `packages/desktop`, run `bun run build && bunx electron-builder --mac dir --config electron-builder.config.ts --publish never "--config.mac.identity=-" "--config.mac.notarize=false"`, then open `dist/mac-arm64/TurenOS Dev.app`. For renderer-only changes, skip `prebuild` and the verify scripts: `bunx electron-vite build` followed by the same `electron-builder` command.
- Shells spawned inside another Electron app inherit `ELECTRON_RUN_AS_NODE=1`, which makes any `electron` binary run as plain Node and exit silently. Prefix Electron launches and `electron-vite dev` with `env -u ELECTRON_RUN_AS_NODE`.
- Headless `serve` requires `FORGE_SECRET_VAULT_KEY_ID` plus a base64 32-byte `FORGE_SECRET_VAULT_KEY`; a key that did not seal existing credentials fails startup with "Stored credentials belong to another OS-protected key". For a throwaway instance, point `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` at a scratch dir.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `forge`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(desktop): preserve window state`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@turenlabs/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/forge`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/forge`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input promotes one at a time at the next provider-turn boundary after in-flight tool calls settle — it does not wait for the Session to become idle; reevaluate continuation before promoting another. Machine advisory inputs (board posts, settle notices, direct child advisories, shell-job completions) instead promote as one consecutive batch at a boundary so a settling swarm costs a single provider turn. Steers take precedence over queued inputs at every boundary. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.
