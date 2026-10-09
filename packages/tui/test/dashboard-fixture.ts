import { expect } from "bun:test"
import type { Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { connect, type Session, type Snapshot } from "../src/server"
import type {
  CommandsListOutput,
  PermissionsListOutput,
  QuestionsListOutput,
  SessionsTaskListOutput,
  SessionsGoalGetOutput,
} from "@turenlabs/client"
import { cleanup } from "./support"
export { cleanup }

export async function waitForFrame(
  view: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await view.renderOnce()
    const frame = view.captureCharFrame()
    if (predicate(frame)) return frame
    // Renderer-idle can occur while HTTP is in flight; wait for those responses.
    await Bun.sleep(10)
  }
  throw new Error(`Expected screen did not appear:\n${view.captureCharFrame()}`)
}

/** Esc leaves an open reply editor for the dashboard shortcuts, keeping its draft. */
export async function leaveComposer(view: Awaited<ReturnType<typeof createTestRenderer>>) {
  await waitForFrame(view, (frame) => frame.includes("Typing"))
  view.mockInput.pressEscape()
  await waitForFrame(view, (frame) => !frame.includes("Typing"))
}

export async function clickText(view: Awaited<ReturnType<typeof createTestRenderer>>, text: string) {
  await view.renderOnce()
  const lines = view.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  await view.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
}

export function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}

