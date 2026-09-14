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
import { CodeSigningRuntime } from "@turenlabs/core/tool/code-signing-runtime"
import { CodeSigningTools } from "@turenlabs/core/tool/code-signing-tools"
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

// DER fixtures ported from wasm-tools tools/code-signing/test/verify.mjs (the
// same deterministic blobs src/fixtures.rs produces).
const b64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"))
const CERT = b64(
  "MIIBjDCCAXKgAwIBAgIDAQIDMA0GCSqGSIb3DQEBCwUAMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MB4XDTI1MDEwMTAwMDAwMFoXDTM1MDEwMTAwMDAwMFowKzEUMBIGA1UEAwwLVGVzdCBTaWduZXIxEzARBgNVBAoMClR1cmVuIFRlc3QwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAwMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wIDAQABo38wfTAMBgNVHRMEBTADAQEAMA4GA1UdDwEB/wQEAwIHgDAdBgNVHSUEFjAUBggrBgEFBQcDAwYIKwYBBQUHAwgwHQYDVR0OBBYEFBERERERERERERERERERERERERERMB8GA1UdIwQYMBaAFBERERERERERERERERERERERERERMA0GCSqGSIb3DQEBCwUAAwUA3q2+7w==",
)
const CRL = b64(
  "MIHoMIHRAgEBMA0GCSqGSIb3DQEBCwUAMCcxEDAOBgNVBAMMB1Rlc3QgQ0ExEzARBgNVBAoMClR1cmVuIFRlc3QXDTI1MDEwMTAwMDAwMFoXDTI2MDEwMTAwMDAwMFowZjAgAgEKFw0yNTAzMDEwMDAwMDBaMAwwCgYDVR0VBAMKAQEwIAIBCxcNMjUwMzAxMDAwMDAwWjAMMAoGA1UdFQQDCgEBMCACAQwXDTI1MDMwMTAwMDAwMFowDDAKBgNVHRUEAwoBAaAOMAwwCgYDVR0UBAMCAQcwDQYJKoZIhvcNAQELBQADAwDK/g==",
)
const CMS = b64(
  "MIIC6AYJKoZIhvcNAQcCoIIC2TCCAtUCAQExDzANBglghkgBZQMEAgEFADAjBgkqhkiG9w0BBwGgFgQUaGVsbG8gc2lnbmVkIGNvbnRlbnSgggGQMIIBjDCCAXKgAwIBAgIDAQIDMA0GCSqGSIb3DQEBCwUAMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MB4XDTI1MDEwMTAwMDAwMFoXDTM1MDEwMTAwMDAwMFowKzEUMBIGA1UEAwwLVGVzdCBTaWduZXIxEzARBgNVBAoMClR1cmVuIFRlc3QwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAwMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wIDAQABo38wfTAMBgNVHRMEBTADAQEAMA4GA1UdDwEB/wQEAwIHgDAdBgNVHSUEFjAUBggrBgEFBQcDAwYIKwYBBQUHAwgwHQYDVR0OBBYEFBERERERERERERERERERERERERERMB8GA1UdIwQYMBaAFBERERERERERERERERERERERERERMA0GCSqGSIb3DQEBCwUAAwUA3q2+7zGCAQQwggEAAgEBMDAwKzEUMBIGA1UEAwwLVGVzdCBJc3N1ZXIxEzARBgNVBAoMClR1cmVuIFRlc3QCASowDQYJYIZIAWUDBAIBBQCgaTAYBgkqhkiG9w0BCQMxCwYJKoZIhvcNAQcBMBwGCSqGSIb3DQEJBTEPFw0yNTA2MDEwMDAwMDBaMC8GCSqGSIb3DQEJBDEiBCDjaG+mNxOFeQ2XEg96WidfX4uqHrK9lkAlXgw0Gx9gNDANBgkqhkiG9w0BAQsFAARAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==",
)
const PE_SIGNED = b64(
  "TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQRQAAZIYAAAAAAAAAAAAAAAAAAPAAIgALAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAgAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8EAAAAAgIAMIIEcwYJKoZIhvcNAQcCoIIEZDCCBGACAQExDzANBglghkgBZQMEAgEFADBpBgorBgEEAYI3AgEEoFsEWTBXMCIGCisGAQQBgjcCAQ+gFDASAwIAAKIMMAqBCHRlc3QuZXhlMDEwDQYJYIZIAWUDBAIBBQAEIFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVoIIBkDCCAYwwggFyoAMCAQICAwECAzANBgkqhkiG9w0BAQsFADArMRQwEgYDVQQDDAtUZXN0IFNpZ25lcjETMBEGA1UECgwKVHVyZW4gVGVzdDAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMDBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8CAwEAAaN/MH0wDAYDVR0TBAUwAwEBADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMIMB0GA1UdDgQWBBQRERERERERERERERERERERERERETAfBgNVHSMEGDAWgBQRERERERERERERERERERERERERETANBgkqhkiG9w0BAQsFAAMFAN6tvu8xggJJMIICRQIBATAwMCsxFDASBgNVBAMMC1Rlc3QgSXNzdWVyMRMwEQYDVQQKDApUdXJlbiBUZXN0AgEqMA0GCWCGSAFlAwQCAQUAoGkwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjUwNjAxMDAwMDAwWjAvBgkqhkiG9w0BCQQxIgQgFDFU6ZGdlshxCikp2r7gm/lmO8E+vQYpyV9ywMUhwXUwDQYJKoZIhvcNAQELBQAEQKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhggFBMCgGCisGAQQBgjcCAwIxGgQYmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZMIIBEwYJKoZIhvcNAQkGMYIBBDCCAQACAQEwMDArMRQwEgYDVQQDDAtUZXN0IElzc3VlcjETMBEGA1UECgwKVHVyZW4gVGVzdAIBCTANBglghkgBZQMEAgEFAKBpMBgGCSqGSIb3DQEJAzELBgkqhkiG9w0BBwEwHAYJKoZIhvcNAQkFMQ8XDTI1MDYwMTAwMDAwMFowLwYJKoZIhvcNAQkEMSIEIEJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCMA0GCSqGSIb3DQEBCwUABECqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAA==",
)
const MACHO_SIGNED = b64(
  "z/rt/gwAAAEAAAAAAgAAAAEAAAAQAAAAAAAAAAAAAAAdAAAAEAAAAGAAAABDBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+t4MwAAABEMAAAAEAAAAAAAAACwAAAACAAAAzAAAAAUAAADUAAEAAAAAAU/63gwCAAAAoAACAwAAAAACAAAAYAAAAEAAAAABAAAAAgAAEAAgAgAMAAAAAAAAAAAAAABPAAAAAAAAAAAAAAAAY29tLnR1cmVuLnRlc3QAVEVBTUlEOTkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+t4MAQAAAAj63nFxAAAAezw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPjxkaWN0PjxrZXk+Y29tLmV4YW1wbGUudGVzdDwva2V5Pjx0cnVlLz48L2RpY3Q+PC9wbGlzdD763gsBAAAC9DCCAugGCSqGSIb3DQEHAqCCAtkwggLVAgEBMQ8wDQYJYIZIAWUDBAIBBQAwIwYJKoZIhvcNAQcBoBYEFGhlbGxvIHNpZ25lZCBjb250ZW50oIIBkDCCAYwwggFyoAMCAQICAwECAzANBgkqhkiG9w0BAQsFADArMRQwEgYDVQQDDAtUZXN0IFNpZ25lcjETMBEGA1UECgwKVHVyZW4gVGVzdDAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMDBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8CAwEAAaN/MH0wDAYDVR0TBAUwAwEBADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMIMB0GA1UdDgQWBBQRERERERERERERERERERERERERETAfBgNVHSMEGDAWgBQRERERERERERERERERERERERERETANBgkqhkiG9w0BAQsFAAMFAN6tvu8xggEEMIIBAAIBATAwMCsxFDASBgNVBAMMC1Rlc3QgSXNzdWVyMRMwEQYDVQQKDApUdXJlbiBUZXN0AgEqMA0GCWCGSAFlAwQCAQUAoGkwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjUwNjAxMDAwMDAwWjAvBgkqhkiG9w0BCQQxIgQg42hvpjcThXkNlxIPelonX1+Lqh6yvZZAJV4MNBsfYDQwDQYJKoZIhvcNAQELBQAEQKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=",
)

