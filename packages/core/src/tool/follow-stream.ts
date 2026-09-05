export * as FollowStream from "./follow-stream"

import { isIP } from "node:net"
import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { BinaryAnalysisRuntime } from "./binary-analysis-runtime"
import { read } from "./binary-file"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const IP = Schema.String.check(
  Schema.isMaxLength(45),
  Schema.makeFilter((value) => isIP(value) !== 0 && !value.includes("%")),
)
const Port = NonNegativeInt.check(Schema.isLessThanOrEqualTo(65535))
export const Input = Schema.Struct({
  path: Schema.NonEmptyString,
  sourceIP: IP,
  sourcePort: Port,
  destinationIP: IP,
  destinationPort: Port,
  maxPackets: PositiveInt.check(Schema.isLessThanOrEqualTo(256)).pipe(Schema.optional),
  maxPacketBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)).pipe(Schema.optional),
  maxBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(65536)).pipe(Schema.optional),
})

type Tuple = Pick<typeof Input.Type, "sourceIP" | "sourcePort" | "destinationIP" | "destinationPort">
type Segment = { sequence: number; bytes: Uint8Array; syn: boolean; fin: boolean; rst: boolean; declared: number }

// URL's IPv6 canonicalization is purely local; isIP rejects names, zones and URL syntax first.
function address(value: string) {
  if (!isIP(value) || value.includes("%")) throw new Error("Expected an unscoped IP literal")
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value
}

export function captureFilter(tuple: Tuple, datalink: number) {
  address(tuple.sourceIP)
  address(tuple.destinationIP)
  if (![tuple.sourcePort, tuple.destinationPort].every((port) => Number.isInteger(port) && port >= 0 && port <= 65535))
    throw new Error("Invalid TCP port")
  if (isIP(tuple.sourceIP) !== isIP(tuple.destinationIP)) throw new Error("Endpoints must use the same IP version")
  // Decimal byte-load comparisons avoid libpcap's getaddrinfo path and the wrapper's
  // alphabetic-token lexer (which rejects hexadecimal literals and IPv6 hex digits).
  const endpoints = (source: string, destination: string) =>
    [source, destination]
      .flatMap((value, index) => {
        if (isIP(value) === 4)
          return [
            `ip[${12 + index * 4}:4] = ${value.split(".").reduce((result, part) => result * 256 + Number(part), 0)}`,
          ]
        const halves = address(value)
          .slice(1, -1)
          .split("::")
          .map((half) => (half ? half.split(":") : []))
        const groups =
          halves.length === 1
            ? halves[0]!
            : [
                ...halves[0]!,
                ...Array.from({ length: 8 - halves[0]!.length - halves[1]!.length }, () => "0"),
                ...halves[1]!,
              ]
        return [0, 2, 4, 6].map(
          (word) =>
            `ip6[${8 + index * 16 + word * 2}:4] = ${parseInt(groups[word]!, 16) * 65536 + parseInt(groups[word + 1]!, 16)}`,
        )
      })
      .join(" and ")
  // Keep fragments and IPv6 extensions for explicit diagnostics rather than hiding them with a TCP-only BPF.
  const filter = `((${endpoints(tuple.sourceIP, tuple.destinationIP)}) or (${endpoints(tuple.destinationIP, tuple.sourceIP)})) and (tcp port ${tuple.sourcePort} or tcp port ${tuple.destinationPort} or ip proto 6 or ip6)`
  return datalink === 1 ? `(${filter}) or ether proto 33024 or ether proto 34984` : filter
}

