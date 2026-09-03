export * as ForensicTools from "./forensic-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { read } from "./binary-file"
import { ForensicRuntime } from "./forensic-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const Path = Schema.NonEmptyString.annotate({
  description: "File to analyze. Relative paths resolve from the active Location.",
})
const ReportOutput = Schema.Struct({ path: Schema.String, report: Schema.String })
const MaxPackets = PositiveInt.check(Schema.isLessThanOrEqualTo(4096)).pipe(Schema.optional).annotate({
  description: "Maximum packets to decode. Defaults to 1024; maximum 4096.",
})
const MaxResults = PositiveInt.check(Schema.isLessThanOrEqualTo(4096)).pipe(Schema.optional).annotate({
  description: "Maximum records to return. Defaults to 256; maximum 4096.",
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* ForensicRuntime.Service
    const failure = (action: string, path: string) => (error: Error) =>
      new ToolFailure({ message: `${action} ${path}: ${error.message}` })
    const analyze = (
      name: string,
      target: ForensicRuntime.Target,
      path: string,
      options: Record<string, unknown>,
      context: Tool.Context,
    ) =>
      Effect.gen(function* () {
        const file = yield* read(path, name, context, mutation, fs, permission)
        const result = yield* runtime
          .analyze({ target, bytes: file.bytes, options })
          .pipe(Effect.mapError(failure("Unable to analyze", path)))
        return { path: file.resource, report: JSON.stringify({ path: file.resource, ...result }, null, 2) }
      }).pipe(Effect.mapError(toToolFailure(`Unable to analyze ${path}`)))

    yield* tools
      .register({
        wifi_offline: Tool.make({
          description:
            "Summarize one offline 802.11 PCAP or radiotap capture with pcap-file, ieee80211, and radiotap compiled to WebAssembly. Returns SSIDs, BSSIDs, clients, deauth counts, and whether EAPOL frames are present. Live capture and handshake cracking are not available.",
          input: Schema.Struct({ path: Path, maxPackets: MaxPackets }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            analyze("wifi_offline", "wifi-offline", input.path, { maxPackets: input.maxPackets ?? 1024 }, context),
        }),
        windows_artifacts: Tool.make({
          description:
            "Parse one Windows forensic artifact with prefetch-core, evtx, mft, amcache-core, lnk-core, jumplist_parser, or winreg-core compiled to WebAssembly. Auto-detects Prefetch, EVTX, MFT, Amcache/hive, LNK, and jump lists. The file is never executed.",
          input: Schema.Struct({
            path: Path,
            kind: Schema.Literals(["auto", "prefetch", "evtx", "mft", "amcache", "lnk", "jumplist", "hive"])
              .pipe(Schema.optional)
              .annotate({ description: "Artifact kind. Defaults to auto." }),
            jumplistKind: Schema.Literals(["automatic", "custom"]).pipe(Schema.optional).annotate({
              description: "Jump list format when kind is jumplist. Defaults to automatic.",
            }),
            maxResults: MaxResults,
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            analyze(
              "windows_artifacts",
              "windows-artifacts",
              input.path,
              {
                kind: input.kind ?? "auto",
                jumplistKind: input.jumplistKind ?? "automatic",
                maxResults: input.maxResults ?? 256,
              },
              context,
            ),
        }),
        rebuild_timeline: Tool.make({
          description:
            "Rebuild a bounded timeline from a Sleuth Kit bodyfile and optional parsed Windows artifact JSON with the bodyfile crate compiled to WebAssembly. Returns one sorted event list. It does not run mactime or write host files.",
          input: Schema.Struct({
            path: Path,
            artifacts: Schema.String.pipe(Schema.optional).annotate({
              description: "Optional JSON array of windows_artifacts results to merge into the timeline.",
            }),
            maxEvents: MaxResults,
          }),
          output: ReportOutput,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            analyze(
              "rebuild_timeline",
              "rebuild-timeline",
              input.path,
              {
                artifacts: input.artifacts,
                maxEvents: input.maxEvents ?? 1024,
              },
              context,
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/forensic",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, ForensicRuntime.node],
})

function toToolFailure(message: string) {
  return (error: unknown) =>
    error instanceof ToolFailure
      ? error
      : new ToolFailure({ message: error instanceof Error ? `${message}: ${error.message}` : message })
}
