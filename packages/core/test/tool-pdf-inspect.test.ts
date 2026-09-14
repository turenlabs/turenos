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
import { PdfInspectRuntime } from "@turenlabs/core/tool/pdf-inspect-runtime"
import { PdfInspectTools } from "@turenlabs/core/tool/pdf-inspect-tools"
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
        PdfInspectRuntime.node,
        PdfInspectTools.node,
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

// Minimal PDF with a correct xref table. Objects are [id, body]; stream bodies
// are { dict, content }.
function buildPdf(objects: ReadonlyArray<readonly [number, string | { dict?: string; content: Uint8Array }]>) {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const push = (part: string | Uint8Array) => parts.push(typeof part === "string" ? encoder.encode(part) : part)
  const size = () => parts.reduce((total, part) => total + part.length, 0)
  push("%PDF-1.5\n")
  const offsets: Array<readonly [number, number]> = []
  for (const [id, body] of objects) {
    offsets.push([id, size()])
    push(`${id} 0 obj\n`)
    if (typeof body === "string") push(body)
    else {
      push(`<< ${body.dict ?? ""} /Length ${body.content.length} >>\nstream\n`)
      push(body.content)
      push("\nendstream")
    }
    push("\nendobj\n")
  }
  const xref = size()
  const max = objects.length + 1
  push(`xref\n0 ${max}\n0000000000 65535 f \n`)
  for (const [, offset] of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  push(`trailer\n<< /Size ${max} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  const out = new Uint8Array(size())
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const pageContent = new TextEncoder().encode("BT /F1 12 Tf 100 700 Td (Hello Turen) Tj ET")

const pdf = buildPdf([
  [1, "<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(boot) 6 0 R] >> >> >>"],
  [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
  [
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ],
  [4, { content: pageContent }],
  [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  [6, "<< /Type /Action /S /JavaScript /JS (app.alert('x')) >>"],
])

describe("PdfInspectRuntime and PdfInspectTools", () => {
  it.live("inspects, lists objects, decodes streams, and extracts text through a fresh pdf-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/sample.pdf`, pdf))
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.pdf`, "definitely not a pdf"))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["pdf_inspect", "pdf_objects", "pdf_stream_decode", "pdf_text"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_pdf_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspect = yield* call("call-pdf-inspect", "pdf_inspect", { path: "sample.pdf" })
          expect(inspect.type).toBe("text")
          if (inspect.type !== "text") return
          expect(inspect.value).toContain('"schema_version": 1')
          expect(inspect.value).toContain('"page_count": 1')
          expect(inspect.value).toContain('"object_count": 6')
          expect(inspect.value).toContain('"encrypted": false')
          expect(inspect.value).toContain('"open_action"')
          expect(inspect.value).toContain('"javascript"')

          const objects = yield* call("call-pdf-objects", "pdf_objects", { path: "sample.pdf" })
          expect(objects.type).toBe("text")
          if (objects.type !== "text") return
          expect(objects.value).toContain('"object_count": 6')
          expect(objects.value).toContain('"returned": 6')

          const fonts = yield* call("call-pdf-objects-font", "pdf_objects", {
            path: "sample.pdf",
            type: "font",
          })
          expect(fonts.type).toBe("text")
          if (fonts.type !== "text") return
          expect(fonts.value).toContain('"returned": 1')
          expect(fonts.value).toContain('"subtype": "Type1"')

          const decoded = yield* call("call-pdf-stream-decode", "pdf_stream_decode", {
            path: "sample.pdf",
            objectId: 4,
          })
          expect(decoded.type).toBe("text")
          if (decoded.type !== "text") return
          expect(decoded.value).toContain(`"decoded_length": ${pageContent.length}`)
          const report = JSON.parse(decoded.value as string) as { data_base64?: string }
          expect(report.data_base64).toBe(Buffer.from(pageContent).toString("base64"))

          const text = yield* call("call-pdf-text", "pdf_text", { path: "sample.pdf" })
          expect(text.type).toBe("text")
          if (text.type !== "text") return
          expect(text.value).toContain("Hello Turen")
          expect(text.value).toContain('"page_count": 1')

          const failed = yield* call("call-pdf-inspect-garbage", "pdf_inspect", { path: "garbage.pdf" })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
