// Verifies the real built code-signing WASM artifact (pkg or packaged dist
// directory) — no mocks. Fixture bytes are the same deterministic DER blobs
// produced by src/fixtures.rs (see `dump_fixtures`).
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_code_signing_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_code_signing_wasm_bg.wasm")) })

const b64 = (text) => new Uint8Array(Buffer.from(text, "base64"))
const FIXTURES = {
  cert: b64("MIIBjDCCAXKgAwIBAgIDAQIDMA0GCSqGSIb3DQEBCwUAMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MB4XDTI1MDEwMTAwMDAwMFoXDTM1MDEwMTAwMDAwMFowKzEUMBIGA1UEAwwLVGVzdCBTaWduZXIxEzARBgNVBAoMClR1cmVuIFRlc3QwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAwMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wIDAQABo38wfTAMBgNVHRMEBTADAQEAMA4GA1UdDwEB/wQEAwIHgDAdBgNVHSUEFjAUBggrBgEFBQcDAwYIKwYBBQUHAwgwHQYDVR0OBBYEFBERERERERERERERERERERERERERMB8GA1UdIwQYMBaAFBERERERERERERERERERERERERERMA0GCSqGSIb3DQEBCwUAAwUA3q2+7w=="),
  cert2: b64("MIIBYTCCAUegAwIBAgIBBTANBgkqhkiG9w0BAQsFADAmMQ8wDQYDVQQDDAZTZWNvbmQxEzARBgNVBAoMClR1cmVuIFRlc3QwHhcNMjUwMTAxMDAwMDAwWhcNMzUwMTAxMDAwMDAwWjAmMQ8wDQYDVQQDDAZTZWNvbmQxEzARBgNVBAoMClR1cmVuIFRlc3QwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAwMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wIDAQABo2AwXjAMBgNVHRMEBTADAQEAMA4GA1UdDwEB/wQEAwIHgDAdBgNVHQ4EFgQUEREREREREREREREREREREREREREwHwYDVR0jBBgwFoAUEREREREREREREREREREREREREREwDQYJKoZIhvcNAQELBQADBQDerb7v"),
  crl: b64("MIHoMIHRAgEBMA0GCSqGSIb3DQEBCwUAMCcxEDAOBgNVBAMMB1Rlc3QgQ0ExEzARBgNVBAoMClR1cmVuIFRlc3QXDTI1MDEwMTAwMDAwMFoXDTI2MDEwMTAwMDAwMFowZjAgAgEKFw0yNTAzMDEwMDAwMDBaMAwwCgYDVR0VBAMKAQEwIAIBCxcNMjUwMzAxMDAwMDAwWjAMMAoGA1UdFQQDCgEBMCACAQwXDTI1MDMwMTAwMDAwMFowDDAKBgNVHRUEAwoBAaAOMAwwCgYDVR0UBAMCAQcwDQYJKoZIhvcNAQELBQADAwDK/g=="),
  cms: b64("MIIC6AYJKoZIhvcNAQcCoIIC2TCCAtUCAQExDzANBglghkgBZQMEAgEFADAjBgkqhkiG9w0BBwGgFgQUaGVsbG8gc2lnbmVkIGNvbnRlbnSgggGQMIIBjDCCAXKgAwIBAgIDAQIDMA0GCSqGSIb3DQEBCwUAMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MB4XDTI1MDEwMTAwMDAwMFoXDTM1MDEwMTAwMDAwMFowKzEUMBIGA1UEAwwLVGVzdCBTaWduZXIxEzARBgNVBAoMClR1cmVuIFRlc3QwXDANBgkqhkiG9w0BAQEFAANLADBIAkEAwMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wIDAQABo38wfTAMBgNVHRMEBTADAQEAMA4GA1UdDwEB/wQEAwIHgDAdBgNVHSUEFjAUBggrBgEFBQcDAwYIKwYBBQUHAwgwHQYDVR0OBBYEFBERERERERERERERERERERERERERMB8GA1UdIwQYMBaAFBERERERERERERERERERERERERERMA0GCSqGSIb3DQEBCwUAAwUA3q2+7zGCAQQwggEAAgEBMDAwKzEUMBIGA1UEAwwLVGVzdCBJc3N1ZXIxEzARBgNVBAoMClR1cmVuIFRlc3QCASowDQYJYIZIAWUDBAIBBQCgaTAYBgkqhkiG9w0BCQMxCwYJKoZIhvcNAQcBMBwGCSqGSIb3DQEJBTEPFw0yNTA2MDEwMDAwMDBaMC8GCSqGSIb3DQEJBDEiBCDjaG+mNxOFeQ2XEg96WidfX4uqHrK9lkAlXgw0Gx9gNDANBgkqhkiG9w0BAQsFAARAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg=="),
  peSigned: b64("TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQRQAAZIYAAAAAAAAAAAAAAAAAAPAAIgALAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAgAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8EAAAAAgIAMIIEcwYJKoZIhvcNAQcCoIIEZDCCBGACAQExDzANBglghkgBZQMEAgEFADBpBgorBgEEAYI3AgEEoFsEWTBXMCIGCisGAQQBgjcCAQ+gFDASAwIAAKIMMAqBCHRlc3QuZXhlMDEwDQYJYIZIAWUDBAIBBQAEIFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVoIIBkDCCAYwwggFyoAMCAQICAwECAzANBgkqhkiG9w0BAQsFADArMRQwEgYDVQQDDAtUZXN0IFNpZ25lcjETMBEGA1UECgwKVHVyZW4gVGVzdDAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMDBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8CAwEAAaN/MH0wDAYDVR0TBAUwAwEBADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMIMB0GA1UdDgQWBBQRERERERERERERERERERERERERETAfBgNVHSMEGDAWgBQRERERERERERERERERERERERERETANBgkqhkiG9w0BAQsFAAMFAN6tvu8xggJJMIICRQIBATAwMCsxFDASBgNVBAMMC1Rlc3QgSXNzdWVyMRMwEQYDVQQKDApUdXJlbiBUZXN0AgEqMA0GCWCGSAFlAwQCAQUAoGkwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjUwNjAxMDAwMDAwWjAvBgkqhkiG9w0BCQQxIgQgFDFU6ZGdlshxCikp2r7gm/lmO8E+vQYpyV9ywMUhwXUwDQYJKoZIhvcNAQELBQAEQKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhggFBMCgGCisGAQQBgjcCAwIxGgQYmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZMIIBEwYJKoZIhvcNAQkGMYIBBDCCAQACAQEwMDArMRQwEgYDVQQDDAtUZXN0IElzc3VlcjETMBEGA1UECgwKVHVyZW4gVGVzdAIBCTANBglghkgBZQMEAgEFAKBpMBgGCSqGSIb3DQEJAzELBgkqhkiG9w0BBwEwHAYJKoZIhvcNAQkFMQ8XDTI1MDYwMTAwMDAwMFowLwYJKoZIhvcNAQkEMSIEIEJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCMA0GCSqGSIb3DQEBCwUABECqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAA=="),
  peUnsigned: b64("TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQRQAAZIYAAAAAAAAAAAAAAAAAAPAAIgALAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="),
  machoSigned: b64("z/rt/gwAAAEAAAAAAgAAAAEAAAAQAAAAAAAAAAAAAAAdAAAAEAAAAGAAAABDBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+t4MwAAABEMAAAAEAAAAAAAAACwAAAACAAAAzAAAAAUAAADUAAEAAAAAAU/63gwCAAAAoAACAwAAAAACAAAAYAAAAEAAAAABAAAAAgAAEAAgAgAMAAAAAAAAAAAAAABPAAAAAAAAAAAAAAAAY29tLnR1cmVuLnRlc3QAVEVBTUlEOTkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+t4MAQAAAAj63nFxAAAAezw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPjxkaWN0PjxrZXk+Y29tLmV4YW1wbGUudGVzdDwva2V5Pjx0cnVlLz48L2RpY3Q+PC9wbGlzdD763gsBAAAC9DCCAugGCSqGSIb3DQEHAqCCAtkwggLVAgEBMQ8wDQYJYIZIAWUDBAIBBQAwIwYJKoZIhvcNAQcBoBYEFGhlbGxvIHNpZ25lZCBjb250ZW50oIIBkDCCAYwwggFyoAMCAQICAwECAzANBgkqhkiG9w0BAQsFADArMRQwEgYDVQQDDAtUZXN0IFNpZ25lcjETMBEGA1UECgwKVHVyZW4gVGVzdDAeFw0yNTAxMDEwMDAwMDBaFw0zNTAxMDEwMDAwMDBaMCsxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMRMwEQYDVQQKDApUdXJlbiBUZXN0MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAMDBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8CAwEAAaN/MH0wDAYDVR0TBAUwAwEBADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0lBBYwFAYIKwYBBQUHAwMGCCsGAQUFBwMIMB0GA1UdDgQWBBQRERERERERERERERERERERERERETAfBgNVHSMEGDAWgBQRERERERERERERERERERERERERETANBgkqhkiG9w0BAQsFAAMFAN6tvu8xggEEMIIBAAIBATAwMCsxFDASBgNVBAMMC1Rlc3QgSXNzdWVyMRMwEQYDVQQKDApUdXJlbiBUZXN0AgEqMA0GCWCGSAFlAwQCAQUAoGkwGAYJKoZIhvcNAQkDMQsGCSqGSIb3DQEHATAcBgkqhkiG9w0BCQUxDxcNMjUwNjAxMDAwMDAwWjAvBgkqhkiG9w0BCQQxIgQg42hvpjcThXkNlxIPelonX1+Lqh6yvZZAJV4MNBsfYDQwDQYJKoZIhvcNAQELBQAEQKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo="),
  machoUnsigned: b64("z/rt/gwAAAEAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="),
}
const OPTIONS = "{}"
const ok = (text) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1)
  assert.equal(value.error, undefined, text)
  return value
}
const err = (text, code) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1)
  assert.equal(value.error, code, text)
}

