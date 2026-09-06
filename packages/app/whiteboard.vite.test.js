import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { createServer, request } from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { whiteboardPlugin } from "./whiteboard.vite.js"

const root = path.resolve(path.dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")), "../..")
const plugin = whiteboardPlugin()
const transpiler = new Bun.Transpiler({ loader: "js" })
const loads = []
plugin.config().optimizeDeps.esbuildOptions.plugins[0].setup({
  onLoad: (options, load) => loads.push({ options, load }),
})

for (const mode of ["dev", "prod"]) {
  test(`removes only the installed ${mode} font fallback and keeps valid JavaScript`, () => {
    const dir = path.join(root, "dist", mode)
    const modules = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".js"))
      .map((file) => path.join(file.parentPath, file.name))
      .map((id) => ({ id, code: readFileSync(id, "utf8") }))
      .filter((module) => module.code.includes("ASSETS_FALLBACK_URL"))
    expect(modules.length).toBeGreaterThan(0)
    for (const module of modules) {
      const result = plugin.transform(module.code, module.id)
      expect(result).toBeDefined()
      expect(loads[0].options.filter.test(module.id)).toBe(true)
      expect(loads[0].load({ path: module.id })).toEqual({
        contents: result.code,
        loader: "js",
        resolveDir: path.dirname(module.id),
      })
      expect(loads[0].load({ path: "/unrelated/dist/index.js" })).toBeUndefined()
      // The CDN declaration stays intact; only the call using it is gone.
      expect(result.code.split("ASSETS_FALLBACK_URL").length).toBe(module.code.split("ASSETS_FALLBACK_URL").length - 1)
      expect(result.code).toContain("ASSETS_FALLBACK_URL")
      expect(result.code).toContain("EXCALIDRAW_ASSET_PATH")
      expect(() => transpiler.transformSync(result.code)).not.toThrow()
    }
  })
}

test("transform fails closed, remains package-scoped, and keeps prebundling", () => {
  const id = path.join(root, "dist/prod/index.js")
  expect(() => plugin.transform("fonts.add(Font.ASSETS_FALLBACK_URL)", id)).toThrow("Unrecognized")
  expect(plugin.transform("fonts.add(Font.ASSETS_FALLBACK_URL)", "/src/app.js")).toBeUndefined()
  expect(plugin.transform("new URL(baseUrl, location.origin)", id)).toBeUndefined()
  expect(plugin.transform("new URL(baseUrl, location.origin)", "/src/app.js")).toBeUndefined()
  expect(plugin.transform("fonts.add(Font.ASSETS_FALLBACK_URL)", id + ".map")).toBeUndefined()
  expect(plugin.config().optimizeDeps.exclude).toBeUndefined()
  expect(plugin.config().optimizeDeps.include).toContain("@excalidraw/excalidraw")
  expect(plugin.config().resolve.dedupe).toEqual(["react", "react-dom"])
  expect(
    plugin.transform("Font.ASSETS_FALLBACK_URL", "/node_modules/.vite/deps/@excalidraw_excalidraw.js"),
  ).toBeUndefined()
  expect(plugin.transform("$a.push(new URL($b, $Font.ASSETS_FALLBACK_URL))", id).code).toBe("void 0")
  const code = "const unrelated = new URL(asset, origin); urls.push(new URL(asset, Font.ASSETS_FALLBACK_URL));"
  expect(plugin.transform(code, id + "?v=123").code).toBe("const unrelated = new URL(asset, origin); void 0;")
  expect(plugin.transform("const result = (a.push(new URL(b,c.ASSETS_FALLBACK_URL)), a)", id).code).toBe(
    "const result = (void 0, a)",
  )
})

