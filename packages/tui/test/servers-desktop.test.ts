import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createDesktopAttach } from "../../desktop/src/main/desktop-attach"
import { local, open, scratch, server } from "./servers-fixture"

const apps = ["com.turenlabs.forge", "com.turenlabs.forge.beta", "com.turenlabs.forge.dev"]

test.each(["darwin", "linux", "win32"] as const)(
  "discovers and authenticates desktop-published records on %s",
  async (platform) => {
    const home = await scratch()
    const config = join(home, "config")
    const appData = join(home, "AppData", "Roaming")
    const root =
      platform === "darwin" ? join(home, "Library", "Application Support") : platform === "linux" ? config : appData
    const servers = local(home, { platform, env: { XDG_CONFIG_HOME: config, APPDATA: appData } })
    const listener = server()
    await servers.load()
    expect(await servers.preferred()).toBeUndefined()

    for (const app of apps) {
      const directory = join(root, app)
      await mkdir(directory, { recursive: true })
      const attach = createDesktopAttach(directory, (message) => {
        throw new Error(message)
      })
      attach.publish({ url: listener.url.origin, username: "forge", password: "secret" })
      const target = await servers.preferred()
      expect(target?.id).toBe(`desktop:${app}`)
      expect(servers.problems()).toEqual([])
      const endpoint = await open(servers, target!)
      expect(endpoint.url).toBe(listener.url.origin)
      expect(endpoint.version).toBe("1.0.32")
      expect(await servers.trusts(listener.url.origin)).toBe(true)
      attach.clear()
      expect(await servers.preferred()).toBeUndefined()
      expect(await servers.trusts(listener.url.origin)).toBe(false)
    }
  },
)

test("republished desktop records connect to the replacement server", async () => {
  const home = await scratch()
  const directory = join(home, "Library", "Application Support", apps[0]!)
  await mkdir(directory, { recursive: true })
  const attach = createDesktopAttach(directory, (message) => {
    throw new Error(message)
  })
  const servers = local(home)
  const first = server("first-secret")
  attach.publish({ url: first.url.origin, username: "forge", password: "first-secret" })
  expect((await open(servers, (await servers.preferred())!)).url).toBe(first.url.origin)
  attach.clear()
  first.stop(true)
  expect(await servers.preferred()).toBeUndefined()
  const replacement = server("new-secret")
  attach.publish({ url: replacement.url.origin, username: "forge", password: "new-secret" })
  const endpoint = await open(servers, (await servers.preferred())!)
  expect(endpoint.url).toBe(replacement.url.origin)
  expect(endpoint.password).toBe("new-secret")
  attach.clear()
})
