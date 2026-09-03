import { afterEach, expect, test } from "bun:test"
import type { ContentPart } from "@/context/prompt"
import { MAX_ATTACHMENT_BYTES, createPromptAttachmentsCore } from "@/components/prompt-input/attachments"

const originalFileReader = globalThis.FileReader

afterEach(() => {
  globalThis.FileReader = originalFileReader
})

function attachmentHarness() {
  let parts: ContentPart[] = []
  let warnings = 0
  const editor = document.createElement("div")
  const attachments = createPromptAttachmentsCore({
    capture: () => ({
      current: () => parts,
      cursor: () => 0,
      set: (next) => {
        parts = next
      },
    }),
    editor: () => editor,
    warn: () => warnings++,
  })
  return { attachments, parts: () => parts, warnings: () => warnings }
}

test("keeps duplicate image filenames as distinct ordered attachments", async () => {
  const harness = attachmentHarness()
  const files = [
    new File([Uint8Array.of(1, 2, 3)], "same.png", { type: "image/png" }),
    new File([Uint8Array.of(4, 5, 6)], "same.png", { type: "image/png" }),
  ]

  expect(await harness.attachments.addAttachments(files)).toBe(true)
  const images = harness.parts().filter((part) => part.type === "image")
  expect(images.map((image) => image.filename)).toEqual(["same.png", "same.png"])
  expect(new Set(images.map((image) => image.id)).size).toBe(2)
  expect(images.every((image) => image.dataUrl.startsWith("data:image/png;base64,"))).toBe(true)
})

test("rejects an oversized attachment before reading it", async () => {
  const harness = attachmentHarness()
  const file = new File(["x"], "huge.png", { type: "image/png" })
  Object.defineProperty(file, "size", { value: MAX_ATTACHMENT_BYTES + 1 })

  expect(await harness.attachments.addAttachment(file)).toBe(false)
  expect(harness.parts()).toEqual([])
  expect(harness.warnings()).toBe(1)
})

test("keeps the prompt unchanged when FileReader conversion fails", async () => {
  class BrokenFileReader {
    result: string | ArrayBuffer | null = null
    #listeners = new Map<string, EventListener>()
    addEventListener(type: string, listener: EventListener) {
      this.#listeners.set(type, listener)
    }
    readAsDataURL() {
      this.#listeners.get("error")?.(new Event("error"))
    }
  }
  globalThis.FileReader = BrokenFileReader as unknown as typeof FileReader
  const harness = attachmentHarness()

  expect(await harness.attachments.addAttachment(new File(["x"], "broken.png", { type: "image/png" }))).toBe(false)
  expect(harness.parts()).toEqual([])
})