test("optimizer links the installed editor and its CommonJS dependencies into browser ESM", async () => {
  const { build } = createRequire(createRequire(import.meta.url).resolve("vite"))("esbuild")
  const result = await build({
    ...plugin.config().optimizeDeps.esbuildOptions,
    entryPoints: [path.join(root, "dist/dev/index.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["browser", "development"],
    define: { "process.env.NODE_ENV": '"development"' },
    loader: { ".woff2": "file", ".ttf": "file", ".wasm": "file" },
    outdir: "whiteboard-test-output",
    write: false,
    metafile: true,
    logLevel: "silent",
  })
  expect(Object.keys(result.metafile.inputs).some((id) => id.includes("es6-promise-pool"))).toBe(true)
  const output = result.outputFiles.find((file) => path.basename(file.path) === "index.js")
  expect(output).toBeDefined()
  expect(() => transpiler.transformSync(output.text)).not.toThrow()
  expect(
    Object.values(result.metafile.outputs)
      .flatMap((file) => file.imports)
      .filter((item) => item.external),
  ).toEqual([])
  expect(output.text).toContain("ASSETS_FALLBACK_URL")
  // The optimizer emits outside the package root, so Vite does not patch twice.
  expect(plugin.transform(output.text, output.path)).toBeUndefined()
}, 30000)

const emitted = []
plugin.generateBundle.call({ emitFile: (asset) => emitted.push(asset) })
const font = emitted.find((asset) => asset.fileName.endsWith(".woff2"))

test("build emits the complete installed font tree, byte-for-byte, and upstream notice", () => {
  const dir = path.join(root, "dist/prod/fonts")
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((file) => file.isFile())
  expect(emitted.filter((asset) => asset.fileName.startsWith("excalidraw/fonts/"))).toHaveLength(files.length)
  for (const file of files) {
    const source = path.join(file.parentPath, file.name)
    const name = "excalidraw/fonts/" + path.relative(dir, source).replaceAll("\\", "/")
    expect(emitted.find((asset) => asset.fileName === name)?.source).toEqual(readFileSync(source))
  }
  expect(emitted.find((asset) => asset.fileName === "excalidraw/README.md")?.source).toEqual(
    readFileSync(path.join(root, "README.md")),
  )
  expect(emitted.find((asset) => asset.fileName === "excalidraw/FONT-NOTICES.txt")?.source).toEqual(
    readFileSync(new URL("./excalidraw-fonts-NOTICES.txt", import.meta.url)),
  )
})

// Exercise the actual middleware over HTTP, preserving raw traversal paths.
const server = createServer()
plugin.configResolved({ base: "/nested/" })
plugin.configureServer({
  middlewares: {
    use: (middleware) =>
      server.on("request", (req, res) =>
        middleware(req, res, () => {
          res.statusCode = 418
          res.end()
        }),
      ),
  },
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
afterAll(() => new Promise((resolve) => server.close(resolve)))

function get(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: server.address().port, path: url, method }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("font middleware", () => {
  test("GET/HEAD serve exact assets under the configured base with font MIME", async () => {
    const response = await get("/nested/" + font.fileName + "?cache=1")
    expect(response.status).toBe(200)
    expect(response.headers["content-type"]).toBe("font/woff2")
    expect(response.body).toEqual(font.source)
    const head = await get("/nested/" + font.fileName, "HEAD")
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    expect(Number(head.headers["content-length"])).toBe(font.source.length)
    expect((await get("/nested/" + font.fileName.replace("fonts/", "%66onts/"))).status).toBe(200)
    expect((await get("/nested/" + font.fileName, "POST")).status).toBe(405)
  })

  test("rejects traversal, malformed encoding, and non-whitelisted paths", async () => {
    for (const suffix of [
      "fonts/../../package.json",
      "fonts/%2e%2e/%2e%2e/package.json",
      "fonts/%252e%252e/package.json",
      "fonts/%2e%2e%5cpackage.json",
      "fonts/%00",
      "fonts/%E0%A4%A",
      "fonts/missing.woff2",
      "package.json",
    ])
      expect((await get("/nested/excalidraw/" + suffix)).status).toBe(404)
    expect((await get("/unrelated-api")).status).toBe(418)
  })
})
