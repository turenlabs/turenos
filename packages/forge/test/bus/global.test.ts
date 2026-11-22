import { expect, test } from "bun:test"
import { BacklogLimit, GlobalBusEmitter, globalEventFrame, type GlobalEvent } from "@/bus/global"

function event(id: string, text = "") {
  return { payload: { id, type: "fixture.event", properties: { text } } }
}

test("replay evicts oldest frames by bytes and retains the recent suffix", () => {
  const first = event("one", "🌍".repeat(128))
  const second = event("two", "é".repeat(512))
  const third = event("three", "\n".repeat(256))
  const fourth = event("four")
  const budget = globalEventFrame(second).bytes + globalEventFrame(third).bytes + globalEventFrame(fourth).bytes
  const bus = new GlobalBusEmitter(budget)
  const events = [first, second, third, fourth]
  events.forEach((frame) => bus.emit("event", frame))
  expect(bus.eventsAfter("one")).toBeUndefined()
  expect(bus.eventsAfter("two")).toEqual([globalEventFrame(third), globalEventFrame(fourth)])
  expect(bus.eventsAfter("four")).toEqual([])
})

test("replay evicts by event count and preserves order after wrapping", () => {
  const bus = new GlobalBusEmitter()
  for (let index = 0; index <= BacklogLimit; index++) bus.emit("event", event(String(index)))
  expect(bus.eventsAfter("0")).toBeUndefined()
  const replay = bus.eventsAfter("1")
  expect(replay?.length).toBe(BacklogLimit - 1)
  expect(replay?.at(0)?.id).toBe("2")
  expect(replay?.at(-1)?.id).toBe(String(BacklogLimit))
})

test("oversized events reach live listeners and break replay continuity", () => {
  const oversized = event("large", "x".repeat(1024))
  const bus = new GlobalBusEmitter(512)
  const live: GlobalEvent[] = []
  bus.on("event", (frame) => live.push(frame))

  bus.emit("event", event("old"))
  bus.emit("event", oversized)
  bus.emit("event", event("recent"))
  bus.emit("event", event("tail"))

  expect(live[1]).toBe(oversized)
  expect(bus.eventsAfter("old")).toBeUndefined()
  expect(bus.eventsAfter("large")).toBeUndefined()
  expect(bus.eventsAfter("recent")?.map((frame) => frame.id)).toEqual(["tail"])
})

test("a sync copy does not anchor a cursor whose live frame was evicted", () => {
  const live = event("shared", "x".repeat(256))
  const sync = { payload: { id: "shared", type: "sync" } }
  const tail = event("tail")
  const bus = new GlobalBusEmitter(globalEventFrame(live).bytes + globalEventFrame(sync).bytes)
  bus.emit("event", live)
  bus.emit("event", sync)
  expect(bus.eventsAfter("shared")).toEqual([globalEventFrame(sync)])

  bus.emit("event", tail)
  expect(bus.eventsAfter("shared")).toBeUndefined()
  expect(bus.eventsAfter("tail")).toEqual([])
})

test("unserializable events preserve in-process delivery and break replay continuity", () => {
  const broken = { payload: { id: "broken", type: "fixture.event", value: 1n } }
  const bus = new GlobalBusEmitter()
  const received: unknown[] = []
  bus.on("event", (frame) => received.push(frame))
  bus.emit("event", event("old"))
  bus.emit("event", broken)
  bus.emit("event", event("recent"))

  expect(received[1]).toBe(broken)
  expect(bus.eventsAfter("old")).toBeUndefined()
  expect(bus.eventsAfter("broken")).toBeUndefined()
  expect(bus.eventsAfter("recent")).toEqual([])
})
