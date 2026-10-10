import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServers, type Endpoint, type Target } from "../src/servers"
import { cleanup } from "./support"
export { cleanup }

export async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "turen-tui-servers-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** A TurenOS-shaped server that accepts one Basic credential. */
export function server(password = "secret", routes: Record<string, unknown> = {}) {
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Basic ${btoa(`forge:${password}`)}`)
        return new Response(null, { status: 401 })
      const path = new URL(request.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.0.32" })
      return path in routes ? Response.json(routes[path]) : new Response(null, { status: 404 })
    },
  })
  cleanup.push(() => listener.stop(true))
  return listener
}

export async function desktop(home: string, url: string, overrides: Record<string, unknown> = {}, mode = 0o600) {
  const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
  await mkdir(directory, { recursive: true })
  const file = join(directory, "attach.json")
  await writeFile(
    file,
    JSON.stringify({ version: 1, url, username: "forge", password: "secret", pid: process.pid, ...overrides }),
    { mode },
  )
  await chmod(file, mode)
  return file
}

export function local(home: string, extra: Parameters<typeof createServers>[0] = {}) {
  return createServers({ home, platform: "darwin", env: {}, forge: null, config: join(home, "servers.json"), ...extra })
}

export async function open(servers: ReturnType<typeof createServers>, target: Target) {
  const endpoint = await servers.resolve(target)
  cleanup.push(() => endpoint.close?.())
  return endpoint
}

export async function healthy(endpoint: Endpoint) {
  const response = await fetch(new URL("/global/health", endpoint.url), {
    headers: { authorization: `Basic ${btoa(`${endpoint.username}:${endpoint.password}`)}` },
  })
  return response.status
}
