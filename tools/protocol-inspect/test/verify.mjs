import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_protocol_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_protocol_inspect_wasm_bg.wasm")) })

const packet = ethernetIpv4UdpDns()
const parsed = JSON.parse(api.inspect(packet, 1, "{}"))
assert.equal(parsed.operation, "protocol_inspect")
assert.equal(parsed.result.parsed, true)
assert.equal(parsed.result.layers.payloadBytes, 30)
assert.equal(parsed.result.application.kind, "dns")
assert.equal(parsed.result.application.counts.questions, 1)
assert.equal(parsed.result.application.questions[0].name, "example.test")

const http = JSON.parse(api.inspect(ethernetIpv4Tcp(new TextEncoder().encode("GET http://user:pass@example.test/path?secret=1 HTTP/1.1\\r\\n\\r\\n")), 1, "{}"))
assert.equal(http.result.application.kind, "http")
assert.match(http.result.application.startLine, /redacted/)
assert.doesNotMatch(http.result.application.startLine, /user:pass|secret=1/)

const tls = JSON.parse(api.inspect(ethernetIpv4Tcp(tlsServerHello()), 1, "{}"))
assert.equal(tls.result.application.kind, "tls")
assert.equal(tls.result.application.records[0].handshake.type, "server_hello")
assert.equal(tls.result.application.records[0].handshake.hello.extensions.length, 1)

const unsupported = JSON.parse(api.inspect(packet, 999, "{}"))
assert.equal(unsupported.result.parsed, false)
assert.match(unsupported.warnings[0], /unsupported link type/i)

const malformed = JSON.parse(api.inspect(new Uint8Array([1, 2, 3]), 1, "{}"))
assert.equal(malformed.result.parsed, false)
assert.ok(malformed.warnings.length >= 1)

console.log("Protocol inspection WASM compatibility verified")

function ethernetIpv4Tcp(payload) {
  const packet = new Uint8Array(14 + 20 + 20 + payload.length)
  packet.set([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 8, 0], 0)
  const ip = 14
  packet[ip] = 0x45
  packet[ip + 2] = (packet.length - 14) >> 8
  packet[ip + 3] = (packet.length - 14) & 0xff
  packet[ip + 8] = 64
  packet[ip + 9] = 6
  packet.set([192, 0, 2, 1], ip + 12)
  packet.set([198, 51, 100, 80], ip + 16)
  const tcp = ip + 20
  const tcpView = new DataView(packet.buffer)
  tcpView.setUint16(tcp, 40000)
  tcpView.setUint16(tcp + 2, 443)
  packet[tcp + 12] = 0x50
  packet[tcp + 13] = 0x18
  packet.set(payload, tcp + 20)
  return packet
}

function tlsServerHello() {
  const body = new Uint8Array(46)
  const bodyView = new DataView(body.buffer)
  bodyView.setUint16(0, 0x0303)
  body.fill(7, 2, 34)
  body[34] = 0
  bodyView.setUint16(35, 0x1301)
  body[37] = 0
  bodyView.setUint16(38, 6)
  bodyView.setUint16(40, 43)
  bodyView.setUint16(42, 2)
  body[44] = 3
  body[45] = 4

  const handshake = new Uint8Array(4 + body.length)
  handshake[0] = 2
  handshake[1] = 0
  handshake[2] = body.length >> 8
  handshake[3] = body.length
  handshake.set(body, 4)

  const record = new Uint8Array(5 + handshake.length)
  const recordView = new DataView(record.buffer)
  record[0] = 22
  record[1] = 3
  record[2] = 3
  recordView.setUint16(3, handshake.length)
  record.set(handshake, 5)
  return record
}

function ethernetIpv4UdpDns() {
  const name = Uint8Array.from([7, ...new TextEncoder().encode("example"), 4, ...new TextEncoder().encode("test"), 0])
  const dns = new Uint8Array(12 + name.length + 4)
  const dnsView = new DataView(dns.buffer)
  dnsView.setUint16(0, 0x1234)
  dnsView.setUint16(2, 0x0100)
  dnsView.setUint16(4, 1)
  dns.set(name, 12)
  dnsView.setUint16(12 + name.length, 1)
  dnsView.setUint16(14 + name.length, 1)

  const packet = new Uint8Array(14 + 20 + 8 + dns.length)
  packet.set([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 8, 0], 0)
  const ip = 14
  packet[ip] = 0x45
  packet[ip + 2] = (packet.length - 14) >> 8
  packet[ip + 3] = (packet.length - 14) & 0xff
  packet[ip + 6] = 0x40
  packet[ip + 7] = 0
  packet[ip + 8] = 64
  packet[ip + 9] = 17
  packet.set([192, 0, 2, 1], ip + 12)
  packet.set([198, 51, 100, 53], ip + 16)
  const udp = ip + 20
  const udpView = new DataView(packet.buffer)
  udpView.setUint16(udp, 53000)
  udpView.setUint16(udp + 2, 53)
  udpView.setUint16(udp + 4, 8 + dns.length)
  packet.set(dns, udp + 8)
  return packet
}
