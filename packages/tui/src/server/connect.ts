import { Forge } from "@turenlabs/client"
import { createApi } from "../api"
import { liveEvents } from "../live-events"
import { createProviders } from "../providers"
import { createWorkingFolders } from "../working-folders"
import type { ConnectionOptions, Context, Session } from "./context"
import { launch } from "./launch"
import { agents, checkShell, commands, findFiles, resolveCommand, runs, shell } from "./queries"
import {
  deleteSession,
  detail,
  searchSessions,
  updateSession,
  type SessionChange,
  type SessionSearch,
} from "./sessions"
import { snapshot } from "./snapshot"
import { basicAuthHeaders, createTransport, validateConnection } from "./transport"
import { worktree } from "./worktree"

export function connect(options: ConnectionOptions) {
  const { url, username } = validateConnection(options)
  const controller = new AbortController()
  const headers = basicAuthHeaders(username, options.password)
  const transport = createTransport(controller)
  const client = Forge.make({ baseUrl: url.href, headers, fetch: transport })
  const folders = createWorkingFolders({ url, headers, transport })
  const api = createApi({ url, headers, signal: controller.signal })
  const ctx: Context = { url, headers, controller, options, transport, client, folders, api }
  const providers = createProviders({ url, headers, signal: controller.signal })
  return {
    address: url.origin,
    providers,
    folders,
    client,
    api,
    events: (signal: AbortSignal) => liveEvents(url, headers, AbortSignal.any([controller.signal, signal])),
    snapshot: () => snapshot(ctx),
    searchSessions: (input: SessionSearch, signal?: AbortSignal) => searchSessions(ctx, input, signal),
    updateSession: (session: Session, change: SessionChange) => updateSession(ctx, session, change),
    deleteSession: (session: Session) => deleteSession(ctx, session),
    worktree: (directory: string, name: string, retry: boolean, signal?: AbortSignal) =>
      worktree(ctx, directory, name, retry, signal),
    detail: (sessionID: string, cursor?: string) => detail(ctx, sessionID, cursor),
    agents: (directory: string) => agents(ctx, directory),
    commands: (directory: string, workspaceID?: string) => commands(ctx, directory, workspaceID),
    findFiles: (directory: string, query: string, workspaceID?: string, signal?: AbortSignal) =>
      findFiles(ctx, directory, query, workspaceID, signal),
    shell: (sessionID: string, id: string, command: string) => shell(ctx, sessionID, id, command),
    checkShell,
    resolveCommand: (text: string, directory: string, workspaceID?: string) =>
      resolveCommand(ctx, text, directory, workspaceID),
    runs: (loopID: string) => runs(ctx, loopID),
    launch: (ids?: Parameters<typeof launch>[1]) => launch(ctx, ids),
    close: () => controller.abort(),
  }
}
