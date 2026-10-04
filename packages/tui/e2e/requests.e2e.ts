import { expect, test } from "bun:test"
import { sandbox } from "./support"

const tui = sandbox("requests")

test("a permission request is reviewed and allowed once, then the tool runs", async () => {
  await tui.launch("please run the marker")
  await tui.waitFor("Needs input")
  await tui.keys("p")
  const dialog = await tui.waitFor("Permission request")
  expect(dialog).toContain("echo sandbox-marker && ls")
  expect(dialog).toMatch(/▶ Reject/)
  await tui.keys("Down", "C-s")
  await tui.waitFor("Done: the bash tool returned")
  await tui.idle()
  expect(tui.screen()).toContain("bash · echo sandbox-marker && ls")
})

test("a rejected permission leaves the tool unrun", async () => {
  await tui.reply("run it again")
  await tui.waitFor("Needs input")
  await tui.keys("p")
  await tui.waitFor("Permission request")
  await tui.keys("C-s")
  await tui.idle()
  const screen = await tui.settle()
  // The server records a declined tool as interrupted; nothing ran, so no output follows.
  const after = screen.slice(screen.lastIndexOf("run it again"))
  expect(after).toContain("[interrupted] bash · echo sandbox-marker && ls")
  expect(after).not.toContain("Done: the bash tool")
})

test("a question is answered from the picker", async () => {
  await tui.reply("ask me a colour")
  await tui.waitFor("Question 1 of 1", 20_000)
  await tui.waitFor("Enter Choose, then review answers")
  await tui.keys("Down", "Enter")
  const review = await tui.waitFor("Review answers")
  expect(review).toContain("Blue")
  await tui.keys("C-s")
  await tui.waitFor("Done: the question tool returned")
  await tui.idle()
})

test("a running turn stops from the action row's x, and reads as interrupted", async () => {
  await tui.reply("tell me a slow story")
  await tui.waitFor("word3")
  await tui.waitFor("x Stop")
  await tui.keys("x")
  await tui.waitFor("Type stop")
  await tui.type("stop")
  await tui.keys("C-s")
  await tui.waitFor("INTERRUPTED: the turn was stopped before it finished.")
  await tui.idle()
  expect(tui.screen()).not.toContain("ERROR: Provider turn interrupted")
})

test("Esc twice stops a running turn without the typed confirmation", async () => {
  await tui.reply("another slow story")
  await tui.waitFor("word2")
  await tui.keys("Escape")
  await tui.waitFor("Press Esc again to stop this turn")
  await tui.keys("Escape")
  await tui.waitFor("INTERRUPTED: the turn was stopped before it finished.")
  await tui.idle()
})

test("the footer names the session's agent and model", async () => {
  await tui.waitFor("build · sandbox/scripted")
})

test("a rejected provider request ends the turn with a visible error", async () => {
  await tui.reply("this should fail")
  await tui.waitFor("ERROR: HTTP 401: sandbox provider refused the key", 30_000)
  await tui.idle()
})

test("provider retries are visible while they happen, then the reply arrives", async () => {
  await tui.reply("be flaky")
  await tui.waitFor(/Retrying/, 20_000)
  expect(tui.screen()).toContain("sandbox provider is busy")
  await tui.waitFor("Recovered after the retries.", 60_000)
  await tui.idle()
  await tui.waitFor((screen: string) => !screen.includes("Retrying"))
})
