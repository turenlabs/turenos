import { describe, expect } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { LLMEvent, type LLMRequest, type Model as LLMModel } from "@turenlabs/llm"
import { Catalog } from "@turenlabs/core/catalog"
import { SessionCompaction } from "@turenlabs/core/session/compaction"
import { SessionMessage } from "@turenlabs/core/session/message"
import { TextPart } from "@turenlabs/core/session/prompt"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
// Must precede the direct plugin import: the provider barrel and its members
// form an import cycle, and reaching a member first leaves the barrel's binding
// uninitialised. Pre-existing, and the sibling suite orders its imports the
// same way for the same reason.
import { ProviderPlugins } from "@turenlabs/core/plugin/provider"
import { ClaudeCodePlugin, overrideProbe } from "@turenlabs/core/plugin/provider/claude-code"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

/**
 * Transcribed verbatim from the real catalog (`https://models.dev/api.json`,
 * the same document TurenOS caches at `~/.cache/forge/models.json`) rather than
 * written to the shape this fix assumes. Two facts here are the whole point and
 * neither would survive being invented:
 *
 *   - The 1M window is on the *base* entry. Anthropic models publish no
 *     `variants` at all, so a variant-aware lookup would have found nothing to
 *     look up; the stale number was never a missing variant.
 *   - Old and new generations coexist under one `family`, and only
 *     `release_date` separates them. `claude-opus-4-5` is still 200k, which is
 *     exactly the number the hardcoded table used to report for `opus`, so a
 *     resolver that picked the wrong entry would reproduce the bug silently.
 */
const ANTHROPIC = [
  {
    id: "claude-opus-5",
    family: "claude-opus",
    released: "2026-07-24",
    limit: { context: 1_000_000, output: 128_000 },
  },
  { id: "claude-opus-4-5", family: "claude-opus", released: "2025-11-24", limit: { context: 200_000, output: 64_000 } },
  {
    id: "claude-sonnet-5",
    family: "claude-sonnet",
    released: "2026-06-29",
    limit: { context: 1_000_000, output: 128_000 },
  },
  {
    id: "claude-haiku-4-5",
    family: "claude-haiku",
    released: "2025-10-15",
    limit: { context: 200_000, output: 64_000 },
  },
  {
    id: "claude-fable-5",
    family: "claude-fable",
    released: "2026-06-07",
    limit: { context: 1_000_000, output: 128_000 },
  },
] as const

const seedAnthropic = Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  yield* catalog.transform(
    Effect.fn(function* (draft) {
      for (const entry of ANTHROPIC) {
        draft.model.update(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(entry.id), (model) => {
          model.family = ModelV2.Family.make(entry.family)
          model.time.released = Date.parse(entry.released)
          model.limit = { context: entry.limit.context, output: entry.limit.output }
        })
      }
    }),
  )
})

const addPlugin = Effect.gen(function* () {
  overrideProbe(() => Promise.resolve({ status: "authenticated", executable: "/usr/local/bin/claude" }) as never)
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ClaudeCodePlugin.effect(host)
}).pipe(Effect.ensuring(Effect.sync(() => overrideProbe())))

describe("ClaudeCodePlugin context limits", () => {
  it.effect("resolves limits inside the plugin the runtime actually loads", () =>
    Effect.sync(() => expect(ProviderPlugins).toContain(ClaudeCodePlugin)),
  )

  it.effect("takes each CLI alias's window from the newest catalog entry in its family", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seedAnthropic
      yield* addPlugin

      const window = (id: string) =>
        catalog.model
          .get(ClaudeCodeCLI.ID, ModelV2.ID.make(id))
          .pipe(Effect.map((model) => model && { context: model.limit.context, output: model.limit.output }))

      // The regression. `opus` resolves to Opus 5 inside the CLI, and Opus 5 is
      // a 1M model; TurenOS reported 200k and compacted against it.
      expect(yield* window("opus")).toEqual({ context: 1_000_000, output: 128_000 })
      expect(yield* window("sonnet")).toEqual({ context: 1_000_000, output: 128_000 })
      expect(yield* window("fable")).toEqual({ context: 1_000_000, output: 128_000 })
      // Haiku genuinely is 200k. The fix must not simply raise everything.
      expect(yield* window("haiku")).toEqual({ context: 200_000, output: 64_000 })
    }),
  )

  it.effect("prefers the newer generation when one family holds several", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seedAnthropic
      yield* addPlugin

      // Both `claude-opus-5` (1M) and `claude-opus-4-5` (200k) are live under
      // `claude-opus`. Picking by map-insertion order or by id sort would land
      // on the 200k entry and silently restore the bug.
      const model = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("opus"))
      expect(model?.limit.context).toBe(1_000_000)
    }),
  )

  it.effect("falls back to the static table when the catalog has no anthropic entries", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin

      // A packaged build with no snapshot must still offer a usable window
      // rather than zero, which would read as "unknown context" and disable
      // compaction entirely.
      const model = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("opus"))
      const fallback = ClaudeCodeCLI.MODELS.find((item) => item.id === "opus")!
      expect(model?.limit.context).toBe(fallback.context)
      expect(model?.limit.context).toBeGreaterThan(0)
    }),
  )
})

