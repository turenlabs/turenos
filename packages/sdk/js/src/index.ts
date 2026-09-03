export * from "./client.js"
export * from "./server.js"

import { createForgeClient } from "./client.js"
import { createForgeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createForge(options?: ServerOptions) {
  const server = await createForgeServer({
    ...options,
  })

  const client = createForgeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