// cert_inspect — DER and PEM bundle.
const certReport = ok(api.cert_inspect(FIXTURES.cert, OPTIONS))
assert.equal(certReport.count, 1)
const cert = certReport.certificates[0]
assert.equal(cert.subject, "CN=Test Signer, O=Turen Test")
assert.equal(cert.serial_hex, "010203")
assert.equal(cert.version, 3)
assert.equal(cert.signature_algorithm.name, "sha256WithRSAEncryption")
assert.equal(cert.public_key.algorithm, "rsaEncryption")
assert.equal(cert.public_key.size_bits, 512)
assert.equal(cert.extended_key_usage.code_signing, true)
assert.equal(cert.is_ca, false)
assert.equal(cert.subject_key_identifier, "1111111111111111111111111111111111111111")
assert.match(cert.fingerprint_sha256, /^[0-9a-f]{64}$/)

const pem = (label, bytes) =>
  `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----\n`
const bundle = new TextEncoder().encode(pem("CERTIFICATE", FIXTURES.cert) + pem("CERTIFICATE", FIXTURES.cert2))
const bundleReport = ok(api.cert_inspect(bundle, OPTIONS))
assert.equal(bundleReport.count, 2)
assert.equal(bundleReport.certificates[1].subject, "CN=Second, O=Turen Test")

