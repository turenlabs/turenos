import assert from "node:assert/strict"
import { mock } from "bun:test"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { base64Encode } from "@turenlabs/core/util/encode"
import type { Session } from "@turenlabs/sdk/v2/client"
import { createHomeSessionIndexCache } from "@/context/global-sync/home-session-index"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "timeline-session-menu-fixture",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const path =
        /[\\/]message-timeline\.tsx$/.test(args.path) && process.env.TIMELINE_BASE_SOURCE
          ? process.env.TIMELINE_BASE_SOURCE
          : args.path
      const result = await compiler.transformAsync(await Bun.file(path).text(), {
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

const operation = process.argv[2]
const failure = process.argv[3] === "failure"
assert.ok(operation === "archive" || operation === "delete")
const { ServerConnection } = await import("@/context/server")
const routeServer = { type: "http" as const, http: { url: "https://route-server.test" } }
const routeKey = ServerConnection.key(routeServer)
const now = Date.now()
const session: Session = {
  id: "ses_parent",
  slug: "ses_parent",
  projectID: "project",
  directory: "/workspace",
  title: "Session lab",
  version: "dev",
  time: { created: now, updated: now },
}
const child: Session = { ...session, id: "ses_child", parentID: session.id }
const grandchild: Session = { ...session, id: "ses_grandchild", parentID: child.id }
const sibling: Session = { ...session, id: "ses_other", title: "Other session" }
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
const home = createHomeSessionIndexCache(queryClient, routeKey)
const other = createHomeSessionIndexCache(queryClient, "https://other-server.test")
queryClient.setQueryData(home.indexKey, { sessions: [session, sibling], eventSequence: 0 })
queryClient.setQueryData(other.indexKey, { sessions: [session, sibling], eventSequence: 0 })
const [data, set] = createStore({
  session: [session, child, grandchild, sibling],
  session_status: {},
  message: {},
  part: {},
})
const evicted: string[] = []
const requests: { operation: string; input: unknown }[] = []
const toasts: unknown[] = []
const request = (name: string) => async (input: unknown) => {
  requests.push({ operation: name, input })
  if (failure) throw new Error("offline")
  return { data: true }
}
const sync = {
  data,
  set,
  session: {
    get: (id: string) => data.session.find((item) => item.id === id),
    evict: (id: string) => evicted.push(id),
    sync: async () => {},
  },
}
const sdk = { directory: "/workspace", client: { session: { update: request("archive"), delete: request("delete") } } }
await mock.module("@/context/sdk", () => ({ useSDK: () => () => sdk }))
await mock.module("@/context/sync", () => ({ useSync: () => () => sync }))
await mock.module("@/context/server-sync", () => ({ useServerSync: () => () => ({ homeSessions: home }) }))
await mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ server: routeServer, scope: routeKey, client: sdk.client }),
}))
await mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
await mock.module("@/context/settings", () => ({
  useSettings: () => ({ general: { newLayoutDesigns: () => true, showReasoningSummaries: () => false } }),
}))
await mock.module("@/context/tabs", () => ({ useTabs: () => ({ newDraft: () => {} }) }))
await mock.module("@/context/file", () => ({
  useFile: () => ({ tab: (value: string) => value, pathFromTab: (value: string) => value, load: () => {} }),
}))
await mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: session.id, serverKey: base64Encode(routeKey) },
    sessionKey: () => "route-session",
    tabs: () => ({ open: () => {}, setActive: () => {} }),
    view: () => ({ reviewPanel: { opened: () => false, open: () => {} } }),
  }),
}))
await mock.module("@/utils/toast", () => ({ showToast: (value: unknown) => toasts.push(value) }))
await mock.module("@turenlabs/ui/context/file", () => ({ useFileComponent: () => () => null }))
await mock.module("@turenlabs/session-ui/message-part", () => ({
  ContextToolGroup: () => null,
  FailureToolGroup: () => null,
  Message: () => null,
  MessageDivider: () => null,
  Part: () => null,
  partDefaultOpen: () => false,
  groupParts: () => [],
  renderable: () => false,
}))
await mock.module("@/pages/session/goal/session-v2-timeline-controller", () => ({
  sessionTurnActivity: { get: () => ({}) },
  sessionPromptPending: { delivery: () => undefined },
  sessionPromptStartup: { has: () => false },
  expandSessionV2ToolBody: () => {},
}))
await mock.module("@/pages/session/timeline/compaction-summary", () => ({ CompactionSummary: () => null }))

