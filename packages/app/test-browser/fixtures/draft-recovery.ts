import assert from "node:assert/strict"
import { plugin } from "bun"
import { createComponent, createRoot, getOwner, runWithOwner, type Owner } from "solid-js"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Platform } from "@/context/platform"
import type { Prompt } from "@/context/prompt-state"

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

const { createMemoryHistory, MemoryRouter, Route } = await import("@solidjs/router")
const { PlatformProvider } = await import("@/context/platform")
const { ServerProvider, ServerConnection } = await import("@/context/server")
const { TabsProvider, useTabs } = await import("@/context/tabs")
const { createDraftPromptSession } = await import("@/context/prompt-state")
const { Persist, PersistTesting, draftPersistedKeys } = await import("@/utils/persist")

const connection = { type: "http" as const, http: { url: "http://draft-test.invalid" } }
const server = ServerConnection.key(connection)
const values = new Map<string, Map<string, string>>()
const reads = new Map<string, (value: string | null) => void>()
const delays = new Set<string>()
const platform: Platform = {
  platform: "desktop",
  windowID: "draft-recovery-test",
  openLink() {},
  restart: async () => undefined,
  back() {},
  forward() {},
  notify: async () => undefined,
  openDirectoryPickerDialog: async () => null,
  storage(name = "default"): AsyncStorage {
    const data = values.get(name) ?? new Map<string, string>()
    values.set(name, data)
    return {
      getItem: async (key) => {
        if (delays.has(key)) return new Promise((resolve) => reads.set(key, resolve))
        return data.get(key) ?? null
      },
      setItem: async (key, value) => {
        data.set(key, value)
      },
      removeItem: async (key) => {
        data.delete(key)
      },
      clear: async () => data.clear(),
      key: async (index) => [...data.keys()][index] ?? null,
      getLength: async () => data.size,
      length: Promise.resolve(data.size),
    }
  },
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const storedDraft = (draftID: string, key = "prompt") => {
  const target = Persist.draft(draftID, key)
  return values.get(target.storage!)?.get(target.key)
}

async function mount(value = platform) {
  const state: { tabs?: ReturnType<typeof useTabs>; owner?: Owner | null; dispose?: VoidFunction } = {}
  createRoot((dispose) => {
    state.dispose = dispose
    createComponent(PlatformProvider, {
      value,
      get children() {
        return createComponent(ServerProvider, {
          defaultServer: server,
          servers: [connection],
          get children() {
            return createComponent(MemoryRouter, {
              history: createMemoryHistory(),
              get children() {
                return createComponent(Route, {
                  path: "*",
                  component: () =>
                    createComponent(TabsProvider, {
                      get children() {
                        state.tabs = useTabs()
                        state.owner = getOwner()
                        return null
                      },
                    }),
                })
              },
            })
          },
        })
      },
    })
  })
  await flush()
  assert.ok(state.tabs)
  return {
    tabs: state.tabs,
    dispose: state.dispose!,
    prompt(draftID: string) {
      return runWithOwner(state.owner!, () =>
        state.tabs!.state(state.tabs!.draft(draftID), "prompt", () => createDraftPromptSession(draftID)),
      )!
    },
  }
}

const original = await mount()
const model = { providerID: "openai", modelID: "gpt-6-astra", variant: "high" }
const draft = await original.tabs.newDraft({ server, directory: "/project", worktree: "/project/branch" })
const prompt = original.prompt(draft.draftID)
await prompt.ready.promise
const parts: Prompt = [
  { type: "text", content: "Review ", start: 0, end: 7 },
  {
    type: "file",
    content: "@src/index.ts",
    path: "src/index.ts",
    start: 7,
    end: 20,
    selection: { startLine: 3, endLine: 9 },
    mime: "text/typescript",
  },
  {
    type: "image",
    id: "image-1",
    filename: "screenshot.png",
    mime: "image/png",
    dataUrl: "data:image/png;base64,dGVzdA==",
    sourcePath: "/images/screenshot.png",
  },
]
const persistedParts = (prompt: Prompt) =>
  prompt.flatMap((part) => {
    if (part.type !== "image") return [part]
    if (typeof part.sourcePath !== "string") return []
    const { dataUrl: _dataUrl, previewUrl: _previewUrl, ...rest } = part
    return [rest]
  })
prompt.set(parts, 12)
prompt.model.set(model)
prompt.context.add({
  type: "file",
  path: "README.md",
  comment: "Keep this detail",
  selection: { startLine: 1, endLine: 2 },
  preview: "Important detail",
})
for (const key of draftPersistedKeys().filter((key) => key !== "prompt")) {
  const target = Persist.draft(draft.draftID, key)
  await platform.storage!(target.storage).setItem(target.key, JSON.stringify({ value: key }))
}
const snapshot = storedDraft(draft.draftID)
const context = JSON.parse(JSON.stringify(prompt.context.items()))
original.tabs.closeTab(0)
await flush()
assert.equal(storedDraft(draft.draftID), snapshot)
assert.equal(original.tabs.store.length, 0)
original.dispose()

// Renderer disposal/recreation models relaunch against the same durable store.
const restored = await mount()
restored.tabs.reopenClosedTab()
await flush()
assert.deepEqual(JSON.parse(JSON.stringify(restored.tabs.store)), [draft])
const recovered = restored.prompt(draft.draftID)
await recovered.ready.promise
assert.deepEqual(
  JSON.parse(JSON.stringify(recovered.current())),
  persistedParts(parts),
)
assert.equal(recovered.cursor(), 12)
assert.deepEqual(JSON.parse(JSON.stringify(recovered.model.current())), model)
assert.deepEqual(JSON.parse(JSON.stringify(recovered.context.items())), context)
for (const key of draftPersistedKeys().filter((key) => key !== "prompt")) {
  assert.equal(storedDraft(draft.draftID, key), JSON.stringify({ value: key }))
}

// Recovering an older draft never copies into the draft typed in the meantime.
restored.tabs.closeTab(0)
const newer = await restored.tabs.newDraft({ server, directory: "/new-project" }, "Newer text")
await restored.prompt(newer.draftID).ready.promise
restored.tabs.reopenClosedTab()
await flush()
assert.equal(restored.prompt(newer.draftID).current()[0]!.type, "text")
assert.deepEqual(JSON.parse(JSON.stringify(restored.prompt(newer.draftID).current())), [
  { type: "text", content: "Newer text", start: 0, end: 10 },
])
assert.equal(restored.tabs.draft(newer.draftID).directory, "/new-project")

// A delayed successful submit after close removes recovery for the promoted
// identity, even if its destination session already has a tab.
restored.tabs.closeTab(restored.tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === draft.draftID))
restored.tabs.addSessionTab({ server, sessionId: "established" })
restored.tabs.promoteDraft(draft.draftID, { server, sessionId: "established" })
restored.tabs.reopenClosedTab()
await flush()
assert.equal(restored.tabs.store.filter((tab) => tab.type === "session" && tab.sessionId === "established").length, 1)
assert.equal(
  restored.tabs.store.some((tab) => tab.type === "draft" && tab.draftID === draft.draftID),
  false,
)
for (const key of draftPersistedKeys()) assert.equal(storedDraft(draft.draftID, key), undefined)

