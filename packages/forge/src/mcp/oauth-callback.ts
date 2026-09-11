import { createConnection } from "net"
import { createServer } from "http"
import { OauthCallbackPage } from "@turenlabs/core/oauth/page"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH, parseRedirectUri } from "./oauth-provider"

const OAUTH_CALLBACK_HOST = "127.0.0.1"

// Current callback server configuration (may differ from defaults if custom redirectUri is used)
let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let server: ReturnType<typeof createServer> | undefined
const pendingAuths = new Map<string, PendingAuth>()
// Reverse index: mcpName → oauthState, so cancelPending(mcpName) can
// find the right entry in pendingAuths (which is keyed by oauthState).
const mcpNameToState = new Map<string, string>()

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function cleanupStateIndex(oauthState: string) {
  for (const [name, state] of mcpNameToState) {
    if (state === oauthState) {
      mcpNameToState.delete(name)
      break
    }
  }
}

function stopIfIdle() {
  if (pendingAuths.size > 0 || !server) return

  server.close()
  server = undefined
}

function handleRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  // OAuth redirects are GET navigations; anything else is not a provider callback.
  if (req.method !== "GET") {
    res.writeHead(405)
    res.end("Method not allowed")
    return
  }

  const url = new URL(req.url || "/", `http://localhost:${currentPort}`)

  if (url.pathname !== currentPath) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  // Enforce state parameter presence
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  if (error) {
    const errorMsg = errorDescription || error
    if (pendingAuths.has(state)) {
      const pending = pendingAuths.get(state)!
      clearTimeout(pending.timeout)
      pendingAuths.delete(state)
      cleanupStateIndex(state)
      pending.reject(new Error(errorMsg))
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    stopIfIdle()
    return
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error("No authorization code provided", { provider: "MCP" }))
    return
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(OauthCallbackPage.error(errorMsg, { provider: "MCP" }))
    return
  }

  const pending = pendingAuths.get(state)!

  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupStateIndex(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(OauthCallbackPage.success({ provider: "MCP" }))
  stopIfIdle()
}

const PORT_SCAN_COUNT = 10

function listen(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const created = createServer(handleRequest)
    created.once("error", reject)
    created.listen(port, OAUTH_CALLBACK_HOST, () => {
      created.removeListener("error", reject)
      // A bound server can still emit errors; without a listener they throw.
      created.on("error", () => {})
      resolve(created)
    })
  })
}

export async function ensureRunning(redirectUri?: string): Promise<{ port: number; path: string }> {
  const requested = redirectUri ? parseRedirectUri(redirectUri) : undefined

  if (server) {
    // An unconfigured flow reuses whichever port/path is already bound. A flow
    // with an explicit redirectUri on a different address restarts the server.
    if (!requested || (requested.port === currentPort && requested.path === currentPath)) {
      return { port: currentPort, path: currentPath }
    }
    await stop()
  }

  // An explicit redirectUri must bind exactly: the authorization server was told
  // that address. Without one, walk a small range — the default port may already
  // be held by another Forge process (Desktop + CLI) or a foreign app, and a
  // foreign listener can never resolve this process's pending states.
  const candidates = requested
    ? [requested]
    : Array.from({ length: PORT_SCAN_COUNT }, (_, index) => ({
        port: OAUTH_CALLBACK_PORT + index,
        path: OAUTH_CALLBACK_PATH,
      }))

  for (const candidate of candidates) {
    if (await isPortInUse(candidate.port)) {
      if (requested) {
        throw new Error(
          `MCP OAuth callback port ${candidate.port} is already in use by another process. ` +
            "Choose a different callbackPort/redirectUri or free the port.",
        )
      }
      continue
    }
    try {
      server = await listen(candidate.port)
    } catch (error) {
      if (requested) throw error
      continue
    }
    currentPort = candidate.port
    currentPath = candidate.path
    return { port: currentPort, path: currentPath }
  }

  throw new Error(
    `No loopback port available for the MCP OAuth callback (tried ${OAUTH_CALLBACK_PORT}-${OAUTH_CALLBACK_PORT + PORT_SCAN_COUNT - 1})`,
  )
}

export function waitForCallback(oauthState: string, mcpName?: string): Promise<string> {
  if (mcpName) mcpNameToState.set(mcpName, oauthState)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        if (mcpName) mcpNameToState.delete(mcpName)
        reject(new Error("OAuth callback timeout - authorization took too long"))
        stopIfIdle()
      }
    }, CALLBACK_TIMEOUT_MS)

    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
}

export function cancelPending(mcpName: string): void {
  // Look up the oauthState for this mcpName via the reverse index
  const oauthState = mcpNameToState.get(mcpName)
  const key = oauthState ?? mcpName
  const pending = pendingAuths.get(key)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(key)
    mcpNameToState.delete(mcpName)
    pending.reject(new Error("Authorization cancelled"))
    stopIfIdle()
  }
}

export async function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      resolve(false)
    })
  })
}

export async function stop(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }

  for (const [_name, pending] of pendingAuths) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingAuths.clear()
  mcpNameToState.clear()
}

export function isRunning(): boolean {
  return server !== undefined
}

export * as McpOAuthCallback from "./oauth-callback"
