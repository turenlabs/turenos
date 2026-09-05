import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { BinaryAnalysisRuntime } from "@turenlabs/core/tool/binary-analysis-runtime"
import { FollowStream } from "@turenlabs/core/tool/follow-stream"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"

const tuple = { sourceIP: "10.0.0.1", sourcePort: 1234, destinationIP: "10.0.0.2", destinationPort: 80 }
const it = testEffect(AppNodeBuilder.build(BinaryAnalysisRuntime.node))
const segment = (sequence: number, text: string, syn = false) => ({
  sequence,
  bytes: Buffer.from(text),
  syn,
  fin: false,
  rst: false,
  declared: text.length,
})

function tcp(
  sequence: number,
  text: string,
  options: {
    reverse?: boolean
    syn?: boolean
    fin?: boolean
    vlan?: boolean
    ipv6?: boolean
    fragment?: boolean
    extension?: boolean
  } = {},
) {
  const ethernet = options.vlan ? 18 : 14
  const ip = options.ipv6 ? 40 : 20
  const bytes = Buffer.alloc(ethernet + ip + 20 + text.length)
  bytes.writeUInt16BE(options.vlan ? 0x8100 : options.ipv6 ? 0x86dd : 0x0800, 12)
  if (options.vlan) bytes.writeUInt16BE(options.ipv6 ? 0x86dd : 0x0800, 16)
  if (options.ipv6) {
    bytes[ethernet] = 0x60
    bytes.writeUInt16BE(20 + text.length, ethernet + 4)
    bytes[ethernet + 6] = options.extension ? 44 : 6
    bytes[ethernet + 23] = options.reverse ? 2 : 1
    bytes[ethernet + 39] = options.reverse ? 1 : 2
  } else {
    bytes[ethernet] = 0x45
    bytes.writeUInt16BE(ip + 20 + text.length, ethernet + 2)
    bytes.writeUInt16BE(options.fragment ? 0x2000 : 0, ethernet + 6)
    bytes[ethernet + 9] = 6
    bytes.set([10, 0, 0, options.reverse ? 2 : 1, 10, 0, 0, options.reverse ? 1 : 2], ethernet + 12)
  }
  bytes.writeUInt16BE(options.reverse ? 80 : 1234, ethernet + ip)
  bytes.writeUInt16BE(options.reverse ? 1234 : 80, ethernet + ip + 2)
  bytes.writeUInt32BE(sequence, ethernet + ip + 4)
  bytes[ethernet + ip + 12] = 0x50
  bytes[ethernet + ip + 13] = options.syn
    ? options.reverse
      ? 0x12
      : 2
    : 0x10 | (options.fin ? 1 : 0) | (text.length ? 8 : 0)
  bytes.write(text, ethernet + ip + 20)
  return bytes
}

function pcap(packets: Buffer[], link = 1) {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(0xa1b2c3d4)
  header.writeUInt16LE(2, 4)
  header.writeUInt16LE(4, 6)
  header.writeUInt32LE(65535, 16)
  header.writeUInt32LE(link, 20)
  return Buffer.concat([
    header,
    ...packets.flatMap((packet, i) => {
      const record = Buffer.alloc(16)
      record.writeUInt32LE(1700000000 + i)
      record.writeUInt32LE(packet.length, 8)
      record.writeUInt32LE(packet.length, 12)
      return [record, packet]
    }),
  ])
}

function capture(packets: Buffer[], datalink = 1): BinaryAnalysisRuntime.CaptureResult {
  return {
    datalink,
    datalinkName: "fixture",
    datalinkDescription: "fixture",
    offset: 0,
    nextOffset: null,
    eof: true,
    packets: packets.map((bytes, number) => ({
      number,
      seconds: 0,
      microseconds: 0,
      capturedLength: bytes.length,
      originalLength: bytes.length,
      bytesHex: bytes.toString("hex"),
      bytesTruncated: false,
    })),
  }
}

