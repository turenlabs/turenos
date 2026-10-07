import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer, LayerMap, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import { Project } from "@turenlabs/core/project"
import { Pty } from "@turenlabs/core/pty"
import { PtyID } from "@turenlabs/core/pty/schema"
import { PtyTicket } from "@turenlabs/core/pty/ticket"
import { AbsolutePath } from "@turenlabs/core/schema"
import { WorkspaceV2 } from "@turenlabs/core/workspace"
import { Authorization } from "@turenlabs/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@turenlabs/protocol/middleware/schema-error"
import { PtyGroup } from "@turenlabs/protocol/groups/pty"
import { ServerAuth } from "../auth"
import { CorsConfig } from "../cors"
import { layer, LocationMiddleware, type LocationServices } from "../location"
import { authorizationLayer } from "../middleware/authorization"
import { schemaErrorLayer } from "../middleware/schema-error"
import { PtyEnvironment } from "../pty-environment"
import { PtyHandler } from "./pty"

const directory = AbsolutePath.make("/pty-preflight-fixture")
const existing = PtyID.make("pty_existing")
const missing = PtyID.make("pty_missing")

async function fixture(options: { password?: boolean; ttl?: Duration.Input; cors?: string[] } = {}) {
  const calls: string[] = []
  const refs: Location.Ref[] = []
  const tickets = await Effect.runPromise(PtyTicket.make(options.ttl))
  const locations = Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make((ref: Location.Ref) =>
      Layer.mergeAll(
        Layer.succeed(Location.Service, {
          directory: ref.directory,
          workspaceID: ref.workspaceID,
          project: { id: Project.ID.make("global"), directory: ref.directory },
        }),
        Layer.mock(Pty.Service, {
          get: (ptyID) =>
            Effect.gen(function* () {
              calls.push(`pty.get:${ptyID}`)
              if (ptyID !== existing) return yield* new Pty.NotFoundError({ ptyID })
              return {
                id: ptyID,
                title: "fixture",
                command: "fixture",
                args: [],
                cwd: directory,
                status: "running",
                pid: 1,
              }
            }),
        }),
      ).pipe(
        Layer.tap(() =>
          Effect.sync(() => {
            refs.push(ref)
            calls.push(`location.build:${ref.directory}`)
          }),
        ),
      ),
    ).pipe(
      // This route-only fixture intentionally omits unrelated Location services.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Effect.map((map) => map as LayerMap.LayerMap<Location.Ref, LocationServices>),
    ),
  )
  const app = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(
      HttpApi.make("server")
        .add(PtyGroup.middleware(LocationMiddleware))
        .middleware(Authorization)
        .middleware(SchemaErrorMiddleware),
    ).pipe(
      Layer.provide(PtyHandler),
      Layer.provide(layer),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(
        ServerAuth.Config.configLayer({
          username: "forge",
          password: options.password ? Option.some("fixture-only") : Option.none(),
        }),
      ),
      Layer.provide(Layer.succeed(CorsConfig, { cors: options.cors })),
      Layer.provide(locations),
      Layer.provide(PtyEnvironment.layer),
      Layer.provide(
        Layer.succeed(PtyTicket.Service, {
          issue: (input) => tickets.issue(input),
          consume: (input) =>
            Effect.sync(() => calls.push("ticket.consume")).pipe(Effect.andThen(tickets.consume(input))),
        }),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
  return {
    calls,
    refs,
    tickets,
    connect: (ptyID: string, query = `directory=${directory}`, headers: HeadersInit = {}) =>
      app.handler(new Request(`http://localhost/api/pty/${ptyID}/connect?${query}`, { headers })),
    [Symbol.asyncDispose]: () => app.dispose(),
  }
}

describe("PTY connection authorization preflight", () => {
  test("Basic auth rejects ticketless requests before Location", async () => {
    await using app = await fixture({ password: true })
    expect((await app.connect(missing)).status).toBe(401)
    expect(app.calls).toEqual([])
  })

  for (const input of [
    { name: "missing ticket", query: "", headers: new Headers() },
    {
      name: "invalid ticket with Basic auth enabled",
      query: "&ticket=invalid",
      headers: new Headers(),
      password: true,
    },
    {
      name: "rejected origin",
      query: "&ticket=invalid",
      headers: new Headers({ origin: "https://denied.example" }),
      password: true,
    },
  ]) {
    test(`${input.name} cannot distinguish missing and existing PTYs`, async () => {
      await using app = await fixture({ password: input.password })
      const absent = await app.connect(missing, `directory=${directory}${input.query}`, input.headers)
      const present = await app.connect(existing, `directory=${directory}${input.query}`, input.headers)
      expect([absent.status, present.status]).toEqual([403, 403])
      expect([await absent.text(), await present.text()]).toEqual(["", ""])
      expect(app.calls.filter((call) => call.startsWith("location.") || call.startsWith("pty."))).toEqual([])
    })
  }

  for (const ptyID of ["not-a-pty", "%6Eot-a-pty"]) {
    test(`malformed PTY ID ${ptyID} is forbidden before Location, PTY, or ticket work`, async () => {
      await using app = await fixture({ password: true })
      const invalid = await app.connect(ptyID, `directory=${directory}&ticket=invalid`)
      expect(invalid.status).toBe(403)
      expect(await invalid.text()).toBe("")
      expect(app.calls).toEqual([])
      expect(app.refs).toEqual([])

      const issued = await Effect.runPromise(app.tickets.issue({ ptyID: missing, directory }))
      const query = `directory=${directory}&ticket=${issued.ticket}`
      const malformed = await app.connect(ptyID, query)
      expect(malformed.status).toBe(403)
      expect(await malformed.text()).toBe("")
      expect(app.calls).toEqual([])
      expect(app.refs).toEqual([])

      expect((await app.connect(missing, query)).status).toBe(404)
      expect(app.calls).toEqual(["ticket.consume", `location.build:${directory}`, `pty.get:${missing}`])
    })
  }

  test("rejected origin preserves a valid ticket for an authorized missing PTY", async () => {
    await using app = await fixture({ password: true })
    const issued = await Effect.runPromise(app.tickets.issue({ ptyID: missing, directory }))
    const query = `directory=${directory}&ticket=${issued.ticket}`
    expect((await app.connect(missing, query, { origin: "https://denied.example" })).status).toBe(403)
    expect(app.calls).toEqual([])
    const authorized = await app.connect(missing, query)
    expect(authorized.status).toBe(404)
    expect(await authorized.text()).toBe("")
    expect(app.calls).toEqual(["ticket.consume", `location.build:${directory}`, `pty.get:${missing}`])
    app.calls.length = 0
    expect((await app.connect(missing, query)).status).toBe(403)
    expect(app.calls).toEqual(["ticket.consume"])
  })

  for (const field of ["ptyID", "directory", "workspaceID"] as const) {
    test(`wrong ${field} does not initialize Location or consume the ticket`, async () => {
      await using app = await fixture({ password: true })
      const workspaceID = WorkspaceV2.ID.make("wrk_ticket")
      const issued = await Effect.runPromise(app.tickets.issue({ ptyID: missing, directory, workspaceID }))
      const query = new URLSearchParams({
        ticket: issued.ticket,
        directory: field === "directory" ? "/other-directory" : directory,
        workspace: field === "workspaceID" ? "wrk_other" : workspaceID,
      })
      expect((await app.connect(field === "ptyID" ? existing : missing, query.toString())).status).toBe(403)
      expect(app.calls).toEqual(["ticket.consume"])
      app.calls.length = 0
      expect(
        (await app.connect(missing, `directory=${directory}&workspace=${workspaceID}&ticket=${issued.ticket}`)).status,
      ).toBe(404)
      expect(app.calls).toEqual(["ticket.consume", `location.build:${directory}`, `pty.get:${missing}`])
      expect(app.refs).toEqual([Location.Ref.make({ directory, workspaceID })])
    })
  }

  test("expired tickets are forbidden before Location or PTY lookup", async () => {
    await using app = await fixture({ password: true, ttl: 1 })
    const issued = await Effect.runPromise(app.tickets.issue({ ptyID: missing, directory }))
    // Real time passing is the behavior under test, not a readiness barrier.
    await Effect.runPromise(Effect.sleep(25))
    expect((await app.connect(missing, `directory=${directory}&ticket=${issued.ticket}`)).status).toBe(403)
    expect(app.calls).toEqual(["ticket.consume"])
  })

  for (const input of [
    { name: "plain query", query: `directory=${directory}&workspace=wrk_ticket`, directory, workspace: "wrk_ticket" },
    {
      name: "scoped query",
      query: `location[directory]=${directory}&location[workspace]=wrk_ticket`,
      directory,
      workspace: "wrk_ticket",
    },
    {
      name: "matching aliases",
      query: `directory=${directory}&location[directory]=${directory}&workspace=wrk_ticket&location[workspace]=wrk_ticket`,
      directory,
      workspace: "wrk_ticket",
    },
    { name: "encoded query", query: "location[directory]=%2Fpty%20fixture%25", directory: "/pty fixture%" },
    {
      name: "header fallback",
      query: "",
      headers: new Headers({ "x-forge-directory": "%2Fpty%20fixture%25", "x-forge-workspace": "wrk_ticket" }),
      directory: "/pty fixture%",
      workspace: "wrk_ticket",
    },
    {
      name: "empty query header fallback",
      query: "directory=&location[directory]=&workspace=&location[workspace]=",
      headers: new Headers({ "x-forge-directory": directory, "x-forge-workspace": "wrk_ticket" }),
      directory,
      workspace: "wrk_ticket",
    },
    {
      name: "query overrides headers",
      query: `directory=${directory}&workspace=wrk_ticket`,
      headers: new Headers({ "x-forge-directory": "/ignored", "x-forge-workspace": "wrk_ignored" }),
      directory,
      workspace: "wrk_ticket",
    },
    {
      name: "undecodable header fallback",
      query: "",
      headers: new Headers({ "x-forge-directory": "/literal%path" }),
      directory: "/literal%path",
    },
    { name: "default directory", query: "", directory: process.cwd() },
    { name: "encoded route parameter", query: `directory=${directory}`, directory, ptyID: "%70ty_missing" },
    {
      name: "allowed configured origin",
      query: `directory=${directory}`,
      directory,
      headers: new Headers({ origin: "https://allowed.example" }),
    },
    {
      name: "same host origin",
      query: `directory=${directory}`,
      directory,
      headers: new Headers({ origin: "http://localhost", host: "localhost" }),
    },
  ]) {
    test(`${input.name} uses exactly the ticket's Location scope`, async () => {
      await using app = await fixture({ cors: ["https://allowed.example"] })
      const scope = {
        ptyID: missing,
        directory: AbsolutePath.make(input.directory),
        workspaceID: input.workspace ? WorkspaceV2.ID.make(input.workspace) : undefined,
      }
      const issued = await Effect.runPromise(app.tickets.issue(scope))
      expect(
        (await app.connect(input.ptyID ?? missing, `${input.query}&ticket=${issued.ticket}`, input.headers)).status,
      ).toBe(404)
      expect(app.calls).toEqual(["ticket.consume", `location.build:${scope.directory}`, `pty.get:${missing}`])
      expect(app.refs).toEqual([Location.Ref.make({ directory: scope.directory, workspaceID: scope.workspaceID })])
      expect(await Effect.runPromise(app.tickets.consume({ ...scope, ticket: issued.ticket }))).toBe(false)
    })
  }

  for (const query of [
    `directory=${directory}&location[directory]=/conflicting`,
    `directory=${directory}&workspace=wrk_ticket&location[workspace]=wrk_conflicting`,
  ]) {
    test(`conflicting aliases reject without consuming a ticket: ${query}`, async () => {
      await using app = await fixture()
      const issued = await Effect.runPromise(app.tickets.issue({ ptyID: missing, directory }))
      const response = await app.connect(missing, `${query}&ticket=${issued.ticket}`)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("Conflicting location query parameters")
      expect(app.calls).toEqual([])
      expect((await app.connect(missing, `directory=${directory}&ticket=${issued.ticket}`)).status).toBe(404)
    })
  }
})
