import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@turenlabs/core/session/compaction"
import { SessionContextManagement } from "@turenlabs/core/session/context-management"

const handoff = {
  objective: "Migrate the backend to Bun",
  importantDetails: ["Must keep macOS, Windows and Linux on arm64 and x64", "Decision: PTY via bun-pty because node-pty fails"],
  completed: ["Server boots under Bun: packages/server/src/main.ts"],
  active: ["Windows arm64 build still failing"],
  blocked: [],
  nextMoves: ["Run `bun run build:win-arm64`", "Fix the missing native module error"],
  relevantFiles: ["packages/desktop/src/main/sidecar.ts: spawns the backend"],
  durableMemories: [],
}

describe("renderHandoff", () => {
  test("produces a checkpoint every compaction consumer accepts", () => {
    expect(SessionCompaction.validSummary(SessionContextManagement.renderHandoff(handoff))).toBe(true)
  })

  test("fills empty sections instead of leaving them out", () => {
    const text = SessionContextManagement.renderHandoff({
      ...handoff,
      completed: [],
      active: [" ", ""],
      relevantFiles: [],
    })
    expect(SessionCompaction.validSummary(text)).toBe(true)
    expect(text).toContain("### Completed\n- (none)")
    expect(text).toContain("### Active\n- (none)")
    expect(text).toContain("## Relevant Files\n- (none)")
  })

  test("numbers next moves in order and keeps each on one line", () => {
    const text = SessionContextManagement.renderHandoff({ ...handoff, nextMoves: ["first\nstep", "second"] })
    expect(text).toContain("## Next Move\n1. first step\n2. second")
  })

  test("renders an empty next move list in the template's own none form", () => {
    // The checkpoint tool rejects an empty list before it renders; the renderer itself stays total.
    const text = SessionContextManagement.renderHandoff({ ...handoff, nextMoves: [] })
    expect(text).toContain("## Next Move\n1. (none)")
    expect(SessionCompaction.validSummary(text)).toBe(true)
  })
})

describe("nudge thresholds", () => {
  test("one level per band, from the shared compaction target", () => {
    expect(SessionContextManagement.BUDGET).toBe(SessionCompaction.CONTEXT_TARGET)
    expect(SessionContextManagement.nudgeLevel(0.29)).toBeUndefined()
    expect(SessionContextManagement.nudgeLevel(0.3)).toBe("soft")
    expect(SessionContextManagement.nudgeLevel(0.39)).toBe("soft")
    expect(SessionContextManagement.nudgeLevel(SessionCompaction.CONTEXT_TARGET)).toBe("hard")
    expect(SessionContextManagement.nudgeLevel(0.9)).toBe("hard")
  })

  test("notes name the fill level and the tool to call", () => {
    for (const level of ["soft", "hard"] as const) {
      const note = SessionContextManagement.nudge({ level, usedPercent: 33 })
      expect(note).toContain("33%")
      expect(note).toContain("session_checkpoint")
    }
  })
})

describe("standing guidance", () => {
  test("states the budget, the cache lifetime, and what breaks the cache", () => {
    const text = SessionContextManagement.GUIDANCE
    expect(text).toContain(`${Math.round(SessionCompaction.CONTEXT_TARGET * 100)}%`)
    expect(text).toContain("5 minutes")
    expect(text).toContain("tool_load")
    expect(text).toContain("session_context")
    expect(text).toContain("session_checkpoint")
  })

  test("is static text: no per-session or per-turn values", () => {
    expect(SessionContextManagement.GUIDANCE).toBe(SessionContextManagement.GUIDANCE)
    expect(SessionContextManagement.GUIDANCE).not.toMatch(/ses_[0-9a-f]{8}/)
  })
})

describe("describe", () => {
  const row = (secondsAgo: number, input: number, read: number, write = 0, now = 1_000_000) => ({
    time: now - secondsAgo * 1000,
    tokens_input: input,
    tokens_cache_read: read,
    tokens_cache_write: write,
  })
  const base = { window: 1_000_000, turns: 10, cost: 12.3456, checkpoints: [] as number[], now: 1_000_000 }

  test("reports fill from the newest turn and the cache hit over recent turns", () => {
    const status = SessionContextManagement.describe({ ...base, recent: [row(10, 100_000, 200_000), row(60, 50_000, 50_000)] })
    expect(status.contextTokens).toBe(300_000)
    expect(status.usedPercent).toBe(30)
    // 250k cached of 400k input over both turns.
    expect(status.cacheHitPercent).toBe(63)
    expect(status.cost).toBe(12.35)
    expect(status.advice).toContain("Close to")
  })

  test("counts cache writes as context, as providers that report them separately do", () => {
    const status = SessionContextManagement.describe({ ...base, recent: [row(5, 1_000, 100_000, 99_000)] })
    expect(status.contextTokens).toBe(200_000)
  })

  test("classifies the cache by idle time against a five minute lifetime", () => {
    const at = (seconds: number) => SessionContextManagement.describe({ ...base, recent: [row(seconds, 1, 1)] }).cache
    expect(at(30)).toBe("warm")
    expect(at(239)).toBe("warm")
    expect(at(240)).toBe("expiring")
    expect(at(299)).toBe("expiring")
    expect(at(300)).toBe("cold")
    expect(SessionContextManagement.describe({ ...base, recent: [] }).cache).toBe("unknown")
  })

  test("says over budget once the window passes the target", () => {
    const status = SessionContextManagement.describe({ ...base, recent: [row(1, 100_000, 350_000)] })
    expect(status.usedPercent).toBe(45)
    expect(status.advice).toContain("Over the 40% budget")
  })

  test("does not report a size that predates the latest checkpoint", () => {
    const status = SessionContextManagement.describe({
      ...base,
      recent: [row(120, 100_000, 500_000)],
      checkpoints: [base.now - 30_000],
    })
    expect(status.contextTokens).toBeUndefined()
    expect(status.usedPercent).toBeUndefined()
    expect(status.compactions).toBe(1)
    expect(status.advice).toContain("not known yet")
  })

  test("leaves the fill unknown without a declared window", () => {
    const status = SessionContextManagement.describe({ ...base, window: undefined, recent: [row(1, 100, 100)] })
    expect(status.contextTokens).toBe(200)
    expect(status.usedPercent).toBeUndefined()
  })
})
