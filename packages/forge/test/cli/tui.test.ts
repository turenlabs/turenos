import { expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../fixture/fixture"
import { tuiNativeDefines } from "../../script/tui"

test("compiled tui runs without Bun or node_modules and preserves client authentication", async () => {
  await using tmp = await tmpdir()
  const binary = path.join(tmp.path, process.platform === "win32" ? "forge.exe" : "forge")
  const built = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../src/index.ts")],
    compile: { outfile: binary },
    define: {
      FORGE_VERSION: '"test"',
      FORGE_CHANNEL: '"dev"',
      FORGE_MODELS_DEV: "{}",
      ...tuiNativeDefines({}),
    },
  })
  expect(built.success).toBe(true)
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: tmp.path,
      env: {
        PATH: "",
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }
  const help = await run(["tui", "--help"])
  expect(help.stderr).toBe("")
  expect(help.code).toBe(0)
  expect(help.stdout).toContain("Agent and script commands")
  expect((await run(["tui", "--version"])).code).toBe(0)
  const invalid = await run(["tui", "https://user:test-only-secret@example.com"])
  expect(invalid.code).toBe(1)
  expect(invalid.stderr).not.toContain("test-only-secret")
  expect((await run(["tui", "misspelled-command"])).code).toBe(2)

  const authorizations: (string | null)[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      authorizations.push(request.headers.get("authorization"))
      if (request.headers.get("authorization") !== `Basic ${btoa("forge:test-only-password")}`)
        return new Response("Unauthorized", { status: 401 })
      const route = new URL(request.url).pathname
      if (route === "/api/session/active") return Response.json({ data: {} })
      if (route === "/api/session") return Response.json({ data: [], cursor: {} })
      return new Response("Not found", { status: 404 })
    },
  })
  try {
    const listed = await run(["tui", "sessions", "--everywhere", "--json", "--url", server.url.href], {
      FORGE_SERVER_PASSWORD: "test-only-password",
    })
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout).sessions).toEqual([])
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations.every((value) => value === `Basic ${btoa("forge:test-only-password")}`)).toBe(true)
    expect(listed.stderr).not.toContain("test-only-password")
  } finally {
    server.stop(true)
  }
}, 60_000)

test("OpenTUI resolves the native library for the build target libc", async () => {
  await using tmp = await tmpdir()
  const entry = path.join(tmp.path, "renderer.ts")
  await Bun.write(
    entry,
    `import { createCliRenderer } from ${JSON.stringify(Bun.resolveSync("@opentui/core", path.dirname(fileURLToPath(import.meta.resolve("@turenlabs/tui")))))}; await createCliRenderer();`,
  )
  for (const abi of [undefined, "musl"] as const) {
    const built = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      define: {
        ...tuiNativeDefines({ abi }),
        "process.platform": '"linux"',
        "process.arch": '"x64"',
      },
      plugins: [
        {
          name: "native-selection",
          setup(build) {
            build.onResolve({ filter: /^@opentui\/core-(linux|darwin|win32)-/ }, (args) => {
              return { path: args.path, namespace: "native-selection" }
            })
            build.onLoad({ filter: /.*/, namespace: "native-selection" }, (args) => ({
              contents: `throw new Error(${JSON.stringify(`test-only-native:${args.path}`)}); export default '';`,
              loader: "js",
            }))
          },
        },
      ],
    })
    expect(built.success).toBe(true)
    const file = path.join(tmp.path, "native.js")
    await Bun.write(file, built.outputs[0])
    const child = Bun.spawn([process.execPath, file], {
      env: { OPENTUI_LIBC: "test-only-wrong-libc" },
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited).toBe(1)
    expect(stderr).toContain(`test-only-native:@opentui/core-linux-x64${abi === "musl" ? "-musl" : ""}`)
    if (abi === undefined) expect(stderr).not.toContain("test-only-native:@opentui/core-linux-x64-musl")
  }
}, 30_000)
