import { Service } from "@turenlabs/core/session/whiteboard"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { EventV2 } from "@turenlabs/core/event"
import { Effect, Stream } from "effect"
import { encode } from "effect/unstable/encoding/Sse"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const WhiteboardHandler = HttpApiBuilder.group(Api, "server.whiteboard", (handlers) =>
  Effect.gen(function* () {
    const board = yield* Service
    const events = yield* EventV2.Service
    return handlers
      .handle("whiteboard.get", (ctx) => board.get(ctx.params.sessionID))
      .handle("whiteboard.update", (ctx) =>
        board.update(ctx.params.sessionID, ctx.payload.patch, {
          id: ctx.payload.clientID,
          name: ctx.payload.username,
          kind: "human",
        }),
      )
      .handle("whiteboard.presence", (ctx) => board.presence(ctx.params.sessionID, ctx.payload))
      .handleRaw("whiteboard.events", (ctx) =>
        Effect.gen(function* () {
          // Fail missing Sessions before returning HTTP 200. Recheck after subscribing as well.
          yield* board.get(ctx.params.sessionID)
          const output = Stream.unwrap(
            Effect.gen(function* () {
              // Listener installation precedes the snapshot read: a reconnect cannot lose a commit.
              const live = yield* EventV2.allBounded(events, 256)
              const snapshot = yield* board.get(ctx.params.sessionID)
              const presence = yield* board.participants(ctx.params.sessionID)
              const initial = [
                {
                  id: EventV2.ID.create(),
                  type: Whiteboard.Connected.type,
                  data: { sessionID: ctx.params.sessionID, revision: snapshot.revision },
                },
                {
                  id: EventV2.ID.create(),
                  type: Whiteboard.Presence.type,
                  data: { sessionID: ctx.params.sessionID, ...presence },
                },
              ]
              return Stream.fromIterable(initial).pipe(
                Stream.concat(
                  live.pipe(
                    Stream.filter(
                      (event) =>
                        (event.type === Whiteboard.Updated.type || event.type === Whiteboard.Presence.type) &&
                        (event.data as { sessionID?: string }).sessionID === ctx.params.sessionID,
                    ),
                  ),
                ),
              )
            }),
          ).pipe(
            Stream.map((event) => ({
              _tag: "Event" as const,
              event: "message",
              id: undefined,
              data: JSON.stringify(event),
            })),
            Stream.pipeThroughChannel(encode()),
          )
          return HttpServerResponse.stream(
            output.pipe(
              Stream.merge(Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n")), {
                haltStrategy: "left",
              }),
              Stream.encodeText,
            ),
            {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-store, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
  }),
)
