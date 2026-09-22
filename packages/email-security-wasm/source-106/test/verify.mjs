import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../pkg"))
const api = await import(pathToFileURL(path.join(root, "turen_email_security_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(root, "turen_email_security_wasm_bg.wasm")) })
const message = await readFile(path.join(import.meta.dirname, "fixture.eml"))
const report = JSON.parse(api.inspect(message, JSON.stringify({ include_bodies: true })))

assert.equal(report.schema_version, 1)
assert.equal(report.subject, "Test Email")
assert.equal(report.from[0].address, "alice@example.test")
assert.equal(report.attachments[0].name, "invoice.exe")
assert.ok(report.bodies.some((body) => body.value.includes("https://example.test/login")))
assert.ok(report.iocs.some((ioc) => ioc.kind === "url" && ioc.value === "https://example.test/login"))
assert.ok(report.signals.some((signal) => signal.code === "dmarc_fail_advertised"))
assert.ok(report.signals.some((signal) => signal.code === "reply_to_present"))

assert.deepEqual(api.extract_attachment(message, 0, 7), new TextEncoder().encode("MVHELLO"))
assert.throws(() => api.extract_attachment(message, 0, 6), /attachment_too_large/)
assert.throws(() => api.extract_attachment(message, 1, 1024), /attachment_not_found/)
for (const index of [-1, 0.5, 256, 2 ** 32, NaN, Infinity])
  assert.throws(() => api.extract_attachment(message, index, 1024), /invalid_attachment_index/)
for (const max of [0, -1, 0.5, 8 * 1024 * 1024 + 1, 2 ** 32, NaN, Infinity])
  assert.throws(() => api.extract_attachment(message, 0, max), /invalid_max_output_bytes/)
assert.throws(() => api.extract_attachment(new Uint8Array(), 0, 1024), /empty_message/)
assert.throws(() => api.extract_attachment(new Uint8Array(32 * 1024 * 1024 + 1), 0, 1024), /message_too_large/)

const multipart = (encoding, data) => new TextEncoder().encode([
  'Content-Type: multipart/mixed; boundary="b"', '', '--b',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="../../untrusted.bin"',
  `Content-Transfer-Encoding: ${encoding}`, '', data, '--b--', '',
].join('\r\n'))
assert.deepEqual(api.extract_attachment(multipart('quoted-printable', '=00=FF=41=0A'), 0, 4), Uint8Array.from([0, 255, 65, 10]))
assert.equal(api.extract_attachment(multipart('base64', ''), 0, 1).length, 0)
const maximum = new Uint8Array(8 * 1024 * 1024).fill(0x61)
assert.deepEqual(api.extract_attachment(multipart('base64', Buffer.from(maximum).toString('base64')), 0, maximum.length), maximum)
assert.throws(() => api.extract_attachment(multipart('base64', Buffer.alloc(maximum.length + 1).toString('base64')), 0, maximum.length), /attachment_too_large/)

const invalid = JSON.parse(api.inspect(new Uint8Array(), "{}"))
assert.equal(invalid.error, "empty_message")
const sanitized = JSON.parse(
  api.sanitize_html(
    '<p onclick="alert(1)">safe</p><script>alert(2)</script><a href="javascript:alert(3)">bad</a><a href="https://example.test">good</a><form>form</form>',
  ),
)
assert.ok(sanitized.html.includes("safe"))
assert.ok(sanitized.html.includes('href="https://example.test"'))
assert.ok(!sanitized.html.includes("onclick"))
assert.ok(!sanitized.html.includes("javascript:"))
assert.ok(!sanitized.html.includes("alert(2)"))
assert.ok(!sanitized.html.includes("form"))
console.log("email security WASM verified")
