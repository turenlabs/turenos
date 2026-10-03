import { afterEach, expect, test } from "bun:test"
import { connect } from "../src/server"
import { folderContains } from "../src/working-folders"

test("working folders include nested directories but not prefix siblings", () => {
  expect(folderContains("/srv/repo", "/srv/repo/package")).toBe(true)
  expect(folderContains("/srv/repo/", "/srv/repo")).toBe(true)
  expect(folderContains("/srv/repo", "/srv/repository")).toBe(false)
  expect(folderContains("/", "/srv/repo")).toBe(true)
  expect(folderContains("C:\\Repo", "c:/repo/package")).toBe(true)
  expect(folderContains("C:\\Repo", "C:\\Repo-other")).toBe(false)
})

const scope = "desktop/store/working-folders"
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop()))
})

function stored(directories: string[], revision = 1) {
  return {
    scope,
    key: "open",
    value: JSON.stringify({ version: 1, directories }),
    revision,
    timeCreated: 1,
    timeUpdated: 1,
  }
}

function fixture(initial: ReturnType<typeof stored> | null = null) {
  const control = {
    state: initial,
    status: 200,
    putStatus: 200,
    gets: 0,
    puts: [] as { scope: string; key: string; value: string; expectedRevision: number | null }[],
    auth: [] as (string | null)[],
    get: undefined as (() => Response | Promise<Response>) | undefined,
    conflict: undefined as (() => void) | undefined,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/global/storage") {
        const routes: Record<string, unknown> = {
          "/api/location": { directory: "/srv/project", project: { id: "project", directory: "/srv/project" } },
          "/api/session": { data: [], cursor: {} },
          "/api/session/active": { data: {} },
          "/api/pty": { location: { directory: url.searchParams.get("location[directory]") }, data: [] },
          "/api/loop": [],
        }
        return Response.json(routes[url.pathname] ?? null)
      }
      control.auth.push(request.headers.get("authorization"))
      if (request.method === "GET") {
        control.gets++
        expect(url.searchParams.get("scope")).toBe(scope)
        expect(url.searchParams.get("key")).toBe("open")
        if (control.get) return control.get()
        if (control.status !== 200) return new Response(null, { status: control.status })
        return Response.json({ state: control.state })
      }
      const body = await request.json()
      control.puts.push(body)
      expect(request.method).toBe("PUT")
      expect(body.scope).toBe(scope)
      expect(body.key).toBe("open")
      expect(Object.keys(body).sort()).toEqual(["expectedRevision", "key", "scope", "value"])
      if (control.putStatus !== 200) return new Response(null, { status: control.putStatus })
      if (control.status !== 200) return new Response(null, { status: control.status })
      control.conflict?.()
      if (body.expectedRevision !== (control.state?.revision ?? null)) return new Response(null, { status: 409 })
      control.state = { ...stored([], (control.state?.revision ?? 0) + 1), value: body.value }
      return Response.json(control.state)
    },
  })
  const connection = connect({ url: server.url.href, username: "operator", password: "test-only" })
  cleanup.push(async () => {
    connection.close()
    await server.stop(true)
  })
  return { control, connection }
}

test("missing reads never write; explicit open creates only its directory", async () => {
  const { connection, control } = fixture()
  expect(await connection.folders.read()).toBeUndefined()
  expect(control.puts).toEqual([])
  expect(await connection.folders.open("/one")).toEqual(["/one"])
  expect(control.puts[0]?.expectedRevision).toBeNull()
  expect(control.auth.every((value) => value === `Basic ${Buffer.from("operator:test-only").toString("base64")}`)).toBe(
    true,
  )
})

test("explicit close seeds empty; authoritative empty reads remain empty", async () => {
  const { connection, control } = fixture()
  expect(await connection.folders.close("/absent")).toEqual([])
  expect(control.puts[0]?.expectedRevision).toBeNull()
  expect(await connection.folders.read()).toEqual([])
  await connection.folders.close("/absent")
  expect(control.puts).toHaveLength(1)
})

