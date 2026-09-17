import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2] ?? "")
const createLibpcap = (await import(pathToFileURL(path.join(directory, "libpcap.mjs")).href)).default
const runtime = await createLibpcap({ locateFile: (file) => path.join(directory, file) })

const packet = Uint8Array.from([
  2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 1, 8, 0,
  0x45, 0, 0, 0x22, 0, 1, 0, 0, 0x40, 0x11, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2,
  0x30, 0x39, 0, 0x35, 0, 10, 0, 0, 0x68, 0x69,
])
const capture = new Uint8Array(24 + 16 + packet.length)
const view = new DataView(capture.buffer)
view.setUint32(0, 0xa1b2c3d4, true)
view.setUint16(4, 2, true)
view.setUint16(6, 4, true)
view.setUint32(16, 65535, true)
view.setUint32(20, 1, true)
view.setUint32(24, 1700000000, true)
view.setUint32(28, 250000, true)
view.setUint32(32, packet.length, true)
view.setUint32(36, packet.length, true)
capture.set(packet, 40)

const result = runtime.inspectCapture(capture, "udp and dst port 53", 0, 64, 4096)
assert.equal(result.datalink, 1)
assert.equal(result.datalinkName, "EN10MB")
assert.equal(result.packets.length, 1)
assert.equal(result.packets[0].seconds, 1700000000)
assert.equal(result.packets[0].microseconds, 250000)
assert.deepEqual([...result.packets[0].bytes], [...packet])
assert.equal(result.nextOffset, null)

assert.match(runtime.inspectCapture(capture, "host example.com", 0, 1, 16).error, /symbolic names/)
assert.ok(runtime.inspectCapture(capture.subarray(0, 10), "", 0, 1, 16).error)
console.log("official libpcap offline WASM compatibility verified")
