import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const packageDirectory = path.resolve(process.argv[2] ?? "")
const api = await import(pathToFileURL(path.join(packageDirectory, "yara_x_js.js")).href)
await api.default({ module_or_path: await readFile(path.join(packageDirectory, "yara_x_js_bg.wasm")) })

const compiler = new api.Compiler()
let rules
let scanner

try {
  compiler.addSource(`
    rule turen_wasm_compatibility : verified {
      meta:
        source = "turen"
      strings:
        $marker = "abc"
      condition:
        $marker
    }
  `)
  assert.deepEqual(compiler.errors, [])
  rules = compiler.build()
  scanner = rules.scanner()
  scanner.setTimeoutMs(250)
  scanner.setMaxMatchesPerPattern(1)

  const result = scanner.scan(new TextEncoder().encode("abc abc"))
  assert.equal(result.valid, true)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].identifier, "turen_wasm_compatibility")
  assert.deepEqual(result.matches[0].tags, ["verified"])
  assert.equal(result.matches[0].patterns[0].matches.length, 1)
} finally {
  scanner?.free()
  rules?.free()
  compiler.free()
}

console.log("YARA-X WASM compatibility verified")

const boundedCompiler = new api.Compiler()
let boundedRules
let boundedScanner

try {
  boundedCompiler.addSource(
    Array.from({ length: 300 }, (_, index) => `rule bounded_${index} { condition: true }`).join("\n"),
  )
  boundedRules = boundedCompiler.build()
  boundedScanner = boundedRules.scanner()
  const bounded = boundedScanner.scan(new Uint8Array())
  assert.equal(bounded.valid, true)
  assert.equal(bounded.matches.length, 256)
  assert.equal(bounded.truncated, true)
} finally {
  boundedScanner?.free()
  boundedRules?.free()
  boundedCompiler.free()
}

console.log("YARA-X pre-serialization result bounds verified")

const patternCompiler = new api.Compiler()
try {
  patternCompiler.addSource(`
    rule too_many_patterns {
      strings:
        ${Array.from({ length: 257 }, (_, index) => `$p${index} = "A${index}"`).join("\n        ")}
      condition:
        any of them
    }
  `)
  assert.throws(() => patternCompiler.build(), /compiled pattern count 257 exceeds limit 256/)
} finally {
  patternCompiler.free()
}

const matchCompiler = new api.Compiler()
let matchRules
let matchScanner
try {
  matchCompiler.addSource(`
    rule aggregate_matches {
      strings:
        ${Array.from({ length: 32 }, (_, index) => `$p${index} = "A"`).join("\n        ")}
      condition:
        any of them
    }
  `)
  matchRules = matchCompiler.build()
  matchScanner = matchRules.scanner()
  matchScanner.setMaxMatchesPerPattern(256)
  const bounded = matchScanner.scan(new TextEncoder().encode("A".repeat(256)))
  assert.equal(bounded.matches[0].patterns.flatMap((pattern) => pattern.matches).length, 4096)
} finally {
  matchScanner?.free()
  matchRules?.free()
  matchCompiler.free()
}

console.log("YARA-X compiled-pattern and aggregate-match bounds verified")
