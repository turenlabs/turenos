export * as ProtocolInspectTools from "./protocol-inspect-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { BinaryAnalysisRuntime } from "./binary-analysis-runtime"
import { read } from "./binary-file"
import { ProtocolInspectRuntime } from "./protocol-inspect-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_PACKETS = 256
const MAX_PACKET_BYTES = ProtocolInspectRuntime.MAX_PACKET_BYTES
const MAX_PACKET_RESULT_BYTES = 16 * 1024
const MAX_REPORT_BYTES = 64 * 1024

const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "Offline PCAP or PCAPNG file." }),
  filter: Schema.String.check(Schema.isMaxLength(4096))
    .pipe(Schema.optional)
    .annotate({ description: "Numeric-only classic BPF filter." }),
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(100_000))
    .pipe(Schema.optional)
    .annotate({ description: "Filtered packet offset. Defaults to 0." }),
  maxPackets: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_PACKETS))
    .pipe(Schema.optional)
    .annotate({ description: "Maximum packets returned. Defaults to 64." }),
  maxPacketBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_PACKET_BYTES))
    .pipe(Schema.optional)
    .annotate({ description: "Maximum bytes parsed per packet. Defaults to 256." }),
})
const Output = Schema.Struct({ path: Schema.String, report: Schema.String })

const payloadFields = new Set([
  "bytes",
  "byteshex",
  "data",
  "packetbytes",
  "packetdata",
  "packethex",
  "payload",
  "payloadbytes",
  "payloaddata",
  "payloadhex",
  "payloadprefix",
  "payloadprefixhex",
  "payloadraw",
  "payloadpreview",
  "payloadpreviewhex",
  "raw",
  "rawbytes",
  "rawdata",
  "rawhex",
  "rawpayloadprefix",
  "rawpayloadprefixhex",
  "rawpreview",
  "rawpreviewhex",
  "rawpayload",
  "unknownpayloadprefix",
  "unknownpayloadprefixhex",
  "unknownprotocolprefix",
  "unknownprotocolprefixhex",
  "unknownprefix",
  "unknownprefixhex",
])

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const captureRuntime = yield* BinaryAnalysisRuntime.Service
    const protocolRuntime = yield* ProtocolInspectRuntime.Service
    const failure = (action: string, path: string) => (error: Error) =>
      new ToolFailure({ message: `${action} ${path}: ${error.message}` })

    yield* tools
      .register({
        protocol_inspect: Tool.make({
          description:
            "Inspect bounded packets from one offline PCAP or PCAPNG with the official libpcap capture path and the bundled protocol WebAssembly parser. Supports numeric classic BPF filters, packet offsets, and packet limits; raw packet payloads are never returned, and live capture, devices, paths, dumping, and network access are unavailable.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "protocol_inspect", context, mutation, fs, permission)
              const maxPackets = input.maxPackets ?? 64
              const capture = yield* captureRuntime
                .capture({
                  bytes: file.bytes,
                  filter: input.filter ?? "",
                  offset: input.offset ?? 0,
                  maxPackets,
                  maxPacketBytes: input.maxPacketBytes ?? 256,
                })
                .pipe(Effect.mapError(failure("Unable to capture packets from", input.path)))
              const packets = yield* Effect.forEach(
                capture.packets.slice(0, maxPackets),
                (packet) =>
                  Effect.gen(function* () {
                    const bytes = yield* decodePacket(packet.bytesHex)
                    const protocol = yield* protocolRuntime
                      .inspect({ bytes, linkType: capture.datalink })
                      .pipe(Effect.mapError(failure("Unable to inspect packet from", input.path)))
                    return {
                      number: packet.number,
                      seconds: packet.seconds,
                      microseconds: packet.microseconds,
                      capturedLength: packet.capturedLength,
                      originalLength: packet.originalLength,
                      bytesTruncated: packet.bytesTruncated,
                      protocol: boundedResult(protocol),
                    }
                  }),
                { concurrency: 1 },
              )
              const report = serializeReport({
                path: file.resource,
                datalink: capture.datalink,
                datalinkName: capture.datalinkName,
                datalinkDescription: capture.datalinkDescription,
                offset: capture.offset,
                nextOffset: capture.nextOffset,
                eof: capture.eof,
                packets,
                truncated: capture.nextOffset !== null || packets.length < capture.packets.length,
              })
              return { path: file.resource, report }
            }).pipe(Effect.mapError(toToolFailure(`Unable to inspect capture ${input.path}`))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/protocol-inspect",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    PermissionV2.node,
    BinaryAnalysisRuntime.node,
    ProtocolInspectRuntime.node,
  ],
})

function decodePacket(value: string) {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value))
    return Effect.fail(new Error("libpcap returned invalid packet bytes"))
  return Effect.succeed(Uint8Array.from(Buffer.from(value, "hex")))
}

function boundedResult(value: unknown) {
  const redacted = redactPayload(value)
  const encoded = JSON.stringify(redacted)
  if (encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_PACKET_RESULT_BYTES) return redacted
  return { truncated: true, warning: "Protocol result exceeded the per-packet output bound" }
}

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !payloadFields.has(normalizeKey(key)))
      .map(([key, nested]) => [key, redactPayload(nested)]),
  )
}

function normalizeKey(value: string) {
  return value.replaceAll("_", "").replaceAll("-", "").toLowerCase()
}

function serializeReport(input: {
  readonly path: string
  readonly datalink: number
  readonly datalinkName: string
  readonly datalinkDescription: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly eof: boolean
  readonly packets: ReadonlyArray<unknown>
  readonly truncated: boolean
}): string {
  const encoded = JSON.stringify(input, null, 2)
  if (Buffer.byteLength(encoded, "utf8") <= MAX_REPORT_BYTES) return encoded
  if (input.packets.length > 0)
    return serializeReport({ ...input, packets: input.packets.slice(0, -1), truncated: true })
  return JSON.stringify({ path: input.path, datalink: input.datalink, packets: [], truncated: true }, null, 2)
}

function toToolFailure(message: string) {
  return (error: unknown) =>
    error instanceof ToolFailure
      ? error
      : new ToolFailure({ message: error instanceof Error ? `${message}: ${error.message}` : message })
}
