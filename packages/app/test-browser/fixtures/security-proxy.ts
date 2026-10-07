import assert from "node:assert/strict"
import { mock, spyOn } from "bun:test"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { Platform } from "@/context/platform"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"

// Compile the real page and provider. Context stubs stay in this child process.
const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "security-proxy-fixture",
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
await mock.module("@/context/server", () => ({
  useServer: () => ({ current: { type: "sidecar", variant: "base" }, projects: { last: () => "/proxy-test" } }),
}))
await mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ session: { peek: () => undefined } }),
}))
const { createMemoryHistory, MemoryRouter, Route } = await import("@solidjs/router")
const { PlatformProvider } = await import("@/context/platform")
const { default: SecurityProxyPage } = await import("@/pages/security-proxy")

const owner = { directory: "/proxy-test" }
const savedCase: SecurityProxy.Case = {
  id: "fixture",
  name: "Fixture case",
  owner,
  revision: 0,
  createdAt: 1,
  rules: [],
}
const body = (data: string): SecurityProxy.Body => ({ data, encoding: "utf8", state: "complete", size: data.length })
const flow = (id: string, response: string, createdAt: number): SecurityProxy.Flow => ({
  id,
  caseID: savedCase.id,
  source: "browser",
  request: {
    url: `https://target.invalid/${id}`,
    method: "POST",
    headers: [{ name: "Authorization", value: "[redacted]" }],
    body: body("request"),
  },
  responseHeaders: [{ name: "Content-Type", value: "application/json" }],
  responseBody: body(response),
  status: 200,
  state: "complete",
  createdAt,
  durationMs: 5,
  note: "",
})
const first = flow("first", "common\nold value\n", 300)
const second = flow("second", "common\nnew value\n", 200)
const older = flow("older-needle", "older response\n", 100)
const stored = [first, second, older]
const summary = (value: SecurityProxy.Flow): SecurityProxy.Flow => ({
  ...value,
  request: { ...value.request, headers: [], body: { ...value.request.body, data: "", state: "unavailable" } },
  responseBody: { ...value.responseBody, data: "", state: "unavailable" },
})
const original = (value: SecurityProxy.Flow): SecurityProxy.Flow => ({
  ...value,
  request: { ...value.request, headers: [{ name: "Authorization", value: "Bearer fixture-secret" }] },
})
const cursor200 = { key: "after-200", timeCreated: 200 }
const cursor400 = { key: "after-400", timeCreated: 100 }
const commands: SecurityProxy.Command[] = []
let settleReplay: ((result: SecurityProxy.Result) => void) | undefined
let settleExport: ((result: SecurityProxy.Result) => void) | undefined
let delayExport = true
const platform: Platform = {
  platform: "desktop",
  openLink() {},
  restart: async () => undefined,
  back() {},
  forward() {},
  notify: async () => undefined,
  securityProxy: {
    async invoke(command) {
      commands.push(command)
      assert.deepEqual(command.owner, owner)
      if (command.type === "list") return { cases: [savedCase] }
      if (command.type === "get") return { case: { ...savedCase, id: command.caseID } }
      if (command.type === "snapshot" || command.type === "close")
        return {
          snapshot: {
            caseID: command.caseID,
            generation: "generation",
            open: false,
            url: "",
            intercept: false,
            pauses: [],
          },
        }
      if (command.type === "flow" || command.type === "reveal") {
        const value = stored.find((item) => item.id === command.flowID)
        assert.ok(value)
        return { flow: command.type === "reveal" ? original(value) : value }
      }
      if (command.type === "replay") {
        assert.equal(command.flowID, first.id)
        return new Promise<SecurityProxy.Result>((resolve) => {
          settleReplay = resolve
        })
      }
      if (command.type === "flows") {
        if (command.caseID === "next-case") return { flows: [], total: 0 }
        assert.equal(command.caseID, savedCase.id)
        // Fixed pages test cursor traversal without copying production filters.
        if (command.view) {
          assert.equal(command.filter, undefined)
          if (!command.cursor)
            return { flows: [command.view === "revealed" ? original(first) : first], nextCursor: cursor200, total: 3 }
          if (command.cursor.key === cursor200.key) {
            if (command.view === "masked" && delayExport)
              return new Promise<SecurityProxy.Result>((resolve) => {
                settleExport = resolve
              })
            return { flows: [], nextCursor: cursor400, total: 3 }
          }
          assert.deepEqual(command.cursor, cursor400)
          return {
            flows: command.view === "revealed" ? [original(second), original(older)] : [second, older],
            total: 3,
          }
        }
        if (command.filter) {
          assert.equal(command.filter.query, "needle")
          if (!command.cursor) return { flows: [], nextCursor: cursor200, total: 3 }
          assert.deepEqual(command.cursor, cursor200)
          return { flows: [summary(older)], total: 3 }
        }
        if (!command.cursor) return { flows: [summary(first), summary(second)], nextCursor: cursor200, total: 3 }
        assert.deepEqual(command.cursor, cursor200)
        return { flows: [summary(older)], total: 3 }
      }
      return assert.fail(`Unexpected command ${command.type}`)
    },
  },
}
const host = document.createElement("div")
document.body.append(host)
// Happy DOM has no layout. Give only the history viewport a fixed size.
const viewportWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!
const viewportHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return this.getAttribute("aria-label") === "Captured flows" ? 800 : viewportWidth.get!.call(this)
  },
})
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return this.getAttribute("aria-label") === "Captured flows" ? 600 : viewportHeight.get!.call(this)
  },
})
const history = createMemoryHistory()
history.set({ value: "/?proxyCase=fixture" })
const dispose = render(
  () =>
    createComponent(PlatformProvider, {
      value: platform,
      get children() {
        return createComponent(MemoryRouter, {
          history,
          get children() {
            return createComponent(Route, { path: "*", component: () => createComponent(SecurityProxyPage, {}) })
          },
        })
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
const button = (name: string) => {
  const element = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)
  assert.ok(element, `Missing button ${name}`)
  return element
}
const field = (label: string) => {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label='${label}']`,
  )
  assert.ok(element, `Missing field ${label}`)
  return element
}
const enter = (label: string, value: string) => {
  const element = field(label)
  element.value = value
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
}
const row = (id: string) => {
  const cell = host.querySelector(`[aria-label='Captured flows'] td[title='https://target.invalid/${id}']`)
  assert.ok(cell, `Missing row ${id}`)
  return cell.closest("tr")!
}
const exportCommands = () => commands.filter((command) => command.type === "flows" && command.view)
const replayCommands = () => commands.filter((command) => command.type === "replay")
const downloads: Blob[] = []
const objectURL = spyOn(URL, "createObjectURL").mockImplementation((value) => {
  assert.ok(value instanceof Blob)
  downloads.push(value)
  return "blob:fixture-download"
})
const revokeURL = spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
const anchorClick = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)

try {
  await until(() => !!host.querySelector("td[title='https://target.invalid/first']"), "Initial history did not render")
  assert.equal(row("first").children[3]!.textContent, "json")
  assert.equal(host.querySelectorAll("tbody tr:not([aria-hidden])").length, 2)

  // Export traverses unloaded pages, including an empty page with a cursor.
  button("Export…").click()
  button("Build export").click()
  await until(() => !!settleExport, "Export did not request its second page")
  assert.ok(host.textContent?.includes("1 flows"))
  assert.equal(host.querySelector("td[title='https://target.invalid/older-needle']"), null)
  delayExport = false
  settleExport!({ flows: [], nextCursor: cursor400, total: 3 })
  await until(
    () => !![...host.querySelectorAll("button")].find((item) => item.textContent === "Download 3 flows"),
    "Export did not finish",
  )
  assert.deepEqual(
    exportCommands().map((command) => (command.type === "flows" ? command.cursor?.key : undefined)),
    [undefined, "after-200", "after-400"],
  )
  button("Download 3 flows").click()
  const json = JSON.parse(await downloads[0]!.text())
  assert.deepEqual(
    json.flows.map((item: { id: string }) => item.id),
    [first.id, second.id, older.id],
  )
  assert.ok(!JSON.stringify(json).includes("fixture-secret"))
  enter("Export format", "har")
  enter("Export visibility", "revealed")
  const beforeOriginals = exportCommands().length
  button("Build export").click()
  await until(() => !!host.querySelector("[role=alertdialog]"), "Original export did not ask for confirmation")
  assert.equal(exportCommands().length, beforeOriginals)
  button("Confirm").click()
  await until(
    () => exportCommands().length === beforeOriginals + 3 && !button("Build export").disabled,
    "Original export did not finish",
  )
  assert.ok(
    exportCommands()
      .slice(beforeOriginals)
      .every((command) => command.type === "flows" && command.view === "revealed"),
  )
  assert.equal(button("Download 3 flows").disabled, false)
  button("Download 3 flows").click()
  const har = JSON.parse(await downloads[1]!.text())
  assert.equal(har.log.version, "1.2")
  assert.deepEqual(
    har.log.entries.map((entry: { request: { url: string } }) => entry.request.url),
    stored.map((item) => item.request.url),
  )
  assert.ok(JSON.stringify(har).includes("Bearer fixture-secret"))
  button("Close").click()

  enter("Case search", "needle")
  button("Apply to case").click()
  await until(
    () => !!host.querySelector("td[title='https://target.invalid/older-needle']"),
    "Case search stopped at an empty page",
  )
  const filtered = commands.filter((command) => command.type === "flows" && command.filter)
  assert.equal(filtered.length, 2)
  assert.equal(filtered[1]!.type === "flows" && filtered[1]!.cursor?.key, "after-200")
  assert.equal(host.querySelector("td[title='https://target.invalid/first']"), null)
  assert.equal(button("Load older").disabled, true)
  button("Clear").click()
  await until(
    () => !!host.querySelector("td[title='https://target.invalid/first']"),
    "Clear did not restore the first page",
  )
  button("Load older").click()
  await until(
    () => !!host.querySelector("td[title='https://target.invalid/older-needle']"),
    "Load older did not append history",
  )
  button("Clear").click()
  await until(() => !button("Load all").disabled, "Clear did not restore the history cursor")
  button("Load all").click()
  await until(
    () => !!host.querySelector("td[title='https://target.invalid/older-needle']") && button("Load all").disabled,
    "Load all did not reach the end of history",
  )

  row("first").click()
  await until(() => !!host.querySelector("[aria-label='Other flow']"), "Selected flow did not load")
  enter("Other flow", "second")
  button("Compare").click()
  await until(() => !!host.querySelector("[aria-label='Response differences'] span"), "Comparison did not render")
  const differences = field("Response differences")
  assert.ok(
    [...differences.querySelectorAll("span")].some(
      (span) =>
        span.textContent?.startsWith("- ") &&
        span.textContent.includes("old value") &&
        span.className.includes("danger"),
    ),
  )
  assert.ok(
    [...differences.querySelectorAll("span")].some(
      (span) =>
        span.textContent?.startsWith("+ ") &&
        span.textContent.includes("new value") &&
        span.className.includes("success"),
    ),
  )
  const revealLabel = [...host.querySelectorAll("label")].find((label) => label.textContent?.trim() === "reveal both")!
  const revealCheckbox = revealLabel.querySelector("input")!
  revealCheckbox.checked = true
  revealCheckbox.dispatchEvent(new Event("change", { bubbles: true }))
  const beforeReveal = commands.filter((command) => command.type === "reveal").length
  button("Compare").click()
  await until(() => !!host.querySelector("[role=alertdialog]"), "Revealed comparison did not ask for confirmation")
  assert.equal(commands.filter((command) => command.type === "reveal").length, beforeReveal)
  button("Confirm").click()
  await until(
    () =>
      commands.filter((command) => command.type === "reveal").length === beforeReveal + 2 &&
      !button("Compare").disabled,
    "Revealed comparison did not finish",
  )

  row("first").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }))
  button("Send to Repeater").click()
  await until(() => !!host.querySelector("[aria-label='Repeater tab name']"), "Repeater did not create a tab")
  enter("Repeater tab name", "Draft A")
  enter("URL", "https://target.invalid/draft-a")
  enter('Headers JSON array [{"name","value"}]', '[{"name":"X-Draft","value":"A"}]')
  enter("Raw HTTP request", "POST /raw-a HTTP/1.1\nHost: target.invalid\n\nA")
  const auth = () =>
    [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.trim().startsWith("auth"))!
      .querySelector("select")!
  auth().value = "live"
  auth().dispatchEvent(new Event("change", { bubbles: true }))
  button("Duplicate").click()
  enter("Repeater tab name", "Draft B")
  enter("URL", "https://target.invalid/draft-b")
  enter('Headers JSON array [{"name","value"}]', '[{"name":"X-Draft","value":"B"}]')
  enter("Raw HTTP request", "POST /raw-b HTTP/1.1\nHost: target.invalid\n\nB")
  auth().value = "captured"
  auth().dispatchEvent(new Event("change", { bubbles: true }))
  const checkDraft = (name: string, suffix: string, mode: string) => {
    button(name).click()
    assert.equal(field("URL").value, `https://target.invalid/draft-${suffix.toLowerCase()}`)
    assert.equal(field('Headers JSON array [{"name","value"}]').value, `[{"name":"X-Draft","value":"${suffix}"}]`)
    assert.ok(field("Raw HTTP request").value.includes(`/raw-${suffix.toLowerCase()}`))
    assert.equal(auth().value, mode)
    assert.equal(host.querySelector("[role=tab][aria-selected=true]")?.textContent, name)
  }
  checkDraft("Draft A", "A", "live")
  checkDraft("Draft B", "B", "captured")
  button("Draft A").click()
  button("Send").click()
  await until(() => !!settleReplay, "Replay command did not start")
  assert.equal(replayCommands().length, 1)
  const sent = replayCommands()[0]!
  assert.equal(sent.auth, "live")
  assert.equal(sent.edits?.url, "https://target.invalid/draft-a")
  assert.deepEqual(sent.edits?.headers, [{ name: "X-Draft", value: "A" }])
  assert.ok(sent.replayID)
  button("Draft B").click()
  settleReplay!({
    flow: { ...flow("replay-a", "result for A", 400), source: "replay", status: 201, parentID: first.id },
  })
  await until(() => !button("Send").disabled, "Replay did not settle")
  assert.equal(field("Repeater send history").querySelectorAll("option").length, 1)
  assert.ok(!host.textContent?.includes("result for A"))
  button("Draft A").click()
  assert.equal(field("Repeater send history").value, "replay-a")
  assert.equal(field("Repeater send history").querySelectorAll("option").length, 2)
  assert.ok(host.textContent?.includes("result for A"))
  checkDraft("Draft B", "B", "captured")
  button("Draft A").click()
  button("Close").click()
  await until(() => !!host.querySelector("[role=alertdialog]"), "Tab close did not ask for confirmation")
  button("Draft B").click()
  button("Confirm").click()
  await until(
    () => host.querySelectorAll("[aria-label='Repeater requests'] [role=tab]").length === 1,
    "Tab close did not remove the originating tab",
  )
  assert.equal(host.querySelector("[aria-label='Repeater requests'] [role=tab]")?.textContent, "Draft B")
  checkDraft("Draft B", "B", "captured")

  history.set({ value: "/?proxyCase=next-case" })
  await until(
    () => commands.some((command) => command.type === "close" && command.caseID === "fixture"),
    "Case change did not close the old case",
  )
  assert.equal(host.querySelector("[aria-label='Repeater tab name']"), null)
  assert.equal(replayCommands().length, 1)
} finally {
  dispose()
  host.remove()
  objectURL.mockRestore()
  revokeURL.mockRestore()
  anchorClick.mockRestore()
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", viewportWidth)
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", viewportHeight)
}
await flush()
assert.equal(replayCommands().length, 1)
await GlobalRegistrator.unregister()
console.log("security proxy checks passed")
