import { expect, test } from "bun:test"
import { validateResponse } from "../src/response-validation"
import { answer, log, message, mates, old, room, task } from "./team-fixture"

const valid = () => answer(log)

const check = (value: unknown) => validateResponse(new URL("http://x/api/team"), undefined, value)

test("the Team validator accepts a valid state and rejects malformed ones", () => {
  expect(check(valid())).toBeDefined()
  expect(() => check({ ...valid(), room: { ...room, id: "bad id" } })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), room: old, rooms: [room] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), messages: Array.from({ length: 201 }, (_, i) => message(i + 1, "x")) })).toThrow(
    "exceeds",
  )
  expect(() => check({ ...valid(), messages: [{ ...log[0], time: "Infinity" }] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), tasks: [task("queued", { sessionID: "../x" })] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), teammates: [{ ...mates[0], handle: "bad handle" }] })).toThrow(
    "Invalid server response",
  )
  expect(() => check({ ...valid(), messages: [log[0], log[0]] })).toThrow("duplicate")
  expect(check({ ...valid(), messages: [{ ...log[0], replyTo: "msg_0" }] })).toBeDefined()
  expect(() => check({ ...valid(), messages: [{ ...log[0], replyTo: "../x" }] })).toThrow("Invalid server response")
})

const write = (path: string, method: string, value: unknown) =>
  validateResponse(new URL(`http://x/api/team${path}`), { method }, value)

const factory = {
  revision: 1,
  config: {
    outcome: "Ship",
    parameters: {},
    constraints: "",
    acceptanceCriteria: "Done",
    directory: "/srv/main",
    coordinatorTeammateID: "tm_moss",
    teammateIDs: ["tm_moss"],
  },
}

const finished = {
  id: "run_1",
  roomID: "trm_team",
  status: "succeeded",
  phase: "done",
  taskIDs: ["job_1"],
  result: "ok",
  time: { created: 1, updated: 2 },
}

type State = ReturnType<typeof valid>

test("a teammate role or name over 512 characters is clipped, not a reason to reject the room", () => {
  const long = "x".repeat(513)
  const state = check({ ...valid(), teammates: [{ ...mates[0], role: long, name: long }] }) as State
  expect(state.teammates[0]!.role).toContain("[truncated")
  expect(state.teammates[0]!.name).toContain("[truncated")
  expect(() => check({ ...valid(), teammates: [{ ...mates[0], name: "bad\u202ename" }] })).toThrow(
    "Invalid server response",
  )
})

test("a room with more than 200 teammates is readable, up to the collection bound", () => {
  const crowd = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...mates[0], id: `tm_${index}`, handle: `mate${index}` }))
  expect((check({ ...valid(), teammates: crowd(201) }) as State).teammates).toHaveLength(201)
  expect(() => check({ ...valid(), teammates: crowd(1001) })).toThrow("exceeds")
})

test("a message author and a task error over their display bounds are clipped", () => {
  const state = check({
    ...valid(),
    messages: [{ ...log[0], author: "x".repeat(513) }],
    tasks: [task("failed", { error: "e".repeat(8001) })],
  }) as State
  expect((state.messages[0] as { author: string }).author).toContain("[truncated")
  expect((state.tasks[0] as unknown as { error: string }).error).toContain("[truncated")
})

test("a posted message may create more than 256 tasks", () => {
  const tasks = Array.from({ length: 300 }, (_, index) => task("queued", { id: `job_${index}` }))
  expect(write("/message", "POST", { message: log[0], tasks })).toBeDefined()
})

test("the Team validator checks the answers of the write routes", () => {
  expect(write("/room", "POST", room)).toBeDefined()
  expect(write("/room/trm_team", "PATCH", room)).toBeDefined()
  expect(write("/room/trm_team/archive", "POST", { ...room, archived: true })).toBeDefined()
  expect(write("/room/trm_team/factory", "PUT", { ...room, factory })).toBeDefined()
  expect(() => write("/room/trm_old", "PATCH", room)).toThrow("room identity")
  expect(() => write("/room", "POST", { ...room, id: "bad id" })).toThrow("Invalid server response")
  expect(() => write("/room/trm_team/factory", "PUT", { ...room, factory: { revision: 1, config: {} } })).toThrow(
    "Invalid server response",
  )
  expect(() => write("/room/trm_team/factory", "PUT", { ...room, factory: { ...factory, revision: -1 } })).toThrow(
    "Invalid server response",
  )
  expect(write("/teammate", "POST", mates[0])).toBeDefined()
  expect(
    write("/teammate/tm_moss", "PATCH", {
      ...mates[0],
      id: "tm_moss",
      agent: "plan",
      model: { providerID: "p", id: "m" },
    }),
  ).toBeDefined()
  expect(() => write("/teammate/tm_other", "PATCH", mates[0])).toThrow("teammate identity")
  expect(() => write("/teammate", "POST", { ...mates[0], handle: "bad handle" })).toThrow("Invalid server response")
  expect(() => write("/teammate", "POST", { ...mates[0], directory: "relative" })).toThrow("Invalid server response")
  expect(() => write("/teammate", "POST", { ...mates[0], model: { providerID: "p" } })).toThrow(
    "Invalid server response",
  )
  expect(write("/teammate/tm_moss/duty", "POST", { loopID: "loop_1", teammateID: "tm_moss" })).toBeDefined()
  expect(() => write("/teammate/tm_moss/duty", "POST", { loopID: "loop_1", teammateID: "tm_rae" })).toThrow("identity")
  expect(write("/room/trm_team/factory/run", "POST", finished)).toBeDefined()
  expect(write("/factory-run/run_1", "GET", finished)).toBeDefined()
  expect(write("/factory-run/run_1/cancel", "POST", { ...finished, status: "cancelled" })).toBeDefined()
  expect(() => write("/factory-run/run_2", "GET", finished)).toThrow("Invalid server response")
  expect(() => write("/factory-run/run_1", "GET", { ...finished, status: "weird" })).toThrow("Invalid server response")
  expect(() => write("/factory-run/run_1", "GET", { ...finished, time: { created: "NaN", updated: 1 } })).toThrow(
    "Invalid server response",
  )
  expect(() => write("/factory-run/run_1", "GET", { ...finished, taskIDs: ["../x"] })).toThrow(
    "Invalid server response",
  )
})

test("a factory run's result is cut rather than rejected, and its error is bounded", () => {
  const long = write("/factory-run/run_1", "GET", { ...finished, result: "x".repeat(40_000) }) as { result: string }
  expect(long.result.length).toBeLessThan(33_000)
  expect(long.result).toContain("[truncated")
  expect(() => write("/factory-run/run_1", "GET", { ...finished, error: "x".repeat(9000) })).toThrow(
    "Invalid server response",
  )
})

test("the state answer validates the factory runs and duties it carries", () => {
  expect(() => check({ ...valid(), factoryRuns: [{ ...finished, id: "bad id" }] })).toThrow("Invalid server response")
  expect(() => check({ ...valid(), factoryRuns: [finished, finished] })).toThrow("duplicate")
  expect(() => check({ ...valid(), duties: [{ loopID: "loop_1" }] })).toThrow("Invalid server response")
  expect(() =>
    check({
      ...valid(),
      room: { ...room, factory: { revision: 1, config: { ...factory.config, outcome: "x".repeat(4001) } } },
      rooms: [old, { ...room, factory: { revision: 1, config: { ...factory.config, outcome: "x".repeat(4001) } } }],
    }),
  ).toThrow("Invalid server response")
})
