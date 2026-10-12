import { describe, expect, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { createTeamAttachmentDraft } from "@/pages/team/attachment-draft"

const png = (name: string, size = 8) => new File([new Uint8Array(size).fill(7)], name, { type: "image/png" })

function setup(options?: { readClipboardImage?: () => Promise<File | null> }) {
  const state = { scope: "server-a\nroom-a" as string | undefined, errors: [] as (string | undefined)[], changes: 0 }
  const draft = createTeamAttachmentDraft({
    scope: () => state.scope,
    onChange: () => {
      state.changes += 1
    },
    onError: (message) => state.errors.push(message),
    readClipboardImage: options?.readClipboardImage,
  })
  return { state, draft }
}

function clipboard(files: File[], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: () => text,
    },
  })
  return event as ClipboardEvent
}

describe("team attachment draft", () => {
  test("reads a selected file into a strict base64 data URI", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      await draft.add([new File(["hello"], "note.bin", { type: "application/x-custom" })])
      expect(
        draft.list().map((item) => ({ name: item.name, mime: item.mime, uri: item.uri, size: item.size })),
      ).toEqual([{ name: "note.bin", mime: "text/plain", uri: `data:text/plain;base64,${btoa("hello")}`, size: 5 }])
      expect(draft.attachments()).toEqual([
        { name: "note.bin", mime: "text/plain", uri: `data:text/plain;base64,${btoa("hello")}` },
      ])
      expect(state.changes).toBe(1)
      dispose()
    })
  })

  test("never sends a script-capable image type as an image", async () => {
    await createRoot(async (dispose) => {
      const { draft } = setup()
      await draft.add([new File(["<svg onload='alert(1)'/>"], "x.svg", { type: "image/svg+xml" })])
      expect(draft.list()[0]?.mime).toBe("text/plain")
      dispose()
    })
  })

  test("stops at five attachments and reports the rest", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      await draft.add(Array.from({ length: 6 }, (_, index) => png(`${index}.png`)))
      expect(draft.list().map((item) => item.name)).toEqual(["0.png", "1.png", "2.png", "3.png", "4.png"])
      expect(state.errors.at(-1)).toContain("up to 5")
      dispose()
    })
  })

  test("rejects a file over 10 MiB without reading it and enforces the 20 MiB total", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      const huge = png("huge.png")
      Object.defineProperty(huge, "size", { value: 10 * 1024 * 1024 + 1 })
      await draft.add([huge])
      expect(draft.list()).toEqual([])
      expect(state.errors.at(-1)).toContain("huge.png")

      await draft.add([png("a.png", 9 * 1024 * 1024), png("b.png", 9 * 1024 * 1024), png("c.png", 3 * 1024 * 1024)])
      expect(draft.list().map((item) => item.name)).toEqual(["a.png", "b.png"])
      expect(state.errors.at(-1)).toContain("20 MiB")
      await draft.add([png("d.png", 2 * 1024 * 1024)])
      expect(draft.list().map((item) => item.name)).toEqual(["a.png", "b.png", "d.png"])
      dispose()
    })
  }, 30_000)

  test("rejects a truncated read instead of sending partial bytes", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      const sampled = png("sampled.png", 16)
      Object.defineProperty(sampled, "size", { value: 4096 })
      await draft.add([sampled])
      expect(draft.list()).toEqual([])
      expect(state.errors.at(-1)).toContain("sampled.png")
      dispose()
    })
  })

  test("takes pasted files and leaves text paste to the field", async () => {
    await createRoot(async (dispose) => {
      const { draft } = setup()
      const image = clipboard([png("pasted.png")])
      await draft.paste(image)
      expect(image.defaultPrevented).toBe(true)
      expect(draft.list().map((item) => item.name)).toEqual(["pasted.png"])

      const text = clipboard([], "plain words")
      await draft.paste(text)
      expect(text.defaultPrevented).toBe(false)
      expect(draft.list()).toHaveLength(1)
      dispose()
    })
  })

  test("reads the native clipboard image only when the browser clipboard is empty", async () => {
    await createRoot(async (dispose) => {
      const reads: number[] = []
      const { draft } = setup({
        readClipboardImage: async () => {
          reads.push(1)
          return png("native.png")
        },
      })
      await draft.paste(clipboard([], "plain words"))
      expect(reads).toHaveLength(0)
      await draft.paste(clipboard([]))
      expect(reads).toHaveLength(1)
      expect(draft.list().map((item) => item.name)).toEqual(["native.png"])
      dispose()
    })
  })

  test("takes dropped files and ignores dropped links and paths", async () => {
    await createRoot(async (dispose) => {
      const { draft } = setup()
      const drop = (files: File[], text = "") => {
        const event = new Event("drop", { bubbles: true, cancelable: true })
        Object.defineProperty(event, "dataTransfer", { value: { files, getData: () => text, types: [] } })
        return event as DragEvent
      }
      const link = drop([], "file:///etc/passwd")
      await draft.drop(link)
      expect(link.defaultPrevented).toBe(true)
      expect(draft.list()).toEqual([])
      await draft.drop(drop([], "https://example.com/a.png"))
      expect(draft.list()).toEqual([])
      await draft.drop(drop([png("dropped.png")]))
      expect(draft.list().map((item) => item.name)).toEqual(["dropped.png"])
      dispose()
    })
  })

  test("keeps each room and server draft separate and drops reads that outlive their scope", async () => {
    await createRoot(async (dispose) => {
      const read = Promise.withResolvers<File | null>()
      const { state, draft } = setup({ readClipboardImage: () => read.promise })
      await draft.add([png("room-a.png")])
      const pending = draft.paste(clipboard([]))
      expect(draft.reading()).toBe(true)

      state.scope = "server-a\nroom-b"
      draft.prune([state.scope])
      read.resolve(png("late.png"))
      await pending
      expect(draft.reading()).toBe(false)
      expect(draft.list()).toEqual([])

      state.scope = "server-a\nroom-a"
      expect(draft.list()).toEqual([])

      await draft.add([png("room-a-again.png")])
      state.scope = "server-b\nroom-a"
      expect(draft.list()).toEqual([])
      draft.prune([state.scope, "server-a\nroom-a"])
      state.scope = "server-a\nroom-a"
      expect(draft.list().map((item) => item.name)).toEqual(["room-a-again.png"])
      dispose()
    })
  })

  test.each(["server-a\nroom-b", "server-b\nroom-a"])(
    "drops pending and queued clipboard reads after a scope round trip through %s",
    async (otherScope) => {
      await createRoot(async (dispose) => {
        const read = Promise.withResolvers<File | null>()
        const { state, draft } = setup({ readClipboardImage: () => read.promise })
        const pending = draft.paste(clipboard([]))
        const queued = draft.add([png("queued.png")])
        state.scope = otherScope
        draft.prune([])
        state.scope = "server-a\nroom-a"
        draft.prune([])
        read.resolve(png("late.png"))
        await Promise.all([pending, queued])
        expect(draft.reading()).toBe(false)
        expect(draft.list()).toEqual([])
        expect(state.changes).toBe(0)
        dispose()
      })
    },
  )

  test("drops an active FileReader after a room round trip", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      const started = Promise.withResolvers<void>()
      const readers: FileReader[] = []
      const read = FileReader.prototype.readAsDataURL
      const spy = spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
        readers.push(this)
        started.resolve()
      })
      try {
        const file = png("late-file.png")
        const pending = draft.add([file])
        await started.promise
        state.scope = "server-a\nroom-b"
        draft.prune([])
        state.scope = "server-a\nroom-a"
        draft.prune([])
        read.call(readers[0]!, file)
        await pending
        expect(draft.list()).toEqual([])
        expect(state.changes).toBe(0)
      } finally {
        spy.mockRestore()
        dispose()
      }
    })
  })

  test("accepts nothing without a writable scope", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      state.scope = undefined
      await draft.add([png("archived.png")])
      const event = clipboard([png("archived.png")])
      await draft.paste(event)
      expect(event.defaultPrevented).toBe(false)
      expect(draft.list()).toEqual([])
      dispose()
    })
  })

  test("removes one attachment and clears only what a send submitted", async () => {
    await createRoot(async (dispose) => {
      const { state, draft } = setup()
      await draft.add([png("a.png"), png("b.png")])
      const sent = draft.list().map((item) => item.id)
      await draft.add([png("c.png")])
      draft.remove(draft.list()[0]!.id)
      expect(draft.list().map((item) => item.name)).toEqual(["b.png", "c.png"])
      expect(state.changes).toBe(4)
      draft.clear("server-a\nroom-a", sent)
      expect(draft.list().map((item) => item.name)).toEqual(["c.png"])
      dispose()
    })
  })
})
