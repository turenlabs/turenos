import { expect, test } from "bun:test"
import { startsSessionV2Turn } from "./session-v2-message-window"

test.each(["subagent_board", "shell_job"] as const)("%s notifications do not start a visible turn", (source) => {
  expect(
    startsSessionV2Turn({ id: "msg_notice", type: "user", source, text: "Background update", time: { created: 1 } }),
  ).toBe(false)
})

test("explicit and historical user prompts still start a visible turn", () => {
  const message = { id: "msg_user", type: "user" as const, text: "Work on this", time: { created: 1 } }
  expect(startsSessionV2Turn(message)).toBe(true)
  expect(startsSessionV2Turn({ ...message, source: "user" })).toBe(true)
})
