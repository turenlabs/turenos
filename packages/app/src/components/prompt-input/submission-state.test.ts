import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { createPromptSubmissionState } from "./submission-state"

type PromptTarget = Parameters<typeof createPromptSubmissionState>[0]["target"]

const draft: Prompt = [{ type: "text", content: "Ship it", start: 0, end: 7 }]
const empty: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function createTarget(name: string, operations: string[]) {
  let value = draft
  const target = {
    current: () => value,
    reset: () => {
      operations.push(`${name}:reset`)
      value = empty
    },
    set: (prompt: Prompt) => {
      operations.push(`${name}:set`)
      value = prompt
    },
    context: {
      add: () => operations.push(`${name}:context`),
    },
  } as unknown as PromptTarget
  return { target, current: () => value }
}

describe("prompt submission state", () => {
  test("transfers context and restoration ownership to a retargeted session", () => {
    const operations: string[] = []
    const initial = createTarget("draft", operations)
    const session = createTarget("session", operations)
    const context = [{ key: "file:src/input.ts", type: "file" as const, path: "src/input.ts" }]
    const submission = createPromptSubmissionState({ target: initial.target, prompt: draft, context })

    submission.retarget(session.target)
    submission.clear()

    expect(operations).toEqual(["session:context", "draft:reset", "session:reset"])
    const restored = submission.restore()
    expect(restored?.target).toBe(session.target)
    expect(restored?.prompt).toBe(draft)
    expect(restored?.context).toBe(context)
    expect(initial.current()).toBe(empty)
    expect(session.current()).toBe(empty)
  })

  test("does not overwrite a newer prompt after the retargeted submission was cleared", () => {
    const operations: string[] = []
    const initial = createTarget("draft", operations)
    const session = createTarget("session", operations)
    const submission = createPromptSubmissionState({ target: initial.target, prompt: draft, context: [] })
    const newer: Prompt = [{ type: "text", content: "Next prompt", start: 0, end: 11 }]

    submission.retarget(session.target)
    submission.clear()
    session.target.set(newer)

    expect(submission.restore()).toBeUndefined()
    expect(session.current()).toBe(newer)
  })
})