// pkcs7_inspect — attached content, matching messageDigest, embedded cert.
const cmsReport = ok(api.pkcs7_inspect(FIXTURES.cms, OPTIONS))
assert.equal(cmsReport.content_type_name, "signedData")
const signedData = cmsReport.signed_data
assert.equal(signedData.digest_algorithms[0].name, "sha256")
assert.equal(signedData.encapsulated_content.attached, true)
assert.equal(signedData.certificates.length, 1)
assert.equal(signedData.signer_count, 1)
assert.equal(signedData.signer_infos[0].message_digest_matches_content, true)
assert.equal(signedData.signer_infos[0].signature_algorithm.name, "sha256WithRSAEncryption")

// crl_inspect.
const crlReport = ok(api.crl_inspect(FIXTURES.crl, OPTIONS))
assert.equal(crlReport.issuer, "CN=Test CA, O=Turen Test")
assert.equal(crlReport.revoked_count, 3)
assert.deepEqual(crlReport.revoked.map((entry) => entry.serial_hex), ["0a", "0b", "0c"])

// pe_authenticode — signed image reports the WIN_CERTIFICATE table, the
// SpcIndirectData eContent, and the page-hash attribute presence.
const peReport = ok(api.pe_authenticode(FIXTURES.peSigned, OPTIONS))
assert.equal(peReport.pe.machine, "x86_64")
assert.equal(peReport.signed, true)
assert.equal(peReport.win_certificates[0].certificate_type_name, "pkcs_signed_data")
assert.equal(peReport.pkcs7.content_type_name, "signedData")
assert.equal(peReport.spc_indirect_data.present, true)
assert.equal(peReport.spc_indirect_data.hash_algorithm.name, "sha256")
assert.equal(peReport.page_hashes_present, true)

