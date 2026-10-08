import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { JwtAuditTools } from "@turenlabs/core/tool/jwt-audit-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
describe("JWT defender tools", () => {
  it.live("verifies signed tokens through the file and WASM worker path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          expect(names).toContain("jwt_inspect")
          expect(names).toContain("jwt_verify")
          const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
          const signed = `${Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: "https://identity.example", aud: "api", exp: 1800000300, sub: "SENSITIVE-SUBJECT" })).toString("base64url")}`
          const signature = sign("sha256", Buffer.from(signed), { key: keys.privateKey, dsaEncoding: "ieee-p1363" })
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/token.jwt`, `${signed}.${signature.toString("base64url")}`),
              Bun.write(`${tmp.path}/key.jwk`, JSON.stringify(keys.publicKey.export({ format: "jwk" }))),
              Bun.write(`${tmp.path}/private.jwk`, JSON.stringify(keys.privateKey.export({ format: "jwk" }))),
              Bun.write(`${tmp.path}/oversized.jwt`, new Uint8Array(128 * 1024 + 1)),
            ]),
          )
          const call = (name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_jwt_audit_test"),
              ...toolIdentity,
              call: { type: "tool-call", id: `call-${randomUUID()}`, name, input },
            })
          const policy = {
            path: "token.jwt",
            keyPath: "key.jwk",
            algorithm: "ES256",
            issuer: "https://identity.example",
            audience: "api",
            now: 1800000000,
          }
          const checked = yield* call("jwt_verify", policy)
          expect(checked.type, JSON.stringify(checked)).toBe("text")
          if (checked.type !== "text") return
          expect(checked.value).toContain('"verified": true')
          expect(checked.value).toContain('"signatureValid": true')
          expect(checked.value).not.toContain("SENSITIVE-SUBJECT")
          const inspected = yield* call("jwt_inspect", { path: "token.jwt" })
          expect(inspected.type).toBe("text")
          if (inspected.type !== "text") return
          expect(inspected.value).toContain('"verified": false')
          const expired = yield* call("jwt_verify", { ...policy, now: 1800000300 })
          expect(expired.type).toBe("text")
          if (expired.type !== "text") return
          expect(expired.value).toContain('"verified": false')
          expect(expired.value).toContain("expired")
          expect((yield* call("jwt_verify", { ...policy, keyPath: "private.jwk" })).type).toBe("error")
          expect((yield* call("jwt_verify", { ...policy, keyPath: "missing.jwk" })).type).toBe("error")
          expect((yield* call("jwt_inspect", { path: "oversized.jwt" })).type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, JwtAuditTools.node]), [
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              ],
              [
                PermissionV2.node,
                Layer.succeed(
                  PermissionV2.Service,
                  PermissionV2.Service.of({
                    assert: () => Effect.void,
                    ask: () => Effect.die("unused"),
                    reply: () => Effect.die("unused"),
                    get: () => Effect.die("unused"),
                    forSession: () => Effect.die("unused"),
                    list: () => Effect.die("unused"),
                  }),
                ),
              ],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ]),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
