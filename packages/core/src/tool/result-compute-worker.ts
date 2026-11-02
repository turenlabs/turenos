import { parentPort } from "node:worker_threads"
import { CodeMode } from "@turenlabs/codemode"
import { Effect, Schema } from "effect"
import { ResultComputeRuntime } from "./result-compute-runtime"

if (!parentPort) throw new Error("result compute worker requires a parent port")

parentPort.once("message", async (message: unknown) => {
  try {
    const request = Schema.decodeUnknownExit(ResultComputeRuntime.Request)(message)
    if (
      request._tag === "Failure" ||
      Buffer.byteLength(request.value.code) > ResultComputeRuntime.maxCodeBytes ||
      Buffer.byteLength(request.value.dataJson) > ResultComputeRuntime.maxDataBytes
    ) {
      parentPort!.postMessage({ type: "failed" } satisfies ResultComputeRuntime.Response)
      return
    }
    // This is an interpreted JSON.parse call, never host eval. Double encoding preserves
    // data strings and object keys without letting them become executable source.
    // Worker threads are resource isolation, not an OS security sandbox: CodeMode's
    // restricted interpreter and empty host tool tree provide capability confinement.
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `const data = JSON.parse(${JSON.stringify(request.value.dataJson)});\n${request.value.code}`,
        tools: {},
        limits: {
          timeoutMs: ResultComputeRuntime.timeoutMs,
          maxOutputBytes: ResultComputeRuntime.maxOutputBytes,
          maxToolCalls: ResultComputeRuntime.maxToolCalls,
          maxAllocationBytes: ResultComputeRuntime.maxAllocationBytes,
          maxOperations: ResultComputeRuntime.maxOperations,
        },
      }),
    )
    parentPort!.postMessage({
      type: "completed",
      resultJson: JSON.stringify(boundResult(result)),
    } satisfies ResultComputeRuntime.Response)
  } catch {
    // Runtime/compiler/worker failures must never expose host exception text or stacks.
    parentPort!.postMessage({ type: "failed" } satisfies ResultComputeRuntime.Response)
  }
})

function boundResult(result: CodeMode.Result): CodeMode.Result {
  const safe =
    !result.ok && result.error.kind === "ExecutionFailure"
      ? { ...result, error: { kind: "ExecutionFailure" as const, message: "Program execution failed." } }
      : result
  if (Buffer.byteLength(JSON.stringify(safe)) <= ResultComputeRuntime.maxOutputBytes) return safe
  // CodeMode adds explanatory markers outside its output budget. Bound the complete
  // result envelope here as well, including diagnostics, escaping and log metadata.
  if (safe.ok)
    return {
      ok: true,
      value: "[Result exceeded the 8192-byte output limit; return a smaller value.]",
      truncated: true,
      toolCalls: [],
    }
  return {
    ok: false,
    error: { kind: safe.error.kind, message: safe.error.message.slice(0, 1024) },
    truncated: true,
    toolCalls: [],
  }
}
