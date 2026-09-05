import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionTable } from "@turenlabs/core/session/sql"
import { EmailSecurityRuntime } from "@turenlabs/core/tool/email-security-runtime"
import { EmailSecurityTools } from "@turenlabs/core/tool/email-security-tools"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_email_extract_attachment_test")
const message = [
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "body",
  "--b",
  "Content-Type: application/octet-stream",
  'Content-Disposition: attachment; filename="../../untrusted.bin"',
  "Content-Transfer-Encoding: base64",
  "",
  "AP9BQgo=",
  "--b",
  "Content-Type: application/octet-stream",
  'Content-Disposition: attachment; filename="duplicate.bin"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "=00=FF=41=0A",
  "--b--",
  "",
].join("\r\n")

const runtimeIt = testEffect(AppNodeBuilder.build(EmailSecurityRuntime.node))
describe("email_extract_attachment", () => {
  runtimeIt.live("decodes selected bytes in fresh real WASM workers and rejects invalid bounds", () =>
    Effect.gen(function* () {
      const runtime = yield* EmailSecurityRuntime.Service
      const bytes = new TextEncoder().encode(message)
      expect(yield* runtime.extractAttachment({ bytes, index: 0, maxOutputBytes: 5 })).toEqual(
        Uint8Array.from([0, 255, 65, 66, 10]),
      )
      expect(yield* runtime.extractAttachment({ bytes, index: 1, maxOutputBytes: 4 })).toEqual(
        Uint8Array.from([0, 255, 65, 10]),
      )
      for (const input of [
        { bytes, index: 2, maxOutputBytes: 5 },
        { bytes, index: 0, maxOutputBytes: 4 },
        { bytes, index: -1, maxOutputBytes: 5 },
        { bytes, index: 0.5, maxOutputBytes: 5 },
        { bytes, index: 0, maxOutputBytes: 0 },
        { bytes, index: 0, maxOutputBytes: 8 * 1024 * 1024 + 1 },
        { bytes: new Uint8Array(32 * 1024 * 1024 + 1), index: 0, maxOutputBytes: 5 },
      ])
        expect((yield* runtime.extractAttachment(input).pipe(Effect.exit))._tag).toBe("Failure")
      // A failed extraction must not poison the next worker or consume its permit.
      expect((yield* runtime.extractAttachment({ bytes, index: 0, maxOutputBytes: 5 })).length).toBe(5)
      const inspected = yield* runtime.inspect({
        bytes,
        includeBodies: false,
        includeAttachmentData: false,
        maxIocs: 0,
      })
      expect(inspected.attachments.length).toBe(2)
      expect(inspected.attachments[0]?.name).toBe("../../untrusted.bin")
    }),
  )

  it.live("writes only a new approved path, returns SHA256, and respects real edit permissions", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/message.eml`, message))
          const database = yield* Database.Service
          yield* database.db
            .insert(ProjectTable)
            .values({
              id: Project.ID.global,
              worktree: AbsolutePath.make(tmp.path),
              sandboxes: [],
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Project.ID.global,
              slug: "email-extract",
              directory: tmp.path,
              title: "email-extract",
              version: "test",
              agent: "build",
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const checks = yield* PermissionChecks.Service
          yield* checks.set(true)
          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
            }),
          )
          const registry = yield* ToolRegistry.Service
          const call = (input: Record<string, unknown>, id: string) =>
            settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id, name: "email_extract_attachment", input },
            })
          const extracted = yield* call({ path: "message.eml", outputPath: "saved.bin", index: 0 }, "extract")
          expect(extracted.result.type).toBe("text")
          const expected = Uint8Array.from([0, 255, 65, 66, 10])
          expect(extracted.output?.structured).toMatchObject({
            path: "message.eml",
            outputPath: "saved.bin",
            index: 0,
            size: expected.length,
            sha256: createHash("sha256").update(expected).digest("hex"),
          })
          expect(new Uint8Array(yield* Effect.promise(() => fs.readFile(`${tmp.path}/saved.bin`)))).toEqual(expected)
          for (const [index, input] of [
            { path: "message.eml", outputPath: "message.eml", index: 0 },
            { path: "message.eml", outputPath: "saved.bin", index: 1 },
            { path: "message.eml", outputPath: "missing-index.bin" },
            { path: "message.eml", outputPath: "too-small.bin", index: 0, maxOutputBytes: 4 },
            { path: "message.eml", outputPath: "missing.bin", index: 2 },
          ].entries())
            expect((yield* call(input, `reject-${index}`)).result.type).toBe("error")
          yield* Effect.promise(() => fs.symlink(`${tmp.path}/message.eml`, `${tmp.path}/alias.eml`))
          expect((yield* call({ path: "message.eml", outputPath: "alias.eml", index: 0 }, "alias")).result.type).toBe(
            "error",
          )
          expect(yield* Effect.promise(() => fs.readFile(`${tmp.path}/message.eml`, "utf8"))).toBe(message)
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions = [
                { action: "*", resource: "*", effect: "allow" },
                { action: "edit", resource: "*", effect: "deny" },
              ]
            }),
          )
          expect((yield* call({ path: "message.eml", outputPath: "denied.bin", index: 0 }, "denied")).result.type).toBe(
            "error",
          )
          expect((yield* Effect.promise(() => fs.readdir(tmp.path))).sort()).toEqual([
            "alias.eml",
            "message.eml",
            "saved.bin",
          ])
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                EmailSecurityTools.node,
                Database.node,
                AgentV2.node,
                PermissionChecks.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                ],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