describe("follow_stream", () => {
  test("rejects hostnames, filter injection, scoped IPv6 and invalid ports", () => {
    const decode = Schema.decodeUnknownSync(FollowStream.Input)
    for (const sourceIP of ["example.com", "10.0.0.1 or ip", "fe80::1%en0"])
      expect(() => decode({ path: "a.pcap", ...tuple, sourceIP })).toThrow()
    expect(() => decode({ path: "a.pcap", ...tuple, sourcePort: 65536 })).toThrow()
    expect(() => FollowStream.captureFilter({ ...tuple, destinationIP: "::1" }, 1)).toThrow()
  })

  test("orders retransmission/out-of-order bytes, consumes SYN, and flags conflicting overlaps", () => {
    const result = FollowStream.reassemble(
      [segment(99, "", true), segment(103, "def"), segment(100, "abc"), segment(102, "Xde")],
      100,
    )
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["abcdef"])
    expect(result.chunks[0]?.sequenceStart).toBe(100)
    expect(result.gaps).toEqual([])
    expect(result.overlapBytes).toBe(3)
    expect(result.conflictingBytes).toBe(1)
    expect(result.outOfOrderPackets).toBeGreaterThan(0)
  })

  test("keeps gaps separate and reports missing tail bytes", () => {
    const result = FollowStream.reassemble([segment(100, "ab"), { ...segment(105, "xy"), declared: 4 }], 100)
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["ab", "xy"])
    expect(result.gaps).toEqual([
      { sequenceStart: 102, length: 3 },
      { sequenceStart: 107, length: 2 },
    ])
  })

  test("handles sequence wrap and bounded byte retention", () => {
    const result = FollowStream.reassemble([segment(0xfffffffe, "ab"), segment(0, "cd")], 100)
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["abcd"])
    expect(result.gaps).toEqual([])
    expect(FollowStream.reassemble([segment(1, "abcdef")], 2)).toMatchObject({
      recoveredBytes: 2,
      byteLimitReached: true,
    })
  })

  test("rejects tuple reuse rather than merging distinct SYN epochs", () => {
    const result = FollowStream.reconstruct(
      capture([tcp(10, "one", { syn: true }), tcp(100, "two", { syn: true })]),
      tuple,
    )
    expect(result.directions[0]?.multipleConnections).toBe(true)
    expect(result.directions[0]?.chunks).toEqual([])
  })

  test("safely reports unsupported links, fragments, extensions and malformed headers", () => {
    expect(FollowStream.reconstruct(capture([tcp(1, "x")], 113), tuple).warnings).toContain("unsupported linktype 113")
    expect(FollowStream.reconstruct(capture([tcp(1, "x", { fragment: true })]), tuple).warnings).toContain(
      "unsupported IPv4 fragment",
    )
    expect(FollowStream.reconstruct(capture([tcp(1, "x", { ipv6: true, extension: true })]), tuple).warnings).toContain(
      "unsupported IPv6 extension or non-TCP next header",
    )
    for (let length = 0; length < 54; length++) {
      const result = FollowStream.reconstruct(capture([tcp(1, "x").subarray(0, length)]), tuple)
      expect(result.directions[0]?.chunks).toEqual([])
    }
  })

  it.live("uses actual libpcap BPF and reconstructs both directions without unrelated ports", () =>
    Effect.gen(function* () {
      const runtime = yield* BinaryAnalysisRuntime.Service
      const unrelated = tcp(500, "not selected")
      unrelated.writeUInt16BE(443, 36)
      const result = yield* runtime.capture({
        bytes: pcap([
          tcp(100, "abc"),
          tcp(900, "reply", { reverse: true }),
          unrelated,
          tcp(103, "def", { vlan: true }),
        ]),
        filter: FollowStream.captureFilter(tuple, 1),
        offset: 0,
        maxPackets: 256,
        maxPacketBytes: 4096,
      })
      const stream = FollowStream.reconstruct(result, tuple)
      expect(stream.directions[0]?.chunks.map((chunk) => chunk.text)).toEqual(["abcdef"])
      expect(stream.directions[1]?.chunks.map((chunk) => chunk.text)).toEqual(["reply"])
      expect(stream.complete).toBe(false)
    }),
  )

  it.live("does not count FIN sequence space as a gap after a complete FIN exchange", () =>
    Effect.gen(function* () {
      const runtime = yield* BinaryAnalysisRuntime.Service
      const packets = [
        tcp(100, "", { syn: true }),
        tcp(900, "", { syn: true, reverse: true }),
        tcp(101, ""),
        tcp(101, "A"),
        tcp(901, "B", { reverse: true }),
        tcp(102, "", { fin: true }),
        tcp(902, "", { reverse: true }),
        tcp(902, "", { fin: true, reverse: true }),
        tcp(103, ""),
      ]
      const result = yield* runtime.capture({
        bytes: pcap(packets),
        filter: FollowStream.captureFilter(tuple, 1),
        offset: 0,
        maxPackets: 256,
        maxPacketBytes: 4096,
      })
      const stream = FollowStream.reconstruct(result, tuple)
      expect(stream.directions.map((direction) => direction.chunks.map((chunk) => chunk.text))).toEqual([["A"], ["B"]])
      expect(stream.directions.map((direction) => direction.gaps)).toEqual([[], []])
      expect(stream.directions.every((direction) => direction.finSeen)).toBe(true)
      // A FIN still supplies evidence of missing payload before its sequence number.
      expect(
        FollowStream.reassemble([segment(100, "", true), { ...segment(103, ""), fin: true }, segment(104, "")], 100)
          .gaps,
      ).toEqual([{ sequenceStart: 101, length: 2 }])
    }),
  )

  it.live("supports raw IPv4/IPv6 with actual libpcap and reports acquisition limits", () =>
    Effect.gen(function* () {
      const runtime = yield* BinaryAnalysisRuntime.Service
      for (const ipv6 of [false, true]) {
        const selected = ipv6 ? { ...tuple, sourceIP: "::1", destinationIP: "0:0:0:0:0:0:0:2" } : tuple
        const result = yield* runtime.capture({
          bytes: pcap([tcp(100, "abc", { ipv6 }).subarray(14), tcp(103, "def", { ipv6 }).subarray(14)], 101),
          filter: FollowStream.captureFilter(selected, 12),
          offset: 0,
          maxPackets: 1,
          maxPacketBytes: 4096,
        })
        const stream = FollowStream.reconstruct(result, selected)
        expect(stream.directions[0]?.chunks.map((chunk) => chunk.text)).toEqual(["abc"])
        expect(stream.captureTruncated).toBe(true)
      }
      const result = yield* runtime.capture({
        bytes: pcap([tcp(100, "abcdef")]),
        filter: FollowStream.captureFilter(tuple, 1),
        offset: 0,
        maxPackets: 256,
        maxPacketBytes: 56,
      })
      const stream = FollowStream.reconstruct(result, tuple)
      expect(stream.warnings).toContain("capture packet bytes truncated")
      expect(stream.directions[0]?.gaps).toEqual([{ sequenceStart: 102, length: 4 }])
    }),
  )
})
