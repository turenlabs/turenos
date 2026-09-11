/* eslint-disable no-console */
// S0 capability probe. This file is intentionally independent of the desktop app.
const { app, BrowserWindow, WebContentsView, net, session } = require("electron")
const http = require("node:http")
const zlib = require("node:zlib")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const checks = []
const limitations = []
const counters = { mutate: 0, drop: 0, response: 0, binary: 0, gzip: 0, redirect: 0, replay: 0 }
const observed = { requests: [], responses: [], bodies: {} }
let server
let browser
let child
let debuggerAttached = false
let timer
let cleaned = false
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "forge-security-probe-"))

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : String(detail) })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

function startServer() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname === "/mutate" && req.method === "POST") {
      counters.mutate += 1
      observed.requests.push({
        route: "mutate",
        method: req.method,
        headers: req.headers,
        body: await requestBody(req),
      })
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ body: observed.requests.at(-1).body, header: req.headers["x-probe"] || null }))
      return
    }
    if (url.pathname === "/drop") {
      counters.drop += 1
      res.end("must-not-arrive")
      return
    }
    if (url.pathname === "/response") {
      counters.response += 1
      res.setHeader("X-Origin", "original")
      res.end("origin-body")
      return
    }
    if (url.pathname === "/binary") {
      counters.binary += 1
      res.setHeader("Content-Type", "application/octet-stream")
      res.end(Buffer.from([0, 1, 2, 255, 254]))
      return
    }
    if (url.pathname === "/gzip") {
      counters.gzip += 1
      res.setHeader("Content-Encoding", "gzip")
      res.end(zlib.gzipSync("gzip-body"))
      return
    }
    if (url.pathname === "/redirect") {
      counters.redirect += 1
      res.statusCode = 302
      res.setHeader("Location", "/redirect-target")
      res.end()
      return
    }
    if (url.pathname === "/redirect-target") {
      res.end("redirect-target")
      return
    }
    if (url.pathname === "/replay") {
      counters.replay += 1
      observed.requests.push({
        route: "replay",
        cookie: req.headers.cookie || null,
        ambient: req.headers["x-ambient-cookie"] || null,
      })
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(observed.requests.at(-1)))
      return
    }
    res.setHeader("Content-Type", "text/html")
    res.end("<!doctype html><title>probe shell</title><div id=sentinel>main-window-sentinel</div>")
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
}

function cdp(method, params = {}) {
  return child.webContents.debugger.sendCommand(method, params)
}

async function rendererFetch(url, options = {}) {
  const expression = `fetch(${JSON.stringify(url)}, ${JSON.stringify(options)}).then(async r => ({status:r.status, headers:Object.fromEntries(r.headers.entries()), text:await r.text()})).catch(e => ({error:String(e)}))`
  return child.webContents.executeJavaScript(expression)
}

