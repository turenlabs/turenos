export * as EmailAuthenticateTools from "./email-authenticate-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt } from "../schema"
import { read } from "./binary-file"
import { EmailAuthenticateRuntime } from "./email-authenticate-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_DNS_SNAPSHOT_CHARS = 4 * 1024 * 1024
const MAX_REPORT_CHARS = 48 * 1024
const Path = Schema.NonEmptyString.annotate({ description: "RFC 5322/MIME message to authenticate." })
const Input = Schema.Struct({
  path: Path,
  clientIp: Schema.String.annotate({ description: "SMTP client IP address." }),
  helo: Schema.String.annotate({ description: "SMTP HELO/EHLO domain." }),
  mailFrom: Schema.String.annotate({ description: "SMTP MAIL FROM address, or empty for a null reverse path." }),
  receiverDomain: Schema.String.annotate({ description: "Receiving domain used for policy evaluation." }),
  evaluationTimeUnix: NonNegativeInt.annotate({ description: "Evaluation time as Unix seconds." }),
  dnsSnapshot: Schema.String.check(Schema.isMaxLength(MAX_DNS_SNAPSHOT_CHARS)).annotate({
    description: "JSON DNS snapshot. Missing records fail closed and never trigger live DNS.",
  }),
})
const Output = Schema.Struct({ path: Schema.String, report: Schema.String })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* EmailAuthenticateRuntime.Service
    yield* tools
      .register({
        email_authenticate: Tool.make({
          deferred: true,
          description:
            "Verify DKIM, SPF, and DMARC using the bundled offline mail-auth WebAssembly engine. Requires explicit SMTP envelope values and a JSON DNS snapshot. Missing records are reported as incomplete; no DNS or network access is performed.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "email_authenticate", context, mutation, fs, permission)
              const dnsSnapshot = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(input.dnsSnapshot).pipe(
                Effect.mapError(() => new ToolFailure({ message: "dnsSnapshot must be valid JSON" })),
              )
              const result = yield* runtime
                .authenticate({
                  bytes: file.bytes,
                  request: {
                    schema_version: 1,
                    envelope: {
                      client_ip: input.clientIp,
                      helo: input.helo,
                      mail_from: input.mailFrom,
                    },
                    receiver_domain: input.receiverDomain,
                    evaluation_time_unix: input.evaluationTimeUnix,
                    dns_snapshot: dnsSnapshot,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to authenticate ${input.path}: ${error.message}` })))
              return { path: file.resource, report: bounded(JSON.stringify({ path: file.resource, ...result }, null, 2)) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to authenticate ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/email-authenticate",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, EmailAuthenticateRuntime.node],
})

function bounded(value: string) {
  return value.length <= MAX_REPORT_CHARS ? value : `${value.slice(0, MAX_REPORT_CHARS - 24)}\n[report truncated]`
}