test("operations preserve exact strings/order and serialize local intents", async () => {
  const paths = ["/z/../z", "C:\\Work", "//host/share", "/space here/"]
  const { connection, control } = fixture(stored(paths))
  const read = await connection.folders.read()
  read?.push("/not-shared")
  expect(connection.folders.current()).toEqual(paths)
  await Promise.all([
    connection.folders.open("/new"),
    connection.folders.close("C:\\Work"),
    connection.folders.open("/last"),
  ])
  expect(await connection.folders.read()).toEqual([paths[0]!, paths[2]!, paths[3]!, "/new", "/last"])
  await connection.folders.open("/new")
  expect(control.puts).toHaveLength(3)
})

for (const operation of ["open", "close"] as const) {
  test(`${operation} replays after conflict without losing a concurrent different folder`, async () => {
    const { connection, control } = fixture(stored(["/base"]))
    control.conflict = () => {
      control.conflict = undefined
      control.state = stored(["/base", "/gui"], 2)
    }
    const directory = operation === "open" ? "/tui" : "/base"
    expect(await connection.folders[operation](directory)).toEqual(
      operation === "open" ? ["/base", "/gui", "/tui"] : ["/gui"],
    )
    expect(control.puts.map((item) => item.expectedRevision)).toEqual([1, 2])
  })
}

test("create-only conflict retains GUI's first seed", async () => {
  const { connection, control } = fixture()
  control.conflict = () => {
    control.conflict = undefined
    control.state = stored(["/legacy"], 1)
  }
  expect(await connection.folders.open("/tui")).toEqual(["/legacy", "/tui"])
  expect(control.puts.map((item) => item.expectedRevision)).toEqual([null, 1])
})

test("conflicts stop after four attempts and do not poison the mutation queue", async () => {
  const { connection, control } = fixture(stored([]))
  control.conflict = () => {
    control.state = stored(["/gui"], control.state!.revision + 1)
  }
  await expect(connection.folders.open("/tui")).rejects.toThrow()
  expect(control.puts).toHaveLength(4)
  expect(control.gets).toBe(4)
  control.conflict = undefined
  expect(await connection.folders.open("/next")).toEqual(["/gui", "/next"])
})

for (const value of [
  "not-json",
  JSON.stringify({ version: 2, directories: [] }),
  JSON.stringify({ version: 1, directories: [], selected: "/a" }),
  JSON.stringify({ version: 1, directories: ["/a", "/a"] }),
  JSON.stringify({ version: 1, directories: [""] }),
  JSON.stringify({ version: 1, directories: ["relative"] }),
  JSON.stringify({ version: 1, directories: ["/a\n"] }),
  JSON.stringify({ version: 1, directories: ["/\u001b[0m"] }),
  JSON.stringify({ version: 1, directories: ["/" + "x".repeat(4096)] }),
  JSON.stringify({ version: 1, directories: Array.from({ length: 257 }, (_, i) => `/d${i}`) }),
  JSON.stringify({ version: 1, directories: Array.from({ length: 256 }, (_, i) => `/${i}${"é".repeat(3000)}`) }),
]) {
  test(`rejects malformed shared value ${value.slice(0, 65)}`, async () => {
    const { connection, control } = fixture({ ...stored([]), value })
    await expect(connection.folders.read()).rejects.toThrow()
    await expect(connection.folders.open("/safe")).rejects.toThrow()
    expect(control.puts).toHaveLength(0)
  })
}

test("rejects mismatched State identity and invalid revisions", async () => {
  const { connection, control } = fixture()
  for (const change of [
    { scope: "desktop/store/other" },
    { key: "other" },
    { revision: -1 },
    { revision: 1.5 },
    { timeUpdated: -1 },
  ]) {
    control.state = { ...stored([]), ...change }
    await expect(connection.folders.read()).rejects.toThrow()
  }
})

