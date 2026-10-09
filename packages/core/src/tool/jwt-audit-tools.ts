export * as JwtAuditTools from "./jwt-audit-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { read } from "./binary-file"
import { JwtAuditRuntime } from "./jwt-audit-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* JwtAuditRuntime.Service
    const fail = (error: unknown) =>
      error instanceof ToolFailure
        ? error
        : new ToolFailure({ message: `JWT audit failed: ${error instanceof Error ? error.message : String(error)}` })
    yield* tools
      .register({
        jwt_inspect: Tool.make({
          deferred: true,
          description:
            "Inspect a compact JWT from a local file without trusting it. Report algorithm, type, key ID, claim names, registered context/time claims, and unsafe key hints or missing expiration. Never fetch key URLs. Does not return the compact token, signature, or sub claim. Inspection is NOT verification.",
          input: Schema.Struct({ path: Schema.NonEmptyString }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "jwt_inspect", context, mutation, fs, permission, 128 * 1024)
              const report = yield* runtime.run({ op: "jwt_inspect", bytes: file.bytes }).pipe(Effect.mapError(fail))
              return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
            }).pipe(Effect.mapError(fail)),
        }),
        jwt_verify: Tool.make({
          deferred: true,
          description:
            "Offline JWT verification using an explicitly supplied trusted PUBLIC JWK file and pinned RS256 or ES256 algorithm. Require exact issuer/audience and unexpired exp; check nbf and future iat. now is explicit Unix seconds, with zero clock skew and non-negative integer dates. Ignore embedded/remote keys. Report signature and claim results separately. This does not establish key ownership, check revocation/replay, or grant authorization.",
          input: Schema.Struct({
            path: Schema.NonEmptyString,
            keyPath: Schema.NonEmptyString.annotate({
              description: "Trusted public JWK JSON file, not JWKS, PEM, or a private key.",
            }),
            algorithm: Schema.Literals(["RS256", "ES256"]),
            issuer: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
            audience: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
            now: Schema.Int.check(
              Schema.isGreaterThanOrEqualTo(0),
              Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
            ),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "jwt_verify", context, mutation, fs, permission, 128 * 1024)
              const key = yield* read(input.keyPath, "jwt_verify", context, mutation, fs, permission, 16 * 1024)
              const report = yield* runtime
                .run({
                  op: "jwt_verify",
                  bytes: file.bytes,
                  jwk: key.bytes,
                  options: {
                    algorithm: input.algorithm,
                    issuer: input.issuer,
                    audience: input.audience,
                    now: input.now,
                  },
                })
                .pipe(Effect.mapError(fail))
              return {
                path: file.resource,
                report: JSON.stringify({ path: file.resource, keyPath: key.resource, ...report }, null, 2),
              }
            }).pipe(Effect.mapError(fail)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({
  name: "tool/jwt-audit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, JwtAuditRuntime.node],
})
