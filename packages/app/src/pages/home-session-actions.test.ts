import { describe, expect, test } from "bun:test"
import type { Session, SessionV2Info } from "@turenlabs/sdk/v2/client"
import {
  archivedSessions,
  deleteSession,
  renameSession,
  SessionActionNotApplied,
  setSessionArchived,
  type SessionLifecycleClient,
} from "./home-session-actions"

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: "ses_1",
    slug: "ses_1",
    projectID: "prj_1",
    directory: "/repo",
    title: "Original",
    version: "",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    ...overrides,
  }) as Session

const client = (overrides: Partial<SessionLifecycleClient["session"]>): SessionLifecycleClient => ({
  session: {
    get: async () => ({ data: undefined }),
    update: async () => ({ data: undefined }),
    delete: async () => ({ data: true }),
    ...overrides,
  },
})

describe("renameSession", () => {
  test("returns the persisted session when the title was applied", async () => {
    const result = await renameSession({
      client: client({ update: async () => ({ data: session({ title: "Renamed" }) }) }),
      sessionID: "ses_1",
      directory: "/repo",
      title: "Renamed",
    })
    expect(result.title).toBe("Renamed")
  })

  test("sends the title as a body field alongside the routing directory", async () => {
    let seen: unknown
    await renameSession({
      client: client({
        update: async (input) => {
          seen = input
          return { data: session({ title: "Renamed" }) }
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
      title: "Renamed",
    })
    expect(seen).toEqual({ sessionID: "ses_1", directory: "/repo", title: "Renamed" })
  })

  // The bug this guards: a 2xx whose body shows the old title is a rename that
  // silently did nothing, and must never be reported as success.
  test("rejects when the server responds 2xx but kept the old title", async () => {
    const promise = renameSession({
      client: client({ update: async () => ({ data: session({ title: "Original" }) }) }),
      sessionID: "ses_1",
      directory: "/repo",
      title: "Renamed",
    })
    await expect(promise).rejects.toBeInstanceOf(SessionActionNotApplied)
  })

  test("rejects when the response carries no session", async () => {
    const promise = renameSession({
      client: client({ update: async () => ({ data: undefined }) }),
      sessionID: "ses_1",
      directory: "/repo",
      title: "Renamed",
    })
    await expect(promise).rejects.toBeInstanceOf(SessionActionNotApplied)
  })

  test("propagates transport errors unchanged", async () => {
    const promise = renameSession({
      client: client({
        update: async () => {
          throw new Error("offline")
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
      title: "Renamed",
    })
    await expect(promise).rejects.toThrow("offline")
  })
})

describe("setSessionArchived", () => {
  test("archives when the server reports an archived timestamp", async () => {
    const result = await setSessionArchived({
      client: client({ update: async () => ({ data: session({ time: { created: 1, updated: 1, archived: 99 } }) }) }),
      sessionID: "ses_1",
      directory: "/repo",
      archived: 99,
    })
    expect(result.time.archived).toBe(99)
  })

  test("restores by sending an explicit null", async () => {
    let seen: unknown
    const result = await setSessionArchived({
      client: client({
        update: async (input) => {
          seen = input
          return { data: session() }
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
      archived: null,
    })
    expect(seen).toEqual({ sessionID: "ses_1", directory: "/repo", time: { archived: null } })
    expect(result.time.archived).toBeUndefined()
  })

  // Archive must not be a one-way door: a restore the server ignored has to
  // report failure rather than leave the row looking restored in the UI only.
  test("rejects when a restore left the session archived", async () => {
    const promise = setSessionArchived({
      client: client({ update: async () => ({ data: session({ time: { created: 1, updated: 1, archived: 99 } }) }) }),
      sessionID: "ses_1",
      directory: "/repo",
      archived: null,
    })
    await expect(promise).rejects.toBeInstanceOf(SessionActionNotApplied)
  })

  test("rejects when an archive left the session active", async () => {
    const promise = setSessionArchived({
      client: client({ update: async () => ({ data: session() }) }),
      sessionID: "ses_1",
      directory: "/repo",
      archived: 99,
    })
    await expect(promise).rejects.toBeInstanceOf(SessionActionNotApplied)
  })
})

describe("archivedSessions", () => {
  test("excludes internal lobby sessions", () => {
    const archived = { time: { created: 1, updated: 1, archived: 2 } }
    expect(
      archivedSessions([
        { ...session({ id: "visible", ...archived }), location: { directory: "/repo" } } as unknown as SessionV2Info,
        {
          ...session({ id: "ses_lobby_hidden", metadata: { "forge.internal": true }, ...archived }),
          location: { directory: "/repo" },
        } as unknown as SessionV2Info,
      ]).map((item) => item.id),
    ).toEqual(["visible"])
  })
})

describe("deleteSession", () => {
  test("resolves when the session no longer reads back", async () => {
    await deleteSession({
      client: client({
        delete: async () => ({ data: true }),
        get: async () => {
          throw new Error("not found")
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
    })
  })

  // The strongest available proof: the record is still there, so nothing was deleted.
  test("rejects when the session still reads back after the delete", async () => {
    const promise = deleteSession({
      client: client({ delete: async () => ({ data: true }), get: async () => ({ data: session() }) }),
      sessionID: "ses_1",
      directory: "/repo",
    })
    await expect(promise).rejects.toBeInstanceOf(SessionActionNotApplied)
  })

  // Regression: a confirmed delete must never be vetoed by an ambiguous
  // read-back. Callers close the session's tabs on this promise resolving, so a
  // false "not applied" strands a tab on a session that is genuinely gone --
  // the "Unknown Session" tab with the not-found fallback. Only the real record
  // counts as survival.
  test.each([
    ["an empty object", {} as Session],
    ["a null body", null as unknown as Session],
    ["a different session", session({ id: "ses_other" })],
  ])("resolves when the post-delete read returns %s", async (_label, body) => {
    await deleteSession({
      client: client({ delete: async () => ({ data: true }), get: async () => ({ data: body }) }),
      sessionID: "ses_1",
      directory: "/repo",
    })
  })

  // A non-2xx throws at the client (throwOnError), and that error propagates.
  test("propagates a failed delete request", async () => {
    const promise = deleteSession({
      client: client({
        delete: async () => {
          throw new Error("500 Internal Server Error")
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
    })
    await expect(promise).rejects.toThrow("500 Internal Server Error")
  })

  // The response body's shape is a transport detail. Asserting on it would let a
  // representation quirk veto a delete the server actually performed, stranding
  // the session's tabs. Survival is established by the read-back, not the body.
  test("resolves when the delete response body is not a literal true", async () => {
    await deleteSession({
      client: client({
        delete: async () => ({ data: undefined }),
        get: async () => {
          throw new Error("not found")
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
    })
  })

  test("does not turn a failed verification read into a failed delete", async () => {
    let reads = 0
    await deleteSession({
      client: client({
        delete: async () => ({ data: true }),
        get: async () => {
          reads += 1
          throw new Error("network blip")
        },
      }),
      sessionID: "ses_1",
      directory: "/repo",
    })
    expect(reads).toBe(1)
  })
})

describe("archivedSessions", () => {
  const info = (id: string, archived?: number, parentID?: string) =>
    ({
      id,
      projectID: "prj_1",
      title: id,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      location: { directory: "/repo" },
      parentID,
      time: { created: 1, updated: 1, archived },
    }) as unknown as SessionV2Info

  test("keeps only archived roots, newest archive first", () => {
    const result = archivedSessions([info("a", 10), info("b"), info("c", 30), info("d", 20, "ses_parent")])
    expect(result.map((item) => item.id)).toEqual(["c", "a"])
  })

  test("returns an empty list when nothing is archived", () => {
    expect(archivedSessions([info("a"), info("b")])).toEqual([])
  })
})
