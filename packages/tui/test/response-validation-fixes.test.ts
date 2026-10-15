import { describe, expect, test } from "bun:test"
import { validateResponse } from "../src/response-validation"
import { session } from "./support"

const at = (path: string) => new URL(`http://127.0.0.1/api/${path}`)
const POST = { method: "POST" }
const location = { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } }
const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `f${index}`, type: "file" }))
const accepts = (path: string, value: unknown, init?: RequestInit) =>
  expect(() => validateResponse(at(path), init, value)).not.toThrow()
const rejects = (path: string, value: unknown, init?: RequestInit) =>
  expect(() => validateResponse(at(path), init, value)).toThrow()

describe("file listings", () => {
  test("fs/list accepts more than 200 entries and fs/find still rejects them", () => {
    accepts("fs/list", { location, data: entries(1000) })
    rejects("fs/list", { location, data: entries(20001) })
    accepts("fs/find", { location, data: entries(200) })
    rejects("fs/find", { location, data: entries(201) })
  })
})

describe("session state", () => {
  const check = (extra: Record<string, unknown>) =>
    validateResponse(at("session/ses_main"), undefined, { data: { ...session(), ...extra } })

  test("valid projectID, subpath, cost and tokens pass", () => {
    expect(() => check({ subpath: "packages/tui", cost: 1.5 })).not.toThrow()
    expect(() => check({ tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 2, write: 0 } } })).not.toThrow()
  })

  test("a non-numeric cost, a negative token count, a bad projectID or a bad subpath is rejected", () => {
    expect(() => check({ cost: "free" })).toThrow()
    expect(() => check({ tokens: { input: -1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })).toThrow()
    expect(() => check({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: -3 } } })).toThrow()
    expect(() => check({ projectID: "../escape" })).toThrow()
    expect(() => check({ subpath: 7 })).toThrow()
  })

  test("a location project needs a valid id and directory", () => {
    const withProject = (project: unknown) => check({ location: { directory: "/srv/main", project } })
    expect(() => withProject({ id: "project", directory: "/srv/main" })).not.toThrow()
    expect(() => withProject({ id: "../x", directory: "/srv/main" })).toThrow()
    expect(() => withProject({ id: "project", directory: "relative/dir" })).toThrow()
  })
})

describe("memory", () => {
  const note = {
    id: "mem_1",
    title: "A note",
    kind: "note",
    body: "text",
    provenance: { assertedBy: "user", source: "user" },
    anchor: {},
  }

  test("a POST /api/memory item is validated", () => {
    accepts("memory", note, POST)
    rejects("memory", { ...note, kind: "rumour" }, POST)
    rejects("memory", { ...note, title: undefined }, POST)
  })

  test("a list rejects duplicate IDs", () => {
    accepts("memory", [note, { ...note, id: "mem_2" }])
    rejects("memory", [note, note])
  })

  test("wing and room items need a name; top-level items need a title", () => {
    accepts("memory/wing", [{ id: "wng_1", name: "Wing", kind: "project", key: "k" }])
    rejects("memory/wing", [{ id: "wng_1", title: "Wing", kind: "project", key: "k" }])
    accepts("memory/room", [{ id: "rom_1", name: "Room", slug: "room" }])
    rejects("memory/room", [{ id: "rom_1", slug: "room" }])
    rejects("memory", [{ ...note, title: undefined, name: "A note" }])
  })
})

describe("created terminals and replays", () => {
  test("POST /api/pty accepts a pty_ id only", () => {
    accepts("pty", { location, data: { id: "pty_1" } }, POST)
    rejects("pty", { location, data: { id: "ses_1" } }, POST)
  })

  test("a replay rejects a bad cursor or more than 500 entries", () => {
    const route = "session/ses_main/replay"
    accepts(route, { data: [], cursor: { next: "abc" } })
    rejects(route, { data: [], cursor: { next: 5 } })
    rejects(route, { data: Array.from({ length: 501 }, () => ({})), cursor: {} })
  })
})
