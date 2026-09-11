import { beforeAll, describe, expect, mock, test } from "bun:test"
import { base64Encode } from "@turenlabs/core/util/encode"
import { ServerScope } from "@/utils/server-scope"
import type { LocalPTY } from "./terminal"

let getWorkspaceTerminalCacheKey: typeof import("./terminal").getWorkspaceTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let replaceTerminalEntry: typeof import("./terminal").replaceTerminalEntry
let upsertSharedTerminal: typeof import("./terminal").upsertSharedTerminal
let coalesceTerminalRequest: typeof import("./terminal").coalesceTerminalRequest
let reconcileTerminalState: typeof import("./terminal").reconcileTerminalState
let pruneTerminalStateEntries: typeof import("./terminal").pruneTerminalStateEntries
let removeWorkspaceTerminalEntries: typeof import("./terminal").removeWorkspaceTerminalEntries
let workspaceStorageKey: (dir: string) => string

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@turenlabs/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
  replaceTerminalEntry = mod.replaceTerminalEntry
  upsertSharedTerminal = mod.upsertSharedTerminal
  coalesceTerminalRequest = mod.coalesceTerminalRequest
  reconcileTerminalState = mod.reconcileTerminalState
  pruneTerminalStateEntries = mod.pruneTerminalStateEntries
  removeWorkspaceTerminalEntries = mod.removeWorkspaceTerminalEntries

  const persist = await import("@/utils/persist")
  workspaceStorageKey = (dir: string) => {
    // Mirrors the provider: workspace terminal stores are keyed by the
    // base64-encoded directory (see TerminalProvider) under "terminal".
    const target = persist.Persist.serverWorkspace(ServerScope.local, base64Encode(dir), "terminal")
    return `${target.storage}:${target.key}`
  }
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo"))).toBe("local\u0000/repo\u0000__workspace__")
  })

  test("can include a server scope", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo", "ssh:debian" as ServerScope))).toBe(
      "ssh:debian\u0000/repo\u0000__workspace__",
    )
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })

  test("preserves custom shell launch metadata for reconnects", () => {
    expect(
      migrateTerminalState({
        active: "shell",
        all: [
          {
            id: "shell",
            title: "Project shell",
            titleNumber: 1,
            command: "zsh",
            args: ["-l"],
            env: { TERM: "xterm-256color" },
          },
        ],
      }),
    ).toEqual({
      active: "shell",
      all: [
        {
          id: "shell",
          title: "Project shell",
          titleNumber: 1,
          command: "zsh",
          args: ["-l"],
          env: { TERM: "xterm-256color" },
        },
      ],
    })
  })

  test("does not restore persisted output from a shared terminal", () => {
    const state = migrateTerminalState({
      active: "pty_shared",
      all: [
        {
          id: "pty_shared",
          title: "Shared terminal",
          titleNumber: 0,
          shared: true,
          sessionID: "ses_shared",
          workspaceID: "wrk_shared",
          buffer: "secret output",
          cursor: 13,
          scrollY: 2,
        },
      ],
    }) as { all: LocalPTY[] }

    expect(state.all[0]).toMatchObject({
      id: "pty_shared",
      shared: true,
      sessionID: "ses_shared",
      workspaceID: "wrk_shared",
    })
    expect(state.all[0]?.buffer).toBeUndefined()
    expect(state.all[0]?.cursor).toBeUndefined()
    expect(state.all[0]?.scrollY).toBeUndefined()
  })

  // Contract: a session owns at most one shared terminal server-side, so
  // persisted duplicates for one session collapse to the most recently
  // appended entry (fresh bindings are appended by shared()).
  test("collapses persisted duplicate shared terminals for one session", () => {
    expect(
      migrateTerminalState({
        active: "pty_old",
        all: [
          { id: "pty_old", title: "Shared terminal", shared: true, sessionID: "ses_a" },
          { id: "shell", title: "Terminal 1", titleNumber: 1 },
          { id: "pty_new", title: "Shared terminal", shared: true, sessionID: "ses_a" },
        ],
      }),
    ).toEqual({
      // The dropped duplicate's active marker carries to the surviving tab.
      active: "pty_new",
      all: [
        { id: "shell", title: "Terminal 1", titleNumber: 1 },
        { id: "pty_new", title: "Shared terminal", titleNumber: 0, shared: true, sessionID: "ses_a" },
      ],
    })
  })

  test("keeps shared terminals that belong to different sessions", () => {
    const state = migrateTerminalState({
      active: "pty_a",
      all: [
        { id: "pty_a", title: "Shared terminal", shared: true, sessionID: "ses_a" },
        { id: "pty_b", title: "Shared terminal", shared: true, sessionID: "ses_b" },
      ],
    }) as { active: string; all: LocalPTY[] }

    expect(state.active).toBe("pty_a")
    expect(state.all.map((pty) => pty.id)).toEqual(["pty_a", "pty_b"])
  })
})

