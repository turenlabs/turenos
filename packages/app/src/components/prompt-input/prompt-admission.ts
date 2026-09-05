import { createStore, produce } from "solid-js/store"
import type { Message, Part } from "@turenlabs/sdk/v2/client"
import type { DirectorySDK } from "@/context/sdk"
import type { Platform } from "@/context/platform"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { sessionPromptOutbox } from "@/pages/session/goal/session-prompt-state"

type Client = DirectorySDK["client"]
type Payload = Parameters<Client["v2"]["session"]["prompt"]>[0] & { id: string; sessionID: string }
export type PromptAdmissionOutcome = "pending" | "projected" | "cancelled" | "missing" | "unknown"
export type PromptAdmissionResult = "admitted" | "unknown" | "rejected" | "cancelled"
export type PromptAdmission = {
  scope: ServerScope
  sessionID: string
  directory: string
  payload: Payload
  message: Message
  parts: Part[]
  state: "unknown" | "rejected" | "admitted"
  error?: string
}

export type PromptAdmissionStorage = {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
  keys(): string[] | Promise<string[]>
}

const PREFIX = "v1:"
const services = new WeakMap<Platform, ReturnType<typeof createPromptAdmission>>()

export function promptAdmissionFor(platform: Platform) {
  const current = services.get(platform)
  if (current) return current
  const storage = platform.platform === "desktop" && platform.storage?.("turen.prompt-admission.dat")
  // Keep irreplaceable intents outside the generic forge.* cache eviction path.
  // Writes here never evict another draft, and a quota failure prevents the POST.
  const prefix = "turen.prompt-admission:"
  const next = createPromptAdmission({
    storage: storage
      ? {
          getItem: (key) => storage.getItem(key),
          setItem: async (key, value) => {
            await storage.setItem(key, value)
          },
          removeItem: async (key) => {
            await storage.removeItem(key)
          },
          keys: async () => {
            const length = storage.getLength ? await storage.getLength() : await storage.length
            return (await Promise.all(Array.from({ length: length ?? 0 }, (_, index) => storage.key?.(index)))).filter(
              (key): key is string => typeof key === "string",
            )
          },
        }
      : {
          getItem: (key) => localStorage.getItem(prefix + key),
          setItem: (key, value) => localStorage.setItem(prefix + key, value),
          removeItem: (key) => localStorage.removeItem(prefix + key),
          keys: () =>
            Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
              .filter((key): key is string => key !== null && key.startsWith(prefix))
              .map((key) => key.slice(prefix.length)),
        },
  })
  services.set(platform, next)
  return next
}

