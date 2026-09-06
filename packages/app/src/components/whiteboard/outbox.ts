import type { Whiteboard } from "@turenlabs/schema/whiteboard"
import { mergeElements, signature, validElement, validFile } from "./sync"

export type Outbox = { elements: readonly Whiteboard.Element[]; files: Whiteboard.Snapshot["files"] }
export interface WhiteboardPersistence {
  load(): Promise<Outbox>
  put(patch: Outbox): Promise<void>
  acknowledge(patch: Outbox): Promise<void>
}
export const emptyOutbox = (): Outbox => ({ elements: [], files: {} })
export function updateOutbox(current: Outbox, patch: Outbox, acknowledge = false): Outbox {
  const sent = new Map(patch.elements.map((element) => [String(element.id), signature(element)]))
  const next = acknowledge
    ? {
        elements: current.elements.filter((element) => sent.get(String(element.id)) !== signature(element)),
        files: Object.fromEntries(
          Object.entries(current.files).filter(([id, file]) => patch.files[id]?.dataURL !== file.dataURL),
        ),
      }
    : { elements: mergeElements(current.elements, patch.elements), files: { ...current.files, ...patch.files } }
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (
    next.elements.length > 5000 ||
    bytes(next.elements) > 4 * 1024 * 1024 ||
    Object.keys(next.files).length > 5000 ||
    bytes(next.files) > 16 * 1024 * 1024
  ) {
    throw new Error(
      "Whiteboard recovery storage exceeds 4 MiB of shapes or 16 MiB of images. Export locally before leaving.",
    )
  }
  return next
}

let database: Promise<IDBDatabase> | undefined
const queues = new Map<string, Promise<unknown>>()
function openDatabase() {
  if (database) return database
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("forge-whiteboard-outbox", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("boards")
    request.onerror = () => {
      database = undefined
      reject(request.error)
    }
    request.onblocked = () => {
      database = undefined
      reject(new Error("Whiteboard recovery storage is blocked by another tab."))
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        database = undefined
      }
      resolve(request.result)
    }
  })
  return database
}

/** The caller supplies a credential-free server scope plus Session ID, never Session ID alone. */
export function createIndexedDBOutbox(storageKey: string): WhiteboardPersistence {
  const run = (patch?: Outbox, acknowledge = false): Promise<Outbox> => {
    const previous = queues.get(storageKey) ?? Promise.resolve()
    const result = previous
      .catch(() => {})
      .then(async () => {
        if (!storageKey || storageKey.length > 4096)
          throw new Error("A bounded server/session storage key is required.")
        const db = await openDatabase()
        return new Promise<Outbox>((resolve, reject) => {
          const transaction = db.transaction("boards", patch ? "readwrite" : "readonly")
          const store = transaction.objectStore("boards")
          const request = store.get(storageKey)
          let value = emptyOutbox()
          let failure: unknown
          request.onsuccess = () => {
            try {
              const stored = request.result as Outbox | undefined
              if (
                stored &&
                (!Array.isArray(stored.elements) ||
                  !stored.elements.every(validElement) ||
                  !stored.files ||
                  !Object.values(stored.files).every(validFile))
              )
                throw new Error("Whiteboard recovery data is invalid. Export the current drawing before leaving.")
              value = updateOutbox(emptyOutbox(), stored ?? emptyOutbox())
              if (!patch) return
              value = updateOutbox(value, patch, acknowledge)
              if (value.elements.length || Object.keys(value.files).length) store.put(value, storageKey)
              else store.delete(storageKey)
            } catch (error) {
              failure = error
              transaction.abort()
            }
          }
          // A successful request is not a durable acknowledgement: wait for transaction commit.
          transaction.oncomplete = () => resolve(value)
          transaction.onabort = () =>
            reject(failure ?? transaction.error ?? new Error("Whiteboard recovery transaction aborted."))
          transaction.onerror = () => {
            failure ??= transaction.error
          }
        })
      })
    queues.set(storageKey, result)
    void result
      .finally(() => {
        if (queues.get(storageKey) === result) queues.delete(storageKey)
      })
      .catch(() => {})
    return result
  }
  return {
    load: () => run(),
    put: async (patch) => {
      await run(patch)
    },
    acknowledge: async (patch) => {
      await run(patch, true)
    },
  }
}
