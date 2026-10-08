import { expect, test } from "bun:test"
import type { Api } from "../src/api"
import { worktree, WorktreeNotStartedError } from "../src/server/worktree"

function fixture(states: unknown[]) {
  const calls: { path: string; method: string }[] = []
  const controller = new AbortController()
  const api: Api = async (path, options) => {
    calls.push({ path, method: options?.method ?? "GET" })
    if (path === "/experimental/worktree/status") {
      expect(options?.directory).toBe("/srv/project")
      expect(options?.query?.name).toBe("tui-attempt")
      return states.shift()
    }
    if (path === "/experimental/worktree" && options?.method === "POST") return { directory: "/srv/worktree" }
    throw new Error(`Unexpected request: ${path}`)
  }
  return { api, controller, calls }
}

test("fresh creation waits for authoritative bootstrap completion", async () => {
  const f = fixture([{ status: "unknown" }, { status: "pending" }, { status: "ready", directory: "/srv/worktree" }])
  expect(await worktree(f, "/srv/project", "tui-attempt", false)).toEqual({
    status: "ready",
    directory: "/srv/worktree",
  })
  expect(f.calls).toEqual([
    { path: "/experimental/worktree/status", method: "GET" },
    { path: "/experimental/worktree", method: "POST" },
    { path: "/experimental/worktree/status", method: "GET" },
    { path: "/experimental/worktree/status", method: "GET" },
  ])
})

test("a retry recovers completed work without reading files or creating another worktree", async () => {
  const f = fixture([{ status: "ready", directory: "/srv/worktree" }])
  expect(await worktree(f, "/srv/project", "tui-attempt", true)).toEqual({
    status: "ready",
    directory: "/srv/worktree",
  })
  expect(f.calls).toEqual([{ path: "/experimental/worktree/status", method: "GET" }])
})

test("a pending setup retry waits without reposting, even before its directory is known", async () => {
  const f = fixture([{ status: "pending" }, { status: "ready", directory: "/srv/worktree" }])
  expect(await worktree(f, "/srv/project", "tui-attempt", true)).toMatchObject({ status: "ready" })
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})

test("failed checkout or bootstrap stays failed regardless of files left on disk", async () => {
  const f = fixture([{ status: "failed", directory: "/srv/worktree", message: "Bootstrap failed" }])
  expect(await worktree(f, "/srv/project", "tui-attempt", true)).toEqual({
    status: "failed",
    message: "Bootstrap failed",
  })
  expect(f.calls).toHaveLength(1)
})

test("unknown retry outcomes cannot relaunch or guess readiness", async () => {
  const f = fixture([{ status: "unknown" }])
  await expect(worktree(f, "/srv/project", "tui-attempt", true)).rejects.toThrow("no retained worktree outcome")
  expect(f.calls).toEqual([{ path: "/experimental/worktree/status", method: "GET" }])
})

test("a mismatched creation directory cannot launch a session", async () => {
  const f = fixture([{ status: "unknown" }, { status: "ready", directory: "/srv/other" }])
  await expect(worktree(f, "/srv/project", "tui-attempt", false)).rejects.toThrow("worktree directory identity")
})

test("missing status support is checked before a fresh POST", async () => {
  const f = fixture([])
  await expect(worktree(f, "/srv/project", "tui-attempt", false)).rejects.toThrow("Invalid server response")
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})

test("a preflight transport failure is explicitly safe to start again", async () => {
  const f = fixture([])
  f.api = async () => {
    throw new Error("offline")
  }
  await expect(worktree(f, "/srv/project", "tui-attempt", false)).rejects.toBeInstanceOf(WorktreeNotStartedError)
})

test("an ambiguous POST failure is never marked safe to start again", async () => {
  const f = fixture([])
  const failure = new Error("upstream reset")
  f.api = async (path) => {
    if (path === "/experimental/worktree/status") return { status: "unknown" }
    throw failure
  }
  await expect(worktree(f, "/srv/project", "tui-attempt", false)).rejects.toBe(failure)
})

test("cancelled pending readiness stops without another status read or POST", async () => {
  const f = fixture([{ status: "pending" }])
  const stop = new AbortController()
  const pending = worktree(f, "/srv/project", "tui-attempt", true, stop.signal)
  stop.abort()
  await expect(pending).rejects.toThrow()
  expect(f.calls).toHaveLength(1)
})

test("an older server explains missing readiness support before creation", async () => {
  const f = fixture([])
  f.api = async () => {
    throw new Error("Server returned HTTP 404.")
  }
  await expect(worktree(f, "/srv/project", "tui-attempt", false)).rejects.toThrow(
    "server readiness support: Server returned HTTP 404",
  )
})
