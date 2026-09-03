import { describe, expect, test } from "bun:test"
import { loopApi } from "./api"

describe("loopApi", () => {
  test("adapts the generated nested SDK contract", async () => {
    const calls: Array<{ method: string; input: unknown }> = []
    const response = { data: {} }
    const receiverMethod = (receiver: () => unknown, action?: (input: unknown) => void) =>
      async function (this: unknown, input?: unknown) {
        expect(this).toBe(receiver())
        action?.(input)
        return response
      }
    const run: Record<string, unknown> = {
      list: receiverMethod(
        () => run,
        (input) => calls.push({ method: "run.list", input }),
      ),
      get: receiverMethod(() => run),
      cancel: receiverMethod(
        () => run,
        (input) => calls.push({ method: "run.cancel", input }),
      ),
    }
    const loop: Record<string, unknown> = {
      list: receiverMethod(() => loop),
      create: receiverMethod(
        () => loop,
        (input) => calls.push({ method: "create", input }),
      ),
      get: receiverMethod(() => loop),
      edit: receiverMethod(
        () => loop,
        (input) => calls.push({ method: "edit", input }),
      ),
      pause: receiverMethod(() => loop),
      resume: receiverMethod(() => loop),
      delete: receiverMethod(() => loop),
      runNow: receiverMethod(() => loop),
      run,
    }
    const api = loopApi({
      v2: {
        loop,
      },
    })

    await api.list()
    await api.create({ name: "CI", prompt: "Check CI", location: { directory: "/repo" }, intervalSeconds: 60 })
    await api.get({ loopID: "loop-1" })
    await api.edit({ loopID: "loop-1", prompt: "Check tests" })
    await api.pause({ loopID: "loop-1" })
    await api.resume({ loopID: "loop-1" })
    await api.runNow({ loopID: "loop-1" })
    await api.runList({ loopID: "loop-1" })
    await api.runGet({ loopID: "loop-1", runID: "run-1" })
    await api.runCancel({ loopID: "loop-1", runID: "run-1" })
    await api.delete({ loopID: "loop-1" })

    expect(calls).toEqual([
      {
        method: "create",
        input: {
          loopCreateInput: {
            name: "CI",
            prompt: "Check CI",
            location: { directory: "/repo" },
            intervalSeconds: 60,
          },
        },
      },
      { method: "edit", input: { loopID: "loop-1", loopEditInput: { prompt: "Check tests" } } },
      { method: "run.list", input: { loopID: "loop-1" } },
      { method: "run.cancel", input: { loopID: "loop-1", runID: "run-1" } },
    ])
  })
})