// A group close larger than recovery capacity must also purge drafts that never
// fitted in the 25-entry stack, without touching another open draft.
const groupDrafts = await Promise.all(
  Array.from({ length: 30 }, (_, index) => restored.tabs.newDraft({ server, directory: "/group" }, `Group ${index}`)),
)
await Promise.all(groupDrafts.map((tab) => restored.prompt(tab.draftID).ready.promise))
const group = restored.tabs.createGroup({ tab: groupDrafts[0]! })!
for (const tab of groupDrafts.slice(1)) restored.tabs.addTabToGroup(tab, group.id)
restored.tabs.closeGroup(group.id)
await flush()
for (const tab of groupDrafts.slice(0, 25)) assert.ok(storedDraft(tab.draftID), `retained group draft ${tab.draftID}`)
for (const tab of groupDrafts.slice(25))
  assert.equal(storedDraft(tab.draftID), undefined, `evicted group draft ${tab.draftID}`)
assert.ok(storedDraft(newer.draftID), "newer open draft")
restored.tabs.closeTab(restored.tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === newer.draftID))
await flush()
assert.equal(storedDraft(groupDrafts[24]!.draftID), undefined, "oldest retained draft is evicted")
assert.ok(storedDraft(groupDrafts[23]!.draftID), "next oldest remains recoverable")
assert.ok(storedDraft(newer.draftID), "latest closed draft is retained")
restored.tabs.reopenClosedTab()
await flush()
assert.equal(restored.tabs.draft(newer.draftID).directory, "/new-project")
restored.dispose()

