import { CodeModeFunction, InterpreterRuntimeError } from "./model.js"
import {
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js"

/** A cumulative logical allocation/work budget, independent of garbage collection. */
export class ExecutionBudget {
  private bytes = 0
  private operations = 0
  private exceeded = false

  constructor(
    private readonly maxBytes: number | undefined,
    private readonly maxOperations: number | undefined,
  ) {}

  step(count = 1): void {
    this.operations += count
    if (this.exceeded || (this.maxOperations !== undefined && this.operations > this.maxOperations)) this.fail()
  }

  allocate(bytes: number): void {
    this.step()
    if (!Number.isFinite(bytes) || bytes < 0) this.fail()
    this.bytes += bytes
    if (this.maxBytes !== undefined && this.bytes > this.maxBytes) this.fail()
  }

  slots(count: number): void {
    this.allocate(Math.max(0, Math.ceil(count)) * 64)
  }

  string(length: number): void {
    this.allocate(Math.max(0, Math.ceil(length)) * 2)
  }

  /** Charge expanded edges, deliberately counting shared children repeatedly. */
  value(value: unknown, factor = 1, depth = 0, path = new Set<object>()): void {
    this.step()
    if (depth > 32) this.fail()
    if (typeof value === "string") {
      this.allocate(value.length * 2 * factor)
      return
    }
    if (value === null || typeof value !== "object") return
    if (value instanceof CodeModeFunction || value instanceof SandboxPromise || value instanceof SandboxDate) return
    if (path.has(value)) return
    path.add(value)
    this.allocate(64 * factor)
    if (value instanceof SandboxURL) this.string(value.url.href.length * factor)
    else if (value instanceof SandboxRegExp) this.string(value.regex.source.length * factor)
    else if (value instanceof SandboxURLSearchParams) {
      for (const [key, item] of value.params) {
        this.slots(factor)
        this.string((key.length + item.length) * factor)
      }
    } else if (value instanceof SandboxMap) {
      for (const [key, item] of value.map) {
        this.slots(factor * 2)
        this.value(key, factor, depth + 1, path)
        this.value(item, factor, depth + 1, path)
      }
    } else if (value instanceof SandboxSet) {
      for (const item of value.set) {
        this.slots(factor)
        this.value(item, factor, depth + 1, path)
      }
    } else if (Array.isArray(value)) {
      this.slots(value.length * factor)
      for (const item of value) this.value(item, factor, depth + 1, path)
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        this.slots(factor)
        this.string(key.length * factor)
        this.value((value as Record<string, unknown>)[key], factor, depth + 1, path)
      }
    }
    path.delete(value)
  }

  /** Reserve parse storage before JSON.parse can materialize a dense document. */
  json(text: string): void {
    this.string(text.length)
    let quoted = false
    let escaped = false
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      if (char === "," || char === ":" || char === "[" || char === "{") this.slots(4)
    }
  }

  private fail(): never {
    this.exceeded = true
    throw new InterpreterRuntimeError(
      "Execution exceeded its allocation or operation budget.",
      undefined,
      "ResourceLimitExceeded",
    )
  }
}
