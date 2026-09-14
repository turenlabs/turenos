import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { RtfInspectRuntime } from "@turenlabs/core/tool/rtf-inspect-runtime"
import { RtfInspectTools } from "@turenlabs/core/tool/rtf-inspect-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

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
const it = testEffect(Layer.empty)

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        RtfInspectRuntime.node,
        RtfInspectTools.node,
      ]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    ),
  )

// \'e9 and \u233 both decode to é; the ? after \u233 is the skipped \uc fallback.
const SAMPLE = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}Hello \'e9\u233?world}`
const OBJDATA_HEX = "d0cf11e0a1b11ae10000000000000000000000000000003e000300"
const EVIL =
  String.raw`{\rtf1\ansi{\object\objemb\objw810\objh740{\*\objclass Package}{\*\objdata ` +
  OBJDATA_HEX +
  String.raw`}}{\*\filetbl{\file\fid0 evil.scr}}{\field{\*\fldinst HYPERLINK "http://evil.example"}{\fldrslt click}}}`
const MALFORMED = String.raw`{\rtf1`

const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : undefined)

describe("RtfInspectRuntime and RtfInspectTools", () => {
  it.live("inspects, audits, and extracts RTF documents through a fresh rtf-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/sample.rtf`, SAMPLE),
              Bun.write(`${tmp.path}/evil.rtf`, EVIL),
              Bun.write(`${tmp.path}/malformed.rtf`, MALFORMED),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["rtf_inspect", "rtf_objects", "rtf_audit", "rtf_text"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_rtf_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspect = yield* call("call-rtf-inspect", "rtf_inspect", { path: "sample.rtf" })
          expect(inspect.type).toBe("text")
          const structure = parse(inspect.value)
          expect(structure.schema_version).toBe(1)
          expect(structure.valid_rtf).toBe(true)
          expect(structure.input_bytes).toBe(SAMPLE.length)
          expect(structure.rtf_version).toBe(1)
          expect(structure.groups.total).toBe(3)
          expect(structure.groups.max_depth).toBe(3)
          expect(structure.groups.unclosed).toBe(0)
          expect(structure.groups.trailing_bytes).toBe(0)
          expect(structure.control_words.total).toBe(5)
          expect(structure.control_words.top.map((row: { name: string }) => row.name)).toContain("fonttbl")
          expect(structure.font_table.count).toBe(1)
          expect(structure.font_table.fonts[0].name).toBe("Arial")
          expect("generator" in structure).toBe(true)
          expect(structure.generator).toBeNull()
          expect(structure.info).toEqual({})
          expect(structure.text_preview).toBe("Hello ééworld")

          const text = yield* call("call-rtf-text", "rtf_text", { path: "sample.rtf" })
          expect(text.type).toBe("text")
          const extracted = parse(text.value)
          expect(extracted.schema_version).toBe(1)
          expect(extracted.text).toBe("Hello ééworld")
          expect(extracted.chars).toBe(13)
          expect(extracted.truncated).toBe(false)

          const objects = yield* call("call-rtf-objects", "rtf_objects", { path: "evil.rtf" })
          expect(objects.type).toBe("text")
          const inventory = parse(objects.value)
          expect(inventory.schema_version).toBe(1)
          expect(inventory.object_count).toBe(1)
          expect(inventory.objects[0].objclass).toBe("Package")
          expect(inventory.objects[0].type).toBe("emb")
          expect(inventory.objects[0].objdata.ole_magic).toBe(true)
          expect(inventory.objects[0].objdata.decoded_bytes).toBe(OBJDATA_HEX.length / 2)
          expect(inventory.objects[0].objdata.preview_hex).toBe(OBJDATA_HEX.slice(0, 32))
          expect(inventory.objects[0].objdata.sha256).toMatch(/^[0-9a-f]{64}$/)
          expect(inventory.objects[0].objdata.payload_hex).toBeNull()

          const objectsInline = yield* call("call-rtf-objects-hex", "rtf_objects", {
            path: "evil.rtf",
            includePayloadHex: true,
          })
          expect(objectsInline.type).toBe("text")
          expect(parse(objectsInline.value).objects[0].objdata.payload_hex).toBe(OBJDATA_HEX)

          const audit = yield* call("call-rtf-audit", "rtf_audit", { path: "evil.rtf" })
          expect(audit.type).toBe("text")
          const findings = parse(audit.value)
          expect(findings.schema_version).toBe(1)
          expect(findings.valid_rtf).toBe(true)
          expect(findings.finding_count).toBeGreaterThanOrEqual(6)
          const kinds = findings.findings.map((finding: { kind: string }) => finding.kind)
          for (const kind of [
            "objdata_payload",
            "ole_compound_object",
            "suspicious_objclass",
            "file_table",
            "embedded_file",
            "field_external_ref",
          ])
            expect(kinds).toContain(kind)
          const ole = findings.findings.find((finding: { kind: string }) => finding.kind === "ole_compound_object")
          expect(ole.severity).toBe("high")
          expect(findings.stats.objects).toBe(1)
          expect(findings.stats.embedded_files).toBe(1)
          expect(findings.stats.fields).toBe(1)

          const malformed = yield* call("call-rtf-audit-malformed", "rtf_audit", { path: "malformed.rtf" })
          expect(malformed.type).toBe("text")
          const malformedReport = parse(malformed.value)
          expect(malformedReport.findings.map((finding: { kind: string }) => finding.kind)).toContain(
            "unbalanced_braces",
          )
          expect(malformedReport.stats.unclosed_groups).toBe(1)

          const malformedInspect = yield* call("call-rtf-inspect-malformed", "rtf_inspect", {
            path: "malformed.rtf",
          })
          expect(malformedInspect.type).toBe("text")
          expect(parse(malformedInspect.value).groups.unclosed).toBe(1)
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
