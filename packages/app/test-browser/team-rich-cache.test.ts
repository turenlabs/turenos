import { describe, expect, test } from "bun:test"
import { ForgeClient } from "../../sdk/js/src/v2/gen/sdk.gen"
import { createClient } from "@turenlabs/sdk/v2/gen/client"
import type { SessionMessage } from "@turenlabs/sdk/v2"
import { observeTeamRichOutput, teamRichCache } from "../src/pages/team/rich-output"

const source = (id: string): SessionMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  time: { created: 1, completed: 2 },
  content: [],
})

function fixture(reply: (request: Request) => Response | Promise<Response>, baseUrl = "http://team.test") {
  const requests: Request[] = []
  const client = new ForgeClient({
    client: createClient({
      baseUrl,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const request = new Request(input)
          requests.push(request)
          return reply(request)
        },
        { preconnect() {} },
      ),
    }),
  })
  return { client, requests, cache: teamRichCache(client) }
}

describe("Team rich output request cache", () => {
  test("shares pending and successful requests for one client", async () => {
    const view = fixture((request) =>
      Response.json({
        data: new URL(request.url).pathname.includes("/message/")
          ? source("assistant")
          : { id: "session", location: { directory: "/actual" } },
      }),
    )
    expect(teamRichCache(view.client)).toBe(view.cache)
    const session = view.cache.session("session")
    const message = view.cache.message("session", "assistant")
    expect(view.cache.session("session")).toBe(session)
    expect(view.cache.message("session", "assistant")).toBe(message)
    await Promise.all([session, message])
    expect(view.cache.session("session")).toBe(session)
    expect(view.cache.message("session", "assistant")).toBe(message)
    expect(view.requests.length).toBe(2)
  })

  test("evicts failed metadata and source requests for retry", async () => {
    let calls = 0
    const view = fixture((request) => {
      calls += 1
      if (calls <= 2) return Response.json({ message: "Unavailable" }, { status: 503 })
      return Response.json({
        data: new URL(request.url).pathname.includes("/message/")
          ? source("assistant")
          : { id: "session", location: { directory: "/actual" } },
      })
    })
    await expect(view.cache.session("session")).rejects.toThrow("Session location is unavailable")
    await expect(view.cache.message("session", "assistant")).rejects.toThrow("Source message is unavailable")
    expect((await view.cache.session("session")).location.directory).toBe("/actual")
    expect((await view.cache.message("session", "assistant")).id).toBe("assistant")
    expect(view.requests.length).toBe(4)
  })

  test("does not cache invalid successful responses", async () => {
    let calls = 0
    const view = fixture(() => {
      calls += 1
      return Response.json({
        data:
          calls === 1
            ? { id: "other", location: { directory: "/wrong" } }
            : calls === 2
              ? source("other")
              : source("assistant"),
      })
    })
    await expect(view.cache.session("session")).rejects.toThrow("Session location is unavailable")
    await expect(view.cache.message("session", "assistant")).rejects.toThrow("Source message is unavailable")
    expect((await view.cache.message("session", "assistant")).id).toBe("assistant")
    expect(view.requests.length).toBe(3)
  })

  test("isolates the same IDs across client and server identities", async () => {
    const a = fixture(() => Response.json({ data: { id: "session", location: { directory: "/a" } } }))
    const b = fixture(
      () => Response.json({ data: { id: "session", location: { directory: "/b" } } }),
      "http://other.test",
    )
    const c = fixture(() => Response.json({ data: { id: "session", location: { directory: "/c" } } }))
    expect((await a.cache.session("session")).location.directory).toBe("/a")
    expect((await b.cache.session("session")).location.directory).toBe("/b")
    expect((await c.cache.session("session")).location.directory).toBe("/c")
    expect(a.cache).not.toBe(b.cache)
    expect(a.cache).not.toBe(c.cache)
    expect([a.requests.length, b.requests.length, c.requests.length]).toEqual([1, 1, 1])
  })

  test("keys exact source requests by both Session and message ID", async () => {
    const view = fixture(() => Response.json({ data: source("assistant") }))
    await view.cache.message("a", "assistant")
    await view.cache.message("b", "assistant")
    await view.cache.message("a", "assistant")
    expect(view.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/session/a/message/assistant",
      "/api/session/b/message/assistant",
    ])
  })

  test("refreshes mutable progress sources and caches only completed assistants", async () => {
    let calls = 0
    const view = fixture(() => {
      calls += 1
      return Response.json({
        data: { ...source("assistant"), time: calls === 1 ? { created: 1 } : { created: 1, completed: 2 } },
      })
    })
    await expect(view.cache.message("session", "assistant")).rejects.toThrow("Source message is still running")
    const completed = view.cache.message("session", "assistant")
    expect((await completed).time.completed).toBe(2)
    expect(view.cache.message("session", "assistant")).toBe(completed)
    expect(view.requests.length).toBe(2)
  })

  test("bounds metadata and source caches with LRU eviction", async () => {
    const view = fixture((request) => {
      const path = new URL(request.url).pathname.split("/")
      return Response.json({
        data: path[4] === "message" ? source(path[5]!) : { id: path[3], location: { directory: "/actual" } },
      })
    })
    await Promise.all(Array.from({ length: 128 }, (_, index) => view.cache.session(`s${index}`)))
    await view.cache.session("s0")
    await view.cache.session("s128")
    await view.cache.session("s0")
    await view.cache.session("s1")
    expect(view.requests.length).toBe(130)
    await Promise.all(Array.from({ length: 512 }, (_, index) => view.cache.message("s0", `m${index}`)))
    await view.cache.message("s0", "m0")
    await view.cache.message("s0", "m512")
    await view.cache.message("s0", "m0")
    await view.cache.message("s0", "m1")
    expect(view.requests.length).toBe(644)
  })

  test("a late rejection does not evict a replacement request", async () => {
    let fail: (response: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      fail = resolve
    })
    let first = true
    const view = fixture((request) => {
      const sessionID = new URL(request.url).pathname.split("/")[3]!
      if (sessionID === "session" && first) {
        first = false
        return pending
      }
      return Response.json({ data: { id: sessionID, location: { directory: "/actual" } } })
    })
    const old = view.cache.session("session")
    const failure = old.catch((error: unknown) => error)
    await Promise.all(Array.from({ length: 128 }, (_, index) => view.cache.session(`s${index}`)))
    const replacement = view.cache.session("session")
    await replacement
    fail(Response.json({ message: "Unavailable" }, { status: 503 }))
    expect(await failure).toEqual(new Error("Session location is unavailable"))
    expect(view.cache.session("session")).toBe(replacement)
    expect(view.requests.length).toBe(130)
  })
})

