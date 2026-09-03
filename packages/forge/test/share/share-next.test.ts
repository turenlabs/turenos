import { beforeEach, describe, expect } from "bun:test"
import { Database } from "@turenlabs/core/database/database"
import { httpClient } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionShareTable } from "@turenlabs/core/share/sql"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AccountRepo } from "../../src/account/repo"
import { AccessToken, OrgID, RefreshToken, RemoteAccountID } from "../../src/account/schema"
import { Env } from "@/env"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const none = HttpClient.make(() => Effect.die("unexpected http call"))

const legacyEndpoint = "https://legacy-share.example.com"

function envService(endpoint: string | null) {
  const values = endpoint ? { FORGE_LEGACY_SHARE_ENDPOINT: endpoint } : {}
  return Env.Service.of({
    get: (key) => Effect.succeed(values[key as keyof typeof values]),
    all: () => Effect.succeed(values),
    set: () => Effect.void,
    remove: () => Effect.void,
  })
}

function requestLayer(client: HttpClient.HttpClient, endpoint: string | null = legacyEndpoint) {
  const replacement = [
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
    [Env.node, Layer.succeed(Env.Service, envService(endpoint))],
  ] as const
  return LayerNode.compile(LayerNode.group([ShareNext.node, AccountRepo.node]), replacement)
}

function integrationLayer(client: HttpClient.HttpClient, endpoint: string | null = legacyEndpoint) {
  const replacement = [
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
    [Env.node, Layer.succeed(Env.Service, envService(endpoint))],
  ] as const
  return LayerNode.compile(
    LayerNode.group([
      ShareNext.node,
      SessionShare.node,
      Session.node,
      SessionProjector.node,
      AccountRepo.node,
      Database.node,
    ]),
    replacement,
  )
}

const persistedShare = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, id))
      .get()
      .pipe(Effect.orDie)
  })

const seedShare = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionShareTable)
      .values({
        session_id: sessionID,
        id: "shr_abc",
        url: "https://legacy-share.example.com/share/abc",
        secret: "sec_123",
      })
      .run()
      .pipe(Effect.orDie)
    yield* markShared(sessionID)
  })

const markShared = (sessionID: SessionID) =>
  Database.Service.use(({ db }) =>
    db
      .update(SessionTable)
      .set({ share_url: "https://legacy-share.example.com/share/abc" })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie),
  )

