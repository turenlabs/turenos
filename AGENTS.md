- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `packages/client/src/generated` or `packages/client/src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The canonical development branch is `main`. `turenio/turen` consumes it for signing and release only.
- `tools/` holds the imported wasm-tools bounded WASM tool targets; follow `tools/AGENTS.md` when working there. `.github/workflows/build-<target>.yml` rebuilds and opens a PR updating `packages/<target>-wasm`; locally run `bun run build:wasm <target>` (recipes live in `script/build-wasm.ts`) and `bun run verify:wasm` checks package checksums.
- `AGENTS.md` files (these instructions) follow `.agents/skills/turen-context/SKILL.md`; run `bun .agents/skills/turen-context/scripts/check.ts` after changing any of them.
- `docs/` follows the documentation method in `.agents/skills/turen-documentation/SKILL.md`; follow it when adding, editing, or moving docs, and run `bun .agents/skills/turen-documentation/scripts/check.ts docs` before finishing.
- `services/catalog/manifests` is the canonical built-in extension catalog (data, skills, MCP, tools); follow `services/catalog/AGENTS.md` when editing it. Run `bun run generate` in `packages/extensions` to update `packages/extensions/src/generated.ts`. There is no remote catalog.
- Shells spawned inside another Electron app inherit `ELECTRON_RUN_AS_NODE=1`, which makes any `electron` binary run as plain Node and exit silently. Prefix Electron launches and `electron-vite dev` with `env -u ELECTRON_RUN_AS_NODE`.

## Package Instructions

Packages with their own rules have an `AGENTS.md`; read it before changing that package:

- `packages/core/AGENTS.md`: V2 Session Core rules; `packages/core/src/tool/AGENTS.md` covers built-in tools.
- `packages/forge/AGENTS.md`: database, extension catalog, module shape, Effect rules, and headless `serve`.
- `packages/llm/AGENTS.md`: the LLM package, with nested files for routes, providers, protocols, and recorded tests.
- `packages/desktop/AGENTS.md`: Electron IPC boundaries and packaged dev builds.
- `packages/app/AGENTS.md`, `packages/codemode/AGENTS.md`, `packages/effect-drizzle-sqlite/AGENTS.md`, `packages/extensions/AGENTS.md`, and `packages/schema/AGENTS.md`.

## Releases

- Follow `docs/operations/releases/README.md` and `docs/operations/releases/automation.md`: merge the version change with normal CI on `main`, then run `./script/release <version>`, or `./script/release <version> --publish-existing` when the public release already exists.
- Never rebuild or re-sign a published version or overwrite published assets. Build and signing credentials stay in `turenio/turen`; never put a developer's general-purpose token in Actions secrets. Preserve the pinned signing identity, non-force pushes, draft verification, and downgrade/concurrency guards.

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
- In `packages/core/src/config` and `packages/forge/src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
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
