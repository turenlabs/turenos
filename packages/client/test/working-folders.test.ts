import { expect, test } from "bun:test"
import { createWorkingFolders } from "../src/working-folders"

type RecordState = { scope: string; key: string; value: string; revision: number; timeCreated: number; timeUpdated: number }

function server(initial?: string[]) {
  const state = {
    record: initial ? stored(initial) : null as RecordState | null,
    beforeWrite: undefined as (() => void) | undefined,
    writes: 0,
    wrongAck: false,
    reads: 0,
  }
  const transport = async (url: URL, init?: RequestInit) => {
    expect(url.pathname).toBe("/global/storage")
    if (init?.method !== "PUT") {
      state.reads++
      expect(url.searchParams.get("scope")).toBe("desktop/store/working-folders")
      expect(url.searchParams.get("key")).toBe("open")
      return Response.json({ state: state.record })
    }
    state.writes++
    state.beforeWrite?.()
    const body = JSON.parse(String(init.body)) as { scope: string; key: string; value: string; expectedRevision: number | null }
    if (body.expectedRevision !== (state.record?.revision ?? null)) return new Response("", { status: 409 })
    state.record = { ...body, revision: (state.record?.revision ?? 0) + 1, timeCreated: 1, timeUpdated: 2 }
    return Response.json(state.wrongAck ? { ...state.record, value: JSON.stringify({ version: 1, directories: ["/wrong"] }) } : state.record)
  }
  const client = () => createWorkingFolders({ url: new URL("https://synthetic.test"), headers: new Headers(), transport })
  return { state, client }
}

function stored(directories: string[]): RecordState {
  return { scope: "desktop/store/working-folders", key: "open", value: JSON.stringify({ version: 1, directories }), revision: 1, timeCreated: 1, timeUpdated: 1 }
}

test("GUI legacy membership migrates once and GUI/TUI changes share the same existing record", async () => {
  const f = server()
  const gui = f.client()
  const tui = f.client()
  expect(await gui.migrate(["/legacy"])).toEqual(["/legacy"])
  expect(await tui.read()).toEqual(["/legacy"])
  await tui.open("/terminal")
  expect(await gui.read()).toEqual(["/legacy", "/terminal"])
  await gui.close("/legacy")
  expect(await tui.read()).toEqual(["/terminal"])
  expect(await f.client().migrate(["/stale-local"])).toEqual(["/terminal"])
  expect(f.state.writes).toBe(3)
})

test("an existing empty shared record overrides a GUI legacy list", async () => {
  const f = server([])
  expect(await f.client().migrate(["/old"])).toEqual([])
  expect(f.state.writes).toBe(0)
})

test("a concurrent migration winner is retained without merging stale GUI state", async () => {
  const f = server()
  f.state.beforeWrite = () => { f.state.record = stored(["/winner"]); f.state.beforeWrite = undefined }
  expect(await f.client().migrate(["/legacy"])).toEqual(["/winner"])
  expect(f.state.writes).toBe(1)
})

test("concurrent mutations retry their revision while retaining the other client's folder", async () => {
  const f = server(["/start"])
  f.state.beforeWrite = () => { f.state.record = { ...stored(["/start", "/other"]), revision: 2 }; f.state.beforeWrite = undefined }
  expect(await f.client().open("/ours")).toEqual(["/start", "/other", "/ours"])
  expect(f.state.writes).toBe(2)
})

test("legacy equivalent drive spellings stay readable; UNC case remains distinct", async () => {
  const f = server(["C:\\Repo", "c:/repo/", "\\\\wsl$\\Ubuntu\\Repo", "\\\\wsl$\\Ubuntu\\repo"])
  const folders = f.client()
  expect(await folders.read()).toEqual(["c:/repo/", "\\\\wsl$\\Ubuntu\\Repo", "\\\\wsl$\\Ubuntu\\repo"])
  expect(await folders.close("C:/REPO")).toEqual(["\\\\wsl$\\Ubuntu\\Repo", "\\\\wsl$\\Ubuntu\\repo"])
  expect(await folders.close("\\\\wsl$\\Ubuntu\\Repo")).toEqual(["\\\\wsl$\\Ubuntu\\repo"])
})

test("migration rejects a substituted acknowledgement", async () => {
  const f = server()
  f.state.wrongAck = true
  await expect(f.client().migrate(["/legacy"])).rejects.toThrow("Invalid working folders")
})

test("unbounded response streams are cancelled before their entire body is read", async () => {
  let cancelled = false
  let chunks = 0
  const folders = createWorkingFolders({
    url: new URL("https://synthetic.test"), headers: new Headers(),
    transport: async () => new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)) },
      cancel() { cancelled = true },
    })),
  })
  await expect(folders.read()).rejects.toThrow("Invalid working folders")
  expect(cancelled).toBe(true)
  expect(chunks).toBeLessThanOrEqual(4)
})
