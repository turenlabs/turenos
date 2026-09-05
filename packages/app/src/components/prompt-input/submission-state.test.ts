import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, type Prompt } from "@/context/prompt-state"
import { createPromptSubmissionState } from "./submission-state"

const draft: Prompt = [{ type: "text", content: "Ship it", start: 0, end: 7 }]
const newer: Prompt = [
  { type: "text", content: "Next prompt", start: 0, end: 11 },
  { type: "image", id: "image-next", filename: "next.png", mime: "image/png", dataUrl: "data:image/png;base64,next" },
]
const context = { type: "file" as const, path: "src/input.ts", comment: "Review this", commentID: "comment" }

describe("prompt submission state", () => {
  test("retargets the complete snapshot and restores it after a known pre-admission failure", () =>
    createRoot((dispose) => {
      const initial = createPromptState()
      const session = createPromptState()
      initial.set(draft, 7)
      initial.context.add(context)
      initial.model.set({ providerID: "p", modelID: "m", variant: "high" })
      const submission = createPromptSubmissionState({
        target: initial,
        prompt: initial.current(),
        context: initial.context.items().slice(),
      })
      expect(submission.retarget(session)).toBe(true)
      expect(session.current()).toEqual(draft)
      expect(session.context.items()).toEqual(initial.context.items())
      expect(session.model.current()).toEqual(initial.model.current())
      expect(submission.clear()).toBe(true)
      expect(submission.restore()?.prompt).toEqual(draft)
      // Source retention/removal belongs to tabs; resetting a disposed draft here
      // would resurrect its just-deleted persisted key.
      expect(initial.current()).toEqual(draft)
      dispose()
    }))

  test("preserves newer text, attachments, context, model and cursor from a reopened draft", () =>
    createRoot((dispose) => {
      const initial = createPromptState()
      initial.set(draft)
      const submission = createPromptSubmissionState({ target: initial, prompt: initial.current(), context: [] })
      const reopened = createPromptState()
      reopened.set(newer, 3)
      reopened.context.add(context)
      reopened.model.set({ providerID: "next-provider", modelID: "next-model" })
      const session = createPromptState()
      expect(submission.retarget(session, reopened)).toBe(true)
      expect(submission.clear()).toBe(false)
      expect(submission.restore()).toBeUndefined()
      expect(submission.prompt).toEqual(draft)
      expect(session.current()).toEqual(newer)
      expect(session.context.items()).toEqual(reopened.context.items())
      expect(session.model.current()).toEqual(reopened.model.current())
      dispose()
    }))

  test("does not clear an existing-session composer edited during preparation", () =>
    createRoot((dispose) => {
      const target = createPromptState()
      target.set(draft)
      const submission = createPromptSubmissionState({ target, prompt: target.current(), context: [] })
      target.set(newer)
      expect(submission.clear()).toBe(false)
      expect(submission.restore()).toBeUndefined()
      expect(target.current()).toEqual(newer)
      dispose()
    }))

  test("does not overwrite newer input typed after a successful clear", () =>
    createRoot((dispose) => {
      const target = createPromptState()
      target.set(draft)
      const submission = createPromptSubmissionState({ target, prompt: target.current(), context: [] })
      expect(submission.clear()).toBe(true)
      target.set(newer)
      expect(submission.restore()).toBeUndefined()
      expect(target.current()).toEqual(newer)
      dispose()
    }))

  test("leaves both drafts intact when another composer already filled the destination", () =>
    createRoot((dispose) => {
      const initial = createPromptState()
      initial.set(draft)
      const session = createPromptState()
      session.set(newer)
      const submission = createPromptSubmissionState({ target: initial, prompt: initial.current(), context: [] })
      expect(submission.retarget(session)).toBe(false)
      expect(submission.clear()).toBe(false)
      expect(initial.current()).toEqual(draft)
      expect(session.current()).toEqual(newer)
      dispose()
    }))
})
