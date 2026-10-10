import { Forge } from "@turenlabs/client"
import { createApi } from "../api"
import { liveEvents } from "../live-events"
import { createProviders } from "../providers"
import { createWorkingFolders } from "@turenlabs/client/working-folders"
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
import type { Folder } from "../working-folders/folder"

export function connect(options: ConnectionOptions) {
  const { url, username, socketPath } = validateConnection(options)
  const controller = new AbortController()
  const headers = basicAuthHeaders(username, options.password)
  const transport = createTransport(controller, socketPath)
  const client = Forge.make({ baseUrl: url.href, headers, fetch: transport })
  const folders = createWorkingFolders({ url, headers, transport })
  const api = createApi({ url, headers, signal: controller.signal, socketPath })
  const missingFiles = new Set<string>()
  const ctx: Context = { url, headers, controller, options, transport, client, folders, api, missingFiles }
  const providers = createProviders({ url, headers, signal: controller.signal, socketPath })
  return {
    address: socketPath ? `unix:${socketPath}` : url.origin,
    /** The origin requests are addressed to; with `socketPath` it is only `http://localhost`. */
    url,
    socketPath,
    providers,
    folders,
    client,
    api,
    missingFiles,
    events: (signal: AbortSignal) =>
      liveEvents(url, headers, AbortSignal.any([controller.signal, signal]), socketPath),
    snapshot: (folder?: Folder) => snapshot(ctx, folder),
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