/**
 * The panel reading 1M while the compaction gate still budgets against 200k
 * would be a worse outcome than the original bug, so this walks the whole
 * chain -- real catalog entry, real plugin, real `fromCatalogModel`, real
 * pre-flight gate -- and asserts on the decision rather than on the display.
 */
describe("the window the plugin publishes is the window compaction budgets against", () => {
  const created = DateTime.makeUnsafe(0)
  const modelRef = ModelV2.Ref.make({
    id: ModelV2.ID.make("opus"),
    providerID: ProviderV2.ID.make("claude-code"),
  })

  /**
   * A summarizable history. `compactIfNeeded` returns false both when the gate
   * declines *and* when it fires but the run declines, so an empty history would
   * read as "under budget" no matter what the budget was.
   */
  const history = () => [
    {
      seq: 1,
      message: SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_u1"),
        type: "user",
        text: "do the thing",
        parts: [TextPart.make({ id: "prt_u1", text: "do the thing" })],
        time: { created },
      }),
    },
    {
      seq: 2,
      message: SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_a1"),
        type: "assistant",
        agent: "build",
        model: modelRef,
        content: [{ type: "text", id: "t", text: "ok" }],
        time: { created },
      }),
    },
    {
      seq: 3,
      message: SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_u2"),
        type: "user",
        text: "current instruction",
        parts: [TextPart.make({ id: "prt_u2", text: "current instruction" })],
        time: { created },
      }),
    },
  ]

  const gate = (model: LLMModel, promptTokens: number) => {
    const compaction = SessionCompaction.make({
      events: { publish: (() => Effect.succeed({})) as never } as never,
      llm: {
        stream: () =>
          Stream.fromArray([
            LLMEvent.textDelta({
              id: "blk_1",
              text: "## Objective\n- ship\n\n## Important Details\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n### Active\n- ship\n\n### Blocked\n- (none)\n\n## Next Move\n1. ship\n2. (none)\n\n## Relevant Files\n- (none)\n\n## Durable Memories\n- (none)",
            }),
            LLMEvent.finish({ reason: "stop" }),
          ]),
      },
      config: Effect.succeed([]),
    })
    return compaction.compactIfNeeded({
      sessionID: SessionSchema.ID.make("ses_limits"),
      entries: history(),
      model,
      request: {
        model,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(promptTokens * 4) }] }],
        tools: [],
      } as unknown as LLMRequest,
    })
  }

  it.effect("carries Opus 5's 1M window all the way into the pre-flight gate", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seedAnthropic
      yield* addPlugin

      const info = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("opus"))
      const resolved = yield* SessionRunnerModel.fromCatalogModel(info!)

      // The number the runner hands the gate, not the one the panel formats.
      expect(resolved.route.defaults.limits?.context).toBe(1_000_000)

      // 400k tokens: over the old 200k figure, well inside the real window.
      // Before the fix this compacted on every single turn.
      expect(yield* gate(resolved, 400_000)).toBe(false)
      expect(yield* gate(resolved, 990_000)).toBe(true)
    }),
  )

  it.effect("keeps Haiku's genuine 200k window rather than raising everything", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* seedAnthropic
      yield* addPlugin

      const info = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("haiku"))
      const resolved = yield* SessionRunnerModel.fromCatalogModel(info!)

      expect(resolved.route.defaults.limits?.context).toBe(200_000)
      expect(yield* gate(resolved, 400_000)).toBe(true)
    }),
  )
})

describe("ClaudeCodeCLI.windowsByFamily", () => {
  it.effect("ignores entries with no family or no declared window", () =>
    Effect.sync(() => {
      const windows = ClaudeCodeCLI.windowsByFamily([
        { family: undefined, released: 9_000, limit: { context: 999_999, output: 1 } },
        { family: "claude-opus", released: 9_000, limit: { context: 0, output: 0 } },
        { family: "claude-opus", released: 1, limit: { context: 200_000, output: 64_000 } },
      ])
      // The zero-context entry is newer but says nothing; it must not shadow a
      // real one, or `unknownContextWindow` would disable compaction.
      expect(windows.get("claude-opus")).toEqual({ context: 200_000, output: 64_000 })
    }),
  )
})