function packet(bytes: Buffer, link: number, tuple: Tuple): (Segment & { direction: number }) | string | undefined {
  let offset = 0
  let protocol = 0
  if (link === 1) {
    if (bytes.length < 14) return "truncated Ethernet header"
    protocol = bytes.readUInt16BE(12)
    offset = 14
    let tags = 0
    while (protocol === 0x8100 || protocol === 0x88a8) {
      if (++tags > 4) return "unsupported VLAN nesting"
      if (bytes.length < offset + 4) return "truncated VLAN header"
      protocol = bytes.readUInt16BE(offset + 2)
      offset += 4
    }
    if (protocol !== 0x0800 && protocol !== 0x86dd) return "unsupported Ethernet protocol"
  } else if (![12, 101, 228, 229].includes(link)) return `unsupported linktype ${link}`
  if (bytes.length <= offset) return "truncated IP header"
  const version = bytes[offset]! >>> 4
  if ((protocol === 0x0800 || link === 228) && version !== 4) return "invalid IPv4 version"
  if ((protocol === 0x86dd || link === 229) && version !== 6) return "invalid IPv6 version"
  let source: string
  let destination: string
  let end: number
  if (version === 4) {
    if (bytes.length < offset + 20) return "truncated IPv4 header"
    const length = (bytes[offset]! & 15) * 4
    const total = bytes.readUInt16BE(offset + 2)
    if (length < 20 || total < length || bytes.length < offset + length) return "invalid or truncated IPv4 header"
    if ((bytes.readUInt16BE(offset + 6) & 0x3fff) !== 0) return "unsupported IPv4 fragment"
    if (bytes[offset + 9] !== 6) return undefined
    source = bytes.subarray(offset + 12, offset + 16).join(".")
    destination = bytes.subarray(offset + 16, offset + 20).join(".")
    end = offset + total
    offset += length
  } else if (version === 6) {
    if (bytes.length < offset + 40) return "truncated IPv6 header"
    if (bytes.readUInt16BE(offset + 4) === 0) return "unsupported IPv6 jumbogram"
    if (bytes[offset + 6] !== 6) return "unsupported IPv6 extension or non-TCP next header"
    const ipv6 = (start: number) =>
      address(Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(start + i * 2).toString(16)).join(":"))
    source = ipv6(offset + 8)
    destination = ipv6(offset + 24)
    end = offset + 40 + bytes.readUInt16BE(offset + 4)
    offset += 40
  } else return "unsupported IP version"
  if (end < offset + 20 || bytes.length < offset + 20) return "truncated TCP header"
  const length = (bytes[offset + 12]! >>> 4) * 4
  if (length < 20 || end < offset + length || bytes.length < offset + length) return "invalid or truncated TCP header"
  const sourcePort = bytes.readUInt16BE(offset)
  const destinationPort = bytes.readUInt16BE(offset + 2)
  const forward =
    source === address(tuple.sourceIP) &&
    destination === address(tuple.destinationIP) &&
    sourcePort === tuple.sourcePort &&
    destinationPort === tuple.destinationPort
  const reverse =
    source === address(tuple.destinationIP) &&
    destination === address(tuple.sourceIP) &&
    sourcePort === tuple.destinationPort &&
    destinationPort === tuple.sourcePort
  if (!forward && !reverse) return undefined
  return {
    direction: forward ? 0 : 1,
    sequence: bytes.readUInt32BE(offset + 4),
    syn: (bytes[offset + 13]! & 2) !== 0,
    fin: (bytes[offset + 13]! & 1) !== 0,
    rst: (bytes[offset + 13]! & 4) !== 0,
    declared: end - offset - length,
    bytes: bytes.subarray(offset + length, Math.min(end, bytes.length)),
  }
}

export function reassemble(segments: ReadonlyArray<Segment>, maxBytes: number) {
  const anchor = segments[0]?.sequence ?? 0
  const cells = new Map<number, number>()
  const state = {
    overlapBytes: 0,
    conflictingBytes: 0,
    outOfOrderPackets: 0,
    byteLimitReached: false,
    ambiguousSequence: false,
    high: -Infinity,
  }
  const syns = new Set<number>()
  let expectedStart: number | undefined
  let expectedEnd: number | undefined
  for (const segment of segments) {
    // Serial arithmetic supports wrap provided the observed connection spans less than half the sequence space.
    const start = ((segment.sequence - anchor) | 0) + Number(segment.syn)
    if (Math.abs(start) >= 0x7fffffff - 65536) state.ambiguousSequence = true
    if (segment.syn) {
      syns.add(segment.sequence)
      expectedStart = start
    }
    if (segment.bytes.length && start < state.high) state.outOfOrderPackets++
    state.high = Math.max(state.high, start)
    // FIN marks the payload boundary but consumes no payload byte. Later ACK-only
    // sequence numbers may include FIN's sequence-space byte, not missing data.
    if (segment.declared > 0 || segment.fin) expectedEnd = Math.max(expectedEnd ?? start, start + segment.declared)
    for (let i = 0; i < segment.bytes.length; i++) {
      const position = start + i
      const previous = cells.get(position)
      if (previous !== undefined) {
        state.overlapBytes++
        if (previous !== segment.bytes[i]) state.conflictingBytes++
        continue
      }
      if (cells.size >= maxBytes) {
        state.byteLimitReached = true
        continue
      }
      cells.set(position, segment.bytes[i]!)
    }
  }
  const ordered = [...cells.entries()].sort((a, b) => a[0] - b[0])
  const chunks: { sequenceStart: number; relativeStart: number; length: number; hex: string; text: string }[] = []
  const gaps: { sequenceStart: number; length: number }[] = []
  let previous = expectedStart ?? ordered[0]?.[0]
  for (const [position, byte] of ordered) {
    if (previous !== undefined && position > previous)
      gaps.push({ sequenceStart: (anchor + previous) >>> 0, length: position - previous })
    const last = chunks[chunks.length - 1]
    const chunk =
      last && last.relativeStart + last.length === position && last.length < 1024
        ? last
        : { sequenceStart: (anchor + position) >>> 0, relativeStart: position, length: 0, hex: "", text: "" }
    if (chunk !== last) chunks.push(chunk)
    chunk.length++
    chunk.hex += byte.toString(16).padStart(2, "0")
    chunk.text += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."
    previous = position + 1
  }
  if (previous !== undefined && expectedEnd !== undefined && expectedEnd > previous)
    gaps.push({ sequenceStart: (anchor + previous) >>> 0, length: expectedEnd - previous })
  return {
    chunks,
    gaps,
    recoveredBytes: cells.size,
    overlapBytes: state.overlapBytes,
    conflictingBytes: state.conflictingBytes,
    outOfOrderPackets: state.outOfOrderPackets,
    byteLimitReached: state.byteLimitReached,
    ambiguousSequence: state.ambiguousSequence,
    multipleConnections: syns.size > 1,
    synSeen: syns.size > 0,
    finSeen: segments.some((s) => s.fin),
    rstSeen: segments.some((s) => s.rst),
  }
}

