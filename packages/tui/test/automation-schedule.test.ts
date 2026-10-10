import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { LoopsCreateInput } from "@turenlabs/client"
import { createAutomations } from "../src/automations"
import { parseSchedule, scheduleProblem } from "../src/automations/schedule"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { connect } from "../src/server"
import { createDashboardState } from "../src/state"
import { cleanup } from "./support"

test("schedule entry checks share desktop rules without the old one-year cap", () => {
  expect(parseSchedule("every 367d")).toEqual({ intervalSeconds: 367 * 86400 })
  expect(parseSchedule("every 0002 hours")).toEqual({ intervalSeconds: 7200 })
  expect(parseSchedule(`${Number.MAX_SAFE_INTEGER}s`)).toEqual({ intervalSeconds: Number.MAX_SAFE_INTEGER })
  expect(parseSchedule("9007199254740992s")).toBeUndefined()
  expect(scheduleProblem("9007199254740992s")).toContain("too long")
  expect(parseSchedule("*/05 * * * *")).toMatchObject({ cronExpression: "*/05 * * * *" })
  // Field syntax is judged by the server, just as it is in the desktop form.
  expect(parseSchedule("*/60 * * * *")).toMatchObject({ cronExpression: "*/60 * * * *" })
  expect(parseSchedule(`${"0".repeat(121)} * * * *`)).toBeUndefined()
})

test("server cron refusal leaves the form editable and allows a corrected submission", async () => {
  const connection = connect({ url: "http://127.0.0.1:4096" })
  cleanup.push(connection.close)
  const requests: LoopsCreateInput[] = []
  connection.client.loops.create = async (input) => {
    requests.push(structuredClone(input))
    throw { _tag: "InvalidRequestError", message: `Invalid cron step: ${input.cronExpression}` }
  }
  const view = await createTestRenderer({ width: 100, height: 36 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  const dialogs = createDialogs(view.renderer, state, createLayout(view.renderer, state), {
    rememberPosition() {},
    cancelPosition() {},
    changed() {},
    async submitted() {},
    say() {},
  })
  createAutomations(
    view.renderer,
    state,
    connection,
    dialogs,
    () => {},
    () => {},
  ).create()
  const dialog = state.modal!
  const fields = dialog.fields.filter((field): field is InputRenderable => field instanceof InputRenderable)
  fields[0]!.value = "Scheduled review"
  fields[1]!.value = "Review the repository"
  fields[2]!.value = "*/60 * * * *"
  fields[3]!.value = "/srv/project"
  await dialogs.submit()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.cronExpression).toBe("*/60 * * * *")
  expect(state.modal).toBe(dialog)
  expect(dialog.busy).toBe(false)
  expect(dialog.error.plainText).toContain("Invalid cron step: */60")
  fields[2]!.value = "*/05 * * * *"
  await dialogs.submit()
  expect(requests).toHaveLength(2)
  expect(requests[1]!.cronExpression).toBe("*/05 * * * *")
  expect(dialog.error.plainText).not.toContain("may already exist")
})
