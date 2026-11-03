import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { folderContains, inFolder, resolveFolder } from "../src/working-folders"

import { connect } from "../src/server"
import { turen, cleanup } from "./support"

test.skipIf(process.platform === "win32")(
  "local folder aliases include sessions and project worktrees without changing remote identity",
  async () => {
    const root = await mkdtemp("/tmp/turen-paths-")
    try {
      await mkdir(join(root, "repo"))
      await symlink(join(root, "repo"), join(root, "alias"))
      const canonical = await realpath(join(root, "repo"))
      const server = turen({
        routes: {
          "GET /api/location": (_, url) => ({
            directory: url.searchParams.get("location[directory]"),
            project: { id: "p", directory: canonical },
          }),
          "GET /api/fs/list": (_, url) => ({
            location: { directory: url.searchParams.get("location[directory]") },
            data: [],
          }),
        },
      })
      const connection = connect({ url: server.url, local: true })
      cleanup.push(connection.close)
      expect((await resolveFolder(connection.client, join(root, "alias"), connection.local)).directory).toBe(canonical)
      expect((await resolveFolder(connection.client, join(root, "alias"))).directory).toBe(join(root, "alias"))
      const folder = { directory: join(root, "alias"), local: true, project: { id: "p", directory: canonical } }
      expect(inFolder(folder, { projectID: "p", location: { directory: canonical } })).toBe(true)
      expect(inFolder(folder, { projectID: "p", location: { directory: "/elsewhere/worktree" } })).toBe(true)
      expect(inFolder({ ...folder, local: false }, { projectID: "p", location: { directory: canonical } })).toBe(false)
      expect(folderContains(join(root, "alias"), canonical, true)).toBe(true)
      expect(folderContains(join(root, "alias"), canonical)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "darwin")("discovery works without system utilities on PATH", async () => {
  const home = await mkdtemp("/tmp/turen-discovery-")
  try {
    const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "attach.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        url: "http://127.0.0.1:12345",
        username: "forge",
        password: "synthetic",
      }),
      { mode: 0o600 },
    )
    const script = `import {createServers} from ${JSON.stringify(new URL("../src/servers.ts", import.meta.url).href)}; console.log((await createServers({home:process.env.TEST_HOME,forge:null}).scan()).map(x=>x.target.kind).join(","))`
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PATH: "/nonexistent", TEST_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(output.trim()).toBe("desktop")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
