import { afterAll, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
const { Persist, persisted, writePersisted, PersistTesting } = await import("@/utils/persist")

// Happy DOM has no storage quota. Keep actual storage reads/removals and model
// the browser's atomic quota error only at its setItem boundary.
const storage = localStorage
const prototype = Object.getPrototypeOf(storage) as Storage
const original = prototype.setItem
let quota = false
prototype.setItem = function (key, value) {
  if (quota) throw new DOMException("quota", "QuotaExceededError")
  original.call(this, key, value)
}
afterAll(() => {
  prototype.setItem = original
})

test("reopened UI keeps an unsaved draft while durable verification still reports failure", async () => {
  const target = Persist.draft("reopen-quota", "prompt")
  const open = () => createRoot((dispose) => ({ dispose, state: persisted(target, createStore({ text: "" })) }))
  const first = open()
  first.state[1]("text", "saved X")
  quota = true
  first.state[1]("text", "unsaved Y")
  first.dispose()
  const reopened = open()
  expect(reopened.state[0].text).toBe("unsaved Y")
  expect(await writePersisted(target, undefined, { text: "unsaved Y" })).toBe(false)
  expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"text":"saved X"}')
  quota = false
  PersistTesting.retryFailedWrites()
  expect(reopened.state[0].text).toBe("unsaved Y")
  expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"text":"unsaved Y"}')
  reopened.state[1]("text", "newer Z")
  reopened.dispose()
  const final = open()
  expect(final.state[0].text).toBe("newer Z")
  final.dispose()
})
