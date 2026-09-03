import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createProfilerController, PROFILE_DIR_NAME } from "./profiler"
import type { SidecarListener } from "./server"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "forge-profiler-test-"))
  roots.push(dir)
  return dir
}

type FakeSidecar = SidecarListener & {
  calls: string[]
  startError?: Error
  stopError?: Error
  writtenTo?: string
}

function fakeSidecar(overrides: Partial<Pick<FakeSidecar, "startError" | "stopError">> = {}) {
  const sidecar: FakeSidecar = {
    calls: [],
    ...overrides,
    stop: async () => {},
    profile: {
      start: async () => {
        sidecar.calls.push("start")
        if (sidecar.startError) throw sidecar.startError
      },
      stop: async (path: string) => {
        sidecar.calls.push("stop")
        sidecar.writtenTo = path
        if (sidecar.stopError) throw sidecar.stopError
        // The real sidecar writes the file itself; the controller only writes
        // the manifest, so the test does not need to create the profile.
        return { samples: 2005, durationMs: 3004.9, sampleRateHz: 667 }
      },
      abort: () => {
        sidecar.calls.push("abort")
      },
    },
  }
  return sidecar
}

function controller(sidecar: FakeSidecar | null, userDataPath: string) {
  const warnings: string[] = []
  const instance = createProfilerController({
    getSidecar: () => sidecar,
    userDataPath,
    environment: () => ({
      version: "0.1.0",
      name: "TurenOS Dev",
      channel: "dev",
      packaged: false,
      platform: "darwin",
      arch: "arm64",
      versions: {},
      userData: userDataPath,
    }),
    log: () => {},
    warn: (message) => warnings.push(message),
  })
  return { instance, warnings }
}

describe("profiler controller", () => {
  test("start then stop writes a manifest and reports where the artefact landed", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar()
    const { instance } = controller(sidecar, root)

    expect(instance.status().running).toBe(false)
    await instance.start()
    expect(instance.status().running).toBe(true)

    const result = await instance.stop()
    expect(sidecar.calls).toEqual(["start", "stop"])
    expect(result.samples).toBe(2005)
    expect(result.file).toBe("sidecar.cpuprofile")
    expect(sidecar.writtenTo).toBe(join(result.directory, "sidecar.cpuprofile"))

    const manifest = JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"))
    expect(manifest.process).toBe("sidecar")
    expect(manifest.capture.samples).toBe(2005)
    expect(instance.status().running).toBe(false)
  })

  test("each run gets its own directory under the profiles folder", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar()
    const { instance } = controller(sidecar, root)

    await instance.start()
    const first = await instance.stop()
    await instance.start()
    const second = await instance.stop()

    expect(first.directory).not.toBe(second.directory)
    const runs = await readdir(join(root, PROFILE_DIR_NAME))
    expect(runs).toHaveLength(2)
  })

  test("is unavailable with no sidecar, and refuses to start", async () => {
    const root = await scratch()
    const { instance } = controller(null, root)
    expect(instance.status().available).toBe(false)
    await expect(instance.start()).rejects.toThrow("The TurenOS server is not running yet")
  })

  test("a sidecar that refuses to start leaves no empty run directory behind", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar({ startError: new Error("inspector unavailable") })
    const { instance } = controller(sidecar, root)

    await expect(instance.start()).rejects.toThrow("inspector unavailable")
    expect(instance.status().running).toBe(false)
    await expect(readdir(join(root, PROFILE_DIR_NAME))).resolves.toEqual([])
  })

  test("a failed collection still writes a manifest explaining what went wrong", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar({ stopError: new Error("Sidecar exited during profiling") })
    const { instance } = controller(sidecar, root)

    await instance.start()
    const directory = instance.status().directory!
    await expect(instance.stop()).rejects.toThrow("Sidecar exited during profiling")

    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
    expect(manifest.capture).toBeNull()
    expect(manifest.failure).toBe("Sidecar exited during profiling")
    expect(manifest.notes[0]).toContain("WARNING: no profile was captured")
    // The run must not stay armed after a failed collection.
    expect(instance.status().running).toBe(false)
  })

  test("stopping when nothing is running is an error, not a silent empty run", async () => {
    const root = await scratch()
    const { instance } = controller(fakeSidecar(), root)
    await expect(instance.stop()).rejects.toThrow("No profile is running")
  })

  test("quitting mid-profile discards the run without awaiting anything", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar()
    const { instance, warnings } = controller(sidecar, root)

    await instance.start()
    // Synchronous by contract: the quit path cannot await, and must not add
    // measurable latency to teardown.
    const before = process.hrtime.bigint()
    instance.abortForQuit()
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6

    expect(elapsedMs).toBeLessThan(5)
    expect(sidecar.calls).toEqual(["start", "abort"])
    expect(instance.status().running).toBe(false)
    expect(warnings.some((w) => w.includes("discarding in-flight CPU profile"))).toBe(true)
    // No stop command is ever sent, so nothing waits on the sidecar.
    expect(sidecar.calls).not.toContain("stop")
    // And the abandoned run leaves no empty directory behind.
    await expect(readdir(join(root, PROFILE_DIR_NAME))).resolves.toEqual([])
  })

  test("aborting when nothing is running is a no-op", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar()
    const { instance } = controller(sidecar, root)
    instance.abortForQuit()
    expect(sidecar.calls).toEqual([])
  })

  test("subscribers see the armed and disarmed transitions", async () => {
    const root = await scratch()
    const { instance } = controller(fakeSidecar(), root)
    const seen: boolean[] = []
    const unsubscribe = instance.subscribe((status) => seen.push(status.running))

    await instance.start()
    await instance.stop()
    unsubscribe()
    await instance.start()

    expect(seen).toEqual([true, false])
  })

  test("a second start while armed is a no-op rather than a second run", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar()
    const { instance } = controller(sidecar, root)

    await instance.start()
    await instance.start()
    expect(sidecar.calls).toEqual(["start"])
    await instance.stop()
    const runs = await readdir(join(root, PROFILE_DIR_NAME))
    expect(runs).toHaveLength(1)
  })

  test("concurrent start and stop are serialised, not interleaved", async () => {
    const root = await scratch()
    const sidecar = fakeSidecar()
    const { instance } = controller(sidecar, root)

    const [, stopped] = await Promise.all([instance.start(), instance.start().then(() => instance.stop())])
    expect(sidecar.calls).toEqual(["start", "stop"])
    expect(stopped.samples).toBe(2005)
  })
})
