import { expect, test } from "bun:test"
import path from "node:path"

test("TurenOS container packages headless runtime artifacts", async () => {
  const dockerfile = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text()

  expect(dockerfile).toContain("dist/forge-linux-x64-baseline-musl/bin/forge")
  expect(dockerfile).toContain("dist/forge-linux-arm64-musl/bin/forge")
  expect(dockerfile).toContain('ENTRYPOINT ["forge"]')
  expect(dockerfile).not.toContain("dist/opencode-")
  expect(dockerfile).not.toContain('["opencode"]')
})

test("TurenOS container build defaults never target the upstream registry", async () => {
  const root = path.resolve(import.meta.dir, "../../../..")
  const files = [
    "packages/containers/script/build.ts",
    "packages/containers/README.md",
    "packages/containers/bun-node/Dockerfile",
    "packages/containers/rust/Dockerfile",
    "packages/containers/tauri-linux/Dockerfile",
    "packages/containers/publish/Dockerfile",
  ]
  const source = (await Promise.all(files.map((file) => Bun.file(path.join(root, file)).text()))).join("\n")

  expect(source).not.toContain("ghcr.io/anomalyco")
  expect(source).toContain("ghcr.io/turenio")

  const env = { ...process.env }
  delete env.REGISTRY
  const result = Bun.spawnSync(["bun", "packages/containers/script/build.ts", "--push"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("REGISTRY is required when pushing TurenOS container images")
})
