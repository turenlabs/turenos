import { expect, test } from "bun:test"
import type { PromptInputState } from "@/components/prompt-input"
import { sessionPromptReady } from "./session-composer-region-controller"

test("prompt readiness never reads the asynchronous persistence promise", () => {
  let promiseRead = false
  const ready = (() => false) as PromptInputState["ready"]
  Object.defineProperty(ready, "promise", {
    get() {
      promiseRead = true
      return new Promise<void>(() => {})
    },
  })

  expect(sessionPromptReady(ready)).toBe(false)
  expect(promiseRead).toBe(false)
})