export function createPromptAdmission(input: {
  storage: PromptAdmissionStorage
  requestTimeoutMs?: number
  retryDelays?: readonly number[]
  checkDelays?: readonly number[]
  maxEntries?: number
  maxBytes?: number
}) {
  const [state, setState] = createStore<{
    entries: Record<string, PromptAdmission | undefined>
    sending: Record<string, boolean | undefined>
    checking: Record<string, boolean | undefined>
    error?: string
  }>({ entries: {}, sending: {}, checking: {} })
  type Cancellation = { scope: ServerScope; sessionID: string; messageID: string }
  const listeners = new Set<(cancelled?: Cancellation) => void>()
  const writes = new Map<string, Promise<unknown>>()
  const confirmed = new Map<string, "pending" | "projected" | "cancelled">()
  const sendingPayloads = new Map<string, Payload>()
  const timeout = input.requestTimeoutMs ?? 5_000
  const keyFor = (scope: ServerScope, sessionID: string, messageID: string) =>
    ScopedKey.from(scope, sessionID, messageID)
  const notify = (cancelled?: Cancellation) => listeners.forEach((listener) => listener(cancelled))
  const serializeWrite = <T>(key: string, action: () => Promise<T>) => {
    const request = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
    writes.set(key, request)
    return request.finally(() => {
      if (writes.get(key) === request) writes.delete(key)
    })
  }
  const persist = (key: string, entry: PromptAdmission) =>
    serializeWrite(key, async () => {
      const value = JSON.stringify({
        scope: entry.scope,
        sessionID: entry.sessionID,
        directory: entry.directory,
        payload: entry.payload,
        message: entry.message,
        parts: entry.parts,
        state: entry.state,
      })
      await input.storage.setItem(PREFIX + key, value)
      if ((await input.storage.getItem(PREFIX + key)) !== value)
        throw new Error("The prompt could not be saved. It has not been sent.")
    })
  let initialized = false
  let loading: Promise<void> | undefined
  const hydrate = (): Promise<void> => {
    if (initialized) return Promise.resolve()
    if (loading) return loading
    loading = Promise.resolve()
      .then(async () => {
        const keys = (await timedRequest(async () => input.storage.keys(), undefined, timeout)).filter((key) =>
          key.startsWith(PREFIX),
        )
        const records = await Promise.all(
          keys.map(async (key) => {
            const raw = await timedRequest(async () => input.storage.getItem(key), undefined, timeout)
            if (!raw) return
            const value: unknown = JSON.parse(raw)
            if (!validEntry(value) || PREFIX + keyFor(value.scope, value.sessionID, value.payload.id) !== key)
              throw new Error("Saved prompt delivery information could not be read. Keep this device's storage intact.")
            return { key: key.slice(PREFIX.length), value }
          }),
        )
        records.forEach((record) => {
          if (!record) return
          setState("entries", record.key, {
            ...record.value,
            state: record.value.state === "admitted" ? "unknown" : record.value.state,
          })
          sessionPromptOutbox.put({
            scope: record.value.scope,
            sessionID: record.value.sessionID,
            message: record.value.message,
            parts: record.value.parts,
          })
        })
        initialized = true
        setState("error", undefined)
        notify()
      })
      .catch((error: unknown) => {
        setState(
          "error",
          error instanceof Error ? error.message : "Saved prompt delivery information could not be read.",
        )
        throw error
      })
      .finally(() => {
        loading = undefined
      })
    return loading
  }
  void hydrate().catch(() => undefined)

  const entries = (scope: ServerScope, sessionID: string) =>
    Object.values(state.entries).filter(
      (entry): entry is PromptAdmission => !!entry && entry.scope === scope && entry.sessionID === sessionID,
    )
  const settle = (
    scope: ServerScope,
    sessionID: string,
    messageID: string,
    outcome: "pending" | "projected" | "cancelled",
  ) => {
    const key = keyFor(scope, sessionID, messageID)
    if (!state.entries[key]) return
    if (state.sending[key]) confirmed.set(key, outcome)
    if (outcome === "pending") setState("entries", key, "state", "admitted")
    if (outcome !== "pending") {
      setState(
        "entries",
        produce((entries) => {
          delete entries[key]
        }),
      )
      sessionPromptOutbox.clear(messageID, scope)
    }
    // Failure to delete only leaves a stale same-ID intent to reconcile next
    // time; it must never turn confirmed admission into an unsent composer.
    void serializeWrite(key, async () => input.storage.removeItem(PREFIX + key)).catch(() => undefined)
    notify(outcome === "cancelled" ? { scope, sessionID, messageID } : undefined)
  }
  const check = async (
    scope: ServerScope,
    sessionID: string,
    messageID: string,
    client: Client,
    signal?: AbortSignal,
  ) => {
    await hydrate()
    const key = keyFor(scope, sessionID, messageID)
    if (!state.entries[key] || state.sending[key] || state.checking[key] || signal?.aborted) return "unknown" as const
    setState("checking", key, true)
    const outcome = await readPromptAdmission(client, sessionID, messageID, signal, timeout).finally(() =>
      setState(
        "checking",
        produce((checking) => {
          delete checking[key]
        }),
      ),
    )
    if (signal?.aborted) return "unknown" as const
    if (outcome === "pending" || outcome === "projected" || outcome === "cancelled")
      settle(scope, sessionID, messageID, outcome)
    // Missing is a snapshot, not proof that an earlier timed-out POST cannot
    // still commit. Retain the original ID and offer only an exact-ID retry.
    return outcome
  }

  const send = async (
    entry: Omit<PromptAdmission, "state" | "error">,
    client: Client,
    signal?: AbortSignal,
    beforePost?: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<PromptAdmissionResult> => {
    await hydrate()
    const key = keyFor(entry.scope, entry.sessionID, entry.payload.id)
    const active = sendingPayloads.get(key)
    if (active) {
      if (JSON.stringify(active) !== JSON.stringify(entry.payload))
        throw new Error("A different prompt already uses this message ID.")
      return "unknown"
    }
    const existing = state.entries[key]
    const previouslyUnknown = existing?.state === "unknown"
    if (existing && JSON.stringify(existing.payload) !== JSON.stringify(entry.payload))
      throw new Error("A different prompt already uses this message ID.")
    if (existing?.state === "admitted") return "admitted"
    const next: PromptAdmission = JSON.parse(
      JSON.stringify({
        scope: entry.scope,
        sessionID: entry.sessionID,
        directory: entry.directory,
        payload: entry.payload,
        message: entry.message,
        parts: entry.parts,
        state: "unknown",
      }),
    )
    const other = Object.entries(state.entries).filter(
      ([id, value]) => id !== key && !!value && value.state !== "admitted",
    )
    if (
      other.length >= (input.maxEntries ?? 100) ||
      JSON.stringify([...other.map(([, value]) => value), next]).length * 2 > (input.maxBytes ?? 64 * 1024 * 1024)
    )
      throw new Error(
        "Too many prompts await delivery confirmation. Check their delivery before sending another prompt.",
      )
    // Verify durable storage before the first POST. No auth, client object, or
    // connection configuration is part of the serialized record.
    sendingPayloads.set(key, next.payload)
    setState("sending", key, true)
    const errors: unknown[] = []
    const retry = input.retryDelays ?? [250, 750, 1500]
    try {
      await timedRequest(() => persist(key, next), signal, timeout).catch((error: unknown) => {
        // The adapter may finish after our deadline. Keep cleanup behind the
        // actual write, while releasing the sender with its composer intact.
        // An earlier uncertain POST still owns its journal on retry failure.
        if (!existing)
          void serializeWrite(key, async () => input.storage.removeItem(PREFIX + key)).catch(() => undefined)
        throw error
      })
      setState("entries", key, next)
      sessionPromptOutbox.put({
        scope: next.scope,
        sessionID: next.sessionID,
        message: next.message,
        parts: next.parts,
      })
      notify()
      await timedRequest(async (signal) => beforePost?.(signal), signal, timeout).catch((error: unknown) => {
        // No POST has begun: keeping this prepared-only record would create a
        // ghost unknown row when the preserved composer is submitted again.
        if (!existing) settle(entry.scope, entry.sessionID, entry.payload.id, "cancelled")
        throw error
      })
      for (const delay of [0, ...retry]) {
        if (signal?.aborted) break
        if (delay && !(await waitFor(delay, signal))) break
        const result = await timedRequest(
          (signal) => client.v2.session.prompt(next.payload, { signal }),
          signal,
          timeout,
        )
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({ ok: false as const, error }))
        if (confirmed.has(key)) return confirmed.get(key) === "cancelled" ? "cancelled" : "admitted"
        if (result.ok || state.entries[key]?.state === "admitted") {
          settle(entry.scope, entry.sessionID, entry.payload.id, "pending")
          return "admitted"
        }
        errors.push(result.error)
        if (!isAmbiguousV2MutationError(result.error)) break
      }
      if (confirmed.has(key)) return confirmed.get(key) === "cancelled" ? "cancelled" : "admitted"
      const uncertain = previouslyUnknown || signal?.aborted || errors.some(isAmbiguousV2MutationError)
      const status = uncertain ? ("unknown" as const) : ("rejected" as const)
      const error = errors.at(-1)
      const failed = {
        ...next,
        state: status,
        error: error instanceof Error ? error.message : "Delivery could not be confirmed.",
      }
      if (state.entries[key]?.state !== "admitted") {
        await timedRequest(() => persist(key, failed), signal, timeout).catch(() => undefined)
        if (confirmed.has(key)) return confirmed.get(key) === "cancelled" ? "cancelled" : "admitted"
        setState("entries", key, failed)
      }
      return status
    } finally {
      sendingPayloads.delete(key)
      confirmed.delete(key)
      setState(
        "sending",
        produce((sending) => {
          delete sending[key]
        }),
      )
      notify()
    }
  }

  return {
    get ready() {
      return hydrate()
    },
    error: () => state.error,
    entries,
    get: (scope: ServerScope, sessionID: string, messageID: string) =>
      state.entries[keyFor(scope, sessionID, messageID)],
    sending: (scope: ServerScope, sessionID: string, messageID: string) =>
      !!state.sending[keyFor(scope, sessionID, messageID)],
    checking: (scope: ServerScope, sessionID: string, messageID: string) =>
      !!state.checking[keyFor(scope, sessionID, messageID)],
    send,
    check,
    settle,
    watch(options: {
      scope: ServerScope
      sessionID: string
      client: Client
      onChange: VoidFunction
      onCancelled?: (messageID: string) => void
      online?: () => boolean
    }) {
      const stopped = new AbortController()
      const checked = new Set<string>()
      const running = new Map<string, AbortController>()
      const poll = (cancelled?: Cancellation) => {
        if (stopped.signal.aborted) return
        if (cancelled?.scope === options.scope && cancelled.sessionID === options.sessionID)
          options.onCancelled?.(cancelled.messageID)
        options.onChange()
        if (options.online?.() === false) return
        entries(options.scope, options.sessionID).forEach((entry) => {
          const key = keyFor(entry.scope, entry.sessionID, entry.payload.id)
          if (entry.state !== "unknown" || state.sending[key] || checked.has(key) || running.has(key)) return
          checked.add(key)
          const controller = new AbortController()
          running.set(key, controller)
          void (async () => {
            for (const delay of input.checkDelays ?? [0, 1_000, 3_000]) {
              if (!(await waitFor(delay, controller.signal))) return
              const outcome = await check(
                entry.scope,
                entry.sessionID,
                entry.payload.id,
                options.client,
                controller.signal,
              )
              if (outcome !== "unknown" && outcome !== "missing") return
            }
          })()
            .catch(() => undefined)
            .finally(() => {
              if (running.get(key) === controller) running.delete(key)
            })
        })
      }
      listeners.add(poll)
      void hydrate()
        .then(() => poll())
        .catch(() => {
          if (!stopped.signal.aborted) options.onChange()
        })
      return {
        refresh() {
          checked.clear()
          void hydrate()
            .then(() => poll())
            .catch(() => {
              if (!stopped.signal.aborted) options.onChange()
            })
        },
        pause() {
          running.forEach((controller) => controller.abort())
          running.clear()
        },
        dispose() {
          stopped.abort()
          listeners.delete(poll)
          running.forEach((controller) => controller.abort())
          running.clear()
        },
      }
    },
  }
}

