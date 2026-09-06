import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Self-host the pinned editor's fonts and use sandbox-compatible downloads. */
export function whiteboardPlugin() {
  const entry = createRequire(import.meta.url).resolve("@excalidraw/excalidraw")
  const root = path.resolve(path.dirname(entry), "../..")
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  if (manifest.version !== "0.18.1")
    throw new Error("Review the Excalidraw font fallback transform before upgrading 0.18.1")
  const dist = path.join(root, "dist").replaceAll("\\", "/") + "/"
  const download = fileURLToPath(new URL("./src/components/whiteboard/download.ts", import.meta.url))
  const fileAccess = createRequire(entry).resolve("browser-fs-access")
  const adapterID = "\0forge:whiteboard-file-access"
  const adapter = `export { fileOpen, directoryOpen, supported } from ${JSON.stringify(fileAccess)};
export { fileSave } from ${JSON.stringify(download)};`
  const fonts = path.join(root, "dist/prod/fonts")
  const files = new Map(
    readdirSync(fonts, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => {
        const source = path.join(file.parentPath, file.name)
        return ["excalidraw/fonts/" + path.relative(fonts, source).replaceAll("\\", "/"), source]
      }),
  )
  files.set("excalidraw/README.md", path.join(root, "README.md"))
  files.set("excalidraw/FONT-NOTICES.txt", fileURLToPath(new URL("./excalidraw-fonts-NOTICES.txt", import.meta.url)))
  const state = { base: "/" }

  return {
    name: "forge:whiteboard-fonts",
    enforce: "pre",
    config() {
      // Keep CommonJS interop for the editor's dependencies while applying the
      // same patches before esbuild creates the development bundle.
      return {
        resolve: { dedupe: ["react", "react-dom"] },
        optimizeDeps: {
          include: [
            "@excalidraw/excalidraw",
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
          ],
          esbuildOptions: {
            plugins: [
              {
                name: "forge:whiteboard-fonts",
                setup(build) {
                  build.onResolve({ filter: /^browser-fs-access$/ }, (args) => {
                    if (args.importer.replaceAll("\\", "/").startsWith(dist))
                      return { path: adapterID, namespace: "whiteboard-file-access" }
                  })
                  build.onLoad({ filter: /.*/, namespace: "whiteboard-file-access" }, () => ({
                    contents: adapter,
                    loader: "js",
                    resolveDir: root,
                  }))
                  build.onLoad({ filter: /[\\/]dist[\\/].*\.js$/ }, (args) => {
                    if (!args.path.replaceAll("\\", "/").startsWith(dist)) return
                    return {
                      contents: stripFontFallback(readFileSync(args.path, "utf8"), args.path),
                      loader: "js",
                      resolveDir: path.dirname(args.path),
                    }
                  })
                },
              },
            ],
          },
        },
      }
    },
    configResolved(config) {
      state.base = new URL(config.base, "http://vite.local/").pathname
    },
    resolveId(source, importer) {
      if (source === "browser-fs-access" && importer?.replaceAll("\\", "/").startsWith(dist)) return adapterID
    },
    load(id) {
      if (id === adapterID) return adapter
    },
    transform(code, id) {
      const filename = id.split("?", 1)[0].replaceAll("\\", "/")
      if (!filename.startsWith(dist) || !filename.endsWith(".js") || !code.includes("ASSETS_FALLBACK_URL")) return
      return { code: stripFontFallback(code, id), map: null }
    },
    generateBundle() {
      for (const [fileName, source] of files) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(source) })
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const raw = (request.url ?? "").split("?", 1)[0]
        if (!raw.startsWith(state.base + "excalidraw/")) return next()
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405
          response.setHeader("Allow", "GET, HEAD")
          return response.end()
        }
        // Decode without URL normalization so dot segments cannot disappear.
        const name = decodeAssetPath(raw.slice(state.base.length))
        const source = name && files.get(name)
        if (!source) {
          response.statusCode = 404
          return response.end()
        }
        const bytes = readFileSync(source)
        response.setHeader("Content-Type", fontMime(path.extname(source)))
        response.setHeader("Content-Length", bytes.length)
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.end(request.method === "HEAD" ? undefined : bytes)
      })
    },
  }
}

function stripFontFallback(code, id) {
  if (!code.includes("ASSETS_FALLBACK_URL")) return code
  // 0.18.1 adds a CDN URL even when EXCALIDRAW_ASSET_PATH is set. Replace
  // only that push, with an expression valid in both dev and minified code.
  const result = code.replace(
    /(?<![$\w.])[$A-Z_a-z][$\w]*\.push\(\s*new URL\(\s*[$A-Z_a-z][$\w]*\s*,\s*[$A-Z_a-z][$\w]*\.ASSETS_FALLBACK_URL\s*\)\s*\)/g,
    "void 0",
  )
  if (result === code) throw new Error(`Unrecognized Excalidraw font fallback in ${id}`)
  return result
}

function decodeAssetPath(raw) {
  try {
    const name = decodeURIComponent(raw)
    if (name.includes("\\") || name.includes("\0") || name.split("/").some((part) => part === "." || part === ".."))
      return
    return name
  } catch {
    return
  }
}

function fontMime(extension) {
  return (
    {
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/plain; charset=utf-8",
    }[extension] ?? "application/octet-stream"
  )
}