export function fixture(
  options: {
    ptyStatus?: number
    loopStatus?: number
    runStatus?: number
    pages?: boolean
    providerStatus?: number
    providerDelay?: number
    noModels?: boolean
    agentStatus?: number
    agentDelay?: number
    agents?: Record<string, string[]>
    messageStatus?: number
    more?: boolean
    messageDelay?: number
    postDelay?: number
    authenticated?: boolean
    failPromptOnce?: boolean
    active?: boolean
    history?: boolean
    text?: string
    toolText?: string
    tasks?: SessionsTaskListOutput
    ownedError?: boolean
    commands?: CommandsListOutput["data"]
    failCommandOnce?: boolean
    variants?: Record<string, unknown>
    goal?: SessionsGoalGetOutput
    directory?: string
    schedule?: Snapshot["loops"][number]["schedule"]
    workingFolders?: string[]
    folderRevision?: number
  } = {},
) {
  const sessions: Session[] = [
    {
      id: "ses_running",
      projectID: "project",
      title: "Review the server",
      agent: "build",
      location: { directory: "/srv/project" },
      time: { created: 1, updated: 2 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]
  const reads: string[] = []
  const messageCursors: (string | null)[] = []
  const historical = new Map<string, Session>()
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const pending: { permissions: PermissionsListOutput; questions: QuestionsListOutput } = {
    permissions: [],
    questions: [],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (options.authenticated === false) return new Response(null, { status: 401 })
      if (url.pathname === "/api/fs/list")
        return Response.json({ location: { directory: url.searchParams.get("location[directory]") }, data: [] })
      if (url.pathname === "/global/storage" && options.workingFolders !== undefined) {
        if (request.method === "PUT") {
          const body = await request.json()
          if (body.expectedRevision !== (options.folderRevision ?? 1)) return new Response(null, { status: 409 })
          options.workingFolders = JSON.parse(body.value).directories
          options.folderRevision = (options.folderRevision ?? 1) + 1
        }
        const state = {
          scope: "desktop/store/working-folders",
          key: "open",
          value: JSON.stringify({ version: 1, directories: options.workingFolders }),
          revision: options.folderRevision ?? 1,
          timeCreated: 1,
          timeUpdated: 1,
        }
        return Response.json(request.method === "PUT" ? state : { state })
      }
      if (request.method === "POST") {
        const body: Record<string, unknown> =
          url.pathname.endsWith("/interrupt") ||
          url.pathname.endsWith("/reject") ||
          url.pathname.endsWith("/revert/clear")
            ? {}
            : await request.json()
        posts.push({ path: url.pathname, body })
        if (options.postDelay) await Bun.sleep(options.postDelay)
        if (url.pathname.endsWith("/revert/stage") || url.pathname.endsWith("/revert/clear")) {
          const index = sessions.findIndex((session) => session.id === url.pathname.split("/")[3])
          if (index < 0) return new Response(null, { status: 404 })
          const revert = url.pathname.endsWith("/stage") ? { messageID: String(body.messageID), files: [] } : undefined
          sessions[index] = { ...sessions[index]!, revert }
          return revert ? Response.json({ data: revert }) : new Response(null, { status: 204 })
        }
        if (options.failCommandOnce && url.pathname.endsWith("/command")) {
          options.failCommandOnce = false
          return new Response("Command acknowledgement lost", { status: 502 })
        }
        if (options.ownedError && url.pathname === "/api/session/ses_running/prompt")
          return Response.json(
            {
              _tag: "InvalidRequestError",
              kind: "session_task_owned",
              message: "Task-owned child Sessions reject direct mutation",
            },
            { status: 400 },
          )
        if (url.pathname.endsWith("/shell")) {
          return Response.json({
            data: { id: body.id, type: "shell", command: body.command, output: "", status: "running" },
          })
        }
        if (url.pathname.endsWith("/model")) {
          const index = sessions.findIndex((session) => session.id === url.pathname.split("/")[3])
          if (index >= 0) sessions[index] = { ...sessions[index]!, model: body.model as Session["model"] }
          return new Response(null, { status: 204 })
        }
        if (options.failPromptOnce && url.pathname.endsWith("/prompt")) {
          options.failPromptOnce = false
          return new Response("Admission response lost", { status: 502 })
        }
        if (url.pathname === "/api/session") {
          const session = {
            ...sessions[0]!,
            id: typeof body.id === "string" ? body.id : "",
            title: "New agent",
            agent: typeof body.agent === "string" ? body.agent : "build",
            model: body.model as Session["model"],
            location: body.location as Session["location"],
          }
          if (!sessions.some((item) => item.id === session.id)) sessions.unshift(session)
          return Response.json({ data: session })
        }
        if (
          url.pathname.includes("/permission/") ||
          url.pathname.includes("/question/") ||
          url.pathname.endsWith("/interrupt")
        )
          return new Response(null, { status: 204 })
        return Response.json({ data: { id: body.id, sessionID: url.pathname.split("/")[3] } })
      }
      reads.push(url.pathname)
      if (url.pathname.endsWith("/goal")) return Response.json({ data: options.goal ?? null })
      if (url.pathname === "/api/command") {
        const directory = url.searchParams.get("location[directory]") ?? "/srv/project"
        return Response.json({
          location: { directory, project: { id: "project", directory } },
          data: options.commands ?? [],
        })
      }
      if (url.pathname === "/provider") {
        if (options.providerDelay) await Bun.sleep(options.providerDelay)
        if (options.providerStatus) return new Response(null, { status: options.providerStatus })
        return Response.json({
          all: [
            {
              id: "test",
              name: "Test Provider",
              models: options.noModels
                ? {}
                : {
                    "org/model": {
                      id: "org/model",
                      providerID: "test",
                      name: "Catalog Model",
                      ...(options.variants ? { variants: options.variants } : {}),
                    },
                  },
            },
          ],
          connected: options.noModels ? [] : ["test"],
          default: {},
        })
      }
      if (url.pathname === "/provider/auth") return Response.json({})
      if (url.pathname === "/api/pty" && options.ptyStatus) return new Response(null, { status: options.ptyStatus })
      if (url.pathname === "/api/loop" && options.loopStatus) return new Response(null, { status: options.loopStatus })
      if (url.pathname.endsWith("/run") && options.runStatus) return new Response(null, { status: options.runStatus })
      if (url.pathname === "/api/agent" && options.agentStatus)
        return new Response(null, { status: options.agentStatus })
      if (url.pathname.endsWith("/message") && options.messageStatus)
        return new Response("Temporary message failure", { status: options.messageStatus })
      if (url.pathname.endsWith("/message") && options.messageDelay) await Bun.sleep(options.messageDelay)
      if (url.pathname === "/api/location")
        return Response.json({
          directory: options.directory ?? "/srv/project",
          project: { id: "project", directory: "/srv/project" },
        })
      if (url.pathname === "/api/session")
        return Response.json({
          data:
            url.searchParams.get("roots") === "true"
              ? [...sessions, ...historical.values()].filter((session) => !session.parentID && !session.time.archived)
              : sessions,
          cursor: options.more ? { next: "more-sessions" } : {},
        })
      if (/^\/api\/session\/ses_[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split("/")[3]!
        const session = sessions.find((item) => item.id === id) ?? historical.get(id)
        return session
          ? Response.json({ data: session })
          : Response.json(
              { _tag: "SessionNotFoundError", message: "Session not found", sessionID: id },
              { status: 404 },
            )
      }
      if (url.pathname === "/api/session/active")
        return Response.json({ data: options.active === false ? {} : { ses_running: { type: "running" } } })
      if (url.pathname === "/api/pty")
        return Response.json({
          location: { directory: url.searchParams.get("location[directory]") ?? "/srv/project" },
          data: [
            {
              id: "pty_shell",
              title: "Build worker",
              command: "sh",
              args: ["build.sh"],
              cwd: "/srv/other",
              status: "running",
              pid: 4242,
            },
          ],
        })
      if (url.pathname === "/api/loop")
        return Response.json([
          {
            id: "loop_check",
            name: "Nightly checks",
            status: "active",
            prompt: "Review overnight changes",
            schedule: options.schedule ?? { type: "interval", seconds: 3600, timezone: "UTC" },
            location: { directory: "/srv/project" },
          },
        ])
      if (url.pathname === "/api/loop/loop_check/run")
        return Response.json([
          {
            id: "run_check",
            loopID: "loop_check",
            status: "succeeded",
            time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
          },
          { id: "run_partial", loopID: "loop_check", status: "failed" },
        ])
      if (url.pathname === "/api/agent") {
        if (options.agentDelay) await Bun.sleep(options.agentDelay)
        const directory = url.searchParams.get("location[directory]") ?? "/srv/project"
        return Response.json({
          location: { directory },
          data: options.agents?.[directory]?.map((id) => ({
            id,
            mode: "primary",
            hidden: false,
          })) ?? [
            { id: "build", mode: "primary", hidden: false, description: "Build agent" },
            { id: "explore", mode: "subagent", hidden: false },
          ],
        })
      }
      if (url.pathname.endsWith("/message")) {
        const cursor = url.searchParams.get("cursor")
        messageCursors.push(cursor)
        if (cursor && url.searchParams.has("order")) return new Response(null, { status: 400 })
        if (options.pages && cursor === "older")
          return Response.json({
            data: [{ id: "msg_old", type: "user", text: "The original task on the older page.", time: { created: 0 } }],
            cursor: { next: "empty-older", previous: "newer" },
          })
        if (options.pages && cursor?.startsWith("empty")) return Response.json({ data: [], cursor: {} })
        return Response.json({
          data: [
            {
              id: "msg_output",
              type: "assistant",
              agent: "build",
              model: { providerID: "test", id: "local" },
              time: { created: 1 },
              content: [
                {
                  id: "part_text",
                  type: "text",
                  text: options.text ?? "Inspecting the server and its running processes.",
                },
                ...(options.toolText
                  ? [
                      {
                        id: "part_result",
                        type: "tool",
                        name: "wait_agents",
                        time: { created: 1 },
                        state: { status: "completed", content: [{ type: "text", text: options.toolText }] },
                      },
                    ]
                  : []),
              ],
            },
            ...(options.history
              ? [
                  {
                    id: "msg_earlier",
                    type: "user",
                    text: "Earlier task that belongs in history.",
                    time: { created: 0 },
                  },
                ]
              : []),
          ],
          cursor: options.pages ? { next: "older", previous: "empty-newer" } : {},
        })
      }
      if (url.pathname.endsWith("/task")) return Response.json(options.tasks ?? { data: [], active: [], cursor: {} })
      if (url.pathname.includes("/permission"))
        return Response.json({
          data: pending.permissions.filter((request) => request.sessionID === url.pathname.split("/")[3]),
        })
      if (url.pathname.includes("/question"))
        return Response.json({
          data: pending.questions.filter((request) => request.sessionID === url.pathname.split("/")[3]),
        })
      if (url.pathname.includes("/input")) return Response.json({ data: [] })
      return new Response(`Unknown fixture route: ${url.pathname}`, { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const connection = connect({ url: server.url.href })
  cleanup.push(connection.close)
  return { server, connection, posts, pending, sessions, historical, reads, messageCursors }
}
