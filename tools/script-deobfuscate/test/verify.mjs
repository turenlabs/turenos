import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Script, createContext } from "node:vm"
import { Worker } from "node:worker_threads"
import { boundaryFixtures, generatedFixtures, payloadFixtures, semanticFixtures } from "./corpus.mjs"
import { bytes, invoke, load, sha256 } from "./runtime.mjs"

// The sole positional argument is a trusted pkg/ or dist/ artifact directory.
// There is deliberately no sample path / source argument or execution mode.
assert.ok(process.argv[2] && process.argv.length === 3, "usage: node verify.mjs <pkg-or-dist-directory>")
const directory = path.resolve(process.argv[2])
const started = Date.now()
await verifyManifest(directory)
const api = await load(directory)
let checked = 0
let printerChanges = 0

// Require real decoding, not just formatting, for the baseline supported subset.
for (const [source, expected, absent] of [
  ['result="a"+"b";', "ab", /"a"\s*\+/],
  ["result=(19+23)*2;", 84, /19\s*\+\s*23/],
]) {
  const report = success(source)
  assert.ok(report.transformations.length > 0, "baseline must transform")
  assert.ok(!absent.test(report.code), "baseline expression must be rewritten")
  assert.deepEqual(observe(report.code).value, normalize(expected))
  // Every baseline evidence span must actually cover the source expression.
  assert.ok(
    report.transformations.some((entry) =>
      new TextDecoder().decode(bytes(source).subarray(entry.start, entry.end)).includes("+"),
    ),
    "original expression evidence",
  )
}

for (const fixture of generatedFixtures()) {
  const original = observe(fixture.source)
  assert.equal(original.error, null, fixture.name)
  assert.deepEqual(original.value, normalize(fixture.expected), `${fixture.name}: generated known value`)
  const report = success(fixture.source, fixture.options)
  assert.deepEqual(observe(report.code), original, `${fixture.name}: semantics/trace/error`)
  checked++
  if (checked % 16 === 0) {
    assert.deepEqual(success(fixture.source, fixture.options), report, "same-input deterministic report")
    const again = success(report.code, fixture.options)
    assert.deepEqual(observe(again.code), original, "second-pass semantics")
    if (again.code !== report.code) printerChanges++
    // Counts/spans refer to different inputs; do not require stable counts.
  }
}

for (const fixture of semanticFixtures) {
  const original = observe(fixture.source)
  assert.equal(original.error, fixture.error ?? null, `${fixture.name}: reference error`)
  for (const assumeStandardBuiltins of [false, true]) {
    const report = success(fixture.source, { assumeStandardBuiltins })
    assert.deepEqual(observe(report.code), original, `${fixture.name}: option=${assumeStandardBuiltins}`)
    checked++
  }
}

