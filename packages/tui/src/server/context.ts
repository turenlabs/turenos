import type { Forge, SessionsListOutput } from "@turenlabs/client"
import type { Api } from "../api"
import type { createWorkingFolders } from "../working-folders"

export type ConnectionOptions = {
  url: string
  directory?: string
  username?: string
  password?: string
}

export type Session = SessionsListOutput["data"][number]

export type Todo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: string }

export type Client = ReturnType<typeof Forge.make>

/** What every connection operation shares: the validated server origin, credentials, and generated client. */
export type Context = {
  url: URL
  headers: Headers
  controller: AbortController
  options: ConnectionOptions
  transport: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  client: Client
  folders: ReturnType<typeof createWorkingFolders>
  api: Api
}
