import { Effect, Schema } from "effect"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { check, object, parse, stable } from "./assertions"
import { call } from "./backend"
import { http, route } from "./dsl"
import type { ActiveScenario, ScenarioContext } from "./types"

const endpoint = "/api/session/{sessionID}/whiteboard"
const element = {
  id: "httpapi-rectangle",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 80,
  angle: 0,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
}
const presence = {
  clientID: "httpapi-whiteboard",
  username: "HTTP API",
  pointer: { x: 3, y: 4 },
  selectedElementIds: [element.id],
}

function request(ctx: ScenarioContext, scenario: ActiveScenario) {
  return Effect.gen(function* () {
    const result = yield* call(scenario, { ...ctx, state: undefined })
    yield* scenario.expect(ctx, undefined, result)
    return result
  })
}

function seed(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const result = yield* request(
      ctx,
      http.protected
        .post("/api/session", "whiteboard.seed")
        .at(() => ({
          path: "/api/session",
          headers: ctx.headers(),
          body: {
            agent: "build",
            model: { providerID: "test", id: "test" },
            location: { directory: ctx.directory },
          },
        }))
        .json(),
    )
    object(result.body)
    object(result.body.data)
    check(typeof result.body.data.id === "string", "seed should create a V2 session")
    return { id: result.body.data.id, path: route(endpoint, { sessionID: result.body.data.id }) }
  })
}

export const whiteboardScenarios = [
  http.protected
    .get(endpoint, "v2.whiteboard.get")
    .seeded(seed)
    .at((ctx) => ({ path: ctx.state.path, headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      const snapshot = Schema.decodeUnknownSync(Whiteboard.Snapshot)(body)
      check(snapshot.sessionID === ctx.state.id, "board should belong to the requested root session")
      check(snapshot.revision === 0, "new board should have revision zero")
      check(snapshot.elements.length === 0 && Object.keys(snapshot.files).length === 0, "new board should be empty")
    }),
  http.protected
    .patch(endpoint, "v2.whiteboard.update")
    .mutating()
    .seeded(seed)
    .at((ctx) => ({
      path: ctx.state.path,
      headers: ctx.headers(),
      body: {
        clientID: presence.clientID,
        username: presence.username,
        patch: { elements: [element], baseRevision: 0 },
      },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        const snapshot = Schema.decodeUnknownSync(Whiteboard.Snapshot)(body)
        check(snapshot.sessionID === ctx.state.id, "patch should target the requested root session")
        check(snapshot.revision === 1, "patch should advance the revision")
        check(stable(snapshot.elements) === stable([element]), "patch should store the submitted element")
        const saved = yield* request(ctx, http.protected.get(ctx.state.path, "whiteboard.readback").json())
        check(stable(saved.body) === stable(snapshot), "GET should reload the persisted patch")
      }),
    ),
  http.protected
    .get(`${endpoint}/events`, "v2.whiteboard.events")
    .seeded(seed)
    .at((ctx) => ({ path: `${ctx.state.path}/events`, headers: ctx.headers() }))
    .stream()
    .status(200, (ctx, result) =>
      Effect.sync(() => {
        check(result.contentType.includes("text/event-stream"), "whiteboard events should be SSE")
        const data = result.text.split("\n").find((line) => line.startsWith("data:"))
        check(data !== undefined, "SSE should emit an initial event")
        const event = Schema.decodeUnknownSync(Whiteboard.Events)(parse(data.slice(5).trim()))
        check(event.type === Whiteboard.Connected.type, "SSE should announce the connection")
        check(event.data.sessionID === ctx.state.id, "SSE should be scoped to the requested root session")
        check(event.data.revision === 0, "SSE should announce the current board revision")
      }),
    ),
  http.protected
    .post(`${endpoint}/presence`, "v2.whiteboard.presence")
    .mutating()
    .seeded(seed)
    .at((ctx) => ({ path: `${ctx.state.path}/presence`, headers: ctx.headers(), body: presence }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        const snapshot = Schema.decodeUnknownSync(Whiteboard.PresenceSnapshot)(body)
        check(snapshot.participants.length === 1, "presence should register one participant")
        const participant = snapshot.participants[0]!
        check(
          participant.clientID === presence.clientID && participant.username === presence.username,
          "presence should retain identity",
        )
        check(stable(participant.pointer) === stable(presence.pointer), "presence should retain the pointer")
        check(
          stable(participant.selectedElementIds) === stable(presence.selectedElementIds),
          "presence should retain selection",
        )
        const saved = yield* request(ctx, http.protected.get(ctx.state.path, "whiteboard.presence.readback").json())
        const board = Schema.decodeUnknownSync(Whiteboard.Snapshot)(saved.body)
        check(
          board.sessionID === ctx.state.id && board.revision === 0 && board.elements.length === 0,
          "presence should not mutate the root board",
        )
      }),
    ),
]