test("non-conflict PUT failures are not retried and retain the last good list", async () => {
  const { connection, control } = fixture(stored(["/good"]))
  control.putStatus = 500
  await expect(connection.folders.open("/new")).rejects.toThrow()
  expect(control.puts).toHaveLength(1)
  expect(control.gets).toBe(1)
  expect(connection.folders.current()).toEqual(["/good"])
  control.putStatus = 200
  expect(await connection.folders.open("/next")).toEqual(["/good", "/next"])
})

test("invalid explicit directories and capacity overflow never write", async () => {
  const { connection, control } = fixture(stored(Array.from({ length: 256 }, (_, i) => `/d${i}`)))
  await expect(connection.folders.open("relative")).rejects.toThrow()
  await expect(connection.folders.close("/bad\n")).rejects.toThrow()
  expect(control.gets).toBe(0)
  await expect(connection.folders.open("/overflow")).rejects.toThrow()
  expect(control.puts).toHaveLength(0)
})

test("malformed envelopes and oversized HTTP bodies do not replace cached folders", async () => {
  const { connection, control } = fixture(stored(["/good"]))
  await connection.folders.read()
  control.get = () => Response.json({ directories: [] })
  await expect(connection.folders.read()).rejects.toThrow()
  control.get = () => new Response("x".repeat(8 * 1024 * 1024 + 1))
  await expect(connection.folders.read()).rejects.toThrow()
  expect(connection.folders.current()).toEqual(["/good"])
  expect(control.puts).toHaveLength(0)
})

for (const status of [401, 403, 404, 500]) {
  test(`folder HTTP ${status} retains last good snapshot without failing other inventories`, async () => {
    const { connection, control } = fixture(stored(["/good"]))
    expect((await connection.snapshot()).workingFolders).toEqual(["/good"])
    control.status = status
    const snapshot = await connection.snapshot()
    expect(snapshot.workingFolders).toEqual(["/good"])
    expect(snapshot.folderError).toBeTruthy()
    expect(snapshot.inventoryErrors).toEqual({ terminals: "", automations: "" })
    expect(snapshot.sessions).toEqual([])
    const before = control.gets
    await expect(connection.folders.open("/no-write")).rejects.toThrow()
    expect(control.gets).toBe(before + 1)
    expect(control.puts).toHaveLength(0)
    control.status = 200
    control.state = stored([], 2)
    expect((await connection.snapshot()).folderError).toBeUndefined()
    expect(connection.folders.current()).toEqual([])
  })
}

for (const stale of [null, stored(["/old"], 1)]) {
  test(`late ${stale ? "old revision" : "missing"} GET cannot replace a successful write`, async () => {
    const { connection, control } = fixture(stored(["/old"], 1))
    let release!: (response: Response) => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    control.get = () => {
      control.get = undefined
      started()
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }
    const pending = connection.folders.read()
    await ready
    await connection.folders.open("/new")
    release(Response.json({ state: stale }))
    expect(await pending).toEqual(["/old", "/new"])
    expect(connection.folders.current()).toEqual(["/old", "/new"])
  })
}

test("out-of-order GETs retain the highest observed revision", async () => {
  const { connection, control } = fixture(stored(["/new"], 5))
  let release!: (response: Response) => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  control.get = () => {
    control.get = undefined
    started()
    return new Promise<Response>((resolve) => {
      release = resolve
    })
  }
  const pending = connection.folders.read()
  await ready
  expect(await connection.folders.read()).toEqual(["/new"])
  release(Response.json({ state: stored(["/old"], 4) }))
  expect(await pending).toEqual(["/new"])
})

test("folder requests reject redirects and connection shutdown aborts subsequent reads", async () => {
  let redirected = false
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      redirected = true
      return Response.json({ state: null })
    },
  })
  cleanup.push(async () => target.stop(true))
  const { connection, control } = fixture()
  control.get = () => Response.redirect(target.url.href)
  await expect(connection.folders.read()).rejects.toThrow()
  expect(redirected).toBe(false)
  control.get = undefined
  connection.close()
  await expect(connection.folders.read()).rejects.toThrow()
})