export function reconstruct(capture: BinaryAnalysisRuntime.CaptureResult, tuple: Tuple, maxBytes = 65536) {
  const directions: [Segment[], Segment[]] = [[], []]
  const warnings = new Set<string>()
  if (![1, 12, 101, 228, 229].includes(capture.datalink)) warnings.add(`unsupported linktype ${capture.datalink}`)
  for (const item of capture.packets) {
    if (item.bytesTruncated || item.capturedLength < item.originalLength) warnings.add("capture packet bytes truncated")
    if (item.bytesHex.length % 2 || !/^[a-f0-9]*$/i.test(item.bytesHex)) {
      warnings.add("invalid packet hex")
      continue
    }
    const parsed = packet(Buffer.from(item.bytesHex, "hex"), capture.datalink, tuple)
    if (typeof parsed === "string") {
      warnings.add(parsed)
      continue
    }
    if (!parsed) continue
    if (parsed.bytes.length < parsed.declared) warnings.add("TCP payload truncated")
    directions[parsed.direction === 0 ? 0 : 1].push(parsed)
  }
  const streams = directions.map((segments, index) =>
    reassemble(segments, index === 0 ? Math.ceil(maxBytes / 2) : Math.floor(maxBytes / 2)),
  )
  const multipleConnections = streams.some((stream) => stream.multipleConnections)
  if (multipleConnections) warnings.add("Multiple SYN sequence numbers: tuple reused; refusing to merge connections")
  return {
    tuple,
    datalink: capture.datalink,
    packetsExamined: capture.packets.length,
    captureTruncated: !capture.eof || capture.nextOffset !== null,
    complete: false,
    limitations:
      "Observed bytes only; missing capture prefixes/suffixes and connection identity cannot be proven. Sequence ordering assumes a span below 2^31. First observed byte wins conflicting overlaps. Byte budget is split equally between directions.",
    warnings: [...warnings],
    directions: streams.map((stream, i) => ({
      direction: i === 0 ? "source-to-destination" : "destination-to-source",
      ...stream,
      chunks: multipleConnections ? [] : stream.chunks,
    })),
  }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* BinaryAnalysisRuntime.Service
    yield* tools
      .register({
        follow_stream: Tool.make({
          description:
            "Reconstruct observed TCP bytes for one explicit bidirectional IP/port tuple from an offline PCAP/PCAPNG. No network or execution. Defaults: 256 packets, 4096 bytes per packet, 65536 stream bytes split by direction. Gaps are never joined; conflicts, unsupported packets and truncation are reported. Output is bounded below 1 MiB and never claims completeness.",
          input: Input,
          output: Schema.Struct({ path: Schema.String, report: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.report }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "follow_stream", context, mutation, fs, permission)
              const header = yield* runtime.capture({
                bytes: file.bytes,
                filter: "",
                offset: 0,
                maxPackets: 1,
                maxPacketBytes: 0,
              })
              const filter = yield* Effect.try({
                try: () => captureFilter(input, header.datalink),
                catch: (error) => new Error(String(error)),
              })
              const capture = [1, 12, 101, 228, 229].includes(header.datalink)
                ? yield* runtime.capture({
                    bytes: file.bytes,
                    filter,
                    offset: 0,
                    maxPackets: input.maxPackets ?? 256,
                    maxPacketBytes: input.maxPacketBytes ?? 4096,
                  })
                : header
              const report = yield* Effect.try({
                try: () => JSON.stringify(reconstruct(capture, input, input.maxBytes ?? 65536)),
                catch: (error) => new Error(String(error)),
              })
              if (Buffer.byteLength(report) > 1024 * 1024)
                return yield* new ToolFailure({ message: "Stream report exceeds 1 MiB output bound" })
              return { path: file.resource, report }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to follow stream: ${String(error)}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/follow-stream",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, BinaryAnalysisRuntime.node],
})
