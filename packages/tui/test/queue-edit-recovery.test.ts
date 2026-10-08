import { expect, test } from "bun:test"
import { dashboard } from "./support"

const queued = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  admittedSeq: 1,
  id,
  sessionID: "ses_main",
  prompt: { text, ...extra },
  delivery: "queue",
  timeCreated: 1,
})

test("an edit whose cancel got no answer reopens the kept copy once the queue shows it is gone", async () => {
  let inputs = [queued("msg_first", "Rename the flag")]
  let down = false
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => (down ? new Response("down", { status: 503 }) : { data: inputs }),
    "POST /api/session/ses_main/input/msg_first/cancel": () => {
      // The server removed the message, then the connection dropped before the answer arrived.
      inputs = []
      down = true
      return new Response("lost", { status: 503 })
    },
  })
  view.mockInput.pressKey("u")
  await screen("Rename the flag")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("may already be removed")
  down = false
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Reply to main task")
  expect(view.renderer.currentFocusedEditor?.plainText).toBe("Rename the flag")
  expect(server.sent("/api/session/ses_main/input/msg_first/cancel")).toHaveLength(1)
})

test("a failed queue refresh leaves nothing actionable until a refresh succeeds", async () => {
  let down = false
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () =>
      down ? new Response("down", { status: 503 }) : { data: [queued("msg_a", "First")] },
    "POST /api/session/ses_main/input/msg_a/steer": () => ({ data: true }),
    "POST /api/session/ses_main/input/msg_a/cancel": () => ({ data: true }),
  })
  view.mockInput.pressKey("u")
  await screen("First")
  down = true
  view.mockInput.pressKey("r", { ctrl: true })
  await screen("Queued messages unavailable")
  view.mockInput.pressKey("e", { ctrl: true })
  view.mockInput.pressEnter()
  view.mockInput.pressKey("d", { ctrl: true })
  view.mockInput.pressKey("d", { ctrl: true })
  await Bun.sleep(100)
  expect(server.requests.filter((item) => item.method === "POST")).toHaveLength(0)
})

test("a queued message with attachments the reply editor cannot carry is not cancelled for editing", async () => {
  const image = { uri: "data:image/png;base64,AAAA", mime: "image/png", name: "shot.png" }
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_img", "Look at this", { files: [image] })] }),
    "POST /api/session/ses_main/input/msg_img/cancel": () => ({ data: true }),
  })
  view.mockInput.pressKey("u")
  await screen("Look at this")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("attachments")
  expect(server.sent("/api/session/ses_main/input/msg_img/cancel")).toHaveLength(0)
})

test("a queued message whose @file mention the text carries still edits", async () => {
  const file = { uri: "file:///srv/main/src/a.ts", mime: "text/plain", name: "a.ts" }
  const { server, view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({ data: [queued("msg_file", "Read @src/a.ts", { files: [file] })] }),
    "POST /api/session/ses_main/input/msg_file/cancel": () => ({ data: true }),
  })
  view.mockInput.pressKey("u")
  await screen("Read @src/a.ts")
  view.mockInput.pressKey("e", { ctrl: true })
  await screen("Reply to main task")
  expect(server.sent("/api/session/ses_main/input/msg_file/cancel")).toHaveLength(1)
})
