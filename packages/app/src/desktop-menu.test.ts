import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "Export Logs...",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("uses TurenOS for user-visible macOS application roles", () => {
    const app = DESKTOP_MENU.find((menu) => menu.id === "app")
    const labels = app?.items?.flatMap((item) => (item.type === "item" && item.label ? [item.label] : [])) ?? []
    expect(labels).toContain("About TurenOS")
    expect(labels).toContain("Hide TurenOS")
    expect(labels).toContain("Quit TurenOS")
  })
})
