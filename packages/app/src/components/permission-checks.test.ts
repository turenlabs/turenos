import { expect, test } from "bun:test"
import { createPermissionChecksUpdater } from "./permission-checks"

test("refetches the committed value when the update response is lost", async () => {
  const values: boolean[] = []
  let server = false
  const update = createPermissionChecksUpdater({
    current: () => values.at(-1),
    mutate: (value) => values.push(value),
    read: () => Promise.resolve(server),
    update: (value) => {
      server = value
      return Promise.reject(new Error("response lost"))
    },
  })

  await update(true)

  expect(server).toBe(true)
  expect(values).toEqual([true, true])
})

test("falls back to the last confirmed value only when update and refetch both fail", async () => {
  const values = [false]
  const update = createPermissionChecksUpdater({
    current: () => values.at(-1),
    mutate: (value) => values.push(value),
    read: () => Promise.reject(new Error("offline")),
    update: () => Promise.reject(new Error("offline")),
  })

  await update(true)

  expect(values).toEqual([false, true, false])
})

test("serializes overlapping toggles so late commits cannot reverse the latest intent", async () => {
  const values = [false]
  let server = false
  let active = 0
  let maxActive = 0
  const commits: { value: boolean; resolve: (value: boolean) => void }[] = []
  const update = createPermissionChecksUpdater({
    current: () => values.at(-1),
    mutate: (value) => values.push(value),
    read: () => Promise.resolve(server),
    update: (value) => {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<boolean>((resolve) =>
        commits.push({
          value,
          resolve: (confirmed) => {
            server = value
            active--
            resolve(confirmed)
          },
        }),
      )
    },
  })

  const first = update(true)
  const second = update(false)
  while (commits.length < 1) await Promise.resolve()
  expect(commits).toHaveLength(1)
  commits[0].resolve(true)
  await first
  while (commits.length < 2) await Promise.resolve()
  commits[1].resolve(false)
  await second

  expect(maxActive).toBe(1)
  expect(server).toBe(false)
  expect(values.at(-1)).toBe(false)
})

test("keeps the last confirmed value when overlapping updates and reads all fail", async () => {
  const values = [false]
  const update = createPermissionChecksUpdater({
    current: () => values.at(-1),
    mutate: (value) => values.push(value),
    read: () => Promise.reject(new Error("offline")),
    update: () => Promise.reject(new Error("offline")),
  })

  await Promise.all([update(true), update(false)])

  expect(values).toEqual([false, true, false, false])
})