// Hydration can finish after close/promotion. Deferred mutations must apply in
// order to persisted history, and reopening must wait for open tabs too.
delays.add("tabs.closed")
const pending = await mount()
const queued = await pending.tabs.newDraft({ server, directory: "/pending" }, "Pending")
await pending.prompt(queued.draftID).ready.promise
pending.tabs.closeTab(pending.tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === queued.draftID))
assert.ok(
  pending.tabs.store.some((tab) => tab.type === "draft" && tab.draftID === queued.draftID),
  "closing waits for recovery history instead of stranding an unrecorded draft",
)
pending.tabs.promoteDraft(queued.draftID, { server, sessionId: "late-promotion" })
pending.tabs.reopenClosedTab()
delays.delete("tabs.closed")
const closed = [...values.values()].find((data) => data.has("tabs.closed"))!.get("tabs.closed")!
reads.get("tabs.closed")!(closed)
await flush()
assert.equal(
  pending.tabs.store.some((tab) => tab.type === "draft" && tab.draftID === queued.draftID),
  false,
)
assert.equal(pending.tabs.store.filter((tab) => tab.type === "session" && tab.sessionId === "late-promotion").length, 1)
assert.equal(storedDraft(queued.draftID), undefined)
pending.dispose()

// The open-tab snapshot can arrive after history. A stale closed entry must
// never overwrite its open draft or delete the persistence it still owns.
const tabStorage = [...values.values()].find((data) => data.has("tabs"))!
const closedStorage = [...values.values()].find((data) => data.has("tabs.closed"))!
closedStorage.set("tabs.closed", JSON.stringify([{ tab: { ...newer, directory: "/stale-project" }, index: 0 }]))
const openSnapshot = tabStorage.get("tabs")!
const newerSnapshot = storedDraft(newer.draftID)
delays.add("tabs")
const hydrating = await mount()
hydrating.tabs.reopenClosedTab()
assert.equal(hydrating.tabs.store.length, 0)
delays.delete("tabs")
reads.get("tabs")!(openSnapshot)
await flush()
assert.equal(hydrating.tabs.store.filter((tab) => tab.type === "draft" && tab.draftID === newer.draftID).length, 1)
assert.equal(hydrating.tabs.draft(newer.draftID).directory, "/new-project")
assert.equal(storedDraft(newer.draftID), newerSnapshot)
hydrating.dispose()