const { createMemoryHistory, MemoryRouter, Route } = await import("@solidjs/router")
const { DialogProvider } = await import("@turenlabs/ui/context/dialog")
const { MessageTimeline } = await import("@/pages/session/timeline/message-timeline")
const history = createMemoryHistory()
history.set({ value: "/session/ses_parent" })
const host = document.createElement("div")
document.body.append(host)
const noop = () => {}
const dispose = render(
  () =>
    createComponent(QueryClientProvider, {
      client: queryClient,
      get children() {
        return createComponent(DialogProvider, {
          get children() {
            return createComponent(MemoryRouter, {
              history,
              get children() {
                return createComponent(Route, {
                  path: "/session/:id",
                  component: () =>
                    createComponent(MessageTimeline, {
                      scroll: { overflow: false, bottom: true, jump: false },
                      onResumeScroll: noop,
                      setScrollRef: noop,
                      onScheduleScrollState: noop,
                      onAutoScrollHandleScroll: noop,
                      onAutoScrollPause: noop,
                      onMarkScrollGesture: noop,
                      hasScrollGesture: () => false,
                      onUserScroll: noop,
                      onHistoryScroll: noop,
                      onAutoScrollInteraction: noop,
                      shouldAnchorBottom: () => false,
                      centered: false,
                      hideContextUsage: true,
                      setContentRef: noop,
                      turnStatus: () => ({ kind: "idle" }),
                      userMessages: [],
                      anchor: (id: string) => id,
                    }),
                })
              },
            })
          },
        })
      },
    }),
  host,
)

const wait = async (check: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error(`${message}: ${document.body.textContent}`)
}
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === text)
const more = host.querySelector<HTMLButtonElement>('[aria-label="common.moreOptions"]')
assert.ok(more, "real timeline menu trigger rendered")
more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
await wait(
  () =>
    !![...document.querySelectorAll('[role="menuitem"]')].find((element) =>
      element.textContent?.includes(`common.${operation}`),
    ),
  "menu item missing",
)
const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
  element.textContent?.includes(`common.${operation}`),
)!
item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
if (operation === "delete") {
  await wait(() => !!button("session.delete.button"), "delete confirmation missing")
  button("session.delete.button")!.click()
}
await wait(() => requests.length === 1 && (failure ? toasts.length === 1 : evicted.length > 0), "action did not settle")
assert.equal(requests[0]?.operation, operation)
assert.equal(toasts.length, failure ? 1 : 0)
const ids = (cache: typeof home) =>
  queryClient.getQueryData<{ sessions: Session[] }>(cache.indexKey)!.sessions.map((item) => item.id)
assert.deepEqual(
  ids(home),
  failure ? [session.id, sibling.id] : [sibling.id],
  `${operation}: ${failure ? "failure retains" : "success removes"} target home row`,
)
assert.deepEqual(ids(other), [session.id, sibling.id], `${operation}: non-target server unchanged`)
assert.equal(home.eventSequence(), failure ? 0 : operation === "delete" ? 3 : 1)
assert.equal(other.eventSequence(), 0)
if (operation === "delete") {
  assert.deepEqual(evicted, failure ? [] : [session.id, child.id, grandchild.id])
  assert.deepEqual(
    data.session.map((item) => item.id),
    failure ? [session.id, child.id, grandchild.id, sibling.id] : [sibling.id],
  )
}
if (operation === "archive")
  assert.equal((requests[0]!.input as { time: { archived: number } }).time.archived > 0, true)
dispose()
host.remove()
queryClient.clear()
console.log(`timeline ${operation} ${failure ? "failure" : "success"} checks passed`)
// Browser fixture timers can outlive disposal; each case runs in its own process.
process.exit(0)
