import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { WasmToolkitRuntime } from "@turenlabs/core/tool/wasm-toolkit-runtime"
import { WasmToolkitTools } from "@turenlabs/core/tool/wasm-toolkit-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(Layer.empty)

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        WasmToolkitRuntime.node,
        WasmToolkitTools.node,
      ]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    ),
  )

const WAT = `(module
  (type $t (func (param i32) (result i32)))
  (import "env" "log" (func $log (param i32)))
  (memory (export "mem") 1 4)
  (func $f (export "f") (type $t) (param i32) (result i32)
    local.get 0)
)`

describe("WasmToolkitRuntime and WasmToolkitTools", () => {
  it.live("compiles wat and analyzes, prints, and reads metadata through a fresh wasm-toolkit worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          // Empty module header: magic + version.
          yield* Effect.promise(() =>
            Bun.write(`${tmp.path}/empty.wasm`, new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])),
          )
          yield* Effect.promise(() => Bun.write(`${tmp.path}/module.wat`, WAT))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/blob.bin`, new Uint8Array([1, 2, 3])))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["wasm_analyze", "wasm_metadata", "wasm_print", "wat_compile"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_wasm_toolkit_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          // wat_compile produces the binary every other operation consumes.
          const compiled = yield* call("call-wat-compile", "wat_compile", { path: "module.wat" })
          expect(compiled.type).toBe("text")
          if (compiled.type !== "text") return
          expect(typeof compiled.value).toBe("string")
          const artifactPath = / to (\S+) \(sha256 /.exec(String(compiled.value))?.[1]
          expect(artifactPath).toBeTruthy()

          const analyzed = yield* call("call-wasm-analyze", "wasm_analyze", { path: artifactPath! })
          expect(analyzed.type).toBe("text")
          if (analyzed.type !== "text") return
          const analysis = JSON.parse(String(analyzed.value)) as {
            encoding?: string
            valid?: boolean
            imports?: Array<{ module: string; name: string; kind: string }>
            exports?: Array<{ name: string; kind: string }>
            features?: string[]
          }
          expect(analysis.encoding).toBe("module")
          expect(analysis.valid).toBe(true)
          expect(analysis.imports?.[0]?.module).toBe("env")
          expect(analysis.imports?.[0]?.name).toBe("log")
          expect(analysis.exports?.some((entry) => entry.name === "f" && entry.kind === "func")).toBe(true)
          expect(analysis.features).toBeInstanceOf(Array)

          const printed = yield* call("call-wasm-print", "wasm_print", { path: artifactPath! })
          expect(printed.type).toBe("text")
          if (printed.type !== "text") return
          const print = JSON.parse(String(printed.value)) as { wat?: string; truncated?: boolean }
          expect(print.wat).toContain("(module")
          expect(print.wat).toContain("local.get")
          expect(print.truncated).toBe(false)

          const metadata = yield* call("call-wasm-metadata", "wasm_metadata", { path: artifactPath! })
          expect(metadata.type).toBe("text")
          if (metadata.type !== "text") return
          const meta = JSON.parse(String(metadata.value)) as {
            encoding?: string
            custom_sections?: Array<{ name: string; recognized: boolean }>
          }
          expect(meta.encoding).toBe("module")
          expect(meta.custom_sections?.some((section) => section.name === "name" && section.recognized)).toBe(true)

          // The bare header is a valid empty module.
          const empty = yield* call("call-wasm-analyze-empty", "wasm_analyze", { path: "empty.wasm" })
          expect(empty.type).toBe("text")
          if (empty.type !== "text") return
          expect(empty.value).toContain('"valid": true')
          expect(empty.value).toContain('"encoding": "module"')

          // Non-wasm input fails cleanly; invalid wat throws error JSON.
          const failed = yield* call("call-wasm-analyze-bad", "wasm_analyze", { path: "blob.bin" })
          expect(failed.type).toBe("error")

          yield* Effect.promise(() => Bun.write(`${tmp.path}/broken.wat`, "(module (func"))
          const brokenWat = yield* call("call-wat-compile-bad", "wat_compile", { path: "broken.wat" })
          expect(brokenWat.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
