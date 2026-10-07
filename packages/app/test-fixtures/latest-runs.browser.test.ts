import { expect, test, mock } from "bun:test"
import { plugin } from "bun"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

const [current, setCurrent] = createSignal<{ id: string } | undefined>({ id: "server-a" })
const navigations: string[] = []
const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
const requests: string[] = []
mock.module("@solidjs/router", () => ({ useNavigate: () => (path: string) => navigations.push(path) }))
mock.module("@/context/server", () => ({
  useServer: () => ({
    get current() {
      return current()
    },
  }),
}))
mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { automationsEnabled: () => true } }) }))
mock.module("@/context/global", () => ({
  useGlobal: () => ({
    ensureServerCtx: (server: { id: string }) => ({
      sdk: {
        client: {
          v2: {
            loop: {
              list: () => {
                requests.push(server.id)
                const deferred = pending.get(server.id)
                return deferred
                  ? deferred.promise
                  : Promise.resolve({ data: [{ id: `loop-${server.id}`, name: server.id }] })
              },
              run: {
                list: async () => ({
                  data: [
                    {
                      id: `run-${server.id}`,
                      status: "succeeded",
                      scheduledAt: 1000,
                      outputs: { result: { text: `output-${server.id}`, artifacts: [] } },
                    },
                  ],
                }),
              },
            },
          },
        },
      },
    }),
  }),
}))
const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "latest-runs-solid",
  setup(build) {
    build.onLoad({ filter: /pages[\\/]loops[\\/]latest-runs\.tsx$/ }, async (args) => {
      const result = await compiler.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset.default, { generate: "dom" }]],
      })
      return { contents: result?.code ?? "", loader: "tsx" }
    })
  },
})
const { LatestAutomationRuns } = await import("../src/pages/loops/latest-runs")
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

for (const layout of ["home", "overview"] as const) {
  test(`${layout} clears old runs during switching and opens only the new server's run`, async () => {
    pending.clear()
    setCurrent({ id: "server-a" })
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = render(() => createComponent(LatestAutomationRuns, { layout }), host)
    try {
      await tick()
      expect(host.textContent).toContain("server-a")
      const response = Promise.withResolvers<unknown>()
      pending.set("server-b", response)
      setCurrent({ id: "server-b" })
      await tick()
      expect(host.textContent).not.toContain("server-a")
      expect(host.querySelector('[data-action="latest-run-open"]')).toBeNull()
      response.resolve({ data: [{ id: "loop-server-b", name: "server-b" }] })
      await tick()
      expect(host.textContent).toContain("server-b")
      host.querySelector<HTMLButtonElement>('[data-action="latest-run-open"]')!.click()
      expect(navigations.at(-1)).toBe("/automations/loop-server-b?view=runs")
      setCurrent(undefined)
      await tick()
      expect(host.textContent).not.toContain("server-b")
    } finally {
      dispose()
      host.remove()
    }
  })
}

for (const fail of [false, true]) {
  test(`late prior-server ${fail ? "failure" : "success"} cannot overwrite current runs`, async () => {
    pending.clear()
    const response = Promise.withResolvers<unknown>()
    pending.set("server-a", response)
    setCurrent({ id: "server-a" })
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = render(() => createComponent(LatestAutomationRuns, { layout: "overview" }), host)
    try {
      await tick()
      setCurrent({ id: "server-b" })
      await tick()
      expect(host.textContent).toContain("server-b")
      if (fail) response.reject(new Error("old server unavailable"))
      else response.resolve({ data: [{ id: "loop-server-a", name: "server-a" }] })
      await tick()
      expect(host.textContent).toContain("server-b")
      expect(host.textContent).not.toContain("server-a")
    } finally {
      response.resolve({ data: [] })
      dispose()
      host.remove()
    }
  })
}
