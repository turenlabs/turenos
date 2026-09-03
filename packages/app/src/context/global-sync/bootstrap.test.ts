import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { CancelledError, QueryClient } from "@tanstack/solid-query"
import type { Config, ForgeClient, Project, Session } from "@turenlabs/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@turenlabs/session-ui/context"
import { bootstrapDirectory, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const commandReads: string[] = []
    const [store, setStore] = directoryState()

    const bootstrap = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            commandReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        v2: {
          question: { request: { list: async () => ({ data: { data: [] } }) } },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as ForgeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await bootstrap

    expect(store.status).toBe("complete")
    expect(commandReads).toEqual(["command"])
  })

  test("a cancelled reload is not a failure and still completes the directory", async () => {
    const [store, setStore] = directoryState()
    // A real one, not a hand-shaped lookalike: TanStack builds it as
    // `super("CancelledError")`, so the string is the message and `name` stays
    // "Error". A fixture that sets `name` would pass against a check that never
    // matches in production.
    const cancelled = new CancelledError()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: { list: async () => ({ data: [] }) },
        permission: { list: async () => ({ data: [] }) },
        v2: {
          question: { request: { list: async () => ({ data: { data: [] } }) } },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as ForgeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      // Superseded or unmounted work rejects this way. It must not be mistaken
      // for a reload that failed, or the directory never leaves "partial".
      async loadSessions() {
        throw cancelled
      },
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
  })

  test("seeds session status without hydrating every status entry", async () => {
    const [store, setStore] = directoryState()
    let sessionGets = 0
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: { ses_busy: { type: "busy" } } }),
        get: () => {
          sessionGets += 1
          return Promise.resolve({ data: undefined })
        },
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      v2: {
        question: { request: { list: async () => ({ data: { data: [] } }) } },
      },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ForgeClient
    const session = createServerSession(client)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()
    expect(sessionGets).toBe(0)
  })

  test("hydrates one focused session on demand without hydrating status-only sessions", async () => {
    const [store, setStore] = directoryState()
    let sessionGets = 0
    const focused: Session = {
      id: "ses_focused",
      slug: "ses_focused",
      projectID: "project",
      directory: "/project",
      title: "focused",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({
          data: {
            ses_focused: { type: "busy" },
            ses_status_only: { type: "busy" },
          },
        }),
        get: async ({ sessionID }: { sessionID: string }) => {
          sessionGets += 1
          return { data: sessionID === focused.id ? focused : undefined }
        },
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      v2: {
        question: { request: { list: async () => ({ data: { data: [] } }) } },
      },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ForgeClient
    const session = createServerSession(client)

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_status.ses_focused && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(sessionGets).toBe(0)
    await session.sync(focused.id)

    expect(sessionGets).toBe(1)
    expect(session.get(focused.id)).toBe(focused)
    expect(session.get("ses_status_only")).toBeUndefined()
  })

  test("loads pending requests without hydrating every owning session", async () => {
    const [store, setStore] = directoryState()
    let sessionGets = 0
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => {
          sessionGets += 1
          return { data: undefined }
        },
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: {
        list: async () => ({
          data: [{ id: "per_1", sessionID: "ses_permission", action: "read", resources: ["file"] }],
        }),
      },
      v2: {
        question: {
          request: {
            list: async () => ({
              data: {
                data: [{ id: "que_1", sessionID: "ses_question", questions: [] }],
              },
            }),
          },
        },
      },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ForgeClient
    const session = createServerSession(client)

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.permission.ses_permission && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.permission.ses_permission).toHaveLength(1)
    expect(session.data.question.ses_question).toHaveLength(1)
    expect(sessionGets).toBe(0)
  })

  test("does not let an older status retry overwrite a newer bootstrap snapshot", async () => {
    const [store, setStore] = directoryState()
    const firstStatus = Promise.withResolvers<{ data: Record<string, { type: "busy" }> }>()
    let statusCalls = 0
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => {
          statusCalls += 1
          if (statusCalls === 1) return firstStatus.promise
          if (statusCalls === 2) return { data: { ses_newer: { type: "busy" as const } } }
          return { data: { ses_older: { type: "busy" as const } } }
        },
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      v2: {
        question: { request: { list: async () => ({ data: { data: [] } }) } },
      },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ForgeClient
    const session = createServerSession(client)
    const queryClient = new QueryClient()
    const input = {
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key: string) => key,
      queryClient,
      session,
    }

    const older = bootstrapDirectory(input)
    const started = Date.now() + 1_000
    while (statusCalls < 1 && Date.now() < started) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(statusCalls).toBe(1)

    await bootstrapDirectory(input)
    const newerDeadline = Date.now() + 500
    while (statusCalls < 2 && Date.now() < newerDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(statusCalls).toBe(2)
    expect(session.data.session_status.ses_newer).toEqual({ type: "busy" })

    firstStatus.reject(new Error("network request failed"))
    await older

    expect(statusCalls).toBe(3)
    expect(session.data.session_status.ses_newer).toEqual({ type: "busy" })
    expect(session.data.session_status.ses_older).toBeUndefined()
  })

  // store.agent has exactly one writer — this fetch. The re-bootstrap paths
  // (server.instance.disposed / global.disposed) only refresh the picker if it actually
  // hits the server; with ensureQueryData a warm cache made them no-ops and an edited
  // agent needed an app restart to appear.
  test("re-bootstrap refetches the agent list instead of serving the cache", async () => {
    const [store, setStore] = directoryState()
    const agentLists: number[] = []
    const client = {
      app: {
        agents: async () => {
          agentLists.push(agentLists.length + 1)
          return {
            data:
              agentLists.length === 1
                ? [{ name: "build", mode: "primary" }]
                : [
                    { name: "build", mode: "primary" },
                    { name: "reviewer", mode: "primary" },
                  ],
          }
        },
      },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => ({ data: undefined }),
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      v2: {
        question: { request: { list: async () => ({ data: { data: [] } }) } },
      },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ForgeClient
    const session = createServerSession(client)
    const queryClient = new QueryClient()
    const boot = () =>
      bootstrapDirectory({
        directory: "/project",
        scope: ServerScope.local,
        global: {
          config: {} satisfies Config,
          path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
          project: [{ id: "project", worktree: "/project" } as Project],
          provider,
        },
        sdk: client,
        store,
        setStore,
        vcsCache: { setStore() {} } as unknown as VcsCache,
        loadSessions() {},
        translate: (key) => key,
        queryClient,
        session,
      })

    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await boot()
    await until(() => store.agent.length === 1)
    expect(agentLists.length).toBe(1)

    await boot()
    await until(() => store.agent.length === 2)
    expect(agentLists.length).toBe(2)
    expect(store.agent.map((agent) => agent.name)).toEqual(["build", "reviewer"])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as ForgeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
