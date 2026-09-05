import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { EmailSecurityRuntime } from "@turenlabs/core/tool/email-security-runtime"
import { EmailSecurityTools } from "@turenlabs/core/tool/email-security-tools"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import fs from "node:fs/promises"
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

describe("EmailSecurityTools", () => {
  it.live("parses a multipart message through bundled email-security WASM", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              `${tmp.path}/message.eml`,
              [
                'From: "Alice Example" <alice@example.test>',
                "To: Bob <bob@example.test>",
                "Reply-To: reply@other.test",
                "Date: Sat, 29 Aug 2026 12:00:00 +0000",
                "Message-ID: <fixture@example.test>",
                "Subject: =?UTF-8?B?VGVzdCBFbWFpbA==?=",
                "Authentication-Results: mx.example.test; spf=fail; dkim=fail; dmarc=fail",
                'Content-Type: multipart/mixed; boundary="fixture-boundary"',
                "",
                "--fixture-boundary",
                "Content-Type: text/plain; charset=utf-8",
                "",
                "Review https://user:pass@192.168.1.10/download/invoice.exe and contact security@example.test.",
                "--fixture-boundary",
                "Content-Type: text/html; charset=utf-8",
                "",
                '<p onclick="alert(1)">Review <a href="javascript:alert(2)">this</a> <a href="https://example.test/login">https://display.test/login</a>.</p><script>alert(3)</script>',
                "--fixture-boundary",
                'Content-Type: text/plain; name="invoice.exe"',
                'Content-Disposition: attachment; filename="invoice.exe"',
                "Content-Transfer-Encoding: base64",
                "",
                "TVZIRUxMTw==",
                "--fixture-boundary--",
                "",
              ].join("\r\n"),
            ),
          )
          const registry = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
            "email_inspect",
            "email_attachment_inspect",
            "email_extract_attachment",
            "email_link_analyze",
            "email_sanitize_html",
          ])
          const result = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_email_security_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-email-inspect",
              name: "email_inspect",
              input: { path: "message.eml", includeBodies: true },
            },
          })
          expect(result.type).toBe("text")
          if (result.type !== "text") return
          expect(result.value).toContain('"subject": "Test Email"')
          expect(result.value).toContain('"name": "invoice.exe"')
          expect(result.value).toContain("https://example.test/login")
          expect(result.value).toContain("dmarc_fail_advertised")

          const attachment = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_email_attachment_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-email-attachment",
              name: "email_attachment_inspect",
              input: { path: "message.eml", attachmentIndex: 0 },
            },
          })
          expect(attachment.type).toBe("text")
          if (attachment.type !== "text") return
          expect(attachment.value).toContain('"filename": "invoice.exe"')
          expect(attachment.value).toContain('"mime_filename_mismatch": true')
          expect(attachment.value).toContain("use email_extract_attachment")

          const links = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_email_links_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-email-links",
              name: "email_link_analyze",
              input: { path: "message.eml", maxLinks: 16 },
            },
          })
          expect(links.type).toBe("text")
          if (links.type !== "text") return
          if (typeof links.value !== "string") return
          expect(links.value).toContain('"scheme": "javascript"')
          expect(links.value).toContain('"host": "192.168.1.10"')
          expect(links.value).toContain('"userinfo": true')
          expect(links.value).toContain('"ip_literal": true')
          expect(links.value).toContain('"suspicious_extension": true')
          expect(links.value).toContain("display_target_mismatch")
          expect(links.value).toContain("no URL was dereferenced")
          expect(links.value).toContain("cryptographic verification are not performed")
          expect(links.value.length).toBeLessThanOrEqual(32 * 1024)

          const sanitized = yield* executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_email_sanitize_test"),
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-email-sanitize",
              name: "email_sanitize_html",
              input: { path: "message.eml" },
            },
          })
          expect(sanitized.type).toBe("text")
          if (sanitized.type !== "text") return
          expect(sanitized.value).toContain('href="https://example.test/login"')
          expect(sanitized.value).not.toContain("javascript:")
          expect(sanitized.value).not.toContain("onclick")
          expect(sanitized.value).not.toContain("alert(3)")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                EmailSecurityRuntime.node,
                EmailSecurityTools.node,
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
