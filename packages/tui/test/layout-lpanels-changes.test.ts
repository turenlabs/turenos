import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, terminal, turen } from "./support"

async function changes(width: number, height: number) {
  const server = turen({
    routes: {
      "GET /vcs/diff": () => [
        {
          file: "notes.md",
          patch:
            "diff --git a/notes.md b/notes.md\n@@ -0,0 +1 @@\n+Written by the sandbox model, with a long line that cannot fit",
          additions: 3,
          deletions: 0,
          status: "added",
        },
      ],
    },
  })
  const { view, screen } = await terminal(width, height)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  view.mockInput.pressKey("d")
  await screen("diff --git")
  await view.renderOnce()
  return view.captureCharFrame().split("\n")
}

for (const [width, height] of [
  [100, 30],
  [80, 24],
  [60, 24],
] as const)
  test(`Changes keeps its heading, counts and hint inside the frame at ${width}x${height}`, async () => {
    const lines = await changes(width, height)
    const frame = lines.filter((line) => line.trim().startsWith("│") || line.trim().startsWith("╭"))
    const border = Math.max(...frame.map((line) => line.trimEnd().length))
    const heading = lines.find((line) => line.includes("Uncommitted changes"))!
    expect(heading.trimEnd().length).toBe(border)
    expect(heading.trimEnd()).toEndWith("│")
    expect(heading).toContain("1 file +3 -0")
    const hints = lines.filter(
      (line) => /file|scroll|mode|mention|refresh|close/.test(line) && !line.includes("Uncommitted"),
    )
    for (const line of hints) expect(line.replace(/[│\s]/g, "")).not.toStartWith("·")
    expect(lines.join("\n")).toContain("Esc close")
    expect(lines.some((line) => /^[│\s]*close\s*│?$/.test(line))).toBe(false)
  })

test("Changes refits its heading and hints when the terminal shrinks while open", async () => {
  const server = turen({
    routes: {
      "GET /vcs/diff": () => [
        { file: "notes.md", patch: "@@ -0,0 +1 @@\n+x", additions: 3, deletions: 0, status: "added" },
      ],
    },
  })
  const { view, screen } = await terminal(120, 36)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  view.mockInput.pressKey("d")
  await screen("@@ -0,0 +1 @@")
  view.resize(80, 24)
  for (let frame = 0; frame < 4; frame++) await view.renderOnce()
  const lines = view.captureCharFrame().split("\n")
  const heading = lines.find((line) => line.includes("Uncommitted changes"))!
  expect(heading.trimEnd()).toEndWith("│")
  expect(heading).toContain("1 file +3 -0")
  const hint = lines.filter((line) => /file ·|scroll|Esc close/.test(line)).join("\n")
  expect(hint).toContain("Esc close")
  expect(hint).not.toMatch(/\n[│\s]*·/)
})
