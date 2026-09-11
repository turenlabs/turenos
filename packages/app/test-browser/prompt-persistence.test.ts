import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot } from "solid-js"
import { ServerScope } from "@/utils/server-scope"

let Prompt: typeof import("@/context/prompt")
let read: ((value: string | null) => void) | undefined
let writes: string[] = []

const storage: AsyncStorage = {
  getItem: () => new Promise((resolve) => (read = resolve)),
  setItem: async (_key, value) => {
    writes.push(value)
  },
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useParams: () => ({}),
    useSearchParams: () => [{}],
    useLocation: () => ({ pathname: "", query: {} }),
    useNavigate: () => () => undefined,
  }))
  mock.module("@turenlabs/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "desktop", storage: () => storage }),
  }))

  Prompt = await import("@/context/prompt")
})

beforeEach(() => {
  read = undefined
  writes = []
})

function imagePart(id: string) {
  return {
    type: "image" as const,
    id,
    filename: "screenshot.png",
    mime: "image/png",
    dataUrl: `data:image/png;base64,${"A".repeat(1024 * 1024)}`,
  }
}

function whenReady(ready: () => boolean, dispose: VoidFunction, check: () => void) {
  return new Promise<void>((resolve, reject) => {
    createEffect(() => {
      if (!ready()) return
      try {
        check()
        dispose()
        resolve()
      } catch (error) {
        dispose()
        reject(error)
      }
    })
  })
}

describe("prompt persistence", () => {
  test("waits for an async draft to hydrate before reporting ready", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const session = Prompt.createPromptSession(ServerScope.local, { draftID: "draft-async" })
        const ready = Prompt.createPromptReady(() => session)

        expect(ready()).toBe(false)
        expect(session.current()[0]).toMatchObject({ type: "text", content: "" })

        read?.(
          JSON.stringify({
            prompt: [{ type: "text", content: "persisted draft", start: 0, end: 15 }],
            cursor: 15,
            context: { items: [] },
          }),
        )

        whenReady(ready, dispose, () => {
          expect(session.current()[0]).toMatchObject({ type: "text", content: "persisted draft" })
        }).then(resolve, reject)
      })
    })
  })

  test("sanitizes legacy image payloads during async hydration rewrites", async () => {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const session = Prompt.createPromptSession(ServerScope.local, { draftID: "draft-image-legacy" })
        const ready = Prompt.createPromptReady(() => session)
        const image = imagePart("image-legacy")

        read?.(
          JSON.stringify({
            prompt: [
              { type: "text", content: "inspect this", start: 0, end: 12 },
              image,
            ],
            cursor: 12,
            context: { items: [] },
          }),
        )

        whenReady(ready, dispose, () => {
          expect(session.current()).toEqual([{ type: "text", content: "inspect this", start: 0, end: 12 }])
          expect(writes).toHaveLength(1)
          expect(writes[0]).not.toContain("data:image")

          const activeImage = imagePart("image-active")
          session.set([...session.current(), activeImage])
          expect(session.current()).toContainEqual(activeImage)
          expect(writes).toHaveLength(2)
          expect(writes[1]).not.toContain("data:image")
        }).then(resolve, reject)
      })
    })
  })
})
