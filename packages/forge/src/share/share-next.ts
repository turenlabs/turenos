import { Database } from "@turenlabs/core/database/database"
import { httpClient } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { serviceUse } from "@turenlabs/core/effect/service-use"
import { SessionShareTable } from "@turenlabs/core/share/sql"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Account } from "@/account/account"
import { Env } from "@/env"
import type { SessionID } from "@/session/schema"

export type Api = {
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

export interface Interface {
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly remove: (sessionID: SessionID) => Effect.Effect<boolean, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@forge/ShareNext") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")
const legacyEndpointVariable = "FORGE_LEGACY_SHARE_ENDPOINT"

function requireLegacyEndpoint(value: string | undefined) {
  if (!value) {
    throw new Error(`Legacy share network access is disabled; set ${legacyEndpointVariable} to an audited endpoint`)
  }
  if (!URL.canParse(value)) throw new Error(`${legacyEndpointVariable} must be a valid URL`)
  const url = new URL(value)
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`${legacyEndpointVariable} must use HTTPS unless it targets localhost`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${legacyEndpointVariable} cannot include credentials, query parameters, or a fragment`)
  }
  return url.toString().replace(/\/$/, "")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const env = yield* Env.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const vault = yield* SecretVault.Service

    yield* db
      .select()
      .from(SessionShareTable)
      .all()
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows.filter((row) => !vault.isSealed(row.secret)),
            (row) =>
              vault
                .seal("session-share", row.id, row.secret)
                .pipe(
                  Effect.flatMap((secret) =>
                    db.update(SessionShareTable).set({ secret }).where(eq(SessionShareTable.id, row.id)).run(),
                  ),
                ),
            { concurrency: 1, discard: true },
          ),
        ),
        Effect.orDie,
      )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const baseUrl = requireLegacyEndpoint(yield* env.get(legacyEndpointVariable))
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      if (new URL(baseUrl).origin !== new URL(active.value.url).origin) {
        throw new Error(
          `${legacyEndpointVariable} must match the active account origin before credentials are attached`,
        )
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for revoking a legacy share")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl } satisfies Req
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      const share = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!share) return false
      const secret = vault.isSealed(share.secret)
        ? yield* vault.open("session-share", share.id, share.secret)
        : share.secret

      yield* Effect.logInfo("removing legacy share", { sessionID })
      const req = yield* request()
      const response = yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(share.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret }),
        Effect.flatMap((request) => http.execute(request)),
      )
      // The persisted legacy row does not record which backend/API flavor created
      // it. A 404 from today's configured endpoint may therefore be the wrong
      // backend, not proof that the original public link is gone. Fail closed and
      // retain the credentials unless revocation is positively acknowledged.
      yield* HttpClientResponse.filterStatusOk(response)

      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      return true
    })

    return Service.of({ url, request, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Account.node, Env.node, Database.node, SecretVault.node, httpClient],
})

export * as ShareNext from "./share-next"
