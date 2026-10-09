import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { EventV2 } from "@turenlabs/core/event"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionMessageUpdater } from "@turenlabs/core/session/message-updater"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
it.effect("live execution settlement does not append transcript messages", () =>
  Effect.gen(function* () {
    const state: SessionMessageUpdater.MemoryState = { messages: [] }
    yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: SessionEvent.ExecutionSettled.type,
      data: { sessionID: SessionSchema.ID.make("ses_settlement"), outcome: "success" },
    })
    expect(state.messages).toEqual([])
  }),
)
