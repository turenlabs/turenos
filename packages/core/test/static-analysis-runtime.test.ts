import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { deflateRawSync } from "node:zlib"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { StaticAnalysisRuntime } from "@turenlabs/core/tool/static-analysis-runtime"
import { StaticAnalysisTools } from "@turenlabs/core/tool/static-analysis-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Effect, Layer } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(AppNodeBuilder.build(StaticAnalysisRuntime.node))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const names = [
  "identify_file",
  "hash_digest",
  "entropy_scan",
  "fuzzy_hash",
  "import_hash",
  "disassemble",
  "function_flow",
  "vba_extract",
  "dotnet_methods",
  "monodis",
  "scan_embedded",
  "detect_packer",
  "list_archive",
  "extract_archive_entry",
  "parse_pdf",
  "parse_ole",
  "office_inspect",
  "parse_exif",
  "parse_certificate",
  "parse_plist",
  "parse_lnk",
  "parse_minidump",
  "demangle_symbol",
  "parse_dotnet",
  "inspect_overlay",
]

describe("StaticAnalysisRuntime", () => {
  it.live("executes bounded security extensions without replacing legacy parsers", () =>
    Effect.gen(function* () {
      const runtime = yield* StaticAnalysisRuntime.Service
      const arm = yield* runtime.analyze({
        operation: "disassemble",
        bytes: Uint8Array.from([0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6]),
        options: { architecture: "arm64", length: 8, address: 4096 },
      })
      expect(arm.result).toMatchObject({
        architecture: "arm64",
        instructions: [
          { address: "0x1000", bytes: "1f2003d5", text: "nop" },
          { address: "0x1004", bytes: "c0035fd6", text: "ret" },
        ],
      })
      const flow = yield* runtime.analyze({
        operation: "function_flow",
        bytes: Uint8Array.from([0x90, 0xc3]),
        options: { length: 2 },
      })
      expect(flow.result).toMatchObject({ architecture: "x86_64", edges: [{ kind: "return" }] })
      const packer = yield* runtime.analyze({
        operation: "detect_packer",
        bytes: new TextEncoder().encode("UPX!"),
        options: {},
      })
      expect(packer.result).toMatchObject({
        ruleSet: { license: "MIT" },
        matches: [{ name: "UPX", confidence: "low" }],
      })
      const ar = new TextEncoder().encode("!<arch>\nhello/          0           0     0     100644  3         `\nabc\n")
      const listed = yield* runtime.analyze({ operation: "list_archive", bytes: ar, options: {} })
      expect(listed.result).toMatchObject({ format: "ar", entries: [{ name: "hello", size: 3 }] })
      const extracted = yield* runtime.analyze({
        operation: "extract_archive_entry",
        bytes: ar,
        options: { index: 0, maxOutputBytes: 3 },
      })
      expect(extracted.result).toMatchObject({ format: "ar", contentBase64: "YWJj" })
      for (const operation of ["vba_extract", "dotnet_methods"])
        expect(
          yield* runtime.analyze({ operation, bytes: Uint8Array.of(1), options: {} }).pipe(Effect.flip),
        ).toBeInstanceOf(Error)
    }),
  )

  it.live("executes identify, hash, disassemble, and archive WASM operations", () =>
    Effect.gen(function* () {
      const runtime = yield* StaticAnalysisRuntime.Service
      const identified = yield* runtime.analyze({
        operation: "identify_file",
        bytes: new TextEncoder().encode("%PDF-1.4\n"),
        options: {},
      })
      expect(identified).toMatchObject({ operation: "identify_file" })
      expect(identified.result).toMatchObject({ magic: "pdf" })

      const hashed = yield* runtime.analyze({
        operation: "hash_digest",
        bytes: new TextEncoder().encode("abc"),
        options: { algorithm: "sha256" },
      })
      expect(hashed.result).toMatchObject({
        algorithm: "sha256",
        digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      })

      const disassembled = yield* runtime.analyze({
        operation: "disassemble",
        bytes: Uint8Array.from([0x90, 0xc3]),
        options: { bitness: 64, length: 2 },
      })
      expect(
        (disassembled.result as { instructions: ReadonlyArray<{ text: string }> }).instructions.length,
      ).toBeGreaterThan(0)

      const listed = yield* runtime.analyze({
        operation: "list_archive",
        bytes: zipBytes({ "hello.txt": "hello wasm" }),
        options: {},
      })
      expect(listed.result).toMatchObject({ format: "zip" })

      const office = yield* runtime.analyze({
        operation: "office_inspect",
        bytes: zipBytes({
          "[Content_Types].xml":
            '<Types xmlns="urn:schemas-microsoft-com:package:2006"><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
          "word/_rels/document.xml.rels":
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.example.test/hyperlink" Target="https://example.test/payload" TargetMode="External"/></Relationships>',
          "word/vbaProject.bin": "synthetic macro marker",
        }),
        options: {},
      })
      expect(office.result).toMatchObject({
        format: "ooxml",
        detections: {
          macro: { status: "present" },
          externalLinks: { status: "present" },
        },
      })

      const monodis = yield* runtime.analyze({
        operation: "monodis",
        bytes: Uint8Array.of(1, 2, 3),
        options: {},
      })
      expect(monodis.result).toMatchObject({ text: expect.stringContaining("Error:") })
    }),
  )

  testEffect(Layer.empty).live("registers the shipped static-analysis tools", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/sample.pdf`, "%PDF-1.4\n%%EOF\n"))
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([...names].sort())
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_static_analysis_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-identify-file",
              name: "identify_file",
              input: { path: "sample.pdf" },
            },
          })
          expect(result.type).toBe("text")
          if (result.type === "text") expect(result.value).toContain('"magic": "pdf"')
          const header = [
            "empty/".padEnd(16),
            "0".padEnd(12),
            "0".padEnd(6),
            "0".padEnd(6),
            "100644".padEnd(8),
            "0".padEnd(10),
            "`\n",
          ].join("")
          yield* Effect.promise(() => fs.writeFile(`${tmp.path}/empty.ar`, `!<arch>\n${header}`))
          const extracted = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_static_analysis_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-extract-empty",
              name: "extract_archive_entry",
              input: { path: "empty.ar", outputPath: "empty.bin", index: 0 },
            },
          })
          expect(extracted.type).toBe("text")
          expect((yield* Effect.promise(() => fs.readFile(`${tmp.path}/empty.bin`))).length).toBe(0)
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                StaticAnalysisRuntime.node,
                StaticAnalysisTools.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                ],
                [PermissionV2.node, permission],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function zipBytes(files: Record<string, string>) {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + compressed.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(8, 8, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, compressed.length, true)
    view.setUint32(22, data.length, true)
    view.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(compressed, 30 + nameBytes.length)
    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, 8, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, compressed.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralStart = offset
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, locals.length, true)
  endView.setUint16(10, locals.length, true)
  endView.setUint32(
    12,
    centrals.reduce((sum, item) => sum + item.length, 0),
    true,
  )
  endView.setUint32(16, centralStart, true)
  const total =
    locals.reduce((sum, item) => sum + item.length, 0) +
    centrals.reduce((sum, item) => sum + item.length, 0) +
    end.length
  const output = new Uint8Array(total)
  let cursor = 0
  for (const part of [...locals, ...centrals, end]) {
    output.set(part, cursor)
    cursor += part.length
  }
  return output
}

function crc32(bytes: Uint8Array) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}