export async function readPromptAdmission(
  client: Client,
  sessionID: string,
  messageID: string,
  signal?: AbortSignal,
  timeout = 5_000,
): Promise<PromptAdmissionOutcome> {
  const read = <T>(request: (signal: AbortSignal) => Promise<T>) => timedRequest(request, signal, timeout)
  const durable = await read((signal) => client.v2.session.inputStatus({ sessionID, messageID }, { signal }))
    .then((response) => response.data?.data?.status)
    .catch(() => undefined)
  if (signal?.aborted) return "unknown"
  if (durable === "admitted") return "pending"
  if (durable === "promoted") return "projected"
  if (durable === "cancelled") return "cancelled"
  const pending = await read((signal) => client.v2.session.pendingInputs({ sessionID }, { signal }))
    .then((response) => (response.data?.data.some((input) => input.id === messageID) ? "pending" : "missing"))
    .catch((error: unknown) => (errorStatus(error) === 404 ? "missing" : "unknown"))
  if (signal?.aborted) return "unknown"
  if (pending === "pending") return "pending"
  const projected = await read((signal) => client.v2.session.message({ sessionID, messageID }, { signal }))
    .then(() => "projected" as const)
    .catch((error: unknown) => (errorStatus(error) === 404 ? "missing" : "unknown"))
  if (signal?.aborted) return "unknown"
  if (projected === "projected") return "projected"
  return pending === "missing" && projected === "missing" ? "missing" : "unknown"
}

