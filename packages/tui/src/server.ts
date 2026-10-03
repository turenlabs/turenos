import { ClientError, Forge } from "@turenlabs/client"
import type { SessionsCreateOutput, SessionsListOutput } from "@turenlabs/client"
import { createApi, parseJSON } from "./api"
import { display } from "./messages"
import { createProviders } from "./providers"
import { eventStream, liveEvents } from "./live-events"
import { createWorkingFolders } from "./working-folders"
import { promptPayload } from "./prompt-files"
import {
  array,
  checkDirectory,
  choice,
  identifier,
  invalid,
  isRecord,
  modelRef,
  name,
  object,
  parseResponse,
  string,
  validateResponse,
} from "./response-validation"

export { transcript } from "./messages"

export type ConnectionOptions = {
  url: string
  directory?: string
  username?: string
  password?: string
}

export type Session = SessionsListOutput["data"][number]

export function errorText(error: unknown): string {
  if (error instanceof ClientError) {
    if (error.reason === "Transport") return `Connection failed: ${errorText(error.cause)}`
    if (error.reason === "UnexpectedStatus") {
      const status = isRecord(error.cause) ? error.cause.status : undefined
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)
        return "Server returned an unexpected HTTP response. Check the server logs."
      if (status === 401 || status === 403) return "Authentication required. Check the server credentials."
      if (status >= 500) return `Server returned HTTP ${status}. Retry; if it persists, check the server logs.`
      if (status === 404) return "Server returned HTTP 404. Check the server URL, requested item, and API version."
      return `Server returned HTTP ${status}. Check the request and server logs.`
    }
  }
  if (isRecord(error) && error._tag === "UnauthorizedError") {
    if (typeof error.message === "string" && error.message) return display(error.message, 500)
    return "Authentication required. Check the server credentials."
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return display(error.message, 500)
  }
  return "Request failed. Check the server connection."
}

