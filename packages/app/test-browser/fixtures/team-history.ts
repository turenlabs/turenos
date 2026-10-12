import assert from "node:assert/strict"
import { mock, spyOn } from "bun:test"
import { plugin } from "bun"
import { createComponent, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { ForgeClient } from "../../../sdk/js/src/v2/gen/sdk.gen"
import { createClient } from "@turenlabs/sdk/v2/gen/client"
import type { Team } from "@turenlabs/schema/team"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "team-history-fixture",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
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

const [provider, setProvider] = createStore({ connected: ["local"], name: "First model" })
const connection = { type: "sidecar", variant: "base" }
const { ServerConnection } = await import("@/context/server")
await mock.module("@/context/server", () => ({
  ServerConnection,
  useServer: () => ({ current: connection, key: "fixture" }),
}))
await mock.module("@/context/global", () => ({
  useGlobal: () => ({
    ensureServerCtx: () => ({
      sync: {
        data: {
          get provider() {
            return {
              connected: provider.connected,
              all: new Map([
                ["local", { models: { model: { id: "model", providerID: "local", name: provider.name } } }],
              ]),
            }
          },
        },
      },
    }),
  }),
}))
await mock.module("@/components/nav-rail", () => ({ useNavRail: () => ({ collapsed: () => true }) }))
await mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
// This fixture checks the page's ownership and refresh behavior, not rich-output rendering.
await mock.module("@/pages/team/message-content", () => ({
  TeamMessageContent: (props: { message: Team.Message }) => {
    const node = document.createElement("p")
    node.textContent = props.message.text
    return node
  },
}))

const rooms = [
  { id: "room-a", name: "First", topic: "Long factory", head: 2 },
  { id: "room-b", name: "Second", topic: "Other factory", head: 1 },
]
const messages: Team.Message[] = [
  { id: "message-a", roomID: "room-a", seq: 1, kind: "human", author: "Tom", text: "Keep this history", time: 1 },
  {
    id: "message-new",
    roomID: "room-a",
    seq: 2,
    kind: "system",
    author: "Factory",
    text: "New factory update",
    time: 2,
  },
  { id: "message-b", roomID: "room-b", seq: 1, kind: "human", author: "Tom", text: "Second room history", time: 3 },
]
const requests: URL[] = []
let failHistory = false
let failDuties = false
let settleDuties: ((response: Response) => void) | undefined
let settleOlder: ((response: Response) => void) | undefined
const snapshot = (roomID: string, selected: Team.Message[]): Team.State => ({
  room: rooms.find((room) => room.id === roomID)!,
  rooms,
  teammates: [],
  messages: selected,
  tasks: [],
  duties: [],
  factoryRuns: [],
  hasMore: true,
})
const client = new ForgeClient({
  client: createClient({
    baseUrl: "http://team.test",
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(new Request(input).url)
        requests.push(url)
        if (url.pathname === "/api/loop") {
          if (failDuties) return Response.json({ message: "Duties unavailable" }, { status: 500 })
          if (settleDuties) return Response.json({ data: [] })
          return new Promise<Response>((resolve) => {
            settleDuties = resolve
          })
        }
        if (url.pathname === "/api/team") {
          if (failHistory) return Response.json({ message: "History unavailable" }, { status: 500 })
          if (url.searchParams.has("before"))
            return new Promise<Response>((resolve) => {
              settleOlder = resolve
            })
          const roomID = url.searchParams.get("roomID")!
          return Response.json(
            snapshot(
              roomID,
              messages.filter(
                (message) =>
                  message.roomID === roomID &&
                  (url.searchParams.has("after")
                    ? message.seq > Number(url.searchParams.get("after"))
                    : message.seq === 1),
              ),
            ),
          )
        }
        return Response.json({ data: [] })
      },
      { preconnect() {} },
    ),
  }),
})
const [sdk, setSDK] = createSignal({ client, url: "http://team.test", scope: "fixture" })
await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => sdk }))

const intervals = new Map<number, () => void>()
let intervalID = 0
const interval = spyOn(window, "setInterval").mockImplementation((callback) => {
  assert.equal(typeof callback, "function")
  intervals.set(++intervalID, callback as () => void)
  return intervalID
})
const clearInterval = spyOn(window, "clearInterval").mockImplementation((id) => {
  intervals.delete(Number(id))
})
const { createMemoryHistory, MemoryRouter, Route } = await import("@solidjs/router")
const { default: TeamPage } = await import("@/pages/team")
const history = createMemoryHistory()
history.set({ value: "/team/room-a" })
const host = document.createElement("div")
document.body.append(host)
const dispose = render(
  () =>
    createComponent(MemoryRouter, {
      history,
      get children() {
        return createComponent(Route, { path: "/team/:roomID", component: TeamPage })
      },
    }),
  host,
)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await flush()
  }
  assert.fail(`${message}\n${host.textContent}`)
}
const log = () => host.querySelector<HTMLElement>('[aria-label="Room messages"]')!
const polls = () => intervals.forEach((callback) => callback())
const historyRequests = () => requests.filter((url) => url.pathname === "/api/team").length

try {
  await until(() => !!log()?.textContent?.includes("Keep this history"), "History waited for unrelated duties")
  const original = log().querySelector("article")!
  log().scrollTop = 120
  const beforeCatalogue = historyRequests()
  setProvider("name", "Updated model")
  setProvider("connected", [])
  await flush()
  assert.equal(historyRequests(), beforeCatalogue, "Catalogue update reloaded room history")
  assert.equal(log().querySelector("article"), original, "Catalogue update remounted history")
  assert.equal(log().scrollTop, 120, "Catalogue update reset scroll")

  polls()
  await until(() => !!log().textContent?.includes("New factory update"), "Pending duties blocked new messages")
  assert.equal(log().querySelector("article"), original, "Incremental poll remounted unchanged history")
  settleDuties?.(Response.json({ data: [] }))
  await flush()
  failDuties = true
  failHistory = true
  polls()
  await until(() => !!host.textContent?.includes("History unavailable"), "Missing refresh error")
  assert.equal(log().querySelector("article"), original, "Failed refresh removed history")
  failHistory = false
  polls()
  await until(() => !host.textContent?.includes("History unavailable"), "History did not recover")

  const older = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Load older messages",
  )!
  older.click()
  await until(() => !!settleOlder, "Older request did not start")
  history.set({ value: "/team/room-b" })
  await until(() => !!log().textContent?.includes("Second room history"), "Room switch did not load")
  assert.ok(!log().textContent?.includes("Keep this history"), "Room switch exposed previous history")
  settleOlder?.(
    Response.json(snapshot("room-a", [{ ...messages[0]!, id: "stale", text: "Stale older response", seq: 0 }])),
  )
  await flush()
  assert.ok(!log().textContent?.includes("Stale older response"), "Stale response crossed room ownership")

  setSDK({ client, url: "http://team.test", scope: "fixture" })
  await until(() => !!log().textContent?.includes("Second room history"), "SDK refresh did not recover")
  console.log("Team history checks passed")
} finally {
  dispose()
  interval.mockRestore()
  clearInterval.mockRestore()
  host.remove()
}
