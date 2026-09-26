import { describe, expect, test } from "bun:test"
import type { Event } from "@turenlabs/sdk"
import { traceFromEvent } from "../src/zero-mem-plugin"
import { ZeroMem, create, extractEntities } from "../src/zero-mem"

const trace = (id: string, text: string, timestamp: number, sessionID = "session-a", boundaryID = "turns-a") => ({
  id,
  text,
  timestamp,
  sessionID,
  boundaryID,
})

describe("Zero-Mem", () => {
  test("extracts code and security entities without a model", () => {
    const entities = extractEntities('Rotate CVE-2026-12345 at packages/core/src/memory.ts for "Nightjar API"')
    expect(entities.map((entity) => entity.normalized)).toEqual(
      expect.arrayContaining(["cve-2026-12345", "packages/core/src/memory.ts", "nightjar api"]),
    )
  })

  test("retrieves graph-connected evidence and local context", () => {
    const memory = ZeroMem.create({ topK: 5, windowSize: 4, localRadius: 2, graphHops: 2 })
    memory.upsert([
      trace("turn-1", "Nightjar edge service uses the Sable API.", 1),
      trace("turn-2", "Sable API credentials are stored in the HSM and rotate daily.", 2, "session-a", "turns-b"),
      trace("turn-3", "Incident 418 was opened for a suspicious webhook.", 3),
      trace("turn-4", "The webhook source was verified as GitHub Actions.", 4),
      trace("turn-5", "Resolution: rotate the runner token and require signature validation.", 5),
    ])

    const graphResults = memory.search("Nightjar edge", { topK: 5 })
    expect(graphResults.map((result) => result.trace.id)).toContain("turn-2")
    expect(graphResults.find((result) => result.trace.id === "turn-2")?.relation?.kind).toBe("entity-context")

    const localResults = memory.search("incident 418 resolution", { topK: 5 })
    expect(localResults.map((result) => result.trace.id)).toContain("turn-5")
    expect(localResults.find((result) => result.trace.id === "turn-5")?.closure.kind).not.toBe("none")
  })

  test("keeps ranking order when limiting tied and reverse-ordered results", () => {
    const memory = create({ topK: 5, graphWeight: 0, localWeight: 0, graphHops: 0, localRadius: 0 })
    memory.upsert(
      Array.from({ length: 24 }, (_, i) =>
        trace(`trace-${String(i).padStart(2, "0")}`, "stable quartz evidence", Math.floor(i / 2), `session-${i}`),
      ),
    )

    expect(memory.search("stable quartz").map((result) => result.trace.id)).toEqual([
      "trace-22",
      "trace-23",
      "trace-20",
      "trace-21",
      "trace-18",
    ])

    memory.clear()
    memory.upsert(
      Array.from({ length: 24 }, (_, i) =>
        trace(`trace-${String(i).padStart(2, "0")}`, "stable quartz evidence", i, `session-${i}`),
      ),
    )
    expect(memory.search("stable quartz").map((result) => result.trace.id)).toEqual([
      "trace-23",
      "trace-22",
      "trace-21",
      "trace-20",
      "trace-19",
    ])
  })

  test("keeps scope filters fail-closed and upserts by source id", () => {
    const memory = create({ topK: 10 })
    memory.ingest([
      trace("same-id", "Sable API is in the first boundary.", 1, "session-a", "boundary-a"),
      trace("other", "Sable API is in the second boundary.", 2, "session-a", "boundary-b"),
    ])
    expect(memory.size()).toBe(2)
    memory.upsert(trace("same-id", "Nightjar API moved to the first boundary.", 3, "session-a", "boundary-a"))
    expect(memory.size()).toBe(2)
    expect(memory.search("Nightjar", { boundaryID: "boundary-a" }).map((result) => result.trace.id)).toEqual([
      "same-id",
    ])
    expect(memory.search("Nightjar", { boundaryID: "boundary-b" })).toEqual([])
  })

  test("filters imported records by scope and validity", () => {
    const memory = create({ topK: 10 })
    memory.upsert([
      {
        ...trace("current", "Current rotation policy.", 1),
        scopeID: "room-a",
        validFrom: 100,
        validUntil: 200,
      },
      {
        ...trace("other-room", "Current rotation policy.", 1),
        scopeID: "room-b",
      },
    ])
    expect(memory.search("rotation policy", { scopeID: "room-a", asOf: 150 }).map((result) => result.trace.id)).toEqual(
      ["current"],
    )
    expect(memory.search("rotation policy", { scopeID: "room-a", asOf: 250 })).toEqual([])
  })

  test("keeps the index coherent after rejected batches and protects returned traces", () => {
    const memory = create()
    memory.upsert(trace("stable", "Stable searchable evidence.", 1))
    const result = memory.search("stable evidence")[0]!
    Object.assign(result.trace, { text: "mutated outside the store" })
    expect(memory.search("stable evidence").map((item) => item.trace.id)).toEqual(["stable"])

    memory.upsert({
      ...trace("metadata", "Metadata evidence.", 2),
      metadata: { provenance: { source: "original" } },
    })
    const metadata = memory.get("metadata")?.metadata?.provenance as { source: string }
    metadata.source = "mutated outside the store"
    expect((memory.get("metadata")?.metadata?.provenance as { source: string }).source).toBe("original")

    expect(() =>
      memory.upsert([
        trace("accepted", "This batch must not partially apply.", 2),
        { id: "invalid", text: "missing timestamp" } as unknown as ZeroMem.TraceUnit,
      ]),
    ).toThrow("timestamp")
    expect(memory.size()).toBe(2)
    expect(memory.search("accepted")).toEqual([])
  })

  test("namespaces repeated provider part ids by session and message", () => {
    const event = (sessionID: string, assistantMessageID: string) =>
      ({
        type: "session.next.text.ended",
        properties: {
          timestamp: 1,
          sessionID,
          assistantMessageID,
          textID: "text-0",
          text: "same provider part id",
        },
      }) as unknown as Event
    expect(traceFromEvent(event("session-a", "message-a"))?.id).not.toBe(
      traceFromEvent(event("session-b", "message-b"))?.id,
    )
  })
})
