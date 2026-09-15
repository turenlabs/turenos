import { BrowserWindow, WebContentsView, net, session } from "electron"
import { randomUUID } from "node:crypto"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { ProxyPolicy } from "@turenlabs/protocol/proxy-policy"

const LIMIT = ProxyPolicy.BODY_LIMIT
// Held traffic waits long enough for a human or an agent turn to decide; it still expires by drop, never by silent forward.
const PAUSE_TTL = 300_000
const empty = (state: SecurityProxy.Body["state"] = "unavailable"): SecurityProxy.Body => ({
  data: "",
  encoding: "utf8",
  state,
  size: 0,
})
const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
const text = (input: unknown) => (typeof input === "string" ? input : "")
const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : undefined)
function headers(input: unknown): SecurityProxy.Header[] {
  const items = Array.isArray(input)
    ? input.flatMap((entry: unknown) => {
        const item = record(entry)
        return typeof item.name === "string" && typeof item.value === "string"
          ? [{ name: item.name, value: item.value }]
          : []
      })
    : Object.entries(record(input)).flatMap(([name, value]) => (typeof value === "string" ? [{ name, value }] : []))
  // A persisted flow carries up to four header blocks; bounding each keeps a
  // put command well under the bridge's 8 MiB serialized-command cap.
  const bounded: SecurityProxy.Header[] = []
  let size = 0
  for (const item of items.slice(0, 128)) {
    size += item.name.length + item.value.length
    if (size > 65536) break
    bounded.push(item)
  }
  return bounded
}
const header = (items: readonly SecurityProxy.Header[], name: string) =>
  items.find((item) => item.name.toLowerCase() === name)?.value
const framing = /^(host|content-length|transfer-encoding|connection|keep-alive|trailer|upgrade|proxy-connection)$/i
// ":"-prefixed HTTP/2 pseudo-headers are also transport-derived from the method and URL.
const transportHeaders = (items: readonly SecurityProxy.Header[]) =>
  items.filter((item) => !item.name.startsWith(":") && !framing.test(item.name))
async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
  expire?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expire?.()
          reject(new Error(message))
        }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function body(bytes: Buffer, state: SecurityProxy.Body["state"] = "complete"): SecurityProxy.Body {
  const limited = bytes.subarray(0, LIMIT)
  const utf8 = limited.toString("utf8")
  const encoding = Buffer.from(utf8).equals(limited) ? "utf8" : "base64"
  return {
    data: encoding === "utf8" ? utf8 : limited.toString("base64"),
    encoding,
    size: bytes.length,
    state: bytes.length > LIMIT ? "truncated" : state,
  }
}
function message(input: unknown): SecurityProxy.Message {
  const value = record(input)
  return {
    url: text(value.url),
    method: text(value.method),
    headers: headers(value.headers),
    body:
      typeof value.postData === "string"
        ? body(Buffer.from(value.postData))
        : empty(value.hasPostData === true ? "unavailable" : "complete"),
  }
}
function masked(pause: SecurityProxy.Pause): SecurityProxy.Pause {
  return {
    ...pause,
    request: ProxyPolicy.publicMessage(pause.request),
    headers: ProxyPolicy.publicHeaders(pause.headers),
    body: ProxyPolicy.publicBody(pause.body),
  }
}
function safeBody(items: readonly SecurityProxy.Header[]) {
  const length = header(items, "content-length")
  return (
    length !== undefined &&
    /^\d+$/.test(length) &&
    Number(length) <= LIMIT &&
    !header(items, "content-encoding") &&
    !/text\/event-stream/i.test(header(items, "content-type") ?? "")
  )
}

type Pending = {
  value: SecurityProxy.Pause
  fetchID: string
  sessionID?: string
  flow: SecurityProxy.Flow
  timer: ReturnType<typeof setTimeout>
  busy?: Promise<void>
  taken: boolean
}
type Binding = { ownerID: number; case: SecurityProxy.Case; generation?: Generation; serial: Promise<unknown> }
type Generation = {
  id: string
  binding: Binding
  window: BrowserWindow
  view: WebContentsView
  session: Electron.Session
  shell: string
  intercept: boolean
  error?: string
  closed: boolean
  closing?: Promise<void>
  ready?: Promise<void>
  pauses: Map<string, Pending>
  flows: Map<string, SecurityProxy.Flow>
  hops: Map<string, number>
  tasks: Set<Promise<unknown>>
  sessions: Set<string>
  extraHops: Map<string, number>
  extraHeaders: Map<string, SecurityProxy.Header[]>
}

