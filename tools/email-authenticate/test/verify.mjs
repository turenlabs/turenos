import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(process.argv[2] ?? "pkg")
const api = await import(pathToFileURL(path.join(root, "turen_email_authenticate_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(root, "turen_email_authenticate_wasm_bg.wasm")) })

const message = new TextEncoder().encode(
  [
    "From: Alice <alice@example.test>",
    "To: Bob <bob@example.test>",
    "Date: Sat, 29 Aug 2026 12:00:00 +0000",
    "Message-ID: <auth@example.test>",
    "Subject: Authentication fixture",
    "",
    "fixture",
  ].join("\r\n"),
)
const request = {
  schema_version: 1,
  envelope: {
    client_ip: "203.0.113.7",
    helo: "mail.example.test",
    mail_from: "alice@example.test",
  },
  receiver_domain: "mx.receiver.test",
  evaluation_time_unix: 1_788_000_000,
  dns_snapshot: {
    schema_version: 1,
    captured_at_unix: 1_787_996_400,
    entries: [
      {
        name: "mail.example.test.",
        type: "TXT",
        rcode: "NOERROR",
        ttl_seconds: 3600,
        txt: ["v=spf1 ip4:203.0.113.7 -all"],
      },
      {
        name: "example.test.",
        type: "TXT",
        rcode: "NOERROR",
        ttl_seconds: 3600,
        txt: ["v=spf1 ip4:203.0.113.7 -all"],
      },
      {
        name: "_dmarc.example.test.",
        type: "TXT",
        rcode: "NOERROR",
        ttl_seconds: 3600,
        txt: ["v=DMARC1; p=reject"],
      },
      {
        name: "_dmarc.test.",
        type: "TXT",
        rcode: "NOERROR",
        ttl_seconds: 3600,
        txt: [],
      },
    ],
  },
}

const passed = JSON.parse(api.authenticate(message, JSON.stringify(request)))
assert.equal(passed.spf_helo.result, "Pass")
assert.equal(passed.spf_mail_from.result, "Pass")
assert.equal(passed.dmarc.result, "pass")
assert.equal(passed.complete, true)
assert.match(passed.message_sha256, /^[0-9a-f]{64}$/)

const missing = JSON.parse(
  api.authenticate(
    message,
    JSON.stringify({
      ...request,
      dns_snapshot: { ...request.dns_snapshot, entries: [] },
    }),
  ),
)
assert.equal(missing.complete, false)
assert.ok(missing.warnings.includes("offline_snapshot_miss"))

console.log("offline email authentication WASM verified")
