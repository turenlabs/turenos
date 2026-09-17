import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
const directory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(directory, "turen_rebuild_timeline_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_rebuild_timeline_wasm_bg.wasm")) })
const body = "0|/tmp/a|0|rwxrwxrwx|0|0|4|100|200|300|400\n"
const artifacts = JSON.stringify([{ kind: "prefetch", executable: "CMD.EXE", lastRunTimes: [500], runCount: 2 }])
const parsed = JSON.parse(api.analyze(new TextEncoder().encode(body), JSON.stringify({ artifacts })))
assert.equal(parsed.schemaVersion, 1)
assert.ok(parsed.result.count >= 5)
const timestamps = parsed.result.events.map((event) => event.timestamp)
assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b))
console.log("rebuild-timeline WASM compatibility verified")