describe("Team rich output viewport gate", () => {
  function fixture() {
    const root = document.createElement("div")
    root.setAttribute("role", "log")
    const element = document.createElement("div")
    root.append(element)
    let ready = 0
    let disconnected = 0
    let options: IntersectionObserverInit | undefined
    let observed: Element | undefined
    let emit: (target: Element, isIntersecting: boolean) => void = () => {}
    const cleanup = observeTeamRichOutput(
      element,
      () => {
        ready += 1
      },
      (callback, value) => {
        options = value
        const observer = {
          observe: (target: Element) => {
            observed = target
          },
          disconnect: () => {
            disconnected += 1
          },
        }
        emit = (target, isIntersecting) =>
          callback([{ target, isIntersecting } as IntersectionObserverEntry], observer as IntersectionObserver)
        return observer
      },
    )
    return { root, element, emit, cleanup, state: () => ({ ready, disconnected, options, observed }) }
  }

  test("waits for the message near the room viewport and opens only once", () => {
    const view = fixture()
    expect(view.state().observed).toBe(view.element)
    expect(view.state().options).toEqual({ root: view.root, rootMargin: "400px 0px" })
    view.emit(view.element, false)
    view.emit(document.createElement("div"), true)
    expect(view.state().ready).toBe(0)
    view.emit(view.element, true)
    expect(view.state().ready).toBe(1)
    expect(view.state().disconnected).toBe(1)
    view.emit(view.element, true)
    expect(view.state().ready).toBe(1)
    view.cleanup()
  })

  test("cleanup prevents late visibility from starting work", () => {
    const view = fixture()
    view.cleanup()
    view.emit(view.element, true)
    expect(view.state().ready).toBe(0)
    expect(view.state().disconnected).toBe(1)
  })
})