describe("replaceTerminalEntry", () => {
  test("atomically replaces the failed PTY in its existing slot", () => {
    const shell = { id: "shell", title: "Terminal 1", titleNumber: 1 }
    const failed = { id: "failed", title: "Shell", titleNumber: 2, command: "zsh" }
    const replacement = { id: "replacement", title: "Shell", titleNumber: 2, command: "zsh" }

    expect(replaceTerminalEntry([shell, failed], failed.id, replacement)).toEqual([shell, replacement])
  })

  test("keeps exactly one replacement if the failed PTY already exited", () => {
    const replacement = { id: "replacement", title: "Shell", titleNumber: 1, command: "zsh" }

    expect(replaceTerminalEntry([replacement], "failed", replacement)).toEqual([replacement])
  })
})

describe("upsertSharedTerminal", () => {
  const shell = { id: "shell", title: "Terminal 1", titleNumber: 1 }
  const shared = (id: string, sessionID: string): LocalPTY => ({
    id,
    title: "Shared terminal",
    titleNumber: 0,
    shared: true,
    sessionID,
  })

  // Contract: shared() appends a tab when the session has no entry yet.
  test("appends the session terminal when the workspace has none", () => {
    const next = shared("pty_a", "ses_a")
    expect(upsertSharedTerminal([shell], next)).toEqual([shell, next])
  })

  // Contract: re-requesting the same session's terminal while the binding is
  // unchanged must not stack a second tab (switching views re-calls shared()).
  test("re-shares in place when the server returns the same PTY", () => {
    const existing = shared("pty_a", "ses_a")
    const next = { ...existing, workspaceID: "wrk_1" }
    expect(upsertSharedTerminal([existing, shell], next)).toEqual([next, shell])
  })

  // Contract: when the server binding moved to a fresh PTY while a stale entry
  // for the session survived, the fresh tab takes the stale one's slot rather
  // than appending a duplicate.
  test("replaces a stale same-session entry in its slot when the binding moved", () => {
    const other = { id: "other", title: "Terminal 2", titleNumber: 2 }
    const fresh = shared("pty_new", "ses_a")
    expect(upsertSharedTerminal([shell, shared("pty_old", "ses_a"), other], fresh)).toEqual([shell, fresh, other])
  })

  // Contract: several accumulated stale entries for one session all collapse.
  test("collapses accumulated stale duplicates for the same session", () => {
    const fresh = shared("pty_new", "ses_a")
    expect(upsertSharedTerminal([shared("pty_1", "ses_a"), shell, shared("pty_2", "ses_a")], fresh)).toEqual([
      fresh,
      shell,
    ])
  })

  // Contract: entries for other sessions and private tabs are never touched.
  test("leaves other sessions' shared terminals and private tabs alone", () => {
    const theirs = shared("pty_b", "ses_b")
    const fresh = shared("pty_new", "ses_a")
    expect(upsertSharedTerminal([theirs, shell], fresh)).toEqual([theirs, shell, fresh])
  })

  // Contract: a private tab is not considered stale for the session even if it
  // somehow carries a sessionID — only shared entries collapse.
  test("does not treat a non-shared entry with the same sessionID as stale", () => {
    const unattributed = { id: "pty_c", title: "Shell", titleNumber: 0, sessionID: "ses_a" }
    const fresh = shared("pty_new", "ses_a")
    expect(upsertSharedTerminal([unattributed], fresh)).toEqual([unattributed, fresh])
  })
})