const peUnsignedReport = ok(api.pe_authenticode(FIXTURES.peUnsigned, OPTIONS))
assert.equal(peUnsignedReport.signed, false)
assert.equal(peUnsignedReport.pkcs7, null)

// macho_codesign — SuperBlob, CodeDirectory, entitlements, CMS signature.
const machoReport = ok(api.macho_codesign(FIXTURES.machoSigned, OPTIONS))
assert.equal(machoReport.format, "mach-o")
assert.equal(machoReport.signed, true)
const codeSignature = machoReport.arches[0].code_signature
assert.equal(codeSignature.superblob.index_count, 4)
const directoryReport = codeSignature.code_directory
assert.equal(directoryReport.hash_type_name, "sha256")
assert.equal(directoryReport.page_size, 4096)
assert.equal(directoryReport.ident, "com.turen.test")
assert.equal(directoryReport.team_id, "TEAMID99")
assert.equal(codeSignature.requirements.present, true)
assert.equal(codeSignature.entitlements.present, true)
assert.match(codeSignature.entitlements.xml, /com\.example\.test/)
assert.equal(codeSignature.cms.content_type_name, "signedData")

const machoUnsignedReport = ok(api.macho_codesign(FIXTURES.machoUnsigned, OPTIONS))
assert.equal(machoUnsignedReport.signed, false)
assert.equal(machoUnsignedReport.arches[0].code_signature, null)

// Error contract — malformed, empty, oversized, oversized options.
err(api.cert_inspect(new Uint8Array([0x30, 0x10, 0xff, 0x00]), OPTIONS), "cert_parse_error")
err(api.pkcs7_inspect(new Uint8Array([0x30, 0x80, 0x01]), OPTIONS), "invalid_content_info")
err(api.crl_inspect(FIXTURES.cert, OPTIONS), "crl_parse_error")
err(api.pe_authenticode(new TextEncoder().encode("not a pe file"), OPTIONS), "pe_parse_error")
err(api.macho_codesign(new TextEncoder().encode("not mach-o"), OPTIONS), "macho_parse_error")
err(api.cert_inspect(new Uint8Array(0), OPTIONS), "empty_input")
err(api.cert_inspect(new Uint8Array(32 * 1024 * 1024 + 1), OPTIONS), "input_too_large")
err(api.cert_inspect(FIXTURES.cert, `{"pad":"${"x".repeat(4096)}"}`), "options_too_large")
err(api.cert_inspect(FIXTURES.cert, "{oops"), "invalid_options")

// Determinism — byte-identical output for identical input.
for (const [fn, input] of [
  [api.cert_inspect, FIXTURES.cert],
  [api.pkcs7_inspect, FIXTURES.cms],
  [api.crl_inspect, FIXTURES.crl],
  [api.pe_authenticode, FIXTURES.peSigned],
  [api.macho_codesign, FIXTURES.machoSigned],
]) {
  assert.equal(fn(input, OPTIONS), fn(input, OPTIONS))
}

console.log("code-signing WASM compatibility verified")
