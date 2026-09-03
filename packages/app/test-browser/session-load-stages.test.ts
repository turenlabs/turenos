import { describe, expect, test } from "bun:test"
import { loadSessionV2MessageWindow } from "@/pages/session/goal/session-v2-message-window"
import { generateSessionMessages, smallProfile } from "@/pages/session/benchmark/session-load-fixture"
import { createPageServer, measureSessionLoad } from "@/pages/session/benchmark/session-load-stages"

/**
 * Keeps the stage harness executable.
 *
 * `session-load-stages.ts` reaches `timeline/projection.ts` and therefore `timeline/rows.ts`, whose
 * `session-ui` import chain needs the browser export condition — so it belongs here, under
 * `test:browser`, rather than beside the window test in `src/`. Without a committed test the
 * harness would quietly stop compiling the first time the projection signature moved, and the
 * benchmark would only be discovered to be broken the next time someone needed it.
 *
 * Assertions are on the pipeline's *output*, not its timing: the point is that all six stages ran
 * and produced a coherent projection, and that the drain and the window agree about the transcript
 * they share. Milliseconds belong to the manual benchmark.
 */
describe("session load stages", () => {
  const messages = generateSessionMessages(smallProfile)

  test("runs every stage and projects rows from a window", async () => {
    const server = createPageServer(messages, 20, "desc")
    const result = await measureSessionLoad({
      sessionID: "ses_stage",
      load: async () => (await loadSessionV2MessageWindow({ load: server.load, minimum: 20 })).messages,
      parseMs: () => server.parseMs,
      bytes: () => server.bytesServed,
      overheadMs: () => server.serializeMs,
    })

    expect(result.messagesLoaded).toBe(20)
    expect(result.partsLoaded).toBeGreaterThan(0)
    expect(result.rowCount).toBeGreaterThan(0)
    expect(result.bytesParsed).toBeGreaterThan(0)
    // Every stage is measured, so a stage silently disappearing from the pipeline is visible.
    Object.values(result.timings).forEach((value) => expect(Number.isFinite(value)).toBe(true))
  })

  test("the window moves strictly fewer bytes than the drain for the same transcript", async () => {
    const drainServer = createPageServer(messages, 20, "asc")
    const drained = await measureSessionLoad({
      sessionID: "ses_stage",
      load: async () => {
        const collected = []
        let cursor: string | undefined
        for (;;) {
          const page = await drainServer.load(cursor)
          collected.push(...page.data)
          if (!page.cursor.next) break
          cursor = page.cursor.next
        }
        return collected
      },
      bytes: () => drainServer.bytesServed,
    })

    const windowServer = createPageServer(messages, 20, "desc")
    const windowed = await measureSessionLoad({
      sessionID: "ses_stage",
      load: async () => (await loadSessionV2MessageWindow({ load: windowServer.load, minimum: 20 })).messages,
      bytes: () => windowServer.bytesServed,
    })

    expect(drained.messagesLoaded).toBe(messages.length)
    expect(windowed.messagesLoaded).toBeLessThan(drained.messagesLoaded)
    expect(windowed.bytesParsed).toBeLessThan(drained.bytesParsed)
    expect(windowServer.requests).toBeLessThan(drainServer.requests)
  })
})
