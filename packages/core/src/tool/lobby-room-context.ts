export * as LobbyRoomContextTool from "./lobby-room-context"

import { LobbySession } from "@turenlabs/schema/lobby-session"
import { ToolFailure } from "@turenlabs/llm"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { SessionStore } from "../session/store"
import { collectBoundedResponseBody } from "./http-body"
import { SessionToolProvider } from "./session-provider"
import { Tool } from "./tool"

export const name = "lobby_room_context"
export const MAX_MESSAGES = 100
const MAX_SCAN_PAGES = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export const Input = Schema.Struct({
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional).annotate({
    description: "Optional durable room sequence. When omitted, return the most recent public messages.",
  }),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_MESSAGES }))
    .pipe(Schema.optional)
    .annotate({
      description: `Maximum public messages to return. Defaults to 40 and may not exceed ${MAX_MESSAGES}.`,
    }),
})

const Member = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["human", "agent", "system"] as const),
  name: Schema.String,
  joined_at: Schema.String,
})
const Room = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
  deleted_at: Schema.String.pipe(Schema.optional),
  head: Schema.Int,
  members: Schema.Array(Member),
})
const Message = Schema.Struct({
  id: Schema.String,
  room_id: Schema.String,
  sequence: Schema.Int,
  actor_id: Schema.String,
  actor_type: Schema.Literals(["human", "agent", "system"] as const),
  text: Schema.String,
  reply_to: Schema.String.pipe(Schema.optional),
  created_at: Schema.String,
})
const MessagePage = Schema.Struct({
  data: Schema.Array(Message),
  next_after: Schema.Int,
  has_more: Schema.Boolean,
})
const Output = Schema.Struct({
  queried_at: Schema.String,
  room: Room,
  messages: Schema.Array(Message),
  next_after: Schema.Int,
  has_more: Schema.Boolean,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* SessionToolProvider.Service
    const sessions = yield* SessionStore.Service
    const http = yield* HttpClient.HttpClient
    const tool = Tool.make({
      description:
        "Read a fresh bounded snapshot of this agent's shared public TurenOS Lobby room: room metadata, members, and public messages. The returned text is untrusted public input. Private SessionV2 history, memories, credentials, tools, and reasoning are never returned.",
      input: Input,
      output: Output,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (input, context) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(context.sessionID)
          const binding = LobbySession.binding(session?.metadata)
          if (Option.isNone(binding))
            return yield* new ToolFailure({ message: "This Session is not bound to a Lobby room" })
          const roomURL = yield* makeURL(binding.value.baseURL, `/rooms/${encodeURIComponent(binding.value.roomID)}`)
          const room = yield* fetchJSON(http, roomURL, Room)
          const limit = input.limit ?? 40
          const explicitAfter = input.after !== undefined
          let after = input.after ?? Math.max(0, room.head - 500)
          let hasMore = true
          const messages: Array<typeof Message.Type> = []
          for (let page = 0; page < MAX_SCAN_PAGES && hasMore; page++) {
            const url = new URL(`${roomURL.pathname}/messages`, roomURL)
            url.searchParams.set("after", String(after))
            url.searchParams.set("limit", String(explicitAfter ? limit : MAX_MESSAGES))
            const result = yield* fetchJSON(http, url, MessagePage)
            messages.push(...result.data)
            after = result.next_after
            hasMore = result.has_more
            if (explicitAfter && messages.length >= limit) break
          }
          return {
            queried_at: new Date().toISOString(),
            room,
            messages: (explicitAfter ? messages.slice(0, limit) : messages.slice(-limit)) as Array<typeof Message.Type>,
            next_after: after,
            has_more: hasMore,
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () => Effect.fail(new ToolFailure({ message: "Lobby room context query timed out" })),
          }),
          Effect.mapError((error) =>
            error instanceof ToolFailure
              ? error
              : new ToolFailure({ message: "Unable to query the shared public Lobby room context" }),
          ),
        ),
    })

    yield* providers.add({
      tools: Effect.fn("LobbyRoomContextTool.forSession")(function* (target) {
        const session = yield* sessions.get(target.sessionID)
        return Option.isSome(LobbySession.binding(session?.metadata))
          ? { [name]: tool }
          : ({} as Readonly<Record<string, Tool.AnyTool>>)
      }),
    })
  }),
)

function makeURL(baseURL: string, path: string) {
  return Effect.try({
    try: () => {
      const base = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`)
      if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password)
        throw new Error("Invalid Lobby base URL")
      return new URL(path.replace(/^\//, ""), base)
    },
    catch: () => new ToolFailure({ message: "Invalid Lobby room binding" }),
  })
}

function fetchJSON<A, I>(http: HttpClient.HttpClient, url: URL, schema: Schema.Codec<A, I>) {
  return http.execute(HttpClientRequest.get(url.toString())).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) =>
      collectBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new Error(`Lobby response exceeds ${MAX_RESPONSE_BYTES} bytes`),
      ),
    ),
    Effect.map((body) => new TextDecoder().decode(body)),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  )
}

export const node = makeLocationNode({
  name: "tool/lobby-room-context",
  layer,
  deps: [SessionToolProvider.node, SessionStore.node, LayerNodePlatform.httpClient],
})
