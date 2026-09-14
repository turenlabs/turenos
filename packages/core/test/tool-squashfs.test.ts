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
import { SquashfsRuntime } from "@turenlabs/core/tool/squashfs-runtime"
import { SquashfsTools } from "@turenlabs/core/tool/squashfs-tools"
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
        SquashfsRuntime.node,
        SquashfsTools.node,
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

const PASSWD = "root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/sbin/nologin\nnobody:x:99:99:nobody:/:/sbin/nologin\n"
const PASSWD_SHA256 = "84e1b53a03ceca5913fc4877e27e54a3aab808c418a3e93b1d5d7b9eefff9133"

describe("SquashfsRuntime and SquashfsTools", () => {
  it.live("lists and extracts through a fresh squashfs worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(() =>
            fs.readFile(fileURLToPath(new URL("./fixtures/fixture-gzip.sqfs", import.meta.url))),
          )
          yield* Effect.promise(() => Bun.write(`${tmp.path}/image.sqfs`, fixture))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.sqfs`, "definitely not squashfs"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["squashfs_list", "squashfs_extract"]) expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_squashfs_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const listed = yield* call("call-squashfs-list", "squashfs_list", { path: "image.sqfs" })
          expect(listed.type).toBe("text")
          if (listed.type !== "text") return
          expect(listed.value).toContain('"schema_version": 1')
          expect(listed.value).toContain('"kind": "le_v4_0"')
          expect(listed.value).toContain('"compression": "gzip"')
          expect(listed.value).toContain('"path": "/etc/passwd"')
          expect(listed.value).toContain('"path": "/passwd-link"')
          expect(listed.value).toContain('"linkTarget": "/etc/passwd"')

          const filtered = yield* call("call-squashfs-list-filter", "squashfs_list", {
            path: "image.sqfs",
            pathFilter: "/etc",
            maxResults: 4,
          })
          expect(filtered.type).toBe("text")
          if (filtered.type !== "text") return
          expect(filtered.value).toContain('"truncated": true')
          expect(filtered.value).not.toContain("/passwd-link")

          const extracted = yield* call("call-squashfs-extract", "squashfs_extract", {
            path: "image.sqfs",
            entry: "/etc/passwd",
          })
          expect(extracted.type).toBe("text")
          if (extracted.type !== "text") return
          expect(extracted.value).toContain(PASSWD_SHA256)
          const artifactPath =
            typeof extracted.value === "string" ? / to (\S+) \(sha256/.exec(extracted.value)?.[1] : undefined
          expect(artifactPath).toBeTruthy()
          const artifact = yield* Effect.promise(() => fs.readFile(artifactPath!, "utf8"))
          expect(artifact).toBe(PASSWD)

          const preview = yield* call("call-squashfs-extract-preview", "squashfs_extract", {
            path: "image.sqfs",
            entry: "/bin/big.bin",
            maxBytes: 64,
          })
          expect(preview.type).toBe("text")
          if (preview.type !== "text") return
          expect(preview.value).toContain("64-byte")

          const failed = yield* call("call-squashfs-list-garbage", "squashfs_list", { path: "garbage.sqfs" })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
