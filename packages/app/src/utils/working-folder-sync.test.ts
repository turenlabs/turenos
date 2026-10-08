import { expect, test } from "bun:test"
import { createWorkingFolders } from "@turenlabs/client/working-folders"
import { ServerConnection } from "@/context/server"
import { createServerFolderStores, createWorkingFolderSync, reconcileWorkingFolders } from "./working-folder-sync"

function server() {
  const records = new Map<
    string,
    { scope: string; key: string; value: string; revision: number; timeCreated: number; timeUpdated: number }
  >()
  const control = { fail: false }
  const requests: { url: string; headers: Headers; signal?: AbortSignal | null; redirect?: RequestRedirect }[] = []
  const transport = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({
      url: url.href,
      headers: new Headers(init?.headers),
      signal: init?.signal,
      redirect: init?.redirect,
    })
    const record = records.get(url.origin)
    if (init?.method !== "PUT") return Response.json({ state: record ?? null })
    if (control.fail) return new Response("", { status: 503 })
    const body = JSON.parse(String(init.body)) as {
      scope: string
      key: string
      value: string
      expectedRevision: number | null
    }
    if (body.expectedRevision !== (record?.revision ?? null)) return new Response("", { status: 409 })
    const next = { ...body, revision: (record?.revision ?? 0) + 1, timeCreated: 1, timeUpdated: 2 }
    records.set(url.origin, next)
    return Response.json(next)
  }
  return {
    control,
    requests,
    records,
    fetch: Object.assign(transport, { preconnect() {} }),
    client: (url = "https://one.test") =>
      createWorkingFolders({ url: new URL(url), headers: new Headers(), transport }),
  }
}

test("GUI migration and terminal changes preserve local expansion and order", async () => {
  const remote = server()
  let projects = [
    { worktree: "/b", expanded: false },
    { worktree: "/a", expanded: true },
  ]
  const errors: unknown[] = []
  const gui = createWorkingFolderSync({
    folders: remote.client(),
    projects: () => projects,
    apply: (directories) => {
      projects = reconcileWorkingFolders(projects, directories)
    },
    failed: (error) => errors.push(error),
  })
  await gui.refresh()
  const tui = remote.client()
  expect(await tui.read()).toEqual(["/b", "/a"])
  await tui.open("/terminal")
  await gui.refresh()
  expect(projects).toEqual([
    { worktree: "/b", expanded: false },
    { worktree: "/a", expanded: true },
    { worktree: "/terminal", expanded: true },
  ])
  await gui.change("/a", false)
  expect(await tui.read()).toEqual(["/b", "/terminal"])
  await gui.change("/gui", true)
  expect(await tui.read()).toEqual(["/b", "/terminal", "/gui"])
  expect(errors).toEqual([])
})

test("an existing shared list wins over stale GUI folders and repeated refreshes do not rewrite local state", async () => {
  const remote = server()
  await remote.client().open("/shared")
  let projects = [{ worktree: "/obsolete", expanded: false }]
  let applied = 0
  const gui = createWorkingFolderSync({
    folders: remote.client(),
    projects: () => projects,
    apply: (directories) => {
      applied++
      projects = reconcileWorkingFolders(projects, directories)
    },
    failed: () => {},
  })
  await gui.refresh()
  await gui.refresh()
  expect(projects.map((project) => project.worktree)).toEqual(["/shared"])
  expect(applied).toBe(1)
})

test("a refused GUI edit surfaces its failure and restores confirmed membership", async () => {
  const remote = server()
  let projects = [{ worktree: "/original", expanded: false }]
  const errors: unknown[] = []
  const gui = createWorkingFolderSync({
    folders: remote.client(),
    projects: () => projects,
    apply: (directories) => {
      projects = reconcileWorkingFolders(projects, directories)
    },
    failed: (error) => errors.push(error),
  })
  await gui.refresh()
  projects.push({ worktree: "/unsaved", expanded: true })
  remote.control.fail = true
  await gui.change("/unsaved", true)
  expect(errors).toHaveLength(1)
  expect(projects).toEqual([{ worktree: "/original", expanded: false }])
})

test("each GUI server uses its own endpoint and credentials and aborts requests on disposal", async () => {
  const remote = server()
  const first: ServerConnection.Any = {
    type: "http",
    http: { url: "https://one.test", username: "user", password: "synthetic" },
  }
  const second: ServerConnection.Any = { type: "ssh", host: "synthetic-host", http: { url: "http://127.0.0.1:19001" } }
  const servers = [first, second]
  const stores = createServerFolderStores({
    connection: (key) => servers.find((server) => ServerConnection.key(server) === key),
    projects: (key) => [{ worktree: key === ServerConnection.key(first) ? "/first" : "/second", expanded: true }],
    apply() {},
    failed() {},
    fetch: remote.fetch,
  })
  await stores.get(ServerConnection.key(first))!.refresh()
  await stores.get(ServerConnection.key(second))!.refresh()
  expect(await remote.client("https://one.test").read()).toEqual(["/first"])
  expect(await remote.client("http://127.0.0.1:19001").read()).toEqual(["/second"])
  const requests = remote.requests.filter((request) => request.signal)
  expect(requests[0].headers.get("Authorization")).toBe("Basic " + btoa("user:synthetic"))
  expect(requests.every((request) => request.redirect === "error")).toBe(true)
  stores.dispose()
  expect(requests.every((request) => request.signal?.aborted)).toBe(true)
})
