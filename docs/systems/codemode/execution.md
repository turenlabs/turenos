# CodeMode execution

CodeMode interprets a bounded JavaScript subset and returns structured diagnostics for program, tool, and configured-limit failures. The [CodeMode overview](./README.md) defines the host boundary; the [API](./api.md) defines results and hooks.

## Supported programs

CodeMode executes a deliberately bounded JavaScript subset. It supports:

- Plain data literals, property access, assignment, and destructuring.
- `if`, conditional expressions, `switch`, `for`, `for...of` (arrays, strings, Maps, Sets), `for...in` (own keys of plain objects, index strings of arrays, and namespace/tool names of `tools` references - anything else is an error suggesting `for...of` or `Object.keys`, rather than real JS's surprising behavior of indices for strings and zero iterations for Maps/Sets), `while`, and `do...while`.
- Arrow functions and function declarations with closures, defaults, rest parameters, and destructuring.
- Optional chaining, nullish coalescing, templates, spread (arrays, strings, Maps, Sets), and `try`/`catch`.
- Common array, string, number, `Object`, `Math`, and `JSON` operations. Mutating array methods include `push`/`pop`/`shift`/`unshift`/`splice` (removes in place and returns the removed elements)/`fill`/`copyWithin`; array `keys`/`values`/`entries` return **arrays** (matching the Map/Set convention) and work with `for...of` and spread. String methods include `localeCompare` (locale/options arguments ignored), `normalize`, and the `trimLeft`/`trimRight` aliases. `Object.keys` also accepts arrays (index strings, as in JS) and tool references: `Object.keys(tools)` lists the top-level namespaces, including `$codemode`, and `Object.keys(tools.ns)` lists the names at that node (a callable tool enumerates as `[]`; an unknown path is an `UnknownTool` diagnostic). `Object.values`/`Object.entries` on a tool reference fail with a pointer at `Object.keys(tools)` and `tools.$codemode.search`.
- `Date` - `Date.now()`/`Date.parse()`/`Date.UTC()`, `new Date(...)`, the getter methods, and date arithmetic/comparison via the time value. Dates stringify as ISO (`toString` included, for determinism across host timezones).
- Regular expressions - `/literals/` and `new RegExp(...)` with `test`/`exec` (stateful `lastIndex` for `g`), plus string `match`/`matchAll`/`replace`/`replaceAll`/`split`/`search` with patterns. Match results are arrays carrying `index` and named `groups` as own properties (`input` is omitted). `replace` and `replaceAll` accept function replacers with captures, offset, input, and named groups; callbacks run sequentially, may await tool calls, and have their results coerced to strings. Invalid patterns, invalid flags, and missing-`g` calls fail with catchable errors that say what was wrong and how to fix it (escaping hints, the exact `/pattern/g` to write). Patterns run on the host engine, so pathological backtracking is bounded only by the execution timeout.
- `Map` and `Set` - construction from entries/arrays/strings, `get`/`set`/`add`/`has`/`delete`/`clear`/`size`/`forEach`, and `keys`/`values`/`entries` returning **arrays** (not iterators).
- URL helpers - `URL` resolution and mutation, linked `URLSearchParams`, `URL.canParse`/`URL.parse`, URI and URI-component encoding/decoding, and query parameter construction, lookup, mutation, sorting, callbacks, and materialization. URLSearchParams iteration methods return arrays, matching the Map/Set convention.
- First-class promises - an un-awaited `tools.ns.tool(...)` is a promise value whose call starts immediately on a supervised fiber; `await` resolves it (awaiting a non-promise value is a no-op, and `return tools.ns.tool(...)` resolves like an async-function return). `Promise.all`, `Promise.allSettled`, and `Promise.race` accept any array mixing promises and plain values (built inline, beforehand, or via spread); `Promise.resolve`/`Promise.reject` construct settled promises. `Promise.allSettled` rejection reasons are the same plain `{ name?, message }` data a `catch` binding sees, and `Promise.race` interrupts its losing in-flight calls. At most 8 tool calls run concurrently. When a program completes, still-running un-awaited calls are awaited before the execution ends; a failure from a call that was never awaited surfaces as an unhandled-rejection diagnostic.
- `throw value` and `throw new Error(message)` for explicit program failure. `Error` (and `TypeError`/`RangeError`/`SyntaxError`/`ReferenceError`/`EvalError`/`URIError`) are real constructors, callable with or without `new`; error values are plain `{ name, message }` data that additionally satisfy `instanceof Error` (a specific type matches itself and `Error`, as in JS). Every caught failure - thrown errors, interpreter runtime errors, and tool failures - is `instanceof Error` in a `catch` block; a thrown non-error value (`throw "text"`) is not, matching JS. Caught failures carry the `name` the equivalent real-JS failure would have - `JSON.parse` and invalid regex patterns produce a `SyntaxError` (satisfying `instanceof SyntaxError`), an unknown identifier a `ReferenceError`, assigning to a constant a `TypeError`, a bad `normalize` form a `RangeError`; failures with no specific analogue (including tool failures) are named `"Error"`. `instanceof` also recognizes `Date`, `RegExp`, `Map`, `Set`, `URL`, `URLSearchParams`, `Array`, `Object`, and `Promise`; any other right-hand side is a catchable error.

Inside a program, standard-library values stay live everywhere: the internal data checkpoints (`Object.*` helpers, spread, coercion inputs) preserve the instances, so `Object.values({ d: date })[0].getTime()` and a spread copy of an object holding a Map keep working. Only at the host boundary (final result, tool arguments, `JSON.stringify`) do they serialize exactly as `JSON.stringify` would: Date and URL become strings (an invalid Date becomes `null`), while RegExp, Map, Set, and URLSearchParams become `{}`. Promise values never cross a data boundary: an un-awaited promise in a result or tool argument produces a diagnostic that says to await it, instead of serializing to `{}`.

It does not expose `eval`, dynamic imports, modules, classes, generators, timers, host globals, prototype mutation, custom promise constructors (`new Promise`), promise chaining (`.then`/`.catch`/`.finally` - `await` with `try`/`catch` is the supported style), or arbitrary method calls. Unsupported syntax returns an `UnsupportedSyntax` diagnostic with a source location when available.

CodeMode is an orchestration language, not a general JavaScript runtime.

## Execution limits

The limits are exactly three knobs:

| Limit            |              Default | Bounds                                                               |
| ---------------- | -------------------: | -------------------------------------------------------------------- |
| `timeoutMs`      |    none - no timeout | Wall-clock execution time.                                           |
| `maxToolCalls`   |     none - unlimited | Tool calls admitted during the execution.                            |
| `maxOutputBytes` | none - no truncation | Model-facing output: the serialized result value plus captured logs. |

No limit has a default, on purpose: execution budgets are host policy, not library policy - a host that wants a bound sets one; a host that can interrupt the execution fiber (as TurenOS does on user cancel) may set no timeout, and a host with its own tool-output truncation (as TurenOS has) may leave `maxOutputBytes` unset. A host with neither should set `maxOutputBytes`, or oversized results silently flood model context.

Pass only the overrides you need:

```ts
const runtime = CodeMode.make({
  tools,
  limits: {
    maxToolCalls: 20,
    timeoutMs: 60_000,
  },
})
```

Limits are safe integers. `timeoutMs` must be at least `1`; the others may be `0`. Invalid configuration throws a `RangeError` when `CodeMode.make` or `CodeMode.execute` is called. An explicitly `undefined` value is the same as leaving the limit unset.

Exceeding a configured `maxOutputBytes` never fails the execution. An oversized result value is replaced by its truncated serialized text plus an explanatory marker, logs are kept from the start until the remaining budget is exhausted (with a final marker line noting the cut), and the result carries `truncated: true`.

When configured, the timeout interrupts in-flight tool Effects, including eagerly started calls the program has not awaited (their fibers are supervised by the execution). The interpreter yields cooperatively between steps, so the timeout also interrupts pure busy loops (`while (true) {}`) - no separate work budget exists. Tool implementations remain responsible for making their external operations interruptible or independently bounded.

Two interpreter internals are fixed constants rather than knobs: at most 8 tool calls run concurrently, and values crossing a data boundary may nest at most 32 levels deep (deeper values fail as `InvalidDataValue`, which reads better than a native stack-overflow error). Neither is part of the public contract.

## Diagnostics

Failures are data:

| Kind                    | Meaning                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `ParseError`            | Source is empty or cannot be parsed.                                                                     |
| `UnsupportedSyntax`     | Parsed JavaScript is outside the supported subset.                                                       |
| `UnknownTool`           | A program referenced a tool the host did not provide.                                                    |
| `InvalidToolInput`      | Tool input failed schema decoding or safe-data copying.                                                  |
| `InvalidToolOutput`     | Tool output failed schema decoding or safe-data copying.                                                 |
| `InvalidDataValue`      | Program data violated the plain-data contract (depth, circularity, blocked properties, non-data values). |
| `ToolCallLimitExceeded` | Calls exceeded `maxToolCalls`.                                                                           |
| `TimeoutExceeded`       | Execution exceeded `timeoutMs`.                                                                          |
| `ToolFailure`           | A tool refused or failed.                                                                                |
| `ExecutionFailure`      | The program threw or another execution error occurred.                                                   |

Unknown host failures, defects, invalid outputs, and copying failures are sanitized. To return a safe operational refusal, fail with `toolError`:

```ts
import { toolError } from "@turenlabs/codemode"

run: ({ id }) => (authorized(id) ? loadOrder(id) : Effect.fail(toolError("Order is unavailable")))
```

Only the supplied message is model-visible. The optional cause is never returned in `CodeMode.Result`; hosts should perform any required internal logging before crossing this boundary.

## Source

- [`packages/codemode/src/interpreter/runtime.ts`](../../../packages/codemode/src/interpreter/runtime.ts)
- [`packages/codemode/src/codemode.ts`](../../../packages/codemode/src/codemode.ts)
