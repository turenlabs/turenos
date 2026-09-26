import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Truncate } from "@/tool/truncate"
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
