import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
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
import { InstallerInspectRuntime } from "@turenlabs/core/tool/installer-inspect-runtime"
import { InstallerInspectTools } from "@turenlabs/core/tool/installer-inspect-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
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
        InstallerInspectRuntime.node,
        InstallerInspectTools.node,
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

// Same payloads as the installer-inspect fixture generator in wasm-tools.
const EVIL_DLL = Buffer.from("4d5a9000666978747572652d646c6c2d7061796c6f6164", "hex")
const README_TXT = "Hello cabinet, this is a stored file.\n"

describe("InstallerInspectRuntime and InstallerInspectTools", () => {
  it.live("inspects MSI and CAB through a fresh installer-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const msi = yield* Effect.promise(() =>
            fs.readFile(fileURLToPath(new URL("./fixtures/minimal.msi", import.meta.url))),
          )
          const cab = yield* Effect.promise(() =>
            fs.readFile(fileURLToPath(new URL("./fixtures/stored.cab", import.meta.url))),
          )
          yield* Effect.promise(() => Bun.write(`${tmp.path}/minimal.msi`, msi))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/stored.cab`, cab))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.bin`, "definitely not an installer"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["msi_inspect", "msi_stream_read", "cab_list", "cab_extract"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_installer_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspected = yield* call("call-msi-inspect", "msi_inspect", { path: "minimal.msi" })
          expect(inspected.type).toBe("text")
          if (inspected.type !== "text") return
          expect(inspected.value).toContain('"format": "msi"')
          expect(inspected.value).toContain('"isMsi": true')
          expect(inspected.value).toContain('"type": "installer"')
          expect(inspected.value).toContain('"ProductCode"')
          expect(inspected.value).toContain('"evil.dll"')
          expect(inspected.value).toContain('"customActionPayload"')
          expect(inspected.value).toContain('"serviceInstall"')

          const filtered = yield* call("call-msi-inspect-filter", "msi_inspect", {
            path: "minimal.msi",
            tableFilter: "Property",
          })
          expect(filtered.type).toBe("text")
          if (filtered.type !== "text") return
          expect(filtered.value).toContain('"name": "Property"')
          expect(filtered.value).toContain('"rowCount": 3')

          const stream = yield* call("call-msi-stream", "msi_stream_read", {
            path: "minimal.msi",
            stream: "evil.dll",
          })
          expect(stream.type).toBe("text")
          if (stream.type !== "text") return
          expect(stream.value).toContain(`${EVIL_DLL.length}-byte stream`)
          const streamPath = / to (\S+) \(sha256/.exec(String(stream.value))?.[1]
          expect(streamPath).toBeTruthy()
          const streamBytes = yield* Effect.promise(() => fs.readFile(streamPath!))
          expect(Buffer.compare(streamBytes, EVIL_DLL)).toBe(0)

          const listed = yield* call("call-cab-list", "cab_list", { path: "stored.cab" })
          expect(listed.type).toBe("text")
          if (listed.type !== "text") return
          expect(listed.value).toContain('"format": "cabinet"')
          expect(listed.value).toContain('"fileCount": 2')
          expect(listed.value).toContain('"name": "readme.txt"')
          expect(listed.value).toContain('"name": "loader.js"')
          expect(listed.value).toContain('"scheme": "none"')

          const extracted = yield* call("call-cab-extract", "cab_extract", {
            path: "stored.cab",
            member: "readme.txt",
          })
          expect(extracted.type).toBe("text")
          if (extracted.type !== "text") return
          const cabPath = / to (\S+) \(sha256/.exec(String(extracted.value))?.[1]
          expect(cabPath).toBeTruthy()
          const member = yield* Effect.promise(() => fs.readFile(cabPath!, "utf8"))
          expect(member).toBe(README_TXT)

          const capped = yield* call("call-cab-extract-capped", "cab_extract", {
            path: "stored.cab",
            member: "readme.txt",
            maxBytes: 4,
          })
          expect(capped.type).toBe("text")
          if (capped.type !== "text") return
          expect(capped.value).toContain("4-byte cabinet member")

          const failedMsi = yield* call("call-msi-garbage", "msi_inspect", { path: "garbage.bin" })
          expect(failedMsi.type).toBe("error")
          const failedCab = yield* call("call-cab-garbage", "cab_list", { path: "garbage.bin" })
          expect(failedCab.type).toBe("error")
          const missing = yield* call("call-cab-missing", "cab_extract", {
            path: "stored.cab",
            member: "missing.txt",
          })
          expect(missing.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
