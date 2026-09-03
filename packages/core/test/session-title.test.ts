import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { LLMError, LLMEvent, LLMResponse, Model, TransportReason, type LLMRequest } from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AgentPlugin } from "@turenlabs/core/plugin/agent"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { SessionRunnerTitle } from "@turenlabs/core/session/runner/title"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { location as locationFixture } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCreation.node,
      AgentV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    ],
  ),
)

const directory = AbsolutePath.make("/project")
const location = Location.Ref.make({ directory })
const model = Model.make({ id: "small", provider: "fake", route: OpenAIChat.route })
const overrideModel = Model.make({ id: "configured-title-model", provider: "fake", route: OpenAIChat.route })

/**
 * The real registry, booted the way the product boots it. Nothing here re-declares the `title`
 * agent: if `plugin/agent.ts` stops registering it, or stops giving it a system prompt, these tests
 * stop seeing a title rather than quietly passing against a local stand-in.
 */
const bootAgents = Effect.fnUntraced(function* () {
  const agents = yield* AgentV2.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
    Effect.provideService(Location.Service, Location.Service.of(locationFixture({ directory }))),
  )
  return agents
})

type Harness = {
  readonly requests: LLMRequest[]
  readonly resolvedVariants: (ModelV2.VariantID | undefined)[]
  readonly titler: SessionRunnerTitle.Interface
}

const answer = (text: string) =>
  LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "blk_1" }),
    LLMEvent.textDelta({ id: "blk_1", text }),
    LLMEvent.textEnd({ id: "blk_1" }),
    LLMEvent.finish({ reason: "stop" }),
  ])!

const harness = Effect.fnUntraced(function* (options: {
  readonly generate: (request: LLMRequest) => Effect.Effect<LLMResponse, LLMError>
}) {
  const agents = yield* bootAgents()
  const requests: LLMRequest[] = []
  const resolvedVariants: (ModelV2.VariantID | undefined)[] = []
  const titler = SessionRunnerTitle.make({
    agents,
    events: yield* EventV2.Service,
    llm: {
      generate: (request: LLMRequest) => {
        requests.push(request)
        return options.generate(request)
      },
    },
    models: SessionRunnerModel.Service.of({
      resolve: (session) => {
        resolvedVariants.push(session.model?.variant)
        return Effect.succeed({
          model: String(session.model?.id) === String(overrideModel.id) ? overrideModel : model,
          ref: ModelV2.Ref.make({
            id: ModelV2.ID.make(session.model?.id ?? model.id),
            providerID: ProviderV2.ID.make("fake"),
          }),
          cost: [],
        })
      },
    }),
    store: yield* SessionStore.Service,
  })
  return { requests, resolvedVariants, titler } satisfies Harness
})

const seed = Effect.fnUntraced(function* (options: {
  readonly text: string
  readonly parentID?: SessionSchema.ID
  readonly model?: ModelV2.Ref
}) {
  const creation = yield* SessionCreation.Service
  const events = yield* EventV2.Service
  const session = yield* creation.create({
    location,
    ...(options.parentID ? { parentID: options.parentID } : {}),
    ...(options.model ? { model: options.model } : {}),
  })
  yield* events.publish(SessionEvent.Prompted, {
    sessionID: session.id,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    prompt: Prompt.make({ text: options.text }),
    delivery: "steer",
  })
  return session
})

const titleOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const row = yield* db
    .select({ title: SessionTable.title })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
  return row?.title
})

const transportFailure = new LLMError({
  module: "test",
  method: "generate",
  reason: new TransportReason({ message: "boom" }),
})

