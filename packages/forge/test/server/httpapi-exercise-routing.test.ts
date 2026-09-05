import { describe, expect, test } from "bun:test"
import { http } from "./httpapi-exercise/dsl"
import { coverageResult, failureRatchet, parseOptions, selectedScenarios } from "./httpapi-exercise/routing"
import type { Scenario } from "./httpapi-exercise/types"

const scenarios: Scenario[] = [
  ...Array.from({ length: 7 }, (_, index) => http.protected.get(`/route/${index}`, `scenario.${index}`).json()),
  { kind: "todo", method: "GET", path: "/future", name: "future", reason: "not implemented" },
]

describe("HttpApi scenario shards", () => {
  test.each(["coverage", "auth", "effect"])("preserves every scenario exactly once in %s mode", (mode) => {
    const whole = selectedScenarios(parseOptions(["--mode", mode]), scenarios)
    const partitions = [1, 2, 3].map((index) =>
      selectedScenarios(parseOptions(["--mode", mode, "--shard", `${index}/3`]), scenarios),
    )
    expect(partitions.map((part) => part.length)).toEqual([3, 3, 2])
    expect(
      partitions
        .flat()
        .map((scenario) => scenario.name)
        .sort(),
    ).toEqual(whole.map((scenario) => scenario.name).sort())
    expect(new Set(partitions.flat()).size).toBe(whole.length)
    expect(
      partitions
        .flat()
        .map(coverageResult)
        .filter((result) => result.status === "skip"),
    ).toHaveLength(1)
  })

  test.each(["0/3", "4/3", "1/0", "-1/3", "1.5/3", "1", "1/3/4", "1/9007199254740992"])(
    "rejects invalid shard %s",
    (shard) => expect(() => parseOptions(["--shard", shard])).toThrow("invalid --shard"),
  )

  test("rejects empty, duplicate and partial shard selections", () => {
    expect(() => parseOptions(["--shard"])).toThrow("missing value")
    expect(() => parseOptions(["--shard", "--mode", "effect"])).toThrow("missing value")
    expect(() => parseOptions(["--shard", "1/2", "--shard=2/2"])).toThrow("duplicate")
    expect(() => selectedScenarios(parseOptions(["--shard", "1/9"]), scenarios)).toThrow("empty")
    for (const filter of ["--include", "--start-at", "--stop-at"])
      expect(() => selectedScenarios(parseOptions(["--shard", "1/3", filter, "scenario"]), scenarios)).toThrow(
        "filters",
      )
    expect(parseOptions(["--mode=auth", "--shard=2/3"]).shard).toEqual({ index: 2, total: 3 })
    expect(parseOptions(["--mode=auth"]).mode).toBe("auth")
  })

  test("never reports an unexecuted known failure as fixed or masks a new failure", () => {
    const known = http.protected.get("/known", "known").json()
    const unexpected = http.protected.get("/new", "new").json()
    expect(
      failureRatchet(
        [
          { status: "fail", scenario: known, message: "known failure" },
          { status: "fail", scenario: unexpected, message: "regression" },
        ],
        new Set(["known", "another-shard"]),
      ),
    ).toEqual({
      unexpected: [{ status: "fail", scenario: unexpected, message: "regression" }],
      fixed: [],
    })
    expect(failureRatchet([{ status: "pass", scenario: known }], new Set(["known", "another-shard"]))).toEqual({
      unexpected: [],
      fixed: ["known"],
    })
  })
})
