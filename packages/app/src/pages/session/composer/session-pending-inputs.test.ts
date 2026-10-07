import { describe, expect, test } from "bun:test"
import { orderPendingInputs } from "./session-pending-inputs"

const input = (id: string, delivery: "steer" | "queue") => ({ id, text: id, delivery, sending: false })

describe("orderPendingInputs", () => {
  test("steers deliver ahead of queued inputs regardless of admission order", () => {
    const ordered = orderPendingInputs([
      input("msg_1", "queue"),
      input("msg_2", "steer"),
      input("msg_3", "queue"),
      input("msg_4", "steer"),
    ])
    expect(ordered.map((item) => item.id)).toEqual(["msg_2", "msg_4", "msg_1", "msg_3"])
  })

  test("queued inputs are numbered in delivery order; steers carry no position", () => {
    const ordered = orderPendingInputs([input("msg_1", "queue"), input("msg_2", "steer"), input("msg_3", "queue")])
    expect(ordered.map((item) => item.position)).toEqual([undefined, 1, 2])
  })

  test("upgrading a queued input to a steer renumbers the remaining queue", () => {
    const ordered = orderPendingInputs([input("msg_1", "steer"), input("msg_2", "queue")])
    expect(ordered.map((item) => [item.id, item.position])).toEqual([
      ["msg_1", undefined],
      ["msg_2", 1],
    ])
  })
})
