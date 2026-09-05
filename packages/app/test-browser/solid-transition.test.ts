import { expect, test } from "bun:test"
import { createComponent, createMemo, createResource, Suspense, useTransition, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

// The removed Solid patch covered computations first mounted while a navigation
// transition was waiting for data: https://github.com/solidjs/solid/issues/2046.
test("a pending navigation keeps newly mounted memo values readable during external updates", async () => {
  const [state, setState] = createStore({ route: "overview", revision: 1 })
  const [pending, navigate] = useTransition()
  const response = Promise.withResolvers<string>()
  const value: { read?: Accessor<{ session: string }> } = {}
  const container = document.createElement("div")
  const dispose = render(() => {
    const [loaded] = createResource(
      () => state.route,
      (route) => (route === "overview" ? route : response.promise),
    )
    const detail = () => {
      const session = createMemo(() => ({ session: "retained-session" }))
      value.read = session
      return createMemo(() => `${state.revision}:${session().session}`)
    }
    return createComponent(Suspense, {
      fallback: "Loading",
      get children() {
        return [() => loaded(), () => (state.route === "detail" ? createComponent(detail, {}) : "Overview")]
      },
    })
  }, container)
  try {
    const completion = navigate(() => setState("route", "detail"))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(pending()).toBe(true)
    expect(value.read).toBeFunction()
    setState("revision", 2)
    expect(value.read?.()).toEqual({ session: "retained-session" })
    response.resolve("Loaded")
    await completion
    expect(pending()).toBe(false)
    expect(container.textContent).toContain("2:retained-session")
  } finally {
    response.resolve("Loaded")
    dispose()
  }
})
