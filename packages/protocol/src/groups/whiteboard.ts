import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { SessionID } from "@turenlabs/schema/session-id"
import { Context } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export const makeWhiteboardGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.whiteboard")
    .add(
      HttpApiEndpoint.get("whiteboard.get", "/api/session/:sessionID/whiteboard", {
        params: { sessionID: SessionID },
        success: Whiteboard.Snapshot,
        error: Whiteboard.NotFoundError,
      })
        .middleware(sessionMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.whiteboard.get", summary: "Read session whiteboard" })),
    )
    .add(
      HttpApiEndpoint.patch("whiteboard.update", "/api/session/:sessionID/whiteboard", {
        params: { sessionID: SessionID },
        payload: Whiteboard.UpdateRequest,
        success: Whiteboard.Snapshot,
        error: [Whiteboard.NotFoundError, Whiteboard.ValidationError, Whiteboard.ConflictError],
      })
        .middleware(sessionMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.whiteboard.update", summary: "Merge session whiteboard elements" }),
        ),
    )
    .add(
      HttpApiEndpoint.post("whiteboard.presence", "/api/session/:sessionID/whiteboard/presence", {
        params: { sessionID: SessionID },
        payload: Whiteboard.PresenceInput,
        success: Whiteboard.PresenceSnapshot,
        error: [Whiteboard.NotFoundError, Whiteboard.ValidationError, Whiteboard.ConflictError],
      })
        .middleware(sessionMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.whiteboard.presence",
            summary: "Update ephemeral whiteboard presence",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("whiteboard.events", "/api/session/:sessionID/whiteboard/events", {
        params: { sessionID: SessionID },
        success: HttpApiSchema.StreamSse({ data: Whiteboard.Events }),
        error: Whiteboard.NotFoundError,
      })
        .middleware(sessionMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.whiteboard.events",
            summary: "Subscribe to session whiteboard notifications",
          }),
        ),
    )
