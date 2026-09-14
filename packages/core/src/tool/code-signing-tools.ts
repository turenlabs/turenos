export * as CodeSigningTools from "./code-signing-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { CodeSigningRuntime } from "./code-signing-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ITEMS = 4096

const maxItems = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ITEMS))
  .pipe(Schema.optional)
  .annotate({ description: `Maximum items per reported collection (SANs, revoked certs, signers, embedded certs, blob indices). Defaults to ${MAX_ITEMS}; hard maximum ${MAX_ITEMS}.` })

const FilePath = (description: string) => Schema.NonEmptyString.annotate({ description })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* CodeSigningRuntime.Service

    const run = Effect.fn("CodeSigningTools.run")(function* (request: CodeSigningRuntime.Request, path: string) {
      return yield* runtime
        .run(request)
        .pipe(
          Effect.mapError(
            (error) => new ToolFailure({ message: `Unable to run ${request.op} on ${path}: ${error.message}` }),
          ),
        )
    })

    const fail = (message: string) =>
      Effect.mapError((error: unknown) =>
        error instanceof ToolFailure ? error : new ToolFailure({ message }),
      )

    const inspect = Effect.fn("CodeSigningTools.inspect")(function* (
      op: CodeSigningRuntime.Request["op"],
      action: string,
      input: { readonly path: string; readonly maxItems?: number },
      context: Tool.Context,
      options: Readonly<Record<string, unknown>> = {},
    ) {
      const file = yield* read(input.path, action, context, mutation, fs, permission)
      const report = yield* run(
        { op, bytes: file.bytes, options: { ...options, maxItems: input.maxItems } },
        input.path,
      )
      return { path: file.resource, report: JSON.stringify({ path: file.resource, ...report }, null, 2) }
    })

    yield* tools
      .register({
        cert_inspect: Tool.make({
          deferred: true,
          description:
            "Parse one X.509 certificate file (DER or a PEM bundle) into a structural report: subject, issuer, serial, validity, SANs, extended key usages including the code-signing flag, public key algorithm and size, signature algorithm, SHA-256 fingerprint, CA flag, and per-extension details. Parse only — no trust, chain, or signature verification is performed.",
          input: Schema.Struct({
            path: FilePath("Certificate file to inspect (DER or PEM)."),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("cert_inspect", "cert_inspect", input, context).pipe(
              fail(`Unable to inspect certificate ${input.path}`),
            ),
        }),
        pkcs7_inspect: Tool.make({
          deferred: true,
          description:
            "Parse a PKCS#7/CMS ContentInfo blob (DER or PEM): content type, SignedData digest algorithms, encapsulated content facts, signer infos with attribute OIDs, countersignature and page-hash presence, the messageDigest-vs-content comparison, and embedded certificates. Parse only — no trust or signature verification is performed.",
          input: Schema.Struct({
            path: FilePath("PKCS#7/CMS blob file to inspect (DER or PEM)."),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("pkcs7_inspect", "pkcs7_inspect", input, context).pipe(
              fail(`Unable to inspect PKCS#7 blob ${input.path}`),
            ),
        }),
        crl_inspect: Tool.make({
          deferred: true,
          description:
            "Parse an X.509 certificate revocation list (DER or PEM): issuer, this/next update times, revoked serials with dates and reason codes, CRL number, and extensions. Parse only — no trust or signature verification is performed.",
          input: Schema.Struct({
            path: FilePath("CRL file to inspect (DER or PEM)."),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("crl_inspect", "crl_inspect", input, context).pipe(
              fail(`Unable to inspect CRL ${input.path}`),
            ),
        }),
        pe_authenticode: Tool.make({
          deferred: true,
          description:
            "Parse a PE file's Authenticode data: WIN_CERTIFICATE table entries, the enclosed PKCS#7 report, SpcIndirectData content type/hash algorithm/digest, page-hash attribute presence, and nested signatures. Parse only — no trust or signature verification is performed.",
          input: Schema.Struct({
            path: FilePath("PE image to inspect for Authenticode data."),
            maxItems,
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("pe_authenticode", "pe_authenticode", input, context).pipe(
              fail(`Unable to inspect PE ${input.path}`),
            ),
        }),
        macho_codesign: Tool.make({
          deferred: true,
          description:
            "Parse a Mach-O or fat Mach-O code-signing SuperBlob: LC_CODE_SIGNATURE region, CodeDirectory fields (hash type, flags, page size, slot counts, identifier, team ID), requirements/entitlements presence with SHA-256 hashes, and the CMS signature blob report. Parse only — no signature, requirement, or entitlement verification is performed.",
          input: Schema.Struct({
            path: FilePath("Mach-O or fat Mach-O image to inspect."),
            maxItems,
            includeEntitlementsXml: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Embed the entitlements blob as bounded XML text in the report. Defaults to true.",
            }),
          }),
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            inspect("macho_codesign", "macho_codesign", input, context, {
              includeEntitlementsXml: input.includeEntitlementsXml,
            }).pipe(fail(`Unable to inspect Mach-O ${input.path}`)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/code-signing",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, CodeSigningRuntime.node],
})
