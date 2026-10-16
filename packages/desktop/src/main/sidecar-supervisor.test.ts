import { expect, test } from "bun:test"
import { createSidecarSupervisor } from "./sidecar-supervisor"

function fixture(delayMs = 1) {
  const exits: ((code: number) => void)[] = []
  const ready: number[] = []
  const stopped: number[] = []
  const failures: unknown[] = []
  const supervisor = createSidecarSupervisor({
    spawn: async (exit) => {
      const id = exits.length
      exits.push(exit)
      return {
        id,
        listener: {
          stop: async () => {
            stopped.push(id)
          },
        },
      }
    },
    ready: (result) => {
      ready.push(result.id)
    },
    exited: () => {},
    exhausted: () => {},
    respawning: () => {},
    failed: (error) => {
      failures.push(error)
    },
    delayMs,
  })
  return { supervisor, exits, ready, stopped, failures }
}

test("shutdown clears a scheduled replacement", async () => {
  const f = fixture()
  await f.supervisor.start()
  f.exits[0](0)
  f.supervisor.stop()
  await Bun.sleep(15)
  expect(f.exits).toHaveLength(1)
  expect(f.ready).toEqual([0])
  await expect(f.supervisor.start()).rejects.toThrow("stopped")
})

test("late startup is stopped and never adopted", async () => {
  let complete!: (value: { listener: { stop(): Promise<void> } }) => void
  let stopped = 0
  let adopted = 0
  const supervisor = createSidecarSupervisor({
    spawn: () =>
      new Promise((resolve) => {
        complete = resolve
      }),
    ready: () => {
      adopted++
    },
    exited: () => {},
    exhausted: () => {},
    respawning: () => {},
    failed: () => {},
  })
  const starting = supervisor.start()
  supervisor.stop()
  complete({
    listener: {
      stop: async () => {
        stopped++
      },
    },
  })
  await expect(starting).rejects.toThrow("superseded")
  expect(stopped).toBe(1)
  expect(adopted).toBe(0)
})

test("old exit callbacks cannot retire the replacement", async () => {
  const f = fixture()
  await f.supervisor.start()
  f.exits[0](0)
  await Bun.sleep(15)
  expect(f.ready).toEqual([0, 1])
  f.exits[0](0)
  await Bun.sleep(15)
  expect(f.exits).toHaveLength(2)
  f.supervisor.stop()
})

test("unexpected exits preserve the five-replacement limit", async () => {
  const f = fixture()
  await f.supervisor.start()
  for (let i = 0; i < 6; i++) {
    f.exits[i](0)
    await Bun.sleep(15)
  }
  expect(f.exits).toHaveLength(6)
  expect(f.failures).toHaveLength(0)
  f.supervisor.stop()
})
