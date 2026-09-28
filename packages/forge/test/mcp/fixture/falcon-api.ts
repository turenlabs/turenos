import { Effect } from "effect"

interface FalconApiOptions {
  /** Status returned by POST /oauth2/token. Anything but 2xx makes the pinned falcon-mcp exit before the handshake. */
  authStatus?: number
  /** Status returned by every Falcon API endpoint (post-auth). Exercises tool-call failure paths. */
  apiStatus?: number
}

const meta = { query_time: 0.001, powered_by: "falcon-api-mock", trace_id: "mock-trace-id" }

/**
 * Minimal stand-in for the CrowdStrike Falcon cloud API. Real `falcon-mcp`
 * authenticates at startup against `/oauth2/token` and then issues ordinary
 * Falcon REST calls, so this fixture answers both with the standard
 * `{meta, resources, errors}` envelope.
 */
export function serveFalconApi(options: FalconApiOptions = {}) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const requests: string[] = []
      const record = {
        id: "mock-id-001",
        device_id: "aid-mock-001",
        cid: "cid-mock",
        hostname: "mock-workstation-01",
        composite_id: "ldt-mock-001",
        severity: 50,
        status: "new",
        tactic: "Credential Access",
        technique: "OS Credential Dumping",
        name: "MockActor",
        created_date: "2026-01-01T00:00:00Z",
        description: "falcon-api-mock canned record",
      }
      const envelope = (resources: unknown[]) => ({ meta, resources, errors: [] })

      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          requests.push(`${request.method} ${url.pathname}`)

          if (url.pathname === "/oauth2/token" || url.pathname === "/oauth2/revoke") {
            const status = options.authStatus ?? 201
            if (status < 200 || status >= 300) {
              return Response.json({ errors: [{ code: status, message: "access denied, invalid bearer token" }] }, { status })
            }
            if (url.pathname === "/oauth2/revoke") return Response.json({}, { status })
            return Response.json({ access_token: "mock-falcon-token", token_type: "bearer", expires_in: 1799 }, { status })
          }

          if (options.apiStatus) {
            const status = options.apiStatus
            return Response.json(
              { meta: { ...meta, http_status: status }, resources: [], errors: [{ code: status, message: `mock API failure ${status}` }] },
              { status },
            )
          }

          // NGSIEM (humio) query-job lifecycle: submit, poll, delete.
          if (url.pathname.startsWith("/humio/")) {
            if (request.method === "DELETE") return Response.json({})
            if (request.method === "POST") return Response.json({ id: "mock-ngsiem-job" })
            return Response.json({ cancelled: false, done: true, events: [], metadata: {} })
          }

          if (url.pathname.includes("/queries/")) return Response.json(envelope(["aid-mock-001", "ldt-mock-001"]))
          if (url.pathname.includes("/aggregates/")) {
            return Response.json(envelope([{ name: "mock-aggregate", buckets: [{ label: "mock", count: 1 }] }]))
          }
          return Response.json(envelope([record]))
        },
      })

      return {
        requests,
        url: `http://127.0.0.1:${http.port}`,
        stop: () => http.stop(true),
      }
    }),
    (server) => Effect.promise(server.stop),
  )
}
