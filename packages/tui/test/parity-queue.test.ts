import { expect, test } from "bun:test"
import { dashboard } from "./support"

function queued(id: string, text: string, delivery: "queue" | "steer" = "queue") {
  return { admittedSeq: 1, id, sessionID: "ses_main", prompt: { text }, delivery, timeCreated: 1 }
}

test("queued messages can be sent now, discarded, or taken back into the reply editor", async () => {
  let inputs = [queued("msg_first", "Also run the linter"), queued("msg_second", "Then update the docs")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/steer": () => {
      inputs = inputs.filter((item) => item.id !== "msg_first")
      return { data: true }
    },
    "POST /api/session/ses_main/input/msg_second/cancel": () => {
      inputs = inputs.filter((item) => item.id !== "msg_second")
      return { data: true }
    },
  })
  await screen("u 2 queued")
  view.mockInput.pressKey("u")
  await screen("Also run the linter")
  view.mockInput.pressEnter()
  await screen("Sent now")
  expect(server.sent("/api/session/ses_main/input/msg_first/steer")).toHaveLength(1)
  // Discard asks twice; one Ctrl+D sends nothing.
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Ctrl+D again discards")
  expect(server.sent("/api/session/ses_main/input/msg_second/cancel")).toHaveLength(0)
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Discarded.")
  expect(server.sent("/api/session/ses_main/input/msg_second/cancel")).toHaveLength(1)
})

test("sending the only queued message closes the dialog and says Sent now.", async () => {
  let inputs = [queued("msg_first", "Also run the linter")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/steer": () => {
      inputs = []
      return { data: true }
    },
  })
  await screen("u 1 queued")
  view.mockInput.pressKey("u")
  await screen("Also run the linter")
  view.mockInput.pressEnter()
  await screen("Sent now.")
  expect(server.sent("/api/session/ses_main/input/msg_first/steer")).toHaveLength(1)
  expect(view.captureCharFrame()).not.toContain("Ctrl+D twice discard")
})

test("editing a queued message cancels it and reopens its text in the reply editor", async () => {
  let inputs = [queued("msg_first", "Rename the flag")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      inputs = []
      return { data: true }
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("Typing")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Rename the flag")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(1)
})

test("a queued message too long for the reply editor is never cancelled for editing", async () => {
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_long", "x".repeat(32001))] }),
  })
  view.mockInput.pressKey("u")
  await screen("Held · agent is idle")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("longer than the reply editor")
  expect(server.sent("/api/session/ses_main/input/msg_long/cancel")).toHaveLength(0)
})

test("editing a queued message keeps its text when Escape is pressed during the cancel", async () => {
  let release = () => {}
  const { view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({
      data: [
        {
          id: "msg_q1",
          sessionID: "ses_main",
          prompt: { text: "queued follow-up" },
          delivery: "queue",
          timeCreated: 1,
          admittedSeq: 1,
        },
      ],
    }),
    "POST /api/session/ses_main/input/msg_q1/cancel": () =>
      new Promise((resolve) => {
        release = () => resolve({ data: true })
      }),
  })
  view.mockInput.pressKey("u")
  await screen("queued follow-up")
  view.mockInput.pressKey("e", { ctrl: true })
  await Bun.sleep(50)
  // Escape while the server removes the message must not drop it: the dialog stays until it is a draft.
  view.mockInput.pressEscape()
  await Bun.sleep(50)
  release()
  expect(await screen("Typing")).toContain("queued follow-up")
})

test("a cancel whose answer was lost keeps the message text and does not claim it was delivered", async () => {
  let inputs = [queued("msg_first", "Rename the flag")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      inputs = []
      return new Response("lost", { status: 503 })
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  const frame = await screen("removed or already delivered")
  expect(frame).toContain("Rename the flag")
  expect(frame).not.toContain("already received that message")
  expect(frame).not.toContain("Typing")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(1)
})

test("a lost cancel on a message that is still queued leaves it listed for another try", async () => {
  let fail = true
  let inputs = [queued("msg_first", "Rename the flag")]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      if (fail) return new Response("down", { status: 503 })
      inputs = []
      return { data: true }
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("still queued")
  fail = false
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("Typing")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(2)
})

test("a refresh keeps the same queued message selected and disarms a discard that moved", async () => {
  let inputs = [
    queued("msg_a", "First message"),
    { ...queued("msg_b", "Second message"), admittedSeq: 2 },
    { ...queued("msg_c", "Third message"), admittedSeq: 3 },
  ]
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: inputs }),
    "POST /api/session/ses_main/input/msg_b/steer": () => ({ data: true }),
    "POST /api/session/ses_main/input/msg_b/cancel": () => ({ data: true }),
    "POST /api/session/ses_main/input/msg_c/cancel": () => ({ data: true }),
  })
  view.mockInput.pressKey("u")
  await screen("First message")
  view.mockInput.pressArrow("down")
  await screen("For: main task\n\nSecond message".split("\n")[0]!)
  inputs = inputs.slice(1)
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Second message")
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Ctrl+D again discards")
  inputs = inputs.slice(1)
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("selected message left the queue")
  view.mockInput.pressKey("d", { ctrl: true })
  await screen("Ctrl+D again discards")
  expect(server.sent("/api/session/ses_main/input/msg_b/cancel")).toHaveLength(0)
  expect(server.sent("/api/session/ses_main/input/msg_c/cancel")).toHaveLength(0)
})

test("a message the agent already read is reported instead of silently removed", async () => {
  const { view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_first", "Too late")] }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => ({ data: false }),
  })
  view.mockInput.pressKey("u")
  await screen("Too late")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("already received that message")
  expect(view.captureCharFrame()).not.toContain("Typing")
})
