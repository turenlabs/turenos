import {
  collectSessionV2Messages,
  loadSessionV2MessageWindow,
  SESSION_V2_MESSAGE_PAGE_LIMIT,
} from "../goal/session-v2-message-window"
import { generateSessionMessages, revampV2Profile, type SessionLoadProfile } from "./session-load-fixture"
import { createPageServer, formatStages, measureSessionLoad } from "./session-load-stages"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

/**
 * Stage-by-stage timing of the session tab-switch pipeline, drain versus window.
 *
 *   bun --conditions=browser --preload ./bun-vite-imports.ts --preload ./happydom.ts \
 *     src/pages/session/benchmark/session-load-benchmark.ts
 *
 * Three loading strategies over one identical fixture:
 *
 *   drain        every page of history, ascending — full-history reference
 *   window       the newest page, descending, extended back to a turn boundary — full bodies
 *   window+lean  the same window with `session.messages?lean=true` — oversized tool bodies
 *                arrive as `truncated` stubs and are back-filled per message on expand
 *
 * Everything after the load is the same code in both runs, so a difference in `present`, `store`
 * or `rows` is attributable to how much history was materialised and to nothing else.
 *
 * Two honesty notes about the numbers this prints:
 *
 * 1. It runs on Bun/JSC; the app runs on Chromium/V8. JSC can back `JSON.parse` results with rope
 *    substrings of the source, so the parse stage here is a *lower bound* on what the renderer
 *    pays. Ratios and byte counts transfer between engines; absolute milliseconds do not.
 * 2. Network time is excluded deliberately. It was measured separately against the live server
 *    (11 pages, 228.9 MB, 1.27 s wall) and is not the bottleneck being hunted.
 *
 * The committed regression test (`session-load-window.test.ts`) asserts invariants, never
 * milliseconds, because machine-dependent thresholds do not belong in CI.
 */
async function run(label: string, profile: SessionLoadProfile) {
  process.stdout.write(`generating fixture (${profile.messages} messages)…\n`)
  const generateStart = performance.now()
  const messages = generateSessionMessages(profile)
  const sizes = messages.map((message) => JSON.stringify(message).length)
  const bytes = sizes.reduce((total, size) => total + size, 0)
  process.stdout.write(
    `${label}: ${messages.length} messages, ${(bytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `largest ${(Math.max(...sizes) / 1024 / 1024).toFixed(1)} MiB, ` +
      `>1MiB: ${sizes.filter((size) => size > 1024 * 1024).length} ` +
      `(${(performance.now() - generateStart).toFixed(0)} ms to generate)\n\n`,
  )

  const limit = SESSION_V2_MESSAGE_PAGE_LIMIT

  const drainServer = createPageServer(messages, limit, "asc")
  const drain = await measureSessionLoad({
    sessionID: "ses_bench",
    load: () => collectSessionV2Messages(drainServer.load),
    parseMs: () => drainServer.parseMs,
    bytes: () => drainServer.bytesServed,
    overheadMs: () => drainServer.serializeMs,
  })
  process.stdout.write(
    formatStages("DRAIN  (every page, ascending — reference)", drain, {
      requests: drainServer.requests,
      MiB: (drainServer.bytesServed / 1024 / 1024).toFixed(1),
    }) + "\n\n",
  )

  const windowServer = createPageServer(messages, limit, "desc")
  const windowed = await measureSessionLoad({
    sessionID: "ses_bench",
    load: async () => (await loadSessionV2MessageWindow({ load: windowServer.load })).messages,
    parseMs: () => windowServer.parseMs,
    bytes: () => windowServer.bytesServed,
    overheadMs: () => windowServer.serializeMs,
  })
  process.stdout.write(
    formatStages("WINDOW (newest page, descending — current)", windowed, {
      requests: windowServer.requests,
      MiB: (windowServer.bytesServed / 1024 / 1024).toFixed(1),
    }) + "\n\n",
  )

  // Same windowed walk over the lean payload: oversized tool bodies arrive as stubs and the real
  // body is back-filled per message only when a card is expanded.
  const leanServer = createPageServer(messages, limit, "desc", { lean: true })
  const lean = await measureSessionLoad({
    sessionID: "ses_bench",
    load: async () => (await loadSessionV2MessageWindow({ load: leanServer.load })).messages,
    parseMs: () => leanServer.parseMs,
    bytes: () => leanServer.bytesServed,
    overheadMs: () => leanServer.serializeMs,
  })
  process.stdout.write(
    formatStages("WINDOW+LEAN (newest page, tool bodies stubbed)", lean, {
      requests: leanServer.requests,
      MiB: (leanServer.bytesServed / 1024 / 1024).toFixed(1),
    }) + "\n\n",
  )

  process.stdout.write(
    `total ${drain.timings.total.toFixed(0)} ms -> ${windowed.timings.total.toFixed(0)} ms -> ${lean.timings.total.toFixed(0)} ms ` +
      `(${(drain.timings.total / Math.max(lean.timings.total, 0.001)).toFixed(1)}x), ` +
      `bytes ${(drainServer.bytesServed / 1024 / 1024).toFixed(1)} MiB -> ` +
      `${(windowServer.bytesServed / 1024 / 1024).toFixed(1)} MiB -> ` +
      `${(leanServer.bytesServed / 1024 / 1024).toFixed(1)} MiB, ` +
      `requests ${drainServer.requests} -> ${windowServer.requests} -> ${leanServer.requests}\n`,
  )
}

await run("revamp-v2", revampV2Profile)
await GlobalRegistrator.unregister()