export function createSecurityProxyController(deps: {
  store: (cmd: SecurityProxy.StoreCommand) => Promise<SecurityProxy.Result>
  shellURL: () => string
  shellPreload: string
  protectedOrigins: () => string[]
  focusProxy: (ownerID: number, caseID: string) => void
}) {
  const bindings = new Map<string, Binding>()
  const claims = new Map<string, number>()
  const released = new Set<number>()
  const replays = new Set<Promise<SecurityProxy.Result>>()
  const replayAborts = new Map<number, Set<() => void>>()
  let shuttingDown = false
  let connectionEpoch = 0
  // The bridge admits limited in-flight commands and the store serializes on a
  // semaphore anyway, so concurrent calls only risk capacity rejections. One
  // lane keeps capture flushes, pause settlements, replays, and UI reads ordered.
  let storeLane: Promise<unknown> = Promise.resolve()
  const store = (command: SecurityProxy.StoreCommand): Promise<SecurityProxy.Result> => {
    const result = storeLane.then(() => deps.store(command))
    storeLane = result.catch(() => undefined)
    return result
  }
  const key = (owner: SecurityProxy.Owner, caseID: string) =>
    JSON.stringify([owner.directory, owner.workspaceID ?? null, owner.sessionID ?? null, caseID])
  const allowed = (_binding: Binding, url: string) => {
    const parsed = URL.parse(url)
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) return "blocked"
    if (deps.protectedOrigins().includes(parsed.origin)) return "blocked"
    return "target"
  }
  const report = (generation: Generation, error: unknown) => {
    generation.error = (error instanceof Error ? error.message : "Security browser operation failed")
      .replace(/https?:\/\/\S+/g, "[URL]")
      .slice(0, 1024)
  }
  const track = (generation: Generation, task: Promise<unknown>) => {
    generation.tasks.add(task)
    void task.catch((error: unknown) => report(generation, error)).finally(() => generation.tasks.delete(task))
  }
  const cdp = async (
    generation: Generation,
    method: string,
    params: Record<string, unknown> = {},
    sessionID?: string,
  ): Promise<Record<string, unknown>> => {
    if (generation.closed || generation.view.webContents.isDestroyed()) throw new Error("Security browser is closed")
    // Electron emits an empty session ID for the root target, but rejects it as an attached-session argument.
    const command = sessionID
      ? generation.view.webContents.debugger.sendCommand(method, params, sessionID)
      : generation.view.webContents.debugger.sendCommand(method, params)
    return record(
      await within(command, 10000, "Capture command timed out", () =>
        fatal(generation, new Error("Capture command timed out; target destroyed")),
      ),
    )
  }
  const snapshot = (binding: Binding): SecurityProxy.Result => {
    const generation = binding.generation
    const contents = generation && !generation.closed ? generation.view.webContents : undefined
    return {
      snapshot: {
        caseID: binding.case.id,
        generation: generation?.id ?? "closed",
        open: !!generation && !generation.closed,
        url: contents && !contents.isDestroyed() ? ProxyPolicy.publicURL(contents.getURL()) : "",
        intercept: generation && !generation.closed ? generation.intercept : false,
        error: generation?.error,
        pauses: generation ? [...generation.pauses.values()].map((pause) => masked(pause.value)) : [],
      },
    }
  }
  const put = (generation: Generation, flow: SecurityProxy.Flow) =>
    store({ type: "put", owner: generation.binding.case.owner, caseID: generation.binding.case.id, flow })

  function close(generation: Generation): Promise<void> {
    if (generation.closing) return generation.closing
    generation.closed = true
    generation.closing = (async () => {
      generation.pauses.forEach((pause) => clearTimeout(pause.timer))
      generation.pauses.clear()
      // Never let remote beforeunload hold the app or retain its partition.
      const contents = generation.view.webContents
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
      if (!generation.window.isDestroyed()) generation.window.destroy()
      await within(
        Promise.allSettled([...generation.tasks]),
        2000,
        "Capture drain timed out; history may have gaps",
      ).catch((error: unknown) => report(generation, error))
      try {
        await within(
          Promise.all(
            [...generation.flows.values()].map((flow) =>
              put(generation, { ...flow, state: "unknown", error: "Browser closed before capture completed" }),
            ),
          ),
          2000,
          "Final capture persistence timed out; history may have gaps",
        )
      } finally {
        await within(
          Promise.all([
            generation.session.clearCache(),
            generation.session.clearStorageData(),
            generation.session.clearAuthCache(),
            generation.session.closeAllConnections(),
          ]),
          2000,
          "Browser partition cleanup timed out",
        )
        generation.flows.clear()
        generation.hops.clear()
        generation.sessions.clear()
        generation.extraHops.clear()
        generation.extraHeaders.clear()
      }
    })()
    return generation.closing
  }
  function fatal(generation: Generation, error: unknown) {
    report(generation, error)
    void close(generation).catch((failure: unknown) => report(generation, failure))
  }
  function deadline(generation: Generation, pending: Pending) {
    return setTimeout(
      () => {
        // A stream takeover / outstanding CDP command cannot be safely raced with failRequest.
        if (pending.busy) return fatal(generation, new Error("Paused operation timed out; target destroyed"))
        track(generation, decide(generation, pending, "drop"))
        report(generation, new Error("Paused request expired and was dropped"))
      },
      Math.max(0, pending.value.deadline - Date.now()),
    )
  }
  async function readBody(generation: Generation, pending: Pending) {
    if (pending.value.stage !== "response") throw new Error("Only response bodies need explicit reading")
    if (pending.value.body.state === "complete") return
    if (pending.taken) throw new Error("Response stream was already consumed; drop this response")
    pending.value = { ...pending.value, reading: true }
    try {
      if (/text\/event-stream/i.test(header(pending.value.headers, "content-type") ?? ""))
        throw new Error("Streaming event bodies cannot be edited")
      if (safeBody(pending.value.headers)) {
        const result = await cdp(generation, "Fetch.getResponseBody", { requestId: pending.fetchID }, pending.sessionID)
        pending.value = {
          ...pending.value,
          body: body(Buffer.from(text(result.body), result.base64Encoded === true ? "base64" : "utf8")),
        }
        return
      }
      const result = await cdp(
        generation,
        "Fetch.takeResponseBodyAsStream",
        { requestId: pending.fetchID },
        pending.sessionID,
      )
      const handle = text(result.stream)
      if (!handle) throw new Error("Response stream unavailable")
      pending.taken = true
      const chunks: Buffer[] = []
      let size = 0
      try {
        while (size <= LIMIT) {
          const chunk = await cdp(
            generation,
            "IO.read",
            { handle, size: Math.min(65536, LIMIT + 1 - size) },
            pending.sessionID,
          )
          const bytes = Buffer.from(text(chunk.data), chunk.base64Encoded === true ? "base64" : "utf8")
          size += bytes.length
          chunks.push(bytes)
          if (chunk.eof === true) {
            pending.value = { ...pending.value, body: body(Buffer.concat(chunks)) }
            return
          }
        }
        pending.value = { ...pending.value, body: body(Buffer.concat(chunks), "truncated") }
        throw new Error("Response exceeds 1 MiB; stream takeover requires dropping this response")
      } finally {
        await cdp(generation, "IO.close", { handle }, pending.sessionID)
      }
    } finally {
      pending.value = { ...pending.value, reading: false }
    }
  }
  function decide(
    generation: Generation,
    pending: Pending,
    decision: "forward" | "drop" | "read",
    edits?: SecurityProxy.Edits,
  ): Promise<void> {
    if (pending.busy) return Promise.reject(new Error("A decision or body read is already in progress"))
    if (!generation.pauses.has(pending.value.id)) return Promise.resolve()
    if (edits) ProxyPolicy.validateEdits(edits)
    if (decision === "forward" && edits?.url && allowed(generation.binding, edits.url) !== "target")
      return Promise.reject(new Error("Edited URL must be an allowed HTTP(S) destination"))
    const task = (async () => {
      if (decision === "read")
        return within(readBody(generation, pending), 10000, "Response read timed out", () =>
          fatal(generation, new Error("Response read timed out; target destroyed")),
        )
      if (
        decision === "forward" &&
        pending.value.stage === "response" &&
        (edits || pending.taken) &&
        !edits?.body &&
        pending.value.body.state !== "complete"
      )
        throw new Error("Read a complete response before editing or forwarding a taken stream")
      if (decision === "forward" && pending.value.stage === "request" && edits?.status !== undefined)
        throw new Error("Status is a response-only edit")
      if (
        decision === "forward" &&
        pending.value.stage === "response" &&
        (edits?.url !== undefined || edits?.method !== undefined)
      )
        throw new Error("URL and method are request-only edits")
      const update = () =>
        generation.flows.forEach((flow, id) => {
          if (flow.id === pending.flow.id) generation.flows.set(id, pending.flow)
        })
      // Remove before issuing a terminal command: an uncertain acknowledgement is never retried.
      generation.pauses.delete(pending.value.id)
      try {
        if (decision === "drop") {
          pending.flow = { ...pending.flow, state: "dropped" }
          generation.flows.forEach((flow, id) => {
            if (flow.id === pending.flow.id) generation.flows.delete(id)
          })
          await cdp(
            generation,
            "Fetch.failRequest",
            { requestId: pending.fetchID, errorReason: "BlockedByClient" },
            pending.sessionID,
          )
        } else if (pending.value.stage === "request") {
          const original = pending.value.request
          const request = {
            ...original,
            ...edits,
            headers: edits?.headers ?? original.headers,
            body: edits?.body ?? original.body,
          }
          pending.flow = { ...pending.flow, request, ...(edits ? { originalRequest: original } : {}) }
          update()
          await cdp(
            generation,
            "Fetch.continueRequest",
            {
              requestId: pending.fetchID,
              ...(edits?.url !== undefined ? { url: request.url } : {}),
              ...(edits?.method !== undefined ? { method: request.method } : {}),
              ...(edits?.headers ? { headers: transportHeaders(request.headers) } : {}),
              ...(edits?.body ? { postData: Buffer.from(ProxyPolicy.bytes(request.body)).toString("base64") } : {}),
            },
            pending.sessionID,
          )
        } else if (edits || pending.taken) {
          const responseBody = edits?.body ?? pending.value.body
          const responseHeaders = transportHeaders(edits?.headers ?? pending.value.headers).filter(
            (item) => !/^(content-encoding|content-md5|digest)$/i.test(item.name),
          )
          pending.flow = {
            ...pending.flow,
            status: edits?.status ?? pending.value.status,
            responseHeaders,
            responseBody,
            originalResponse: {
              status: pending.value.status ?? 200,
              headers: pending.value.headers,
              body: pending.value.body,
            },
          }
          update()
          await cdp(
            generation,
            "Fetch.fulfillRequest",
            {
              requestId: pending.fetchID,
              responseCode: edits?.status ?? pending.value.status,
              responseHeaders,
              body: Buffer.from(ProxyPolicy.bytes(responseBody)).toString("base64"),
            },
            pending.sessionID,
          )
        } else await cdp(generation, "Fetch.continueResponse", { requestId: pending.fetchID }, pending.sessionID)
        // A persistence failure loses the history record, not the decision; keep the browser alive.
        if (decision === "drop")
          await put(generation, pending.flow).catch((error: unknown) => report(generation, error))
      } catch (error) {
        fatal(generation, new Error("Pause decision failed or acknowledgement unknown; target destroyed"))
        throw error
      } finally {
        clearTimeout(pending.timer)
      }
    })()
    pending.busy = task
    void task
      .finally(() => {
        pending.busy = undefined
      })
      .catch(() => {})
    return task
  }
  async function configure(generation: Generation, onlySession?: string) {
    const request = generation.intercept
    const response =
      generation.intercept && generation.binding.case.rules.some((rule) => rule.enabled && rule.stage === "response")
    await Promise.all(
      (onlySession ? [onlySession] : [undefined, ...generation.sessions]).map(async (sessionID) => {
        if (!request && !response) {
          await cdp(generation, "Fetch.disable", {}, sessionID)
          return
        }
        await cdp(
          generation,
          "Fetch.enable",
          {
            patterns: [
              ...(request ? [{ urlPattern: "*", requestStage: "Request" }] : []),
              ...(response ? [{ urlPattern: "*", requestStage: "Response" }] : []),
            ],
          },
          sessionID,
        )
      }),
    )
  }
  async function onMessage(generation: Generation, method: string, input: unknown, sessionID?: string) {
    if (generation.closed) return
    const params = record(input)
    if (method === "Target.attachedToTarget") {
      const attached = text(params.sessionId)
      if (!attached) throw new Error("Invalid child capture session")
      generation.sessions.add(attached)
      await cdp(
        generation,
        "Network.enable",
        { maxTotalBufferSize: 16 * LIMIT, maxResourceBufferSize: LIMIT, maxPostDataSize: LIMIT },
        attached,
      )
      await configure(generation, attached)
      await cdp(generation, "Runtime.runIfWaitingForDebugger", {}, attached)
      return
    }
    if (method === "Target.detachedFromTarget") {
      generation.sessions.delete(text(params.sessionId))
      return
    }
    const requestID = text(params.requestId)
    const correlation = `${sessionID ?? "root"}:${requestID}`
    if (method === "Network.requestWillBeSentExtraInfo") {
      if (generation.extraHops.size >= 1000) throw new Error("Header correlation capacity exceeded")
      const hop = (generation.extraHops.get(correlation) ?? -1) + 1
      generation.extraHops.set(correlation, hop)
      const flow = generation.flows.get(correlation)
      // A known hop with no target flow is dependency traffic; never retain its headers.
      if (!flow && generation.hops.get(correlation) === hop) return
      const items = headers(params.headers)
      if (flow && generation.hops.get(correlation) === hop) {
        generation.flows.set(correlation, { ...flow, request: { ...flow.request, headers: items } })
        return
      }
      if (generation.extraHeaders.size >= 100) throw new Error("Uncorrelated header capture capacity exceeded")
      const retained = [...generation.extraHeaders.values(), items].reduce(
        (total, list) =>
          total + list.reduce((sum, item) => sum + Buffer.byteLength(item.name) + Buffer.byteLength(item.value), 0),
        0,
      )
      if (retained > LIMIT) throw new Error("Uncorrelated header capture exceeds 1 MiB")
      // ExtraInfo may precede requestWillBeSent. Keep it only until scope and hop are known.
      generation.extraHeaders.set(`${correlation}:${hop}`, items)
      return
    }
    if (method === "Network.requestWillBeSent") {
      const previous = generation.flows.get(correlation)
      generation.flows.delete(correlation)
      if (previous && params.redirectResponse) {
        const response = record(params.redirectResponse)
        // A persistence failure loses the history record, not the capture loop.
        await put(generation, {
          ...previous,
          status: number(response.status),
          responseHeaders: headers(response.headers),
          state: "complete",
          durationMs: Date.now() - previous.createdAt,
        }).catch((error: unknown) => report(generation, error))
      }
      if (generation.hops.size >= 1000) throw new Error("Request correlation capacity exceeded")
      const hop = (generation.hops.get(correlation) ?? -1) + 1
      generation.hops.set(correlation, hop)
      if (allowed(generation.binding, text(record(params.request).url)) !== "target") {
        generation.extraHeaders.delete(`${correlation}:${hop}`)
        return
      }
      const observed = message(params.request)
      const extra = generation.extraHeaders.get(`${correlation}:${hop}`)
      generation.extraHeaders.delete(`${correlation}:${hop}`)
      const request = extra ? { ...observed, headers: extra } : observed
      if (!request.url.startsWith("http")) return
      if (
        generation.flows.size >= 100 ||
        [...generation.flows.values()].reduce(
          (sum, flow) => sum + flow.request.body.data.length + flow.responseBody.data.length,
          0,
        ) >
          16 * LIMIT
      )
        throw new Error("Capture capacity exceeded; close and reopen browser")
      generation.flows.set(correlation, {
        id: `${generation.id}_${correlation.replace(/[^a-zA-Z0-9_-]/g, "_")}_${hop}`.slice(0, 128),
        caseID: generation.binding.case.id,
        source: "browser",
        request,
        responseHeaders: [],
        responseBody: empty(),
        state: "unknown",
        createdAt: Date.now(),
        note: "",
      })
      return
    }
    const flow = generation.flows.get(correlation)
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      // Retire correlation secrets at completion; close/reset also clears all generation maps.
      generation.hops.delete(correlation)
      generation.extraHops.delete(correlation)
      generation.extraHeaders.forEach((_items, key) => {
        if (key.startsWith(`${correlation}:`)) generation.extraHeaders.delete(key)
      })
    }
    if (method === "Network.responseReceived" && flow) {
      if (flow.originalResponse) return
      const response = record(params.response)
      const items = headers(response.headers)
      generation.flows.set(correlation, {
        ...flow,
        status: number(response.status),
        responseHeaders: items,
        responseBody: empty(
          /text\/event-stream/i.test(header(items, "content-type") ?? "") ? "streaming" : "unavailable",
        ),
      })
      return
    }
    if ((method === "Network.loadingFinished" || method === "Network.loadingFailed") && flow) {
      generation.flows.delete(correlation)
      let captured = flow.responseBody
      // Network's resource/total buffers are bounded before navigation; unlike Fetch, this reads only a completed buffered resource.
      // Bodies are routinely absent (preflights, empty or cached responses, navigation, eviction); that is a capture state, not an error.
      if (method === "Network.loadingFinished" && flow.responseBody.state === "unavailable" && !flow.originalResponse) {
        const result = await cdp(generation, "Network.getResponseBody", { requestId: requestID }, sessionID).catch(
          () => undefined,
        )
        if (result) captured = body(Buffer.from(text(result.body), result.base64Encoded === true ? "base64" : "utf8"))
        if (!result && (number(params.encodedDataLength) ?? 0) > LIMIT)
          captured = { ...empty("truncated"), size: number(params.encodedDataLength) ?? 0 }
      }
      // A persistence failure loses the history record, not the capture loop.
      await put(generation, {
        ...flow,
        responseBody: captured,
        state: method === "Network.loadingFailed" ? "failed" : "complete",
        durationMs: Date.now() - flow.createdAt,
        ...(method === "Network.loadingFailed" ? { error: text(params.errorText).slice(0, 1024) } : {}),
      }).catch((error: unknown) => report(generation, error))
      return
    }
    if (method !== "Fetch.requestPaused") return
    const request = message(params.request)
    const stage =
      number(params.responseStatusCode) !== undefined || params.responseErrorReason !== undefined
        ? "response"
        : "request"
    const scope = allowed(generation.binding, request.url)
    if (scope === "blocked") {
      await cdp(generation, "Fetch.failRequest", { requestId: requestID, errorReason: "BlockedByClient" }, sessionID)
      return
    }
    // Path rules resolve against the request's own origin so they match anywhere;
    // absolute rule paths keep their explicit origin.
    const ruleBase = URL.parse(request.url)?.origin || "https://scope.invalid"
    const rule =
      scope === "target"
        ? generation.binding.case.rules.find(
            (rule) =>
              rule.enabled &&
              rule.stage === stage &&
              (!rule.method || rule.method === "*" || rule.method.toUpperCase() === request.method.toUpperCase()) &&
              ProxyPolicy.matches(request.url, new URL(rule.path || "/", ruleBase).href),
          )
        : undefined
    if (!generation.intercept || rule?.action === "pass" || (!rule && !(generation.intercept && stage === "request"))) {
      await cdp(
        generation,
        stage === "response" ? "Fetch.continueResponse" : "Fetch.continueRequest",
        { requestId: requestID },
        sessionID,
      )
      return
    }
    if (generation.pauses.size >= 50) {
      await cdp(generation, "Fetch.failRequest", { requestId: requestID, errorReason: "BlockedByClient" }, sessionID)
      report(generation, new Error("Pause queue full; new request dropped"))
      return
    }
    const networkKey = `${sessionID ?? "root"}:${text(params.networkId)}`
    const captured = generation.flows.get(networkKey) ?? {
      id: randomUUID(),
      caseID: generation.binding.case.id,
      source: "browser" as const,
      request,
      responseHeaders: [],
      responseBody: empty(),
      state: "unknown" as const,
      createdAt: Date.now(),
      note: "",
    }
    if (!generation.flows.has(networkKey)) generation.flows.set(networkKey, captured)
    const value: SecurityProxy.Pause = {
      id: randomUUID(),
      generation: generation.id,
      stage,
      request,
      status: number(params.responseStatusCode),
      headers: headers(params.responseHeaders),
      body: stage === "request" ? request.body : empty(),
      deadline: Date.now() + PAUSE_TTL,
      reading: false,
    }
    const pending: Pending = {
      value,
      fetchID: requestID,
      sessionID,
      flow: captured,
      timer: setTimeout(() => {}, 0),
      taken: false,
    }
    clearTimeout(pending.timer)
    pending.timer = deadline(generation, pending)
    generation.pauses.set(value.id, pending)
    if (rule?.action !== "replace") return
    if (!rule.find) throw new Error("Literal replacement requires a nonempty search string")
    if (stage === "response") await decide(generation, pending, "read")
    const original = pending.value.body
    if (original.state !== "complete" || original.encoding !== "utf8" || Buffer.byteLength(original.data) > 65536)
      throw new Error("Literal replacement requires complete text no larger than 64 KiB")
    const replacement = body(Buffer.from(ProxyPolicy.replaceLiteral(original.data, rule.find, rule.replace)))
    if (replacement.state !== "complete") throw new Error("Replacement exceeds body limit")
    pending.flow = { ...pending.flow, note: `Applied literal replacement rule ${rule.id}` }
    await decide(generation, pending, "forward", { body: replacement })
  }

  function open(binding: Binding): Generation {
    if (binding.generation && !binding.generation.closed) return binding.generation
    const isolated = session.fromPartition(`security-browser-${randomUUID()}`, { cache: false })
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    const shell = deps.shellURL()
    // Trusted local chrome uses the registered renderer protocol; only remote content gets the disposable session.
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      title: "Security Browser",
      webPreferences: { preload: deps.shellPreload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const generation: Generation = {
      id: randomUUID(),
      binding,
      window,
      view,
      session: isolated,
      shell,
      intercept: false,
      closed: false,
      pauses: new Map(),
      flows: new Map(),
      hops: new Map(),
      tasks: new Set(),
      sessions: new Set(),
      extraHops: new Map(),
      extraHeaders: new Map(),
    }
    binding.generation = generation
    isolated.on("will-download", (event) => {
      event.preventDefault()
      report(generation, new Error("Downloads are unsupported in Security Browser"))
    })
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const blocked = details.url !== "about:blank" && allowed(binding, details.url) === "blocked"
      callback({ cancel: blocked || generation.closed })
    })
    view.webContents.setWindowOpenHandler(() => {
      report(generation, new Error("Popups and popup OAuth are unsupported; authorize same-tab navigation explicitly"))
      return { action: "deny" }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("render-process-gone", () => {
      if (!generation.closed) fatal(generation, new Error("Security browser toolbar stopped; target destroyed"))
    })
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== shell) event.preventDefault()
    })
    window.webContents.on("will-redirect", (event) => event.preventDefault())
    view.webContents.on("will-frame-navigate", (event) => {
      if (allowed(binding, event.url) === "blocked") {
        event.preventDefault()
      }
    })
    view.webContents.on("will-redirect", (event, url) => {
      if (allowed(binding, url) === "blocked") {
        event.preventDefault()
      }
    })
    view.webContents.on("will-attach-webview", (event) => event.preventDefault())
    view.webContents.on("render-process-gone", () => {
      if (!generation.closed) fatal(generation, new Error("Security browser renderer stopped"))
    })
    window.on("close", (event) => {
      if (!generation.closed) {
        event.preventDefault()
        void close(generation).catch((error: unknown) => report(generation, error))
      }
    })
    window.contentView.addChildView(view)
    const resize = () => {
      const bounds = window.getContentBounds()
      view.setBounds({ x: 0, y: 90, width: bounds.width, height: Math.max(0, bounds.height - 90) })
    }
    resize()
    window.on("resize", resize)
    generation.ready = (async () => {
      await window.loadURL(shell)
      await view.webContents.loadURL("about:blank")
      if (generation.closed) return
      view.webContents.debugger.attach("1.3")
      view.webContents.debugger.on("detach", () => {
        if (!generation.closed) fatal(generation, new Error("Capture debugger detached; target destroyed"))
      })
      // Preserve CDP event order without holding the event queue on user decisions.
      let events = Promise.resolve()
      view.webContents.debugger.on("message", (_event, method, params: unknown, sessionID) => {
        if (
          generation.closed ||
          ![
            "Target.attachedToTarget",
            "Target.detachedFromTarget",
            "Network.requestWillBeSent",
            "Network.requestWillBeSentExtraInfo",
            "Network.responseReceived",
            "Network.loadingFinished",
            "Network.loadingFailed",
            "Fetch.requestPaused",
          ].includes(method)
        )
          return
        if (generation.tasks.size >= 64) {
          fatal(generation, new Error("Capture backlog exceeded; target destroyed"))
          return
        }
        events = events
          .then(() => onMessage(generation, method, params, sessionID || undefined))
          .catch((error: unknown) => {
            fatal(generation, error)
          })
        track(generation, events)
      })
      await cdp(generation, "Network.enable", {
        maxTotalBufferSize: 16 * LIMIT,
        maxResourceBufferSize: LIMIT,
        maxPostDataSize: LIMIT,
      })
      await cdp(generation, "Network.setBypassServiceWorker", { bypass: true })
      await cdp(generation, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }, { exclude: true }],
      })
      await configure(generation)
    })().catch((error: unknown) => {
      fatal(generation, error)
      throw error
    })
    return generation
  }

  async function replay(
    ownerID: number,
    binding: Binding,
    command: Extract<SecurityProxy.Command, { type: "replay" }>,
  ): Promise<SecurityProxy.Result> {
    const epoch = connectionEpoch
    const result = await store({
      type: "reveal",
      owner: command.owner,
      caseID: command.caseID,
      flowID: command.flowID,
    })
    if (!result.flow) throw new Error("Captured flow not found")
    if (command.edits) ProxyPolicy.validateEdits(command.edits)
    if (command.edits?.status !== undefined) throw new Error("Replay cannot edit response status")
    const request = { ...result.flow.request, ...command.edits }
    if (allowed(binding, request.url) !== "target") throw new Error("Replay URL must be an allowed HTTP(S) destination")
    ProxyPolicy.validateEdits({ method: request.method })
    const bytes = Buffer.from(ProxyPolicy.bytes(request.body))
    const items = transportHeaders(request.headers)
    ProxyPolicy.validateEdits({ headers: items })
    if (new Set(items.map((item) => item.name.toLowerCase())).size !== items.length)
      throw new Error("Replay cannot represent duplicate header names")
    if (command.auth === "live") {
      const generation = binding.generation
      if (!generation || generation.closed) throw new Error("Live browser cookies require an open browser")
      const cookies = await generation.session.cookies.get({ url: request.url })
      const cookie = cookies.map((item) => `${item.name}=${item.value}`).join("; ")
      const filtered = items.filter((item) => item.name.toLowerCase() !== "cookie")
      items.splice(0, items.length, ...filtered, ...(cookie ? [{ name: "Cookie", value: cookie }] : []))
    }
    const intent: SecurityProxy.Flow = {
      id: command.replayID,
      caseID: command.caseID,
      source: "replay",
      parentID: command.flowID,
      request: { ...request, headers: items },
      originalRequest: result.flow.request,
      responseHeaders: [],
      responseBody: empty(),
      state: "unknown",
      createdAt: Date.now(),
      note: "",
    }
    const reserved = await store({ type: "reserve", owner: command.owner, caseID: command.caseID, flow: intent })
    if (!reserved.created) return reserved
    if (released.has(ownerID) || epoch !== connectionEpoch)
      throw new Error("Owner or backend connection changed; replay intent was not sent")
    const isolated = session.fromPartition(`security-replay-${randomUUID()}`, { cache: false })
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: allowed(binding, details.url) !== "target" || released.has(ownerID) || epoch !== connectionEpoch,
      }),
    )
    const terminal = await new Promise<SecurityProxy.Flow>((resolve) => {
      if (epoch !== connectionEpoch || released.has(ownerID))
        throw new Error("Backend disconnected before replay transport creation")
      const outgoing = net.request({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(items.map((item) => [item.name, item.value])),
        session: isolated,
        redirect: "manual",
        useSessionCookies: false,
      })
      let settled = false
      const finish = (flow: SecurityProxy.Flow) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        replayAborts.get(ownerID)?.delete(abort)
        resolve({ ...flow, durationMs: Date.now() - intent.createdAt })
      }
      const abort = () => {
        finish({ ...intent, state: "failed", error: "Replay aborted; server outcome may be unknown" })
        outgoing.abort()
      }
      const timer = setTimeout(abort, 30000)
      const active = replayAborts.get(ownerID) ?? new Set<() => void>()
      replayAborts.set(ownerID, active)
      active.add(abort)
      outgoing.on("login", (_info, callback) => callback())
      outgoing.on("error", () =>
        finish({ ...intent, state: "failed", error: "Replay transport failed; server outcome may be unknown" }),
      )
      outgoing.on("redirect", (status, _method, _url, responseHeaders) => {
        finish({
          ...intent,
          status,
          responseHeaders: Object.entries(responseHeaders).flatMap(([name, values]) =>
            values.map((value) => ({ name, value })),
          ),
          responseBody: empty(),
          state: "complete",
        })
        outgoing.abort()
      })
      outgoing.on("response", (response) => {
        const responseHeaders = Object.entries(response.headers).flatMap(([name, values]) =>
          (Array.isArray(values) ? values : [values]).flatMap((value) =>
            typeof value === "string" ? [{ name, value }] : [],
          ),
        )
        const chunks: Buffer[] = []
        let size = 0
        if (/text\/event-stream/i.test(header(responseHeaders, "content-type") ?? "")) {
          finish({
            ...intent,
            status: response.statusCode,
            responseHeaders,
            responseBody: empty("streaming"),
            state: "complete",
          })
          outgoing.abort()
          return
        }
        response.on("data", (input: Buffer) => {
          if (settled) return
          const remaining = LIMIT + 1 - size
          chunks.push(input.subarray(0, remaining))
          size += input.length
          if (size > LIMIT) {
            finish({
              ...intent,
              status: response.statusCode,
              responseHeaders,
              responseBody: { ...body(Buffer.concat(chunks), "truncated"), size },
              state: "complete",
            })
            outgoing.abort()
          }
        })
        response.on("end", () =>
          finish({
            ...intent,
            status: response.statusCode,
            responseHeaders,
            responseBody: body(Buffer.concat(chunks)),
            state: "complete",
          }),
        )
        response.on("error", () =>
          finish({
            ...intent,
            status: response.statusCode,
            responseHeaders,
            responseBody: empty(),
            state: "failed",
            error: "Replay response interrupted",
          }),
        )
      })
      outgoing.end(bytes)
    }).finally(async () => {
      await Promise.all([
        isolated.clearCache(),
        isolated.clearStorageData(),
        isolated.clearAuthCache(),
        isolated.closeAllConnections(),
      ])
    })
    return store({ type: "put", owner: command.owner, caseID: command.caseID, flow: terminal })
  }

  async function invoke(ownerID: number, command: SecurityProxy.Command): Promise<SecurityProxy.Result> {
    if (shuttingDown || released.has(ownerID))
      throw new Error("Owner window has been released or controller is shutting down")
    const epoch = connectionEpoch
    if (command.type === "list") return store(command)
    const caseID = command.type === "create" ? command.input.id : command.caseID
    const bindingKey = key(command.owner, caseID)
    // The active session and case are the collaboration boundary. The visible
    // session tab and the agent turn must be able to control the same case.
    claims.set(bindingKey, ownerID)
    if (command.type === "create") {
      const result = await store(command)
      if (released.has(ownerID) || epoch !== connectionEpoch) throw new Error("Owner or backend connection changed")
      if (result.case && !bindings.has(bindingKey))
        bindings.set(bindingKey, { ownerID, case: result.case, serial: Promise.resolve() })
      return result
    }
    const stored =
      bindings.get(bindingKey) ??
      (await store({ type: "get", owner: command.owner, caseID }).then((result) => {
        if (!result.case) throw new Error("Security case not found")
        if (released.has(ownerID)) throw new Error("Owner window has been released")
        const existing = bindings.get(bindingKey)
        if (existing) return existing
        const binding: Binding = { ownerID, case: result.case, serial: Promise.resolve() }
        bindings.set(bindingKey, binding)
        return binding
      }))
    if (!stored) throw new Error("Security case binding is unavailable")
    if (epoch !== connectionEpoch) throw new Error("Backend connection changed during case lookup")
    if (command.type === "snapshot") return snapshot(stored)
    if (command.type === "replay") {
      if (replays.size >= 4) throw new Error("At most four replays may run concurrently")
      const task = replay(ownerID, stored, command)
      replays.add(task)
      void task.finally(() => replays.delete(task)).catch(() => {})
      return task
    }
    const operation = stored.serial.then(async (): Promise<SecurityProxy.Result> => {
      if (released.has(ownerID) || epoch !== connectionEpoch) throw new Error("Owner or backend connection changed")
      if (
        command.type === "get" ||
        command.type === "flows" ||
        command.type === "flow" ||
        command.type === "reveal" ||
        command.type === "note"
      )
        return store(command)
      if (command.type === "delete") {
        if (stored.generation) await close(stored.generation)
        const result = await store(command)
        bindings.delete(bindingKey)
        claims.delete(bindingKey)
        return result
      }
      if (command.type === "rules") {
        const result = await store(command)
        if (result.case) stored.case = result.case
        if (stored.generation && !stored.generation.closed) await configure(stored.generation)
        return result
      }
      if (command.type === "close" || command.type === "reset") {
        if (stored.generation) await close(stored.generation)
        if (command.type === "close") return snapshot(stored)
      }
      if (command.type === "open" || command.type === "reset") {
        if (stored.generation?.closing)
          await stored.generation.closing.catch((error: unknown) => {
            if (stored.generation) report(stored.generation, error)
          })
        if (!stored.generation || stored.generation.closed) {
          const result = await store({ type: "get", owner: command.owner, caseID })
          if (!result.case) throw new Error("Security case not found")
          if (epoch !== connectionEpoch || released.has(ownerID))
            throw new Error("Owner or backend connection changed before browser open")
          stored.case = result.case
        }
        const generation = open(stored)
        await generation.ready
        if (generation.closed || epoch !== connectionEpoch) return snapshot(stored)
        generation.window.show()
        generation.window.focus()
        return snapshot(stored)
      }
      const generation = stored.generation
      if (!generation || generation.closed) throw new Error("Security browser is not open")
      await generation.ready
      // A close during startup resolves ready but destroys the contents.
      if (generation.closed) throw new Error("Security browser is not open")
      if (command.type === "navigate") {
        // Bare hosts go to https; an explicit non-HTTP(S) scheme stays blocked.
        const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(command.url) ? command.url : `https://${command.url}`
        if (allowed(stored, url) === "blocked") throw new Error("Navigation blocked by session policy")
        generation.error = undefined
        void generation.view.webContents.loadURL(url).catch((error: unknown) => {
          // ERR_BLOCKED_BY_CLIENT is our own drop/scope decision; ERR_ABORTED is a superseded
          // navigation; a rejection after close is teardown noise — none are browser faults.
          if (!generation.closed && !/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(String(error))) report(generation, error)
        })
        return snapshot(stored)
      }
      if (command.type === "intercept") {
        if (!command.on) {
          // Stop admitting new pauses before draining the explicit settlement choice.
          generation.intercept = false
          for (const pending of [...generation.pauses.values()]) {
            if (pending.busy) await pending.busy
            // One unsettleable pause must not strand the rest.
            await decide(generation, pending, command.settle).catch((error: unknown) => report(generation, error))
          }
        }
        generation.intercept = command.on
        await configure(generation)
        return snapshot(stored)
      }
      if (command.type === "decide") {
        if (command.generation !== generation.id) throw new Error("Stale browser generation")
        const pending = generation.pauses.get(command.pauseID)
        if (!pending) throw new Error("Pause is stale or already decided; acknowledgement is not retried")
        if (command.decision === "reveal") return { pause: pending.value }
        if (command.decision === "extend") {
          if (pending.busy) throw new Error("Cannot extend an active body read or decision")
          clearTimeout(pending.timer)
          pending.value = { ...pending.value, deadline: Date.now() + PAUSE_TTL }
          pending.timer = deadline(generation, pending)
          return snapshot(stored)
        }
        await decide(generation, pending, command.decision, command.edits)
        return snapshot(stored)
      }
      throw new Error("Unsupported security browser command")
    })
    stored.serial = operation.catch(() => {})
    return operation
  }

  async function toolbar(event: Electron.IpcMainInvokeEvent, input: unknown): Promise<SecurityProxy.Result> {
    // A closed generation keeps its destroyed window so `snapshot` can still report post-close
    // state; reading `window.webContents` on it throws, so it must be skipped before comparing.
    const binding = [...bindings.values()].find((item) => {
      const window = item.generation?.window
      return window !== undefined && !window.isDestroyed() && window.webContents === event.sender
    })
    const generation = binding?.generation
    if (
      !binding ||
      !generation ||
      generation.closed ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== generation.shell ||
      event.sender.getURL() !== generation.shell ||
      generation.shell !== deps.shellURL()
    )
      throw new Error("Untrusted security toolbar sender")
    const payload = record(input)
    const type = text(payload.type)
    if (!Object.keys(payload).every((name) => name === "type" || name === "url"))
      throw new Error("Invalid toolbar payload")
    if (type === "snapshot") return snapshot(binding)
    if (type === "proxy") {
      deps.focusProxy(binding.ownerID, binding.case.id)
      return snapshot(binding)
    }
    if (type === "close" || type === "navigate")
      return invoke(
        binding.ownerID,
        type === "close"
          ? { type, owner: binding.case.owner, caseID: binding.case.id }
          : { type, owner: binding.case.owner, caseID: binding.case.id, url: text(payload.url) },
      )
    const navigation = generation.view.webContents.navigationHistory
    if (type === "back" && navigation.canGoBack()) navigation.goBack()
    else if (type === "forward" && navigation.canGoForward()) navigation.goForward()
    else if (type === "reload") {
      if (allowed(binding, generation.view.webContents.getURL()) !== "blocked") generation.view.webContents.reload()
    } else if (type !== "back" && type !== "forward") throw new Error("Unsupported toolbar command")
    return snapshot(binding)
  }
  async function release(ownerID: number): Promise<void> {
    released.add(ownerID)
    replayAborts.get(ownerID)?.forEach((abort) => abort())
    const owned = [...bindings.entries()].filter(([, binding]) => binding.ownerID === ownerID)
    try {
      await Promise.all(
        owned.map(async ([bindingKey, binding]) => {
          try {
            if (binding.generation) await close(binding.generation)
            await within(binding.serial, 2000, "Owner operation drain timed out")
          } finally {
            bindings.delete(bindingKey)
          }
        }),
      )
    } finally {
      claims.forEach((value, bindingKey) => {
        if (value === ownerID) claims.delete(bindingKey)
      })
      replayAborts.delete(ownerID)
    }
  }
  async function closeAll(): Promise<void> {
    shuttingDown = true
    await Promise.all([...new Set([...claims.values()])].map(release))
    await within(Promise.allSettled([...replays]), 2000, "Replay persistence drain timed out")
  }
  async function disconnect(): Promise<void> {
    connectionEpoch += 1
    replayAborts.forEach((active) => active.forEach((abort) => abort()))
    await Promise.all(
      [...bindings.values()].map(async (binding) => {
        const generation = binding.generation
        if (!generation) return
        report(generation, new Error("Backend disconnected; explicitly reopen the browser after recovery"))
        await close(generation).catch((error: unknown) => report(generation, error))
      }),
    )
  }
  return { invoke, toolbar, release, closeAll, disconnect }
}