const seedAccount = (url: string, org?: string) =>
  AccountRepo.Service.use((repo) =>
    repo.persistAccount({
      remoteID: RemoteAccountID.make("account-1"),
      email: "user@example.com",
      url,
      accessToken: AccessToken.make("st_test_token"),
      refreshToken: RefreshToken.make("rt_test_token"),
      expiry: Date.now() + 10 * 60_000,
      orgID: org ? Option.some(OrgID.make(org)) : Option.none(),
    }),
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext legacy cleanup", () => {
  it.live("request exposes only read and revoke paths for the legacy share API", () =>
    provideTmpdirInstance(
      () =>
        ShareNext.Service.use((service) =>
          Effect.gen(function* () {
            const req = yield* service.request()

            expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
            expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
            expect(req.baseUrl).toBe("https://legacy-share.example.com")
            expect(req.headers).toEqual({})
            expect(Object.keys(req.api).sort()).toEqual(["data", "remove"])
          }),
        ).pipe(Effect.provide(requestLayer(none))),
      {},
    ),
  )

  it.live("request fails closed when no legacy endpoint is explicitly configured", () =>
    provideTmpdirInstance(() =>
      ShareNext.Service.use((service) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(service.request())

          expect(Exit.isFailure(exit)).toBe(true)
        }),
      ).pipe(Effect.provide(requestLayer(none, null))),
    ),
  )

  it.live("request preserves authenticated org paths needed for legacy cleanup and import", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seedAccount("https://control.example.com", "org-1")

        const req = yield* ShareNext.use.request()

        expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
        expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
        expect(req.baseUrl).toBe("https://control.example.com")
        expect(req.headers).toEqual({
          authorization: "Bearer st_test_token",
          "x-org-id": "org-1",
        })
      }).pipe(Effect.provide(requestLayer(none, "https://control.example.com"))),
    ),
  )

  it.live("request never attaches account credentials across origins", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        yield* seedAccount("https://control.example.com", "org-1")

        const exit = yield* Effect.exit(ShareNext.use.request())

        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(Effect.provide(requestLayer(none, "https://legacy-share.example.com"))),
    ),
  )

  it.live("remove revokes the remote share before deleting persisted credentials", () =>
    provideTmpdirInstance(
      () => {
        const seen: HttpClientRequest.HttpClientRequest[] = []
        const client = HttpClient.make((req) => {
          seen.push(req)
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 })))
        })
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "legacy shared session" })
          yield* seedShare(session.id)

          yield* ShareNext.use.remove(session.id)

          expect(yield* persistedShare(session.id)).toBeUndefined()
          expect(seen).toHaveLength(1)
          expect(seen[0]?.method).toBe("DELETE")
          expect(seen[0]?.url).toBe("https://legacy-share.example.com/api/share/shr_abc")
          expect(seen[0]?.body._tag).toBe("Uint8Array")
          if (seen[0]?.body._tag === "Uint8Array") {
            expect(JSON.parse(new TextDecoder().decode(seen[0].body.body))).toEqual({ secret: "sec_123" })
          }
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove retains credentials when remote revocation fails", () =>
    provideTmpdirInstance(
      () => {
        const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "unavailable" }, 503)))
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "legacy shared session" })
          yield* seedShare(session.id)

          const exit = yield* Effect.exit(ShareNext.use.remove(session.id))

          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* persistedShare(session.id)).toMatchObject({
            session_id: session.id,
            id: "shr_abc",
            secret: "sec_123",
          })
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove retains local credentials without attempting network access when opt-in is absent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "legacy shared session" })
        yield* seedShare(session.id)

        const exit = yield* Effect.exit(ShareNext.use.remove(session.id))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* persistedShare(session.id)).toMatchObject({
          session_id: session.id,
          id: "shr_abc",
          secret: "sec_123",
        })
      }).pipe(Effect.provide(integrationLayer(none, null))),
    ),
  )

  it.live("remove retains credentials for ambiguous remote 404 and 410 responses", () =>
    provideTmpdirInstance(
      () => {
        const statuses = [404, 410]
        const client = HttpClient.make((req) =>
          Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: statuses.shift() ?? 500 }))),
        )
        return Effect.gen(function* () {
          const session = yield* Session.Service
          const missing = yield* session.create({ title: "already missing" })
          const gone = yield* session.create({ title: "already gone" })
          yield* seedShare(missing.id)
          yield* seedShare(gone.id)

          expect(Exit.isFailure(yield* Effect.exit(ShareNext.use.remove(missing.id)))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ShareNext.use.remove(gone.id)))).toBe(true)
          expect(yield* persistedShare(missing.id)).toMatchObject({ id: "shr_abc", secret: "sec_123" })
          expect(yield* persistedShare(gone.id)).toMatchObject({ id: "shr_abc", secret: "sec_123" })
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("remove is an idempotent no-op when no legacy credentials exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "private session" })
        yield* ShareNext.use.remove(session.id)
      }).pipe(Effect.provide(integrationLayer(none))),
    ),
  )

  it.live("unshare clears public session metadata only after remote revocation succeeds", () =>
    provideTmpdirInstance(
      () => {
        const client = HttpClient.make((req) =>
          Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 }))),
        )
        return Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "legacy shared session" })
          yield* seedShare(info.id)

          yield* SessionShare.Service.use((service) => service.unshare(info.id))

          expect((yield* session.get(info.id)).shared).toBeUndefined()
          expect(yield* persistedShare(info.id)).toBeUndefined()
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("unshare retains public session metadata and credentials when remote revocation fails", () =>
    provideTmpdirInstance(
      () => {
        const client = HttpClient.make((req) => Effect.succeed(json(req, { error: "unavailable" }, 503)))
        return Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "legacy shared session" })
          yield* seedShare(info.id)

          const exit = yield* SessionShare.Service.use((service) => Effect.exit(service.unshare(info.id)))

          expect(Exit.isFailure(exit)).toBe(true)
          expect((yield* session.get(info.id)).shared).toBe(true)
          expect(yield* persistedShare(info.id)).toMatchObject({ id: "shr_abc", secret: "sec_123" })
        }).pipe(Effect.provide(integrationLayer(client)))
      },
      { config: { enterprise: { url: "https://legacy-share.example.com" } } },
    ),
  )

  it.live("unshare fails closed when public metadata exists without revocation credentials", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const info = yield* session.create({ title: "inconsistent legacy share" })
        yield* markShared(info.id)

        const exit = yield* SessionShare.Service.use((service) => Effect.exit(service.unshare(info.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* session.get(info.id)).shared).toBe(true)
        expect(yield* persistedShare(info.id)).toBeUndefined()
      }).pipe(Effect.provide(integrationLayer(none))),
    ),
  )
})
