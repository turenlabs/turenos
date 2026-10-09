import { connect } from "../src/server"
import { cleanup } from "./support"
export { cleanup }

export function session(id = "ses_test") {
  return {
    id,
    title: "Test session",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    agent: "build",
    location: { directory: "/srv/project" },
    time: { created: 1, updated: 2 },
  }
}

export function fixture(overrides: Record<string, unknown> = {}) {
  const routes = new Map<string, unknown>(
    Object.entries({
      "/api/location": { directory: "/srv/project", project: { id: "project", directory: "/srv/project" } },
      "/api/session": { data: [session()], cursor: {} },
      "/api/session/active": { data: {} },
      "/api/pty": { location: { directory: "/srv/project" }, data: [] },
      "/api/loop": [],
      "/api/agent": {
        location: { directory: "/srv/project" },
        data: [{ id: "build", mode: "primary", hidden: false }],
      },
      "/api/session/ses_test/message": { data: [], cursor: {} },
      "/api/session/ses_test/task": { data: [], active: [], cursor: {} },
      "/api/session/ses_test/permission": { data: [] },
      "/api/session/ses_test/question": { data: [] },
      "/api/session/ses_test/input": { data: [] },
      ...overrides,
    }),
  )
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push(path)
      const value = routes.get(path)
      if (typeof value === "function") return value(request)
      if (value instanceof Response) return value.clone()
      return value === undefined ? new Response(null, { status: 404 }) : Response.json(value)
    },
  })
  const connection = connect({ url: server.url.href })
  cleanup.push(async () => {
    connection.close()
    await server.stop(true)
  })
  return { connection, routes, calls }
}