export function isAmbiguousV2MutationError(error: unknown) {
  if (!error || typeof error !== "object") return false
  if ("name" in error && (error.name === "AbortError" || error.name === "TimeoutError")) return true
  const reason = "reason" in error ? error.reason : undefined
  if (reason === "Transport") return true
  const status = errorStatus(error)
  if (status !== undefined) return status >= 500
  return error instanceof TypeError
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return
  if ("status" in error && typeof error.status === "number") return error.status
  return "cause" in error ? errorStatus(error.cause) : undefined
}

function validEntry(value: unknown): value is PromptAdmission {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<PromptAdmission>
  return (
    typeof entry.scope === "string" &&
    typeof entry.sessionID === "string" &&
    typeof entry.directory === "string" &&
    !!entry.payload &&
    typeof entry.payload.id === "string" &&
    entry.payload.sessionID === entry.sessionID &&
    !!entry.message &&
    entry.message.id === entry.payload.id &&
    entry.message.sessionID === entry.sessionID &&
    entry.message.role === "user" &&
    Array.isArray(entry.parts) &&
    (entry.state === "unknown" || entry.state === "rejected" || entry.state === "admitted")
  )
}

export async function timedRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeout: number,
) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  const timer = setTimeout(
    () => controller.abort(new DOMException("Delivery check timed out", "TimeoutError")),
    timeout,
  )
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  const interrupted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason)
      return
    }
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
  })
  return Promise.race([
    interrupted,
    Promise.resolve().then(() => (controller.signal.aborted ? interrupted : request(controller.signal))),
  ]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
  })
}

function waitFor(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      resolve(ok)
    }
    const cancel = () => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener("abort", cancel, { once: true })
  })
}
