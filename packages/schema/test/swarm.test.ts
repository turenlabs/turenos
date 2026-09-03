import { describe, expect, test } from "bun:test"
import { Swarm } from "../src/swarm"

describe("Swarm.parse", () => {
  test("parses a leading default-budget invocation", () => {
    expect(Swarm.parse("  @swarm compare X, Y, and our implementation  ")).toEqual({
      status: "ready",
      objective: "compare X, Y, and our implementation",
      count: 12,
      explicitCount: false,
    })
  })

  test("parses explicit worker budgets through the hard ceiling", () => {
    expect(Swarm.parse("@swarm 30 audit the competitors")).toEqual({
      status: "ready",
      objective: "audit the competitors",
      count: 30,
      explicitCount: true,
    })
    expect(Swarm.parse("@swarm 50 maximum bounded audit")?.status).toBe("ready")
  })

  test("rejects invalid budgets and missing objectives without losing the request", () => {
    expect(Swarm.parse("@swarm 51 compare everything")).toEqual({
      status: "invalid",
      objective: "compare everything",
      reason: "count_out_of_range",
      requestedCount: "51",
    })
    expect(Swarm.parse("@swarm 1 too narrow")).toEqual({
      status: "invalid",
      objective: "too narrow",
      reason: "count_out_of_range",
      requestedCount: "1",
    })
    expect(Swarm.parse("@swarm 30")).toEqual({
      status: "invalid",
      objective: "",
      reason: "missing_objective",
      requestedCount: "30",
    })
    expect(Swarm.parse("@swarm")).toEqual({
      status: "invalid",
      objective: "",
      reason: "missing_objective",
    })
  })

  test("does not treat ordinary mentions or similar names as a swarm", () => {
    expect(Swarm.parse("compare our @swarm documentation")).toBeUndefined()
    expect(Swarm.parse("@swarming compare implementations")).toBeUndefined()
    expect(Swarm.parse("email @swarm@example.com")).toBeUndefined()
  })

  test("preserves multiline objectives", () => {
    expect(Swarm.parse("@swarm 12 compare X\nthen audit our implementation")).toMatchObject({
      status: "ready",
      objective: "compare X\nthen audit our implementation",
      count: 12,
    })
  })
})
