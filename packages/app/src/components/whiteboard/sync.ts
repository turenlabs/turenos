import type { Whiteboard } from "@turenlabs/schema/whiteboard"
import type { Outbox, WhiteboardPersistence } from "./outbox"

export interface WhiteboardTransport {
  get(signal?: AbortSignal): Promise<Whiteboard.Snapshot>
  update(input: Whiteboard.UpdateRequest, signal?: AbortSignal): Promise<Whiteboard.Snapshot>
  presence(input: Whiteboard.PresenceInput, signal?: AbortSignal): Promise<Whiteboard.PresenceSnapshot>
  events(signal: AbortSignal): AsyncIterable<typeof Whiteboard.Events.Encoded>
}
export type SyncStatus = "Saving" | "Saved" | "Offline"
const types = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "text", "freedraw", "image", "frame"])
export function validElement(element: Whiteboard.Element) {
  return (
    typeof element.id === "string" &&
    element.id.length > 0 &&
    element.id.length <= 128 &&
    typeof element.type === "string" &&
    types.has(element.type) &&
    typeof element.version === "number" &&
    Number.isSafeInteger(element.version) &&
    element.version >= 1 &&
    typeof element.versionNonce === "number" &&
    Number.isSafeInteger(element.versionNonce) &&
    element.versionNonce >= 0
  )
}
export function signature(element: Whiteboard.Element) {
  return `${element.version}:${element.versionNonce}:${!!element.isDeleted}`
}
/** Restore repairs indices in input order, so honor stored stacking before restoration. */
export function orderElements(elements: readonly Whiteboard.Element[]) {
  return [...elements].sort((left, right) => {
    const a = typeof left.index === "string" && left.index.length ? left.index : undefined
    const b = typeof right.index === "string" && right.index.length ? right.index : undefined
    if (a === b) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    return a < b ? -1 : 1
  })
}
export function mergeElements(local: readonly Whiteboard.Element[], remote: readonly Whiteboard.Element[]) {
  const result = new Map(local.filter(validElement).map((element) => [String(element.id), element]))
  remote.filter(validElement).forEach((element) => {
    const previous = result.get(String(element.id))
    if (
      !previous ||
      Number(element.version) > Number(previous.version) ||
      (element.version === previous.version && Number(element.versionNonce) < Number(previous.versionNonce))
    ) {
      result.set(String(element.id), element)
    }
  })
  return [...result.values()]
}
export function validFile(file: Whiteboard.File) {
  return (
    file.id.length > 0 &&
    file.id.length <= 128 &&
    /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(file.mimeType) &&
    file.dataURL.startsWith(`data:${file.mimeType};base64,`) &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(file.dataURL.slice(file.dataURL.indexOf(",") + 1))
  )
}

