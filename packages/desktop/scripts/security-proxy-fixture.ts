import { BrowserWindow, app } from "electron"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { createSecurityProxyController } from "../src/main/security-proxy"

const checks: { name: string; ok: boolean; detail?: string }[] = []
const counts = { hold: 0, drop: 0, edit: 0, secret: 0, replay: 0, unknown: 0 }
let forbiddenPort = 0
let holdHeader: string | undefined
const secretCookies: string[] = []
const owner = { directory: "/security-proxy-integration" }
const caseID = "integration_case"
const cases = new Map<string, SecurityProxy.Case>()
const flows = new Map<string, SecurityProxy.Flow>()
const check = (name: string, ok: boolean, detail?: unknown) =>
  checks.push({ name, ok, detail: detail === undefined ? undefined : String(detail) })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read()
    if (ok(value)) return value
    await wait(25)
  }
  throw new Error("bounded wait expired")
}
const body = (data: string): SecurityProxy.Body => ({
  data,
  encoding: "utf8",
  state: "complete",
  size: Buffer.byteLength(data),
})

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (pathname === "/hold") {
    counts.hold++
    holdHeader = request.headers["x-integration"]
    response.end("hold")
    return
  }
  if (pathname === "/drop") {
    counts.drop++
    response.end("drop")
    return
  }
  if (pathname === "/edit") {
    counts.edit++
    response.end("origin")
    return
  }
  if (pathname === "/secret") {
    counts.secret++
    secretCookies.push(request.headers.cookie ?? "")
    response.end("secret-token")
    return
  }
  if (pathname === "/replay") {
    counts.replay++
    response.end("replayed")
    return
  }
  if (pathname === "/unknown") {
    counts.unknown++
    response.end("unknown")
    return
  }
  if (pathname === "/preflight") {
    response.setHeader("Content-Type", "text/html")
    response.end(
      `<!doctype html><script>fetch("http://127.0.0.1:${forbiddenPort}/thing",{method:"PUT",headers:{"x-custom":"1"}}).catch(()=>{})</script>`,
    )
    return
  }
  response.setHeader("Content-Type", "text/html")
  response.setHeader("Set-Cookie", "fixture=browser; Path=/")
  response.end("<!doctype html><div id=remote>remote</div>")
})
const listen = new Promise<number>((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
)
let forbiddenCount = 0
const forbiddenServer = createServer((_request, response) => {
  forbiddenCount++
  response.end("forbidden")
})
const forbiddenListen = new Promise<number>((resolve) =>
  forbiddenServer.listen(0, "127.0.0.1", () => resolve((forbiddenServer.address() as { port: number }).port)),
)

const store = async (command: SecurityProxy.StoreCommand): Promise<SecurityProxy.Result> => {
  if (command.type === "create") {
    const value = { ...command.input, owner: command.owner, revision: 0, createdAt: Date.now(), rules: [] }
    cases.set(value.id, value)
    return { case: value }
  }
  if (command.type === "get") return { case: cases.get(command.caseID) }
  if (command.type === "rules") {
    const value = cases.get(command.caseID)
    if (!value || value.revision !== command.revision) throw new Error("revision conflict")
    value.revision++
    value.rules = command.rules
    return { case: value }
  }
  if (command.type === "put") {
    flows.set(command.flow.id, command.flow)
    return {}
  }
  if (command.type === "reserve") {
    if (flows.has(command.flow.id)) return { created: false }
    flows.set(command.flow.id, command.flow)
    return { created: true }
  }
  if (command.type === "reveal" || command.type === "flow") return { flow: flows.get(command.flowID) }
  if (command.type === "flows") return { flows: [...flows.values()] }
  return {}
}

async function main() {
  const port = await listen
  forbiddenPort = await forbiddenListen
  const target = `http://127.0.0.1:${port}/`
  const shellURL = () => "data:text/html,<html><body>trusted-shell</body></html>"
  const preloadDir = mkdtempSync(join(tmpdir(), "security-proxy-preload-"))
  const preload = join(preloadDir, "preload.cjs")
  writeFileSync(preload, "")
  await app.whenReady()
  const sentinel = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await sentinel.loadURL("data:text/html,<div id=sentinel>main-sentinel</div>")
  const controller = createSecurityProxyController({
    store,
    shellURL,
    shellPreload: preload,
    protectedOrigins: () => [],
    focusProxy: () => {},
  })
  const common = { owner, caseID }
  await controller.invoke(7, {
    type: "create",
    owner,
    input: { id: caseID, name: "integration" },
  })
  const opened = await controller.invoke(7, { type: "open", ...common })
  const generation = opened.snapshot!.generation
  await controller.invoke(7, { type: "navigate", ...common, url: target })
  const loaded = await until(
    () => controller.invoke(7, { type: "snapshot", ...common }),
    (result) => result.snapshot?.url.startsWith(target) === true,
  )
  check(
    "open-owns-remote-view-shell",
    loaded.snapshot?.open === true && generation !== "closed" && loaded.snapshot.url.startsWith(target),
  )
  await controller
    .invoke(7, { type: "navigate", ...common, url: `http://127.0.0.1:${forbiddenPort}/unknown` })
    .catch(() => undefined)
  await wait(100)
  // Navigation is scheme-gated, not scope-gated: any HTTP(S) destination is allowed.
  check("unlisted-http-navigation-allowed", forbiddenCount >= 1)
  const schemeBlocked = await controller
    .invoke(7, { type: "navigate", ...common, url: "file:///etc/passwd" })
    .then(() => false)
    .catch(() => true)
  check("blocked-scheme-navigation-rejected", schemeBlocked)
  await controller.invoke(7, { type: "navigate", ...common, url: `${target}secret` })
  let secret: SecurityProxy.Flow | undefined
  try {
    secret = await until(
      async () => [...flows.values()].find((flow) => flow.request.url.endsWith("/secret")),
      (flow) => !!flow && flow.responseBody.data.includes("secret-token"),
    )
  } catch (error) {
    const snapshot = await controller
      .invoke(7, { type: "snapshot", ...common })
      .catch((failure) => ({ error: String(failure) }))
    const summary = [...flows.values()].map((flow) => ({
      id: flow.id,
      url: flow.request.url,
      state: flow.state,
      error: flow.error,
      body: {
        state: flow.responseBody.state,
        size: flow.responseBody.size,
        data: flow.responseBody.data.slice(0, 128),
      },
    }))
    throw new Error(`secret capture timeout: ${JSON.stringify({ error: String(error), snapshot, flows: summary })}`)
  }
  if (!secret) throw new Error("secret flow was not captured")
  check("captured-flow-and-secret", secret.responseBody.data.includes("secret-token"), secret.id)

  await controller.invoke(7, { type: "intercept", ...common, on: true, settle: "forward" })
  await controller.invoke(7, { type: "navigate", ...common, url: `${target}hold` })
  const held = await until(
    () => controller.invoke(7, { type: "snapshot", ...common }),
    (result) => !!result.snapshot?.pauses.length,
  )
  const requestPause = held.snapshot!.pauses.find((pause) => pause.stage === "request")!
  const revealed = await controller.invoke(7, {
    type: "decide",
    ...common,
    generation,
    pauseID: requestPause.id,
    decision: "reveal",
  })
  check("intercept-request-reveal", revealed.pause?.request.url.endsWith("/hold"))
  await controller.invoke(7, {
    type: "decide",
    ...common,
    generation,
    pauseID: requestPause.id,
    decision: "forward",
    edits: { headers: [{ name: "X-Integration", value: "edited" }] },
  })
  await until(
    async () => counts.hold,
    (value) => value === 1,
  )
  check("intercept-request-edit", counts.hold === 1 && holdHeader === "edited")
  await controller.invoke(7, { type: "navigate", ...common, url: `${target}drop` })
  const dropped = await until(
    () => controller.invoke(7, { type: "snapshot", ...common }),
    (result) => !!result.snapshot?.pauses.length,
  )
  await controller.invoke(7, {
    type: "decide",
    ...common,
    generation,
    pauseID: dropped.snapshot!.pauses[0].id,
    decision: "drop",
  })
  await wait(100)
  check("intercept-request-drop", counts.drop === 0)
  check("pause-expiry-deadline", requestPause.deadline > Date.now())

  await controller.invoke(7, { type: "intercept", ...common, on: false, settle: "drop" })
  await controller.invoke(7, {
    type: "rules",
    ...common,
    revision: 0,
    rules: [
      {
        id: "request_pass",
        enabled: true,
        stage: "request",
        path: "/edit",
        method: "GET",
        action: "pass",
        find: "",
        replace: "",
      },
      {
        id: "response_rule",
        enabled: true,
        stage: "response",
        path: "/edit",
        method: "GET",
        action: "pause",
        find: "",
        replace: "",
      },
    ],
  })
  await controller.invoke(7, { type: "intercept", ...common, on: true, settle: "forward" })
  await controller.invoke(7, { type: "navigate", ...common, url: `${target}edit` })
  const response = await until(
    () => controller.invoke(7, { type: "snapshot", ...common }),
    (result) => !!result.snapshot?.pauses.some((pause) => pause.stage === "response"),
  )
  const responsePause = response.snapshot!.pauses.find((pause) => pause.stage === "response")!
  const read = await controller.invoke(7, {
    type: "decide",
    ...common,
    generation,
    pauseID: responsePause.id,
    decision: "read",
  })
  check("response-body-read", !!read.snapshot)
  await controller.invoke(7, {
    type: "decide",
    ...common,
    generation,
    pauseID: responsePause.id,
    decision: "forward",
    edits: { body: body("edited-by-controller"), status: 201 },
  })
  const editedFlow = await until(
    async () => [...flows.values()].find((flow) => flow.request.url.endsWith("/edit")),
    (flow) => !!flow && flow.responseBody.data === "edited-by-controller",
  )
  if (!editedFlow) throw new Error("edited response flow was not captured")
  check(
    "response-body-edit-command",
    editedFlow.responseBody.data === "edited-by-controller" && editedFlow.status === 201,
  )

  await controller.invoke(7, { type: "replay", ...common, flowID: secret.id, replayID: "replay_id", auth: "captured" })
  const duplicate = await controller.invoke(7, {
    type: "replay",
    ...common,
    flowID: secret.id,
    replayID: "replay_id",
    auth: "captured",
  })
  check(
    "replay-secret-preserved",
    counts.secret === 2 &&
      secretCookies.length === 2 &&
      secretCookies.every((cookie) => cookie.includes("fixture=browser")),
  )
  check("replay-duplicate-id-deduped", duplicate.created === false)
  await controller.invoke(7, { type: "intercept", ...common, on: false, settle: "forward" })
  await controller.invoke(7, { type: "navigate", ...common, url: `${target}preflight` })
  await until(
    async () => [...flows.values()].find((flow) => flow.request.method === "OPTIONS"),
    (flow) => !!flow,
  )
  const quiet = await controller.invoke(7, { type: "snapshot", ...common })
  check("preflight-missing-body-not-an-error", quiet.snapshot?.error === undefined, quiet.snapshot?.error)
  const hostile = { sender: sentinel.webContents, senderFrame: sentinel.webContents.mainFrame }
  await controller
    .toolbar(hostile as never, { type: "snapshot" })
    .then(() => check("toolbar-hostile-reject", false))
    .catch(() => check("toolbar-hostile-reject", true))
  await controller.invoke(7, { type: "close", ...common })
  const reopened = await controller.invoke(7, { type: "open", ...common })
  check(
    "close-reopen-fresh-generation",
    reopened.snapshot?.open === true && reopened.snapshot.generation !== generation,
  )
  check(
    "main-window-sentinel-unaffected",
    (await sentinel.webContents.executeJavaScript("document.querySelector('#sentinel').textContent")) ===
      "main-sentinel",
  )
  await controller.closeAll()
  sentinel.destroy()
  server.close()
  forbiddenServer.close()
  rmSync(preloadDir, { recursive: true, force: true })
  await app.quit()
}

const timeout = setTimeout(() => {
  check("bounded-15s", false, "timeout")
  process.exit(1)
}, 15000)
main()
  .then(() => {
    clearTimeout(timeout)
    const result = { checks, counts, result: checks.every((item) => item.ok) ? "pass" : "fail" }
    console.log(JSON.stringify(result))
    process.exit(result.result === "pass" ? 0 : 1)
  })
  .catch((error) => {
    clearTimeout(timeout)
    console.log(
      JSON.stringify({
        checks: [...checks, { name: "exception", ok: false, detail: String(error?.stack ?? error) }],
        counts,
        result: "fail",
      }),
    )
    process.exit(1)
  })