describe("CodeSigningRuntime and CodeSigningTools", () => {
  it.live("inspects signing structures through a fresh code-signing worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/cert.der`, CERT),
              Bun.write(`${tmp.path}/list.crl`, CRL),
              Bun.write(`${tmp.path}/blob.p7b`, CMS),
              Bun.write(`${tmp.path}/signed.exe`, PE_SIGNED),
              Bun.write(`${tmp.path}/signed.macho`, MACHO_SIGNED),
              Bun.write(`${tmp.path}/garbage.der`, new TextEncoder().encode("not a certificate")),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["cert_inspect", "crl_inspect", "macho_codesign", "pe_authenticode", "pkcs7_inspect"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_code_signing_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const cert = yield* call("call-cert-inspect", "cert_inspect", { path: "cert.der" })
          expect(cert.type).toBe("text")
          if (cert.type !== "text") return
          expect(cert.value).toContain('"schema_version": 1')
          expect(cert.value).toContain('"count": 1')
          expect(cert.value).toContain('"subject": "CN=Test Signer, O=Turen Test"')
          expect(cert.value).toContain('"serial_hex": "010203"')
          expect(cert.value).toContain('"code_signing": true')
          expect(cert.value).toContain('"fingerprint_sha256"')

          const pkcs7 = yield* call("call-pkcs7-inspect", "pkcs7_inspect", { path: "blob.p7b" })
          expect(pkcs7.type).toBe("text")
          if (pkcs7.type !== "text") return
          expect(pkcs7.value).toContain('"content_type_name": "signedData"')
          expect(pkcs7.value).toContain('"signer_count": 1')
          expect(pkcs7.value).toContain('"message_digest_matches_content": true')

          const crl = yield* call("call-crl-inspect", "crl_inspect", { path: "list.crl" })
          expect(crl.type).toBe("text")
          if (crl.type !== "text") return
          expect(crl.value).toContain('"issuer": "CN=Test CA, O=Turen Test"')
          expect(crl.value).toContain('"revoked_count": 3')
          expect(crl.value).toContain('"serial_hex": "0a"')

          const pe = yield* call("call-pe-authenticode", "pe_authenticode", { path: "signed.exe" })
          expect(pe.type).toBe("text")
          if (pe.type !== "text") return
          expect(pe.value).toContain('"machine": "x86_64"')
          expect(pe.value).toContain('"signed": true')
          expect(pe.value).toContain('"certificate_type_name": "pkcs_signed_data"')
          expect(pe.value).toContain('"page_hashes_present": true')

          const macho = yield* call("call-macho-codesign", "macho_codesign", { path: "signed.macho" })
          expect(macho.type).toBe("text")
          if (macho.type !== "text") return
          expect(macho.value).toContain('"format": "mach-o"')
          expect(macho.value).toContain('"signed": true')
          expect(macho.value).toContain('"hash_type_name": "sha256"')
          expect(macho.value).toContain('"ident": "com.turen.test"')
          expect(macho.value).toContain('"team_id": "TEAMID99"')
          expect(macho.value).toContain("com.example.test")

          const failed = yield* call("call-cert-inspect-bad", "cert_inspect", { path: "garbage.der" })
          expect(failed.type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                CodeSigningRuntime.node,
                CodeSigningTools.node,
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
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
