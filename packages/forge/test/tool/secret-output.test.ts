import { expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { Truncate } from "@/tool/truncate"
import { ToolOutput } from "@/tool/secret-output"
import { testEffect } from "../lib/effect"

import { Credential } from "@turenlabs/core/credential"
import { Integration } from "@turenlabs/schema"
import { LayerNode } from "@turenlabs/core/effect/layer-node"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Truncate.node, Credential.node])))

it.live("redacts known credentials without recognizable token patterns", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const stored = yield* credentials.create({
      integrationID: Integration.ID.make("synthetic-output-test"),
      value: { type: "key", key: "synthetic-opaque-forge-secret-1234" },
    })
    yield* Effect.addFinalizer(() => credentials.remove(stored.id))
    const truncate = yield* Truncate.Service
    const result = yield* truncate.output("synthetic-opaque-forge-secret-1234")
    expect(result.content).not.toContain("synthetic-opaque-forge-secret-1234")
    expect(result.content).toContain("[SECRET:v1:")
  }),
)
const secret = `ghp_${"S".repeat(36)}`

it.live("redacts before preview caps and truncation disk writes", () =>
  Effect.gen(function* () {
    const truncate = yield* Truncate.Service
    const short = yield* truncate.output(secret)
    expect(short.content).not.toContain(secret)
    expect(short.content).toContain("[SECRET:v1:")
    const file = yield* truncate.write(secret)
    expect(yield* Effect.promise(() => Bun.file(file).text())).not.toContain(secret)
    const long = yield* truncate.output(`${secret}\nsecond line`, { maxLines: 1 })
    expect(long.content).not.toContain(secret)
    expect(long.truncated).toBe(true)
    if (long.truncated) {
      const saved = yield* Effect.promise(() => Bun.file(long.outputPath).text())
      expect(saved).not.toContain(secret)
      expect(saved).toContain(short.content)
    }
  }),
)

// Each release is appended with its own write, so each is UTF-8 encoded on its own.
const written = (pieces: readonly string[]) => Buffer.concat(pieces.map((piece) => Buffer.from(piece))).toString()

test("stream releases never bisect a supplementary character across separate writes", () => {
  const cases = [
    // Sized so a fixed release offset fell between the emoji's two UTF-16 halves.
    ["a".repeat(262144 - 4096 - 1) + "😀" + "b".repeat(4095)],
    ...Array.from({ length: 40 }, (_, offset) => {
      const text = `${"line of text ".repeat(400)}${"x".repeat(offset)}😀😀 tail ${"😀".repeat(offset)}\n`
      return text.match(/[\s\S]{1,613}/g)!
    }),
  ]
  for (const chunks of cases) {
    const stream = ToolOutput.stream(SecretRedaction.compile(["synthetic-opaque-9QxW-7741"]))
    const pieces = [...chunks.map((chunk) => stream.push(chunk)), stream.end()]
    expect(written(pieces)).toBe(chunks.join(""))
  }
})

test("stream holds only the undecided suffix and releases decided text immediately", () => {
  const stream = ToolOutput.stream(SecretRedaction.compile(["synthetic opaque value 9QxW"]))
  expect(stream.push("build started\n")).toBe("build started\n")
  // A prompt or progress word with no newline yet is shown at once: no token can grow from it.
  expect(stream.push("waiting for input")).toBe("waiting for input")
  expect(stream.push("\n")).toBe("\n")
  // A token, a configured value, a key header and a reference can still be completing.
  expect(stream.push(`ghp_${"0".repeat(35)}`)).toBe("")
  const token = stream.push("7\n")
  expect(token).toMatch(/^\[SECRET:v1:github:[a-f0-9]{32}\]\n$/)
  expect(stream.push("value synthetic opaque val")).toBe("value ")
  expect(stream.push("ue 9QxW done\n")).toMatch(/^\[SECRET:v1:known:[a-f0-9]{32}\] done\n$/)
  expect(stream.push("key -----BEGIN RSA PRIV")).toBe("key ")
  expect(stream.push("ATE KEY-----\nc3ludGhldGlj\n")).toBe("")
  expect(stream.push("-----END RSA PRIVATE KEY-----\n")).toMatch(/^\[SECRET:v1:pem-private-key:[a-f0-9]{32}\]\n$/)
  expect(stream.end()).toBe("")
})