export function createWhiteboardSync(input: {
  sessionID: string
  clientID: string
  username: string
  transport: WhiteboardTransport
  scene: (elements: readonly Whiteboard.Element[], files: Whiteboard.Snapshot["files"]) => void
  status: (status: SyncStatus) => void
  participants: (participants: Whiteboard.PresenceSnapshot["participants"]) => void
  persistence?: WhiteboardPersistence
  warning?: (message: string) => void
  delay?: number
}) {
  const abort = new AbortController()
  const pending = new Map<string, Whiteboard.Element>()
  const files = new Map<string, Whiteboard.File>()
  let canonical: Whiteboard.Element[] = []
  let knownFiles: Whiteboard.Snapshot["files"] = {}
  let revision = -1
  let disposed = false
  let connected = false
  let loaded = false
  let writing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let stream: AbortController | undefined
  let initialized = !input.persistence
  let initialization: Promise<void> | undefined
  let storageError = false
  let storing: Promise<void> = Promise.resolve()
  const dirty = () => pending.size > 0 || files.size > 0
  const status = () => {
    if (!disposed)
      input.status(!connected || storageError ? "Offline" : dirty() || writing || !loaded ? "Saving" : "Saved")
  }
  const storageFailure = (error: unknown) => {
    storageError = true
    if (!disposed)
      input.warning?.(
        `Recovery storage unavailable: ${error instanceof Error ? error.message : "Storage failed"}. Export locally before leaving.`,
      )
    status()
  }
  const persist = (patch: Outbox) => {
    if (!input.persistence) return
    // Enqueue synchronously so a newly mounted board cannot load ahead of these edits.
    const operation = input.persistence.put(patch).catch(storageFailure)
    storing = Promise.all([storing, operation]).then(() => {})
  }
  const initialize = (): Promise<void> => {
    if (initialization) return initialization
    if (!input.persistence) return Promise.resolve()
    initialization = input.persistence
      .load()
      .then((saved) => {
        if (disposed) return
        mergeElements(saved.elements, [...pending.values()]).forEach((element) =>
          pending.set(String(element.id), element),
        )
        Object.values(saved.files).forEach((file) => {
          if (!files.has(file.id)) files.set(file.id, file)
        })
      })
      .catch((error) => {
        initialization = undefined
        storageFailure(error)
      })
      .then(() => {
        initialized = true
        render()
        status()
        if (dirty()) schedule()
      })
    return initialization
  }
  const render = () => {
    if (!disposed)
      input.scene(mergeElements(canonical, [...pending.values()]), { ...knownFiles, ...Object.fromEntries(files) })
  }
  const accept = (snapshot: Whiteboard.Snapshot) => {
    if (snapshot.sessionID !== input.sessionID || snapshot.revision < revision) return
    revision = snapshot.revision
    canonical = mergeElements(canonical, snapshot.elements)
    knownFiles = { ...knownFiles, ...snapshot.files }
    loaded = true
  }
  const schedule = (delay = input.delay ?? 150) => {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
  }
  const flush = (): Promise<void> => {
    if (writing) return writing
    if (disposed || !initialized || !dirty()) return Promise.resolve()
    const sent = new Map<string, Whiteboard.Element>()
    const sentFiles = new Map<string, Whiteboard.File>()
    let bytes = 128
    const fits = (value: unknown) => {
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength + 128
      // A permitted 4 MiB image needs over 5 MiB after base64 encoding.
      if (bytes + size > 8 * 1024 * 1024 - 1024) return false
      bytes += size
      return true
    }
    files.forEach((file, id) => {
      if (fits(file)) sentFiles.set(id, file)
    })
    pending.forEach((element, id) => {
      if (
        element.type === "image" &&
        !element.isDeleted &&
        typeof element.fileId === "string" &&
        !knownFiles[element.fileId] &&
        !sentFiles.has(element.fileId)
      )
        return
      if (fits(element)) sent.set(id, element)
    })
    if (!sent.size && !sentFiles.size) {
      storageFailure(new Error("A drawing element or image exceeds the server update limit"))
      return Promise.resolve()
    }
    const work = input.transport
      .update(
        {
          clientID: input.clientID,
          username: input.username,
          patch: { elements: [...sent.values()], files: Object.fromEntries(sentFiles) },
        },
        AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      )
      .then(async (snapshot) => {
        if (disposed) return
        if (input.persistence) {
          await storing
          await input.persistence
            .acknowledge({ elements: [...sent.values()], files: Object.fromEntries(sentFiles) })
            .catch((error) => {
              storageFailure(error)
              throw error
            })
          if (disposed) return
        }
        accept(snapshot)
        sent.forEach((element, id) => {
          if (pending.get(id) === element) pending.delete(id)
        })
        sentFiles.forEach((file, id) => {
          if (files.get(id) === file) files.delete(id)
        })
        if (!dirty()) {
          storageError = false
          input.warning?.("")
        }
        failures = 0
        render()
      })
      .catch(() => {
        if (disposed) return
        connected = false
        failures++
      })
      .finally(() => {
        writing = undefined
        if (disposed) return
        status()
        if (dirty()) schedule(Math.min(10000, failures ? 500 * 2 ** Math.min(failures, 5) : (input.delay ?? 150)))
      })
    writing = work
    status()
    return work
  }
  const refresh = async () => {
    await initialize()
    if (disposed) return
    const snapshot = await input.transport.get(abort.signal)
    if (disposed) return
    accept(snapshot)
    render()
    status()
  }
  const connect = async () => {
    stream?.abort()
    const current = new AbortController()
    stream = current
    try {
      // Start consuming before fetching. Connected also forces a post-subscription refresh.
      const iterator = input.transport.events(current.signal)[Symbol.asyncIterator]()
      let next = iterator.next()
      void next.catch(() => {})
      await refresh()
      if (disposed || current.signal.aborted) return
      connected = true
      status()
      while (!disposed && !current.signal.aborted) {
        const event = await next
        if (event.done) throw new Error("Whiteboard stream closed")
        next = iterator.next()
        // Attach a handler immediately while a refresh may be awaiting I/O.
        void next.catch(() => {})
        if (disposed || current.signal.aborted) return
        if (event.value.data.sessionID !== input.sessionID) continue
        connected = true
        if (event.value.type === "session.whiteboard.presence") input.participants(event.value.data.participants)
        else if (event.value.type === "session.whiteboard.connected" || event.value.data.revision > revision)
          await refresh()
        status()
      }
    } catch {
      if (disposed || current.signal.aborted) return
      connected = false
      status()
      reconnect = setTimeout(
        () => {
          reconnect = undefined
          void connect()
        },
        Math.min(10000, 500 * 2 ** Math.min(++failures, 5)),
      )
    }
  }
  return {
    initialize,
    start() {
      void initialize().then(() => {
        if (!disposed) void connect()
      })
    },
    change(elements: readonly Whiteboard.Element[], incomingFiles: Whiteboard.Snapshot["files"]) {
      if (disposed || !initialized) return
      const changed: Whiteboard.Element[] = []
      const added: Record<string, Whiteboard.File> = {}
      const previous = new Map(
        mergeElements(canonical, [...pending.values()]).map((element) => [String(element.id), element]),
      )
      elements.filter(validElement).forEach((element) => {
        const old = previous.get(String(element.id))
        if (old && (signature(old) === signature(element) || mergeElements([old], [element])[0] === old)) return
        const copy = structuredClone(element)
        pending.set(String(element.id), copy)
        changed.push(copy)
      })
      Object.values(incomingFiles)
        .filter(validFile)
        .forEach((file) => {
          if (!knownFiles[file.id] && !files.has(file.id)) {
            files.set(file.id, file)
            added[file.id] = file
          }
        })
      if (changed.length || Object.keys(added).length) persist({ elements: changed, files: added })
      status()
      if (dirty()) schedule()
    },
    refresh,
    reapply: render,
    flush,
    dirty,
    retry() {
      if (disposed) return
      if (reconnect) clearTimeout(reconnect)
      reconnect = undefined
      if (dirty()) persist({ elements: [...pending.values()], files: Object.fromEntries(files) })
      void connect()
      void flush()
    },
    async presence(value: Omit<Whiteboard.PresenceInput, "clientID" | "username">) {
      if (disposed) return
      const result = await input.transport
        .presence({ ...value, clientID: input.clientID, username: input.username }, abort.signal)
        .catch(() => undefined)
      if (!disposed && result) input.participants(result.participants)
    },
    async dispose() {
      if (disposed) return
      // Freeze callbacks immediately, but finish the one serialized outbox before releasing it.
      disposed = true
      stream?.abort()
      if (timer) clearTimeout(timer)
      if (reconnect) clearTimeout(reconnect)
      await storing
      await writing
      if (dirty()) {
        const patch = { elements: [...pending.values()], files: Object.fromEntries(files) }
        await input.transport
          .update({ clientID: input.clientID, username: input.username, patch }, AbortSignal.timeout(10000))
          .then(() => input.persistence?.acknowledge(patch))
          .catch(() => {
            console.warn("Whiteboard changes remain in recovery storage for the next visit.")
          })
      }
      abort.abort()
    },
  }
}
