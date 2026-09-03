import { expect, test } from "bun:test"
import path from "node:path"

test("shipped runtime source has no inherited OpenCode service endpoints", async () => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const files = await Array.fromAsync(
    new Bun.Glob("packages/{app,desktop,forge,server}/src/**/*.ts*").scan({ cwd: root, onlyFiles: true }),
  )
  const source = (await Promise.all(files.map((file) => Bun.file(path.join(root, file)).text()))).join("\n")

  expect(source).not.toContain("app.opencode.ai")
  expect(source).not.toContain("api.opencode.ai")
  expect(source).not.toContain("console.opencode.ai")
  expect(source).not.toContain("opncd.ai")
  expect(source).not.toContain("github.com/apps/opencode-agent")
  expect(source).not.toContain("discord.com/invite/opencode")
  expect(source).not.toContain("oc://renderer")
})