describe("coalesceTerminalRequest", () => {
  test("shares an in-flight request and releases the key after completion", async () => {
    const requests = new Map<string, Promise<string>>()
    let release!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    let created = 0

    const create = () => {
      created += 1
      return created === 1 ? pending : Promise.resolve("retry")
    }
    const first = coalesceTerminalRequest(requests, "session", create)
    const second = coalesceTerminalRequest(requests, "session", create)

    expect(second).toBe(first)
    expect(created).toBe(1)
    release("ready")
    await expect(first).resolves.toBe("ready")

    const retry = coalesceTerminalRequest(requests, "session", create)
    expect(retry).not.toBe(first)
    expect(created).toBe(2)
    await expect(retry).resolves.toBe("retry")
  })

  test("releases the key after a failed request", async () => {
    const requests = new Map<string, Promise<string>>()
    let created = 0
    const create = () => {
      created += 1
      return Promise.reject(new Error("offline"))
    }

    const first = coalesceTerminalRequest(requests, "session", create)
    await expect(first).rejects.toThrow("offline")
    const retry = coalesceTerminalRequest(requests, "session", create)

    expect(retry).not.toBe(first)
    expect(created).toBe(2)
    await expect(retry).rejects.toThrow("offline")
  })
})

describe("pruneTerminalStateEntries", () => {
  test("drops the pruned ids and repairs the active pointer", () => {
    expect(
      pruneTerminalStateEntries(
        {
          active: "dead",
          all: [
            { id: "dead", title: "Shell", titleNumber: 1, command: "zsh" },
            { id: "live", title: "Terminal 2", titleNumber: 2 },
          ],
        },
        new Set(["dead"]),
      ),
    ).toEqual({ active: "live", all: [{ id: "live", title: "Terminal 2", titleNumber: 2 }] })
  })

  test("returns undefined when nothing matches so callers skip the write", () => {
    const state = { active: "live", all: [{ id: "live", title: "Terminal 1", titleNumber: 1 }] }

    expect(pruneTerminalStateEntries(state, new Set(["other"]))).toBeUndefined()
    expect(pruneTerminalStateEntries("garbage", new Set(["other"]))).toBeUndefined()
  })
})

describe("removeWorkspaceTerminalEntries", () => {
  const state = (ids: string[], active?: string) => ({
    active,
    all: ids.map((id, index) => ({ id, title: `Terminal ${index + 1}`, titleNumber: index + 1 })),
  })

  test("purges disposed PTYs from the persisted workspace store", async () => {
    const dir = "/repo/teardown"
    const key = workspaceStorageKey(dir)
    localStorage.setItem(key, JSON.stringify(state(["dead", "live"], "dead")))

    removeWorkspaceTerminalEntries({ directory: dir, ptyIDs: ["dead", "missing"] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      active: "live",
      all: [{ id: "live", title: "Terminal 2", titleNumber: 2 }],
    })
  })

  test("leaves unrelated workspaces and non-matching stores untouched", async () => {
    const dir = "/repo/teardown-other"
    const bystander = "/repo/bystander"
    const raw = JSON.stringify(state(["live"], "live"))
    localStorage.setItem(workspaceStorageKey(dir), raw)
    localStorage.setItem(workspaceStorageKey(bystander), JSON.stringify(state(["dead"], "dead")))

    removeWorkspaceTerminalEntries({ directory: dir, ptyIDs: ["dead"] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(localStorage.getItem(workspaceStorageKey(dir))).toBe(raw)
    expect(JSON.parse(localStorage.getItem(workspaceStorageKey(bystander))!)).toEqual(state(["dead"], "dead"))
  })

  test("ignores empty pty id lists", async () => {
    const dir = "/repo/teardown-empty"
    const raw = JSON.stringify(state(["live"], "live"))
    localStorage.setItem(workspaceStorageKey(dir), raw)

    removeWorkspaceTerminalEntries({ directory: dir, ptyIDs: ["", ""] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(localStorage.getItem(workspaceStorageKey(dir))).toBe(raw)
  })
})

describe("reconcileTerminalState", () => {
  test("removes persisted ghosts while preserving every live nested terminal", () => {
    const shell = { id: "shell", title: "Terminal 1", titleNumber: 1 }
    const nested = { id: "nested", title: "Shell", titleNumber: 2, command: "zsh" }
    const ghost = { id: "ghost", title: "Shell", titleNumber: 3, command: "zsh" }

    expect(
      reconcileTerminalState(
        { active: ghost.id, all: [shell, nested, ghost] },
        [shell.id, nested.id, ghost.id],
        [shell.id, nested.id],
      ),
    ).toEqual({ active: shell.id, all: [shell, nested] })
  })

  test("does not remove a terminal created after reconciliation started", () => {
    const persisted = { id: "persisted", title: "Shell", titleNumber: 1, command: "zsh" }
    const created = { id: "created", title: "Terminal 2", titleNumber: 2 }

    expect(reconcileTerminalState({ active: created.id, all: [persisted, created] }, [persisted.id], [])).toEqual({
      active: created.id,
      all: [created],
    })
  })
})