describe("SessionRunnerTitle", () => {
  it.effect("asks the registered title agent's model and projects the answer as a durable event", () =>
    Effect.gen(function* () {
      const { requests, titler } = yield* harness({
        generate: () => Effect.succeed(answer("Fix flaky login redirect")),
      })
      const session = yield* seed({ text: "the login page redirects twice on Safari, help me work out why" })
      expect(SessionCreation.isPlaceholderTitle(session.title)).toBe(true)

      yield* titler.ensure(session.id)

      // The model was actually asked, and asked with the prompt the real registration carries.
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      const system = request.system.map((part) => part.text)
      expect(system).toHaveLength(1)
      expect(system[0]).toStartWith("You are a title generator. You output ONLY a thread title.")
      expect(system[0]).toContain("Never include tool names in the title")
      expect(request.tools).toEqual([])
      expect(request.messages).toHaveLength(1)
      expect(JSON.stringify(request.messages[0]!.content)).toContain("redirects twice on Safari")

      expect(yield* titleOf(session.id)).toBe("Fix flaky login redirect")

      // Durable, not a row poke: a second participant replaying this Session sees the rename.
      const db = (yield* Database.Service).db
      const types = (yield* db.select({ type: EventTable.type }).from(EventTable).all()).map((row) => row.type)
      expect(types).toContain("session.next.title.updated.1")
    }),
  )

  it.effect("honours a configured model override on the title agent", () =>
    Effect.gen(function* () {
      const { requests, titler } = yield* harness({ generate: () => Effect.succeed(answer("Override in play")) })
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.model = ModelV2.Ref.make({
            id: ModelV2.ID.make(overrideModel.id),
            providerID: ProviderV2.ID.make("fake"),
          })
        }),
      )
      const session = yield* seed({ text: "rename this session please" })

      yield* titler.ensure(session.id)

      expect(String(requests[0]!.model.id)).toBe(overrideModel.id)
      expect(yield* titleOf(session.id)).toBe("Override in play")
    }),
  )

  it.effect("does not inherit the primary model's reasoning variant", () =>
    Effect.gen(function* () {
      const { resolvedVariants, titler } = yield* harness({ generate: () => Effect.succeed(answer("Fast title")) })
      const session = yield* seed({
        text: "keep the title request cheap",
        model: ModelV2.Ref.make({
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make("fake"),
          variant: ModelV2.VariantID.make("max"),
        }),
      })

      yield* titler.ensure(session.id)

      expect(resolvedVariants).toEqual([undefined])
    }),
  )

  it.effect("never titles a subagent session", () =>
    Effect.gen(function* () {
      const { requests, titler } = yield* harness({ generate: () => Effect.die("must not be asked") })
      const parent = yield* seed({ text: "parent work" })
      const child = yield* seed({ text: "child work", parentID: parent.id })

      yield* titler.ensure(child.id)

      expect(requests).toHaveLength(0)
      expect(yield* titleOf(child.id)).toBe(child.title)
    }),
  )

  it.effect("leaves a name somebody already chose alone", () =>
    Effect.gen(function* () {
      const { requests, titler } = yield* harness({ generate: () => Effect.die("must not be asked") })
      const creation = yield* SessionCreation.Service
      const session = yield* creation.create({ location, title: "Named by hand" })

      yield* titler.ensure(session.id)

      expect(requests).toHaveLength(0)
      expect(yield* titleOf(session.id)).toBe("Named by hand")
    }),
  )

  it.effect("does not ask before there is a prompt to name the session after", () =>
    Effect.gen(function* () {
      const { requests, titler } = yield* harness({ generate: () => Effect.die("must not be asked") })
      const creation = yield* SessionCreation.Service
      const session = yield* creation.create({ location })

      yield* titler.ensure(session.id)

      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("keeps the placeholder and stays quiet when the provider fails", () =>
    Effect.gen(function* () {
      const { requests, titler } = yield* harness({ generate: () => Effect.fail(transportFailure) })
      const session = yield* seed({ text: "something the provider will refuse" })

      yield* titler.ensure(session.id)

      expect(requests).toHaveLength(1)
      expect(yield* titleOf(session.id)).toBe(session.title)
      const db = (yield* Database.Service).db
      const types = (yield* db.select({ type: EventTable.type }).from(EventTable).all()).map((row) => row.type)
      expect(types).not.toContain("session.next.title.updated.1")
    }),
  )

  it.effect("a failed attempt is retried by the next turn, and a settled title is not", () =>
    Effect.gen(function* () {
      let attempt = 0
      const { requests, titler } = yield* harness({
        generate: () => {
          attempt += 1
          return attempt === 1 ? Effect.fail(transportFailure) : Effect.succeed(answer("Second time lucky"))
        },
      })
      const session = yield* seed({ text: "retry me" })

      yield* titler.ensure(session.id)
      expect(yield* titleOf(session.id)).toBe(session.title)

      yield* titler.ensure(session.id)
      expect(yield* titleOf(session.id)).toBe("Second time lucky")

      // Now that it has a name, further turns cost nothing.
      yield* titler.ensure(session.id)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("takes the first line only and clamps a runaway answer", () =>
    Effect.gen(function* () {
      const { titler } = yield* harness({
        generate: () => Effect.succeed(answer(`<think>weighing options</think>\n\n${"x".repeat(200)}\nand more`)),
      })
      const session = yield* seed({ text: "clamp me" })

      yield* titler.ensure(session.id)

      const title = yield* titleOf(session.id)
      expect(title).toBe(`${"x".repeat(97)}...`)
    }),
  )

  it.effect("keeps the placeholder when the model answers with nothing usable", () =>
    Effect.gen(function* () {
      const { titler } = yield* harness({ generate: () => Effect.succeed(answer("  \n \n ")) })
      const session = yield* seed({ text: "empty answer" })

      yield* titler.ensure(session.id)

      expect(yield* titleOf(session.id)).toBe(session.title)
    }),
  )

  it.effect("abandons a provider that never answers instead of holding the attempt open", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { titler } = yield* harness({
        generate: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const session = yield* seed({ text: "hangs forever" })

      const fiber = yield* Effect.forkChild(titler.ensure(session.id))
      yield* Deferred.await(started)
      yield* TestClock.adjust("31 seconds")

      // Settles on its own rather than needing to be interrupted, and writes nothing.
      yield* Fiber.join(fiber)
      expect(yield* titleOf(session.id)).toBe(session.title)
    }),
  )

  it.effect("collapses overlapping attempts for the same session into one provider call", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { requests, titler } = yield* harness({
        generate: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(answer("Only once")),
          ),
      })
      const session = yield* seed({ text: "two runs, one title" })

      const first = yield* Effect.forkChild(titler.ensure(session.id))
      yield* Deferred.await(started)
      yield* titler.ensure(session.id)
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect(yield* titleOf(session.id)).toBe("Only once")
    }),
  )
})
