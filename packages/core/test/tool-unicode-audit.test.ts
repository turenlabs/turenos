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
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { UnicodeAuditRuntime } from "@turenlabs/core/tool/unicode-audit-runtime"
import { UnicodeAuditTools } from "@turenlabs/core/tool/unicode-audit-tools"
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
        UnicodeAuditRuntime.node,
        UnicodeAuditTools.node,
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

const encoder = new TextEncoder()

describe("UnicodeAuditRuntime and UnicodeAuditTools", () => {
  it.live("detects, stats, transcodes, and audits through a fresh unicode-audit worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(`${tmp.path}/utf8.txt`, encoder.encode("hello world\nlet π = 3;\n")),
          )
          // UTF-16LE with BOM: "hi"
          yield* Effect.promise(() =>
            Bun.write(`${tmp.path}/utf16le.txt`, new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])),
          )
          // cp1252 "café" — 0xE9 e-acute defeats UTF-8.
          yield* Effect.promise(() =>
            Bun.write(`${tmp.path}/legacy.txt`, new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
          )
          // CVE-2021-42574 shape: RLO + isolates reorder a comment's display.
          yield* Effect.promise(() =>
            Bun.write(
              `${tmp.path}/trojan.js`,
              encoder.encode(
                "if (admin) {\n    /* begin \u202E } \u2066 return true ; \u2069 end */\n    return false;\n}\n",
              ),
            ),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["text_detect", "text_stats", "text_transcode", "unicode_audit"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_unicode_audit_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const detected = yield* call("call-text-detect", "text_detect", { path: "utf8.txt" })
          expect(detected.type).toBe("text")
          if (detected.type !== "text") return
          const detect = JSON.parse(String(detected.value)) as {
            encoding?: string
            utf8_valid?: boolean
            confidence?: string
          }
          expect(detect.encoding).toBe("UTF-8")
          expect(detect.utf8_valid).toBe(true)
          expect(detect.confidence).toBe("high")

          const detected16 = yield* call("call-text-detect-16", "text_detect", { path: "utf16le.txt" })
          expect(detected16.type).toBe("text")
          if (detected16.type !== "text") return
          expect(detected16.value).toContain('"bom": "utf-16le"')
          expect(detected16.value).toContain('"encoding": "UTF-16LE"')

          const stats = yield* call("call-text-stats", "text_stats", { path: "utf8.txt" })
          expect(stats.type).toBe("text")
          if (stats.type !== "text") return
          const statReport = JSON.parse(String(stats.value)) as {
            lines?: number
            scripts?: Array<{ script: string }>
          }
          expect(statReport.lines).toBe(2)
          expect(statReport.scripts?.map((entry) => entry.script)).toContain("Greek")

          const transcoded = yield* call("call-text-transcode", "text_transcode", {
            path: "legacy.txt",
            from: "windows-1252",
          })
          expect(transcoded.type).toBe("text")
          if (transcoded.type !== "text") return
          const transcode = JSON.parse(String(transcoded.value)) as {
            from?: string
            text?: string
            had_errors?: boolean
          }
          expect(transcode.from).toBe("windows-1252")
          expect(transcode.text).toBe("café")
          expect(transcode.had_errors).toBe(false)

          const audited = yield* call("call-unicode-audit", "unicode_audit", { path: "trojan.js" })
          expect(audited.type).toBe("text")
          if (audited.type !== "text") return
          const audit = JSON.parse(String(audited.value)) as {
            risk?: string
            findings?: Array<{ kind: string; name?: string; line?: number }>
          }
          expect(audit.risk).toBe("high")
          const bidi = audit.findings?.filter((finding) => finding.kind === "bidi_control") ?? []
          expect(bidi.length).toBe(3)
          expect(bidi.map((finding) => finding.name)).toContain("RIGHT-TO-LEFT OVERRIDE")

          const clean = yield* call("call-unicode-audit-clean", "unicode_audit", { path: "utf8.txt" })
          expect(clean.type).toBe("text")
          if (clean.type !== "text") return
          expect(clean.value).toContain('"risk": "none"')

          const failed = yield* call("call-text-transcode-bad", "text_transcode", {
            path: "utf8.txt",
            from: "bogus-enc",
          })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
