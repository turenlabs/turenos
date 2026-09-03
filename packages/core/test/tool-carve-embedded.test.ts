import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { CarveEmbeddedTool } from "@turenlabs/core/tool/carve-embedded"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_carve_embedded_test")
const it = testEffect(Layer.empty)

const withTool = <A, E, R>(
  directory: string,
  assertions: PermissionV2.AssertInput[],
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  onAssert?: (input: PermissionV2.AssertInput) => Promise<void>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          CarveEmbeddedTool.node,
        ]),
        [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
          [
            PermissionV2.node,
            Layer.succeed(
              PermissionV2.Service,
              PermissionV2.Service.of({
                assert: (input) =>
                  Effect.sync(() => assertions.push(input)).pipe(
                    Effect.andThen(onAssert ? Effect.promise(() => onAssert(input)) : Effect.void),
                  ),
                ask: () => Effect.die("unused"),
                reply: () => Effect.die("unused"),
                get: () => Effect.die("unused"),
                forSession: () => Effect.die("unused"),
                list: () => Effect.die("unused"),
              }),
            ),
          ],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )

const call = (input: typeof CarveEmbeddedTool.Input.Type, id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "carve_embedded", input },
})

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("CarveEmbeddedTool", () => {
  it.live("extracts an exact nonzero byte range into a managed artifact", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const assertions: PermissionV2.AssertInput[] = []
        const source = Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
        const carved = source.slice(2, 6)
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "source.bin"), source)).pipe(
          Effect.andThen(
            withTool(tmp.path, assertions, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["carve_embedded"])
                const settled = yield* settleTool(
                  registry,
                  call(
                    {
                      path: "source.bin",
                      offset: 2,
                      length: 4,
                      expectedSha256: sha256(carved).toUpperCase(),
                    },
                    "call-carve-success",
                  ),
                )
                expect(settled.result.type).toBe("text")
                expect(settled.output?.structured).toMatchObject({
                  path: "source.bin",
                  offset: 2,
                  length: 4,
                  sha256: sha256(carved),
                })
                const artifactPath = String((settled.output?.structured as { artifactPath?: string }).artifactPath)
                expect(new Uint8Array(yield* Effect.promise(() => fs.readFile(artifactPath)))).toEqual(carved)
                expect(assertions.map((input) => input.action)).toEqual(["read"])
                expect(assertions).toMatchObject([{ sessionID, resources: ["source.bin"], save: ["*"] }])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not create or disclose a digest when the expected digest mismatches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const selected = Uint8Array.from([2, 3])
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "source.bin"), Uint8Array.from([1, ...selected, 4]))).pipe(
          Effect.andThen(
            withTool(tmp.path, [], (registry) =>
              executeTool(
                registry,
                call(
                  { path: "source.bin", offset: 1, length: 2, expectedSha256: "0".repeat(64) },
                  "call-carve-mismatch",
                ),
              ),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result.type).toBe("error")
              if (result.type === "error") expect(result.value).not.toContain(sha256(selected))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an out-of-range carve", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.promise(() => fs.writeFile(path.join(tmp.path, "source.bin"), Uint8Array.from([1, 2, 3, 4]))).pipe(
          Effect.andThen(
            withTool(tmp.path, [], (registry) =>
              executeTool(
                registry,
                call({ path: "source.bin", offset: 3, length: 2 }, "call-carve-range"),
              ),
            ),
          ),
          Effect.tap((result) => Effect.sync(() => expect(result.type).toBe("error"))),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a source replacement without disclosing the replacement digest", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const sourcePath = path.join(tmp.path, "source.bin")
        const secret = Uint8Array.from([9, 8, 7, 6])
        return Effect.promise(() => fs.writeFile(sourcePath, Uint8Array.from([1, 2, 3, 4]))).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              [],
              (registry) =>
                executeTool(
                  registry,
                  call(
                    { path: "source.bin", offset: 0, length: secret.length, expectedSha256: "0".repeat(64) },
                    "call-carve-source-swap",
                  ),
                ),
              async (input) => {
                if (input.action !== "read") return
                await fs.rename(sourcePath, path.join(tmp.path, "original.bin"))
                await fs.writeFile(sourcePath, secret)
              },
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result.type).toBe("error")
              if (result.type === "error") expect(result.value).not.toContain(sha256(secret))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
