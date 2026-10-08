import assert from "node:assert/strict"
import { plugin } from "bun"
import { createComponent, createRoot } from "solid-js"
import { createWorkingFolders } from "@turenlabs/client/working-folders"
import type { Platform } from "@/context/platform"
// Bun does not compile Solid JSX. Use the app's existing JSX compiler so this
// fixture runs the real context providers, tab actions, and persistence layer.
const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "solid-context-fixture",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const result = await compiler.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset.default, { generate: "dom" }]],
      })
      return { contents: result.code, loader: "tsx" }
    })
  },
})

const { PlatformProvider } = await import("@/context/platform")
const { ServerConnection, ServerProvider, useServer } = await import("@/context/server")

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 350; attempt++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("Working-folder update did not arrive")
}

for (const desktop of [false, true]) {
  {
    const url = `https://${desktop ? "desktop" : "web"}-folders.test`
    const key = ServerConnection.Key.make(url)
    const legacy = JSON.stringify({
      list: [],
      projects: { [key]: [{ worktree: "/legacy", expanded: false }] },
      lastProject: {},
      recentlyClosed: {},
    })
    localStorage.setItem("forge.global.dat:server", legacy)
    const saved = new Map([["server", legacy]])
    let record:
      | { scope: string; key: string; value: string; revision: number; timeCreated: number; timeUpdated: number }
      | undefined
    const fetcher = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== "PUT") return Response.json({ state: record ?? null })
        const body = JSON.parse(String(init.body)) as {
          scope: string
          key: string
          value: string
          expectedRevision: number | null
        }
        if (body.expectedRevision !== (record?.revision ?? null)) return new Response("", { status: 409 })
        record = { ...body, revision: (record?.revision ?? 0) + 1, timeCreated: 1, timeUpdated: 1 }
        return Response.json(record)
      },
      { preconnect() {} },
    )
    const platform: Platform = {
      ...(desktop
        ? {
            platform: "desktop" as const,
            async openDirectoryPickerDialog() {
              return null
            },
          }
        : { platform: "web" as const }),
      openLink() {},
      async restart() {},
      back() {},
      forward() {},
      async notify() {},
      fetch: fetcher,
      storage: () => ({
        async getItem(name: string) {
          return saved.get(name) ?? null
        },
        async setItem(name: string, value: string) {
          saved.set(name, value)
        },
        async removeItem(name: string) {
          saved.delete(name)
        },
      }),
    }
    let server: ReturnType<typeof useServer> | undefined
    const dispose = createRoot((dispose) => {
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return createComponent(ServerProvider, {
            defaultServer: key,
            servers: [{ type: "http", http: { url } }],
            get children() {
              server = useServer()
              return null
            },
          })
        },
      })
      return dispose
    })
    try {
      const tui = createWorkingFolders({ url: new URL(url), headers: new Headers(), transport: fetcher })
      await until(() => !!server && !!record)
      assert.deepEqual(await tui.read(), ["/legacy"])
      await tui.open("/terminal")
      await until(() => server!.projects.list().some((project) => project.worktree === "/terminal"))
      assert.deepEqual(server!.projects.list()[0], { worktree: "/legacy", expanded: false })
      server!.projects.close("/terminal")
      await until(() => !!record && !JSON.parse(record.value).directories.includes("/terminal"))
      assert.deepEqual(await tui.read(), ["/legacy"])
      assert.ok(server!.projects.recentlyClosed().includes("/terminal"))
    } finally {
      dispose()
      localStorage.removeItem("forge.global.dat:server")
    }
  }
}

console.log("working folder provider checks passed")