async function main() {
  app.setPath("userData", userData)
  const port = await startServer()
  const base = `http://127.0.0.1:${port}`
  await app.whenReady()

  browser = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await browser.loadURL(`${base}/`)
  const sentinel = await browser.webContents.executeJavaScript("document.querySelector('#sentinel').textContent")
  check("main-window-sentinel-before", sentinel === "main-window-sentinel", sentinel)

  child = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  browser.contentView.addChildView(child)
  child.setBounds({ x: 0, y: 0, width: 900, height: 600 })
  await child.webContents.loadURL("about:blank")
  check("child-webcontentsview", child.webContents.getURL() === "about:blank", child.webContents.getURL())
  check("child-no-preload", child.webContents.getLastWebPreferences().preload == null, "preload absent")

  try {
    child.webContents.debugger.attach("1.3")
    debuggerAttached = true
    check("cdp-attach-after-about-blank", true)
    await child.webContents.loadURL(`${base}/`)
  } catch (error) {
    check("cdp-attach-after-about-blank", false, error.message)
    throw error
  }

  const paused = new Map()
  child.webContents.debugger.on("message", async (_event, method, params) => {
    if (method === "Network.requestWillBeSent")
      observed.requests.push({ cdp: "request", url: params.request.url, method: params.request.method })
    if (method === "Network.responseReceived")
      observed.responses.push({ url: params.response.url, status: params.response.status })
    if (method !== "Fetch.requestPaused") return
    const p = params
    try {
      if (p.request.url.endsWith("/mutate")) {
        paused.set(p.requestId, true)
        await cdp("Fetch.continueRequest", {
          requestId: p.requestId,
          method: "POST",
          postData: Buffer.from("modified-body").toString("base64"),
          headers: [
            { name: "Content-Type", value: "text/plain" },
            { name: "X-Probe", value: "modified-header" },
          ],
        })
        return
      }
      if (p.request.url.endsWith("/drop")) {
        await cdp("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" })
        return
      }
      if (p.request.url.endsWith("/response") && p.responseStatusCode) {
        await cdp("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "text/plain" },
            { name: "X-Probe-Response", value: "edited" },
          ],
          body: Buffer.from("edited-body").toString("base64"),
        })
        return
      }
      await cdp("Fetch.continueRequest", { requestId: p.requestId })
    } catch (error) {
      limitations.push(`Fetch pause handling: ${error.message}`)
      try {
        await cdp("Fetch.continueRequest", { requestId: p.requestId })
      } catch {}
    }
  })
  await cdp("Network.enable", { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 })
  await cdp("Fetch.enable", {
    patterns: [
      { urlPattern: "*", requestStage: "Request" },
      { urlPattern: "*", requestStage: "Response" },
    ],
  })

  const mutate = await rendererFetch(`${base}/mutate`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Probe": "original" },
    body: "original-body",
  })
  check(
    "request-method-body-header-edit",
    mutate.status === 200 && mutate.text.includes("modified-body") && mutate.text.includes("modified-header"),
    JSON.stringify(mutate),
  )

  const drop = await rendererFetch(`${base}/drop`)
  await wait(80)
  check(
    "request-drop-server-counter-zero",
    counters.drop === 0,
    JSON.stringify({ result: drop, counter: counters.drop }),
  )

  const response = await rendererFetch(`${base}/response`)
  check(
    "response-status-header-body-edit",
    response.status === 200 && response.headers["x-probe-response"] === "edited" && response.text === "edited-body",
    JSON.stringify(response),
  )

  await cdp("Fetch.disable")
  const binary = await rendererFetch(`${base}/binary`)
  const gzip = await rendererFetch(`${base}/gzip`)
  const redirect = await rendererFetch(`${base}/redirect`, { redirect: "manual" })
  check("binary-body", binary.text.length > 0, JSON.stringify(binary))
  check("gzip-body", gzip.text === "gzip-body", JSON.stringify(gzip))
  check("redirect-manual", redirect.status === 0, JSON.stringify(redirect))
  limitations.push(
    "Chromium fetch({redirect:'manual'}) exposes a cross-origin redirect as an opaque response (status 0); CDP Network remains the redirect-observation path.",
  )
  check(
    "network-response-events",
    observed.responses.some((item) => item.url.endsWith("/binary")) &&
      observed.responses.some((item) => item.url.endsWith("/gzip")),
    JSON.stringify(observed.responses.slice(-8)),
  )

  const browserSession = session.fromPartition("probe-browser")
  await browserSession.cookies.set({ url: base, name: "ambient", value: "must-not-replay" })
  const isolated = session.fromPartition("probe-replay-isolated")
  const replayResult = await new Promise((resolve, reject) => {
    const req = net.request({
      method: "GET",
      url: `${base}/replay`,
      session: isolated,
      headers: { Cookie: "explicit=replay", "X-Replay": "yes" },
    })
    const parts = []
    req.on("response", (res) => {
      res.on("data", (part) => parts.push(part))
      res.on("end", () => resolve(JSON.parse(Buffer.concat(parts).toString())))
    })
    req.on("error", reject)
    req.end()
  })
  check(
    "isolated-net-request-explicit-cookie",
    replayResult.cookie === "explicit=replay" && replayResult.ambient === null,
    JSON.stringify(replayResult),
  )
  limitations.push(
    "Duplicate request headers are not representable by Electron net.request's object-shaped headers option; CDP header arrays support duplicates.",
  )

  const after = await browser.webContents.executeJavaScript("document.querySelector('#sentinel').textContent")
  check("main-window-unaffected-sentinel", after === "main-window-sentinel", after)
}

async function cleanup() {
  if (cleaned) return
  cleaned = true
  clearTimeout(timer)
  try {
    if (debuggerAttached) child.webContents.debugger.detach()
  } catch {}
  try {
    if (browser && !browser.isDestroyed()) browser.destroy()
  } catch {}
  try {
    if (server) await new Promise((resolve) => server.close(resolve))
  } catch {}
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {}
  const result = { checks, limitations, counters, result: checks.every((item) => item.ok) ? "pass" : "fail" }
  console.log(JSON.stringify(result))
  app.quit()
  setTimeout(() => process.exit(result.result === "pass" ? 0 : 1), 100)
}

timer = setTimeout(() => {
  limitations.push("Probe timed out after 20 seconds")
  cleanup()
}, 20000)
app.on("window-all-closed", () => {})
main()
  .then(cleanup)
  .catch((error) => {
    check("probe-exception", false, error.stack || error.message)
    cleanup()
  })