// Browser quota failure must survive real tab close/reopen, including disposal
// of both the prompt and TabsProvider. Only the atomic setItem boundary is
// simulated: providers, tab recovery, prompt state and persistence remain real.
const web = { ...platform, platform: "web" as const }
const prototype = Storage.prototype
// The original method is called with its receiver below and restored in finally.
// oxlint-disable-next-line typescript-eslint/unbound-method
const setItem = prototype.setItem
let quota = false
let blocked = 0
// Happy DOM binds each method on first access, so install before mounting web providers.
prototype.setItem = function (key, value) {
  if (quota) {
    blocked += 1
    throw new DOMException("quota", "QuotaExceededError")
  }
  setItem.call(this, key, value)
}
const browser = await mount(web)
const browserDraft = await browser.tabs.newDraft({ server, directory: "/browser-quota" }, "Saved X")
const browserPrompt = browser.prompt(browserDraft.draftID)
await browserPrompt.ready.promise
browserPrompt.model.set(model)
const target = Persist.draft(browserDraft.draftID, "prompt")
const storageKey = `${target.storage}:${target.key}`
const saved = localStorage.getItem(storageKey)
assert.ok(saved)
assert.equal(JSON.parse(saved).prompt[0].content, "Saved X")
const unsaved: Prompt = [
  { type: "text", content: "Unsaved Y ", start: 0, end: 10 },
  { ...parts[1]!, start: 10, end: 23 },
  parts[2]!,
]
const persistedUnsaved = persistedParts(unsaved)
const unsavedModel = { ...model, variant: "max" }
quota = true
try {
  browserPrompt.set(unsaved, 9)
  browserPrompt.model.set(unsavedModel)
  browserPrompt.context.add({
    type: "file",
    path: "quota.md",
    comment: "Unsaved context Y",
    selection: { startLine: 2, endLine: 4 },
    preview: "Preserve with draft",
  })
  const unsavedContext = JSON.parse(JSON.stringify(browserPrompt.context.items()))
  assert.ok(blocked > 0, "quota simulation intercepted actual storage writes")
  assert.equal(localStorage.getItem(storageKey), saved, "quota leaves saved X durable")
  browser.tabs.closeTab(0)
  assert.equal(browser.tabs.store.length, 0)
  browser.dispose()

  const reopened = await mount(web)
  assert.equal(reopened.tabs.store.length, 0, "failed tab close is retained in memory")
  reopened.tabs.reopenClosedTab()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.tabs.store)), [browserDraft])
  const unsavedPrompt = reopened.prompt(browserDraft.draftID)
  await unsavedPrompt.ready.promise
  assert.deepEqual(JSON.parse(JSON.stringify(unsavedPrompt.current())), persistedUnsaved)
  assert.equal(unsavedPrompt.cursor(), 9)
  assert.deepEqual(JSON.parse(JSON.stringify(unsavedPrompt.model.current())), unsavedModel)
  assert.deepEqual(JSON.parse(JSON.stringify(unsavedPrompt.context.items())), unsavedContext)
  assert.equal(localStorage.getItem(storageKey), saved, "reopen cannot replace saved X while quota remains")

  quota = false
  PersistTesting.retryFailedWrites()
  const retried = JSON.parse(localStorage.getItem(storageKey)!)
  assert.deepEqual(retried.prompt, persistedUnsaved)
  assert.equal(retried.cursor, 9)
  assert.deepEqual(retried.model, unsavedModel)
  assert.deepEqual(retried.context.items, unsavedContext)
  reopened.dispose()

  const finalBrowser = await mount(web)
  assert.deepEqual(JSON.parse(JSON.stringify(finalBrowser.tabs.store)), [browserDraft])
  const finalPrompt = finalBrowser.prompt(browserDraft.draftID)
  await finalPrompt.ready.promise
  assert.deepEqual(JSON.parse(JSON.stringify(finalPrompt.current())), persistedUnsaved)
  assert.equal(finalPrompt.cursor(), 9)
  assert.deepEqual(JSON.parse(JSON.stringify(finalPrompt.context.items())), unsavedContext)
  finalBrowser.tabs.reopenClosedTab()
  assert.equal(finalBrowser.tabs.store.length, 1, "retry preserves the consumed recovery entry")
  finalBrowser.dispose()
} finally {
  quota = false
  prototype.setItem = setItem
  browser.dispose()
}
console.log("draft recovery lifecycle checks passed")
process.exit(0)
