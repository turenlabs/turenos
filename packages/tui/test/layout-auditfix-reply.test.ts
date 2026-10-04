import { expect, test } from "bun:test"
import { dashboard } from "./support"

for (const [width, height] of [
  [160, 48],
  [80, 24],
  [60, 24],
] as const) {
  test(`a blank reply keeps its editor and message field visible at ${width}x${height}`, async () => {
    const app = await dashboard({})
    app.view.resize(width, height)
    await app.screen("Sessions")
    app.view.mockInput.pressKey("f")
    app.view.mockInput.pressEnter()
    const frame = await app.screen("Enter a message between 1 and 32,000 characters.")
    expect(frame).toContain("Your message")
    expect(frame).toContain("[ Send (Enter) ]")
    expect(app.server.sent("/api/session/ses_main/prompt")).toHaveLength(0)
  })
}