const intrinsicPositive = success('result=atob("QQ==");', { assumeStandardBuiltins: true })
assert.ok(intrinsicPositive.transformations.length > 0, "opt-in standalone atob must decode")
assert.ok(!/atob\s*\(/.test(intrinsicPositive.code), "opt-in atob expression must be rewritten")
assert.deepEqual(observe(intrinsicPositive.code), observe('result="A";'))

// Default must preserve ambient calls even though Node has pristine builtins.
for (const source of ['result=atob("QQ==");', "result=String.fromCharCode(65);"]) {
  const report = success(source)
  assert.equal(report.transformations.length, 0, "default cannot decode ambient intrinsic")
  assert.match(report.code, source.includes("atob") ? /atob\s*\(/ : /String\.fromCharCode\s*\(/)
}

// Potential execution sinks are static evidence only. Never execute these programs,
// their transformed output, or extracted text, even when they look harmless.
for (const fixture of payloadFixtures) {
  assert.equal(success(fixture.source).payloads.length, 0, "extraction opt-in")
  const report = success(fixture.source, { extractPayloads: true, ...fixture.options })
  assert.ok(
    report.payloads.some((payload) => payload.code === fixture.payload),
    `${fixture.name}: recovered payload`,
  )
  for (const payload of report.payloads) {
    const original = new TextDecoder().decode(bytes(fixture.source).subarray(payload.start, payload.end))
    assert.ok(original.includes('"'), "payload span belongs to original sink argument/call")
  }
  checked++
}
const poisonSource = 'eval("while(true){}"); Function("throw 7")(); setTimeout("for(;;){}",0);'
assert.equal(success(poisonSource, { extractPayloads: true }).error, undefined)

for (const source of ['eval(atob("eA==")); atob("QQ==");', 'eval(atob("eA==")) + atob("QQ==");']) {
  const report = success(source, { assumeStandardBuiltins: true })
  assert.ok(
    report.transformations.every((entry) => entry.kind !== "assumed-builtin-decode"),
    "execution effects must veto later/nested intrinsic rewrites",
  )
}

const boundaries = []
for (const fixture of boundaryFixtures()) {
  boundaries.push(await isolated(fixture))
  checked++
}
await isolated(undefined, true)
// Cancellation cannot poison another invocation; the replacement is fresh.
await isolated({ name: "after-cancellation", source: 'result="fresh"+"worker";', success: true })
console.log(
  JSON.stringify({
    verified: true,
    cases: checked,
    second_pass_printer_changes: printerChanges,
    boundary_results: boundaries,
    milliseconds: Date.now() - started,
  }),
)

function success(source, options = {}) {
  const report = invoke(api, bytes(source), JSON.stringify(options))
  assert.equal(report.error, undefined, report.message ?? "unexpected engine error")
  return report
}

function normalize(value) {
  if (value === undefined) return ["undefined"]
  if (typeof value === "number") {
    if (Object.is(value, -0)) return ["number", "-0"]
    if (!Number.isFinite(value)) return ["number", String(value)]
  }
  if (typeof value === "bigint") return ["bigint", value.toString()]
  if (Array.isArray(value)) return ["array", Array.from(value, normalize)]
  if (value !== null && typeof value === "object")
    return [
      "object",
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    ]
  return [typeof value, value]
}

function observe(trustedSource) {
  // All callers above use only authored/generated corpus and its WASM rewrite.
  // Disable dynamic string compilation; code under test cannot eval payloads.
  const context = createContext({ atob }, { codeGeneration: { strings: false, wasm: false } })
  new Script("var result; var trace=[];").runInContext(context, { timeout: 100 })
  let error = null
  try {
    new Script(trustedSource).runInContext(context, { timeout: 100 })
  } catch (caught) {
    error = caught.name
  }
  // Normalize in this realm to retain NaN, -0, undefined and UTF-16 code units.
  return { value: normalize(context.result), trace: normalize(context.trace), error }
}

async function isolated(fixture, cancelProbe = false) {
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    workerData: { directory, fixture, cancelProbe },
  })
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${fixture?.name ?? "cancellation"}: worker timed out`)), 5000)
      const finish = (fn, value) => {
        clearTimeout(timer)
        fn(value)
      }
      worker.on("error", (error) => finish(reject, error))
      worker.on("exit", (code) => finish(reject, new Error(`worker exited before result (${code})`)))
      worker.on("message", (message) => {
        if (cancelProbe && message.ready) finish(resolve, { cancelled: true })
        if (message.done) finish(resolve, message)
      })
    })
  } finally {
    await worker.terminate() // Always join the exact owned worker, including timeout.
  }
}

async function verifyManifest(root) {
  // pkg/ is raw wasm-pack output and may not have a manifest. Packaged dist/
  // must have one; support the repository's SHA256SUMS artifact convention.
  let manifest
  for (const candidate of [path.join(root, "SHA256SUMS"), path.join(root, "..", "SHA256SUMS")]) {
    try {
      manifest = { text: await readFile(candidate, "utf8"), base: path.dirname(candidate) }
      break
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  if (!manifest) {
    assert.notEqual(path.basename(root), "dist", "packaged dist requires SHA256SUMS")
    return
  }
  const covered = new Set()
  for (const line of manifest.text.trim().split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)
    assert.ok(match, "invalid checksum manifest line")
    assert.ok(!path.isAbsolute(match[2]) && !match[2].split(/[\\/]/).includes(".."), "unsafe manifest path")
    const filename = path.resolve(manifest.base, match[2])
    assert.equal(sha256(await readFile(filename)), match[1].toLowerCase(), `checksum ${match[2]}`)
    covered.add(filename)
  }
  for (const filename of ["turen_script_deobfuscate_wasm.js", "turen_script_deobfuscate_wasm_bg.wasm"]) {
    assert.ok(covered.has(path.join(root, filename)), `manifest missing runtime ${filename}`)
  }
}
