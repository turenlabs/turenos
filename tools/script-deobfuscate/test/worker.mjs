import assert from "node:assert/strict"
import { parentPort, workerData } from "node:worker_threads"
import { bytes, invoke, load } from "./runtime.mjs"

// This worker only parses data with WASM. It has no VM/eval path.
const api = await load(workerData.directory)
parentPort.postMessage({ ready: true })
if (workerData.cancelProbe) {
  // Parent terminates this exact worker after initialization. No submitted JS runs.
  setInterval(() => {}, 1000)
} else {
  const fixture = workerData.fixture
  const input = fixture.input ?? bytes(fixture.source)
  const report = invoke(api, input, fixture.optionsJSON)
  if (fixture.reject) assert.ok(report.error, `${fixture.name}: expected explicit rejection`)
  if (fixture.boundedSkip && !report.error) {
    assert.equal(report.code, fixture.source, "deep AST safe-skip must retain original source")
    assert.equal(report.transformations.length, 0, "deep AST must not partially fold")
    assert.ok(
      report.warnings.some((warning) =>
        /depth|unsupported|limit/i.test(typeof warning === "string" ? warning : JSON.stringify(warning)),
      ),
      "deep AST safe-skip must disclose limit",
    )
  }
  if (fixture.success) assert.equal(report.error, undefined, `${fixture.name}: unexpected rejection`)
  if (!report.error && ["many-transforms", "payload-aggregate", "payload-count"].includes(fixture.name)) {
    assert.ok(
      report.truncated ||
        report.warnings.some((warning) =>
          /limit|truncat|bound/i.test(typeof warning === "string" ? warning : JSON.stringify(warning)),
        ),
      `${fixture.name}: dropped evidence must be disclosed`,
    )
  }
  if (!report.error && fixture.name === "value-over-64KiB") {
    assert.ok(
      !report.transformations.some((entry) =>
        new TextDecoder().decode(input.subarray(entry.start, entry.end)).includes("+"),
      ),
      "oversized recovered value must not be folded",
    )
  }
  if (fixture.reject) {
    assert.equal(invoke(api, input, fixture.optionsJSON).error, report.error, "stable error code")
  }
  // An ordinary request after bad input must still work in this worker.
  const after = invoke(api, bytes('result="after"+"poison";'))
  assert.equal(after.error, undefined, `${fixture.name}: poisoned instance`)
  assert.ok(after.transformations.length > 0, "post-poison positive rewrite")
  parentPort.postMessage({
    done: true,
    name: fixture.name,
    error: report.error ?? null,
    truncated: report.truncated ?? false,
  })
}
