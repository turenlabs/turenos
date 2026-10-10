import { describe, expect, test } from "bun:test"
import { createReleaseNotesCoordinator } from "./release-notes"

function fixture(version = "1.0.44") {
  const state = {
    baseline: undefined as string | undefined,
    legacy: null as string | null,
    pending: true,
    existing: false,
    failRead: false,
    failWrite: false,
    wait: undefined as Promise<void> | undefined,
  }
  const storage = {
    async getReleaseNotesVersion() {
      await state.wait
      if (state.failRead) throw new Error("read unavailable")
      return state.baseline
    },
    async setReleaseNotesVersion(_owner: number | string, value: string) {
      if (state.failWrite) throw new Error("write unavailable")
      state.baseline = value
    },
    isFirstLaunchOnboardingPending: async () => state.pending,
    isOldLayoutEligible: async () => state.existing,
  }
  const warnings: unknown[] = []
  const create = (current = version) =>
    createReleaseNotesCoordinator({
      version: current,
      storage,
      legacy: async () => state.legacy,
      warn: (error) => warnings.push(error),
    })
  return { state, create, warnings }
}

describe("desktop release notes", () => {
  test("an unowned shown call cannot acknowledge a still-pending claim", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    const gate = Promise.withResolvers<void>()
    app.state.wait = gate.promise
    const notes = app.create()
    const claiming = notes.claim(1, true)
    const manualShown = notes.shown(1)
    gate.resolve()
    expect(await claiming).toEqual({ previous: "1.0.40" })
    await manualShown
    expect(app.state.baseline).toBe("1.0.40")
    await notes.shown(1)
    expect(app.state.baseline).toBe("1.0.44")
  })

  test("same-window remount keeps a newer claim when a cancelled read finishes", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    const gate = Promise.withResolvers<void>()
    app.state.wait = gate.promise
    const notes = app.create()
    const stale = notes.claim(1, true)
    notes.release(1)
    const current = notes.claim(1, true)
    gate.resolve()
    expect(await stale).toBeNull()
    expect(await current).toEqual({ previous: "1.0.40" })
    await notes.shown(1)
    expect(app.state.baseline).toBe("1.0.44")
  })

  test("read failure stays silent and a later launch can retry", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    app.state.failRead = true
    const notes = app.create()
    await notes.initialize()
    expect(await notes.claim(1, true)).toBeNull()
    app.state.failRead = false
    expect(await app.create().claim(2, true)).toEqual({ previous: "1.0.40" })
    expect(app.warnings).toHaveLength(1)
  })

  test.each(["seed", "optout", "shown"])(
    "handles a failed %s write without poisoning the next launch",
    async (phase) => {
      const app = fixture()
      if (phase !== "seed") app.state.baseline = "1.0.40"
      const notes = app.create()
      if (phase === "shown") expect(await notes.claim(1, true)).toEqual({ previous: "1.0.40" })
      app.state.failWrite = true
      if (phase === "shown") await notes.shown(1)
      if (phase === "seed") await notes.initialize()
      if (phase === "optout") expect(await notes.claim(1, false)).toBeNull()
      expect(await notes.claim(2, true)).toBeNull()
      app.state.failWrite = false
      expect(await app.create().claim(2, true)).toEqual(phase === "seed" ? null : { previous: "1.0.40" })
      expect(app.warnings).toHaveLength(1)
    },
  )

  test("releases an unshown claim without advancing the baseline", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    app.state.pending = false
    const notes = app.create()
    expect(await notes.claim(1, true)).toEqual({ previous: "1.0.40" })
    notes.release(2)
    expect(await notes.claim(2, true)).toBeNull()
    notes.release(1)
    await notes.shown(1)
    expect(app.state.baseline).toBe("1.0.40")
    expect(await notes.claim(2, true)).toEqual({ previous: "1.0.40" })
  })

  test("renderer teardown cancels an asynchronous claim before it can pin ownership", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    app.state.pending = false
    const gate = Promise.withResolvers<void>()
    app.state.wait = gate.promise
    const notes = app.create()
    const claiming = notes.claim(1, true)
    await Promise.resolve()
    notes.release(1)
    const other = notes.claim(2, true)
    gate.resolve()
    expect(await claiming).toBeNull()
    expect(await other).toEqual({ previous: "1.0.40" })
  })

  test.each(["1.0.40", "1.0.50"])("imports the legacy high-water version %s without replacing it", async (version) => {
    const app = fixture()
    app.state.legacy = JSON.stringify({ version })
    app.state.pending = false
    const notes = app.create()
    await notes.initialize()
    expect(app.state.baseline).toBe(version)
    expect(await notes.claim(1, true)).toEqual(version === "1.0.40" ? { previous: version } : null)
    expect(await app.create("1.0.51").claim(2, true)).toEqual({ previous: version })
  })

  test.each(["completed onboarding", "old layout"])("recognizes an existing install from %s", async (kind) => {
    const app = fixture()
    app.state.pending = kind !== "completed onboarding"
    app.state.existing = kind === "old layout"
    const notes = app.create()
    await notes.initialize()
    expect(app.state.baseline).toBe("0.0.0")
    expect(await notes.claim(1, true)).toEqual({ previous: "0.0.0" })
  })

  test("opting out advances the high-water mark without a claim", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    app.state.pending = false
    const notes = app.create()
    expect(await notes.claim(1, false)).toBeNull()
    expect(app.state.baseline).toBe("1.0.44")
    expect(await notes.claim(2, true)).toBeNull()
    expect(await app.create("1.0.50").claim(2, true)).toEqual({ previous: "1.0.44" })
  })

  test.each(["1.0.40", "1.0.39", "1.1.0-beta.1", "dev", "01.1.0", "1.0.44+build", "1.0.44\n"])(
    "does not show or lower the high-water mark on %s",
    async (version) => {
      const app = fixture(version)
      app.state.baseline = "1.0.40"
      app.state.pending = false
      expect(await app.create().claim(1, true)).toBeNull()
      expect(app.state.baseline).toBe("1.0.40")
      expect(await app.create("1.0.40").claim(1, true)).toBeNull()
      expect(await app.create("1.0.44").claim(1, true)).toEqual({ previous: "1.0.40" })
    },
  )

  test("serializes concurrent claims and persists only the claimed owner's acknowledgement", async () => {
    const app = fixture()
    app.state.baseline = "1.0.40"
    app.state.pending = false
    const notes = app.create()
    await notes.shown(2)
    expect(app.state.baseline).toBe("1.0.40")
    expect(await Promise.all([notes.claim(1, true), notes.claim(2, true), notes.claim(1, true)])).toEqual([
      { previous: "1.0.40" },
      null,
      null,
    ])
    await notes.shown(2)
    expect(app.state.baseline).toBe("1.0.40")
    await notes.shown(1)
    expect(app.state.baseline).toBe("1.0.44")
    expect(await app.create().claim(3, true)).toBeNull()
  })

  test("seeds a fresh install silently before onboarding completes", async () => {
    const app = fixture()
    const notes = app.create()
    await notes.initialize()
    expect(app.state.baseline).toBe("1.0.44")
    app.state.pending = false
    expect(await notes.claim(1, true)).toBeNull()
    expect(await app.create().claim(2, true)).toBeNull()
  })
})
