import { describe, expect, test } from "bun:test"
import { sortAutomations } from "./sort"
import type { LoopInfo } from "./api"

const automation = (input: Partial<LoopInfo> & Pick<LoopInfo, "id" | "name" | "status" | "time">) =>
  ({
    prompt: "Check things",
    schedule: { type: "interval", seconds: 3_600, timezone: "UTC" },
    location: { directory: "/repo" },
    overlapPolicy: "skip",
    startsAt: 1,
    expiresAt: 10_000,
    ...input,
  }) as LoopInfo

const items = [
  automation({ id: "old", name: "Zulu", status: "paused", time: { created: 1, updated: 1 }, nextRunAt: undefined }),
  automation({ id: "new", name: "Alpha", status: "active", time: { created: 3, updated: 3 }, nextRunAt: 30 }),
  automation({ id: "middle", name: "Beta", status: "expired", time: { created: 2, updated: 2 }, nextRunAt: 20 }),
]

describe("sortAutomations", () => {
  test("keeps newest-first as the default ordering", () => {
    expect(sortAutomations(items, "created-desc").map((item) => item.id)).toEqual(["new", "middle", "old"])
  })

  test("supports name, status, and next-run ordering", () => {
    expect(sortAutomations(items, "name-asc").map((item) => item.id)).toEqual(["new", "middle", "old"])
    expect(sortAutomations(items, "status").map((item) => item.id)).toEqual(["new", "old", "middle"])
    expect(sortAutomations(items, "next-run").map((item) => item.id)).toEqual(["middle", "new", "old"])
  })

  test("does not mutate the source list", () => {
    const source = [...items]
    sortAutomations(source, "created-asc")
    expect(source.map((item) => item.id)).toEqual(["old", "new", "middle"])
  })
})