export function connect(options: ConnectionOptions) {
  const url = new URL(options.url)
  if (url.pathname !== "/") throw new Error("Use the server's origin URL without a path prefix.")
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) server URL without credentials, a query, or a fragment.")
  }
  // Match the CLI's credential policy for callers that bypass its early validation.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (options.password && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    // Bun's fetch reads NO_PROXY at request time; an empty proxy option still
    // uses shell proxies. Keep local credentials direct and retain other rules.
    const bypass = [process.env.NO_PROXY ?? "", process.env.no_proxy ?? "", "127.0.0.1,localhost,::1"]
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
    process.env.NO_PROXY = [...new Set(bypass)].join(",")
    process.env.no_proxy = process.env.NO_PROXY
  }
  const controller = new AbortController()
  if (options.directory !== undefined) inputDirectory(options.directory)
  const username = options.username ?? "forge"
  if (
    !username ||
    username.length > 512 ||
    username.includes(":") ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(username)
  )
    throw new Error("Use a valid username without ':' or control characters.")
  const headers = new Headers()
  if (options.password) {
    headers.set("Authorization", `Basic ${Buffer.from(`${username}:${options.password}`).toString("base64")}`)
  }
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(10000),
        ...(init?.signal ? [init.signal] : []),
      ])
      // Never forward server credentials to a redirect target. Limit decoded
      // response bytes before the generated client's JSON parser sees them.
      const response = await fetch(input, { ...init, signal, redirect: "error" })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {})
        return Response.json(
          { _tag: "UnauthorizedError", message: "Authentication required. Check the server credentials." },
          { status: response.status },
        )
      }
      if (response.status === 204 || response.status === 205 || !response.body) return response
      const reader = response.body.getReader()
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 8 * 1024 * 1024) throw new Error("Server response exceeds the 8 MiB TUI limit.")
          if (chunks.length >= 8192) throw new Error("Server response exceeds the 8,192 chunk TUI limit.")
          chunks.push(new Uint8Array(chunk.value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const body = new Blob(chunks)
      if (response.ok) {
        const address = new URL(input instanceof Request ? input.url : input.toString())
        // This root API has its own strict State/value parser in working-folders.
        if (address.pathname === "/global/storage")
          return new Response(body, { status: response.status, headers: response.headers })
        const sanitized = validateResponse(address, init, parseResponse(await body.text()))
        if (sanitized !== undefined) return Response.json(sanitized, { status: response.status })
      }
      return new Response(body, { status: response.status, headers: response.headers })
    },
    { preconnect: fetch.preconnect },
  )
  const client = Forge.make({ baseUrl: url.href, headers, fetch: transport })
  const folders = createWorkingFolders({ url, headers, transport })
  const api = createApi({ url, headers, signal: controller.signal })

  async function snapshot() {
    const request = { signal: AbortSignal.timeout(10000) }
    const inventoryErrors = { terminals: "", automations: "" }
    let folderError: string | undefined
    const [location, recent, active, loops] = await Promise.all([
      client.location.get({ location: options.directory ? { directory: options.directory } : undefined }, request),
      client.sessions.list({ limit: 100, order: "desc", archived: false }, request),
      client.sessions.active(request),
      client.loops.list(request).catch((error: unknown) => inventoryError("automations", error)),
      folders.read().catch((error: unknown) => {
        folderError = errorText(error)
      }),
    ])
    const sessions = new Map(recent.data.map((session) => [session.id, session]))
    const missing = Object.keys(active).filter((id) => {
      if (sessions.has(id)) return false
      identifier(id, "ses_")
      return true
    })
    // Limit concurrent HTTP requests while retaining every active session,
    // including older sessions absent from the recent-history page.
    for (let offset = 0; offset < missing.length; offset += 8) {
      const found = await Promise.all(
        missing.slice(offset, offset + 8).map((sessionID) => client.sessions.get({ sessionID }, request)),
      )
      found.forEach((session) => sessions.set(session.id, session))
    }
    if (sessions.size && ![...sessions.values()].some((session) => !session.parentID)) {
      const roots = await client.sessions.list({ roots: true, archived: false, order: "desc", limit: 100 }, request)
      roots.data.filter((session) => !session.parentID).forEach((session) => sessions.set(session.id, session))
    }
    // Terminals are location-scoped on the server; read the server location and open folders.
    const directories = [...new Set([location.directory, ...(folders.current() ?? [])])].slice(0, 8)
    const terminals = await Promise.all(
      directories.map((directory) => client.ptys.list({ location: { directory } }, request)),
    ).catch((error: unknown) => inventoryError("terminals", error))
    const folderStatus: { workingFolders?: string[]; folderError?: string } = {
      workingFolders: folders.current(),
      folderError,
    }
    return {
      ...folderStatus,
      location,
      sessions: [...sessions.values()].sort(
        (a, b) =>
          Number(Object.hasOwn(active, b.id)) - Number(Object.hasOwn(active, a.id)) || b.time.updated - a.time.updated,
      ),
      active,
      terminals: [
        ...new Map(
          (terminals ?? []).flatMap((page) => page.data.map((pty) => [pty.id, { ...pty, location: page.location }])),
        ).values(),
      ],
      terminalsAvailable: terminals !== undefined,
      loops: loops ?? [],
      inventoryErrors,
      updated: Date.now(),
      more: !!recent.cursor.next,
    }

    function inventoryError(kind: keyof typeof inventoryErrors, error: unknown) {
      const status =
        error instanceof ClientError && error.reason === "UnexpectedStatus" && isRecord(error.cause)
          ? error.cause.status
          : undefined
      if (status === 401 || status === 403 || (isRecord(error) && error._tag === "UnauthorizedError")) throw error
      if (kind !== "terminals" || status !== 404) inventoryErrors[kind] = errorText(error)
      return undefined
    }
  }

  async function searchSessions(
    input: { search?: string; archived?: boolean; directory?: string; cursor?: string },
    signal?: AbortSignal,
  ) {
    if (input.search !== undefined && (typeof input.search !== "string" || input.search.length > 256))
      throw new Error("Use a title search of at most 256 characters.")
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096))
      throw new Error("Use a session cursor of at most 4,096 characters.")
    if (input.archived !== undefined && typeof input.archived !== "boolean")
      throw new Error("Choose an archived or unarchived session filter.")
    if (input.directory !== undefined) inputDirectory(input.directory)
    // Cursors already encode the original filters and traversal order.
    return client.sessions.list(
      input.cursor
        ? { cursor: input.cursor, limit: 100 }
        : { search: input.search, archived: input.archived, directory: input.directory, order: "desc", limit: 100 },
      { signal },
    )
  }

  async function updateSession(session: Session, change: { title: string } | { archived: number | null }) {
    identifier(session.id, "ses_")
    inputDirectory(session.location.directory)
    if (!isRecord(change) || Object.keys(change).length !== 1) throw new Error("Choose one session change.")
    if ("title" in change) {
      if (typeof change.title !== "string" || !change.title.trim() || change.title.length > 200)
        throw new Error("Enter a title between 1 and 200 characters, without control characters.")
      try {
        name(change.title)
      } catch {
        throw new Error("Enter a title between 1 and 200 characters, without control characters.")
      }
    } else if (!("archived" in change) || (change.archived !== null && !Number.isFinite(change.archived))) {
      throw new Error("Use a finite archive timestamp, or null to restore the session.")
    }
    const address = new URL(`/session/${encodeURIComponent(session.id)}`, url)
    address.searchParams.set("directory", session.location.directory)
    const requestHeaders = new Headers(headers)
    requestHeaders.set("Content-Type", "application/json")
    const response = await transport(address, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify("title" in change ? { title: change.title } : { time: { archived: change.archived } }),
    }).catch((cause: unknown) => {
      throw new ClientError("Transport", { cause })
    })
    if (response.status === 200 && !response.body) invalid("session acknowledgement")
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403)
      throw new Error("Authentication required. Check the server credentials.")
    if (response.status !== 200) throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
    // The validated bare legacy acknowledgement is not a current Session.
    const updated = await client.sessions.get({ sessionID: session.id })
    if (updated.location.directory !== session.location.directory) invalid("session directory identity")
    return updated
  }

  async function detail(sessionID: string, cursor?: string) {
    identifier(sessionID, "ses_")
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 4096))
      throw new Error("Use a message cursor of at most 4,096 characters.")
    const [messages, tasks, permissions, questions, pending, todos] = await Promise.all([
      client.messages.list({ sessionID, limit: 30, order: cursor ? undefined : "desc", cursor: cursor || undefined }),
      client.sessions.taskList({ sessionID, limit: 50 }),
      client.permissions.list({ sessionID }),
      client.questions.list({ sessionID }),
      client.sessions.pendingInputs({ sessionID }),
      // The agent's to-do list is optional: an older server or a malformed list shows none.
      api(`/session/${encodeURIComponent(sessionID)}/todo`)
        .then(todoList)
        .catch(() => [] as Todo[]),
    ])
    return {
      sessionID,
      messages: messages.data.toReversed(),
      cursor: messages.cursor,
      tasks,
      permissions,
      questions,
      pending,
      todos,
    }
  }

  /** Deletes a session and its subagent sessions; the server interrupts their work first. */
  async function deleteSession(session: Session) {
    identifier(session.id, "ses_")
    const result = await api(`/session/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
      directory: session.location.directory,
      timeout: 30000,
    })
    if (result !== true) invalid("session deletion acknowledgement")
  }

  /**
   * A new git worktree of `directory`, checked out and ready for a session. The server creates it,
   * checks it out in the background, then announces worktree.ready or worktree.failed on
   * /global/event, so that stream is open before the request that starts the checkout. `name` stays
   * the same across retries: after an uncertain attempt, the worktree it made is found and reused.
   */
  async function worktree(directory: string, name: string, retry: boolean) {
    inputDirectory(directory)
    const stop = new AbortController()
    const expired = AbortSignal.timeout(5 * 60 * 1000)
    const events = eventStream(
      url,
      "/global/event",
      headers,
      AbortSignal.any([controller.signal, stop.signal, expired]),
    )[Symbol.asyncIterator]()
    try {
      // The first event, server.connected, means the server already forwards this worktree's events.
      await events.next()
      const found = retry
        ? array(await api("/experimental/worktree", { directory }), 10000).find(
            (item): item is string =>
              typeof item === "string" &&
              item
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/)
                .at(-1) === name,
          )
        : undefined
      // A worktree is checked out once it holds more than its `.git` link file.
      if (
        found &&
        array(await api("/file", { directory: found, query: { path: "" } }), 20000).some(
          (item) => isRecord(item) && item.name !== ".git",
        )
      )
        return { status: "ready" as const, directory: found }
      const target =
        found ??
        string(
          object(await api("/experimental/worktree", { method: "POST", directory, body: { name }, timeout: 60000 }))
            .directory,
          4096,
        )
      checkDirectory(target)
      for (let next = await events.next(); !next.done; next = await events.next()) {
        const outcome = worktreeOutcome(next.value, target)
        if (outcome) return outcome
      }
      throw new Error("The server stopped reporting before the worktree was ready.")
    } catch (error) {
      if (expired.aborted) throw new Error("The server is still preparing the worktree. Ctrl+S keeps waiting.")
      throw error
    } finally {
      stop.abort()
      void events.return?.()
    }
  }

  async function agents(directory: string) {
    inputDirectory(directory)
    const result = await client.agents.list({ location: { directory } })
    return result.data.filter((agent) => !agent.hidden && agent.mode !== "subagent")
  }

  /** Server commands plus the skills of enabled extensions, which run as commands too (as in the desktop). */
  async function commands(directory: string, workspaceID?: string): Promise<{ name: string; description?: string }[]> {
    inputDirectory(directory)
    if (workspaceID !== undefined) identifier(workspaceID)
    const [listed, skills] = await Promise.all([
      client.commands.list({ location: { directory, workspace: workspaceID } }),
      api("/extension", { directory })
        .then(skillList)
        .catch(() => []),
    ])
    const names = new Set(listed.data.map((item) => item.name))
    return [...listed.data, ...skills.filter((skill) => !names.has(skill.name))]
  }

  async function findFiles(directory: string, query: string, workspaceID?: string, signal?: AbortSignal) {
    inputDirectory(directory)
    if (workspaceID !== undefined) identifier(workspaceID)
    if (query.length > 512) throw new Error("Keep the file search below 512 characters.")
    return (await client.files.find({ location: { directory, workspace: workspaceID }, query, limit: 50 }, { signal }))
      .data
  }

  // The server owns execution: this admits one command and returns the shell
  // message the transcript already renders. Retries reuse the caller's ID.
  async function shell(sessionID: string, id: string, command: string) {
    identifier(sessionID, "ses_")
    identifier(id, "msg_")
    if (!command.trim()) throw new Error("Enter a command to run on the server.")
    if (command.length > 8192) throw new Error("Keep the command below 8,192 characters.")
    return client.sessions.shell({ sessionID, id, command })
  }

  async function resolveCommand(text: string, directory: string, workspaceID?: string) {
    const prefix = /^\/([^\s/\\]{1,512})(?:\s|$)/.exec(text)
    if (!prefix) return undefined
    const inventory = await commands(directory, workspaceID)
    if (!inventory.some((item) => item.name === prefix[1])) return undefined
    return { command: prefix[1]!, arguments: text.slice(prefix[0].length) }
  }

  async function runs(loopID: string) {
    identifier(loopID)
    return (await client.loops.runList({ loopID })).slice(0, 10)
  }

  // Retain the same identifiers across ambiguous network failures so retrying
  // admission cannot create another agent or deliver its initial prompt twice.
  function launch() {
    const sessionID = `ses_${crypto.randomUUID().replaceAll("-", "")}`
    const messageID = `msg_${crypto.randomUUID().replaceAll("-", "")}`
    let admitted: SessionsCreateOutput | undefined
    let draft: { directory: string; agent?: string; model?: string; variant?: string; prompt: string } | undefined
    let routing: Promise<{ command: string; arguments: string } | undefined> | undefined
    const send = async (input: {
      directory: string
      agent?: string
      model?: string
      variant?: string
      prompt: string
    }) => {
      input = { ...input }
      inputDirectory(input.directory)
      if (input.agent !== undefined) {
        try {
          name(input.agent)
        } catch {
          throw new Error("Choose a valid agent from this directory's list, or use Server default.")
        }
      }
      if (!input.prompt.trim()) throw new Error("Enter a task for the agent.")
      if (input.prompt.length > 32000) throw new Error("Keep the prompt below 32,000 characters.")
      if (draft && JSON.stringify(draft) !== JSON.stringify(input)) {
        throw new Error(`Retry with the original fields. Inspect session ${sessionID} before starting another launch.`)
      }
      const slash = input.model?.indexOf("/") ?? -1
      if (input.variant !== undefined && !input.model)
        throw new Error("Choose an explicit model before selecting its variant.")
      if (input.model && (slash < 1 || slash === input.model.length - 1))
        throw new Error("Use provider/model for the model, or leave it empty.")
      const model = input.model
        ? {
            providerID: input.model.slice(0, slash),
            id: input.model.slice(slash + 1),
            ...(input.variant !== undefined ? { variant: input.variant } : {}),
          }
        : undefined
      if (model) {
        try {
          modelRef(model)
        } catch {
          throw new Error(
            "Use provider/model with names of 1–512 characters and no control characters, or leave it empty.",
          )
        }
      }
      draft = { ...input }
      // Freeze even an unknown command's prompt route before the first POST.
      // Inventory failures are safe to retry because no admission has occurred.
      const command = await (routing ??= resolveCommand(input.prompt, input.directory).catch((error: unknown) => {
        routing = undefined
        throw error
      }))
      admitted ??= await client.sessions.create({
        id: sessionID,
        location: { directory: input.directory },
        agent: input.agent,
        model,
      })
      if (admitted.id !== sessionID) invalid("launch session identity")
      if (command) {
        await client.sessions.command({
          sessionID: admitted.id,
          id: messageID,
          ...command,
          agent: input.agent,
          model,
          resume: true,
        })
      } else {
        await client.sessions.prompt({
          sessionID: admitted.id,
          id: messageID,
          prompt: promptPayload(input.prompt, input.directory),
        })
      }
      return admitted
    }
    return Object.assign(send, { sessionID, input: () => (draft ? { ...draft } : undefined) })
  }

  const providers = createProviders({ url, headers, signal: controller.signal })
  return {
    address: url.origin,
    providers,
    folders,
    client,
    api,
    events: (signal: AbortSignal) => liveEvents(url, headers, AbortSignal.any([controller.signal, signal])),
    snapshot,
    searchSessions,
    updateSession,
    deleteSession,
    worktree,
    detail,
    agents,
    commands,
    findFiles,
    shell,
    resolveCommand,
    runs,
    launch,
    close: () => controller.abort(),
  }
}

export type Connection = ReturnType<typeof connect>
export type Snapshot = Awaited<ReturnType<Connection["snapshot"]>>
export type Detail = Awaited<ReturnType<Connection["detail"]>>
export type Todo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: string }

/** What one /global/event frame says about the worktree at `directory`, if anything. */
function worktreeOutcome(data: string, directory: string) {
  const event = parseJSON(data)
  if (!isRecord(event) || event.directory !== directory || !isRecord(event.payload)) return undefined
  if (event.payload.type === "worktree.ready") return { status: "ready" as const, directory }
  if (event.payload.type !== "worktree.failed") return undefined
  const message = isRecord(event.payload.properties) ? event.payload.properties.message : undefined
  return { status: "failed" as const, message: typeof message === "string" ? display(message, 500) : "" }
}

function todoList(value: unknown): Todo[] {
  return array(value, 500).map((item) => {
    const todo = object(item)
    choice(todo.status, ["pending", "in_progress", "completed", "cancelled"])
    return {
      content: string(todo.content, 4000),
      status: todo.status as Todo["status"],
      priority: string(todo.priority, 32),
    }
  })
}

function skillList(value: unknown) {
  return array(value, 2048).flatMap((item) => {
    const extension = object(item)
    if (extension.enabled !== true) return []
    return array(object(extension.manifest).contributions, 256).flatMap((value) => {
      const contribution = object(value)
      if (contribution.type !== "skill") return []
      const description = typeof contribution.description === "string" ? contribution.description : ""
      return [{ name: string(contribution.id, 120), description: `Skill · ${description}` }]
    })
  })
}

function inputDirectory(value: unknown) {
  try {
    checkDirectory(value)
  } catch {
    throw new Error("Enter an absolute directory on the server, such as /srv/project.")
  }
}
