/**
 * Simulator suite: payload/size stress on the live-clock harness.
 *
 * Every scenario stays well under ~3s of wall time: sizes are chosen to stress pipeline limits
 * (delta counts, single-frame megabytes, the ToolOutputStore preview cap, history length), not the
 * test machine. No artificial stream delays are configured anywhere in this file, so each turn
 * drains as fast as the stack can move it.
 *
 * The harness model declares a realistic context window, while prune remains disabled by default
 * (`config.prune` folds to false). Long-history scenarios arm a matched summarizer behavior and
 * assert the shipped checkpoint plus continuation-directive semantics if the configured context
 * threshold is reached.
 *
 * Tool output bounding facts asserted below (tool-output-store.ts): the model-facing text of a
 * tool result is capped at `MAX_BYTES` (50KB) / `MAX_LINES` (2000); over-limit output is replaced
 * by a head/tail preview around the literal marker
 * `... output truncated; full content saved to <path> ...`, the full text is written to a managed
 * file, and the file path lands durably on the completed tool state as `outputPaths`.
 */
import { describe } from "bun:test"
import { existsSync, rmSync, statSync } from "node:fs"
import { LLMEvent, type LLMRequest } from "@turenlabs/llm"
import type { SessionMessage } from "@turenlabs/core/session/message"
import { SessionInputTable } from "@turenlabs/core/session/sql"
import { MAX_BYTES } from "@turenlabs/core/tool-output-store"
import { eq } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { reply, replyWithTool, requestUserTexts, simulate, type ScenarioContext } from "./harness"

const TRUNCATION_MARKER = "output truncated; full content saved to"

/** All assistant messages of a durable context, in order. */
const assistantsOf = (messages: ReadonlyArray<SessionMessage.Message>): SessionMessage.Assistant[] =>
  messages.filter((message): message is SessionMessage.Assistant => message.type === "assistant")

/** Concatenated text-part content of one assistant message. */
const assistantText = (message: SessionMessage.Assistant) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

const expectEqual = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected)
    throw new Error(`[payload] ${label}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`)
}

/**
 * Waits for the first `turns` provider requests to have been served AND the session to be off the
 * run coordinator, so the next prompt starts a fresh turn instead of merging into the live one as
 * a mid-stream steer. Tighter than `invariants.settled` (10ms poll, no transcript sweep) because
 * the long-history loop calls it dozens of times.
 */
const quiesced = (ctx: ScenarioContext, turns: number) =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    while (true) {
      const active = yield* ctx.services.session.active
      if (ctx.provider.requests().length >= turns && !active.has(ctx.sessionID)) return
      if (Date.now() - startedAt > 10_000)
        throw new Error(
          `[payload] turn ${turns} did not quiesce within 10s (requests=${ctx.provider.requests().length})`,
        )
      yield* Effect.sleep(Duration.millis(10))
    }
  })

describe("payload: streaming volume", () => {
  // 2600 chars split into 650 four-char deltas (replyEvents: size = ceil(len/chunks)). Justified
  // expectation: a pure text turn always settles idle, and the projector must reassemble every
  // delta into one durable text part with nothing dropped, duplicated, or reordered.
  simulate("650 small text deltas concatenate durably and settle idle", (ctx) =>
    Effect.gen(function* () {
      const full = "0123456789".repeat(260)
      ctx.provider.enqueue(reply(full, { chunks: 650, label: "many-deltas" }))
      yield* ctx.user.prompt("Stream the long answer.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      expectEqual("request count", ctx.provider.requests().length, 1)
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const assistants = assistantsOf(messages)
      expectEqual("assistant message count", assistants.length, 1)
      const text = assistantText(assistants[0]!)
      expectEqual("assistant text length", text.length, full.length)
      expectEqual("assistant text content", text, full)
    }),
  )

  // One ~3MB text frame (reply with chunks: 1 emits a single delta). Justified expectation: a
  // single oversized frame is ordinary content — the turn settles idle and the durable context
  // returned by SessionStore round-trips the payload byte-for-byte (assistant text is not subject
  // to the tool-output preview cap).
  simulate("a single ~3MB text delta settles and round-trips through the store", (ctx) =>
    Effect.gen(function* () {
      const full = "All work and no play makes Forge a dull agent. ".repeat(65_000) // ~3.05MB ASCII
      ctx.provider.enqueue(reply(full, { chunks: 1, label: "megadelta" }))
      yield* ctx.user.prompt("Answer in one enormous frame.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const assistants = assistantsOf(messages)
      expectEqual("assistant message count", assistants.length, 1)
      const text = assistantText(assistants[0]!)
      expectEqual("round-tripped length", text.length, full.length)
      if (text !== full) throw new Error("[payload] 3MB assistant text did not round-trip byte-for-byte")
    }),
  )

  // 128 reasoning deltas then a short text answer. Justified expectation: reasoning is durable
  // first-class content — the turn settles idle with one reasoning part carrying the full
  // concatenation, ordered before the text part it preceded on the wire.
  simulate("reasoning-heavy stream (128 reasoning deltas then text) settles with reasoning durable", (ctx) =>
    Effect.gen(function* () {
      const deltas = Array.from({ length: 128 }, (_, index) => `consider(${index}); `)
      const answer = "Considered everything; here is the answer."
      ctx.provider.enqueue({
        label: "reasoning-heavy",
        events: [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reason-1" }),
          ...deltas.map((text) => LLMEvent.reasoningDelta({ id: "reason-1", text })),
          LLMEvent.reasoningEnd({ id: "reason-1" }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: answer }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      })
      yield* ctx.user.prompt("Think hard, then answer.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 1 })
      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const assistants = assistantsOf(messages)
      expectEqual("assistant message count", assistants.length, 1)
      const content = assistants[0]!.content
      const reasoningIndex = content.findIndex((part) => part.type === "reasoning")
      const textIndex = content.findIndex((part) => part.type === "text")
      if (reasoningIndex < 0) throw new Error("[payload] no durable reasoning part on the assistant message")
      if (textIndex < 0) throw new Error("[payload] no durable text part on the assistant message")
      if (reasoningIndex > textIndex)
        throw new Error(`[payload] reasoning part (index ${reasoningIndex}) ordered after text (index ${textIndex})`)
      const reasoningPart = content[reasoningIndex]!
      const textPart = content[textIndex]!
      if (reasoningPart.type !== "reasoning" || textPart.type !== "text")
        throw new Error("[payload] part indices resolved to unexpected part types")
      expectEqual("reasoning text", reasoningPart.text, deltas.join(""))
      expectEqual("answer text", textPart.text, answer)
    }),
  )
})

describe("payload: tool output bounding", () => {
  // sim_huge returns 1.2MB of text through `toModelOutput`. Justified expectation: the turn
  // settles idle across the tool round-trip (minRequests 2: tool-call turn + result turn), while
  // ToolOutputStore bounds the model-facing result to the 50KB preview containing the truncation
  // marker, records the spill file in `state.outputPaths`, and the raw 1.2MB never re-enters the
  // provider wire.
  simulate("sim_huge 1.2MB output is bounded to the 50KB preview with marker + outputPaths", (ctx) =>
    Effect.gen(function* () {
      const bytes = 1_200_000
      ctx.provider.enqueue(replyWithTool("sim_huge", { bytes }), reply("Digested the bounded output."))
      yield* ctx.user.prompt("Run the huge tool.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      expectEqual("request count", ctx.provider.requests().length, 2)

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const toolParts = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "sim_huge")
      expectEqual("sim_huge tool part count", toolParts.length, 1)
      const state = toolParts[0]!.state
      if (state.status !== "completed")
        throw new Error(`[payload] sim_huge tool part is "${state.status}", expected "completed"`)

      const preview = state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
      const previewBytes = Buffer.byteLength(preview, "utf-8")
      if (previewBytes > MAX_BYTES)
        throw new Error(`[payload] stored model-facing text is ${previewBytes} bytes, above the ${MAX_BYTES} cap`)
      if (!preview.includes(TRUNCATION_MARKER))
        throw new Error(`[payload] bounded preview lacks the truncation marker "${TRUNCATION_MARKER}"`)

      const outputPaths = state.outputPaths ?? []
      expectEqual("outputPaths count", outputPaths.length, 1)
      const spill = outputPaths[0]!
      if (!existsSync(spill)) throw new Error(`[payload] outputPaths file does not exist: ${spill}`)
      const size = statSync(spill).size
      if (size < bytes) throw new Error(`[payload] spill file holds ${size} bytes, expected >= ${bytes}`)

      // The wire never sees the raw payload again: the follow-up request carries the preview.
      const followUp = JSON.stringify(ctx.provider.requests()[1]!.request)
      if (followUp.includes("x".repeat(100_000)))
        throw new Error("[payload] raw 1.2MB tool output leaked into the follow-up provider request")
      if (!followUp.includes(TRUNCATION_MARKER))
        throw new Error("[payload] follow-up provider request lacks the bounded preview marker")
      if (followUp.length > 300_000)
        throw new Error(`[payload] follow-up request serializes to ${followUp.length} chars; preview cap not applied`)

      // Tidy the managed spill file this scenario created (retention would sweep it in 7 days).
      yield* Effect.sync(() => rmSync(spill, { force: true }))
    }),
  )
})

describe("payload: long history", () => {
  // 32 distinct prompted turns, each drained to quiescence before the next prompt (a prompt
  // against a live turn would merge as a mid-stream steer and collapse two turns into one).
  // Justified expectation: every turn settles idle, the durable context holds all 32 user/assistant
  // pairs in order, every admitted input is promoted (settled's orphan sweep plus an explicit row
  // check), and the final request reflects the whole history.
  simulate("32 prompted turns stay consistent and settle", (ctx) =>
    Effect.gen(function* () {
      const TURNS = 32
      for (let turn = 1; turn <= TURNS; turn++) {
        ctx.provider.enqueue(reply(`Reply ${turn} acknowledged.`, { label: `turn-${turn}` }))
        yield* ctx.user.prompt(`Task ${turn}`)
        yield* quiesced(ctx, turn)
      }
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: TURNS })
      expectEqual("request count", ctx.provider.requests().length, TURNS)

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const users = messages.filter((message): message is SessionMessage.User => message.type === "user")
      expectEqual("user message count", users.length, TURNS)
      users.forEach((message, index) => expectEqual(`user text #${index}`, message.text, `Task ${index + 1}`))
      const assistants = assistantsOf(messages)
      expectEqual("assistant message count", assistants.length, TURNS)
      assistants.forEach((message, index) =>
        expectEqual(`assistant text #${index}`, assistantText(message), `Reply ${index + 1} acknowledged.`),
      )

      const rows = yield* ctx.services.db
        .select({ promoted: SessionInputTable.promoted_seq })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, ctx.sessionID))
        .all()
        .pipe(Effect.orDie)
      expectEqual("admitted input rows", rows.length, TURNS)
      expectEqual("promoted input rows", rows.filter((row) => row.promoted !== null).length, TURNS)

      const finalTexts = requestUserTexts(ctx.provider.requests().at(-1)!.request)
      expectEqual(
        "final request user texts",
        JSON.stringify(finalTexts),
        JSON.stringify(Array.from({ length: TURNS }, (_, index) => `Task ${index + 1}`)),
      )
    }),
  )

  // 18 queued prompts drained in one wake chain, each turn appending a ~12KB reply, so the final
  // requests are built from a few hundred KB of history. Justified expectation: the chain settles
  // idle after exactly one request per queued prompt, and every request carries the full prompt
  // history in admission order. This fixture stays below the simulator model's context threshold;
  // the branch below also asserts the shipped semantics if future accounting naturally triggers
  // compaction: the summarizer runs as its own matched request and the post-compaction request ends
  // with the checkpoint's continuation directive.
  simulate("requests built from a long queued-chain history pass invariants", (ctx) =>
    Effect.gen(function* () {
      const TURNS = 18
      const ballast = "history ballast segment. ".repeat(480) // ~12KB per assistant reply
      const prompts = Array.from({ length: TURNS }, (_, index) => `Write chapter ${index + 1}.`)
      const summarizerRequest = (request: LLMRequest) =>
        requestUserTexts(request).some((text) => text.includes("anchored summary"))
      for (let turn = 1; turn <= TURNS; turn++)
        ctx.provider.enqueue(
          reply(`Chapter ${turn} recorded. ${ballast}`, {
            chunks: 4,
            label: `chain-${turn}`,
            match: (request) => !summarizerRequest(request),
          }),
        )
      // Armed only for a naturally-triggered compaction; stays queued (unconsumed) otherwise.
      ctx.provider.enqueue(
        reply("Anchored recap: chapters recorded in order.", { label: "summarizer", match: summarizerRequest }),
      )

      for (const prompt of prompts) yield* ctx.user.prompt(prompt, { delivery: "queue", resume: false })
      yield* ctx.user.resume()
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: TURNS })

      const messages = yield* ctx.services.store.context(ctx.sessionID).pipe(Effect.orDie)
      const compactions = messages.filter((message) => message.type === "compaction")
      const records = ctx.provider.requests()

      if (compactions.length > 0) {
        // Shipped post-compaction semantics: the request after the checkpoint ends with the
        // continuation directive (CONTINUE_AFTER_CHECKPOINT, "Resume immediately...") appended
        // after the <conversation-checkpoint> user message.
        const texts = requestUserTexts(records.at(-1)!.request)
        if (!texts.some((text) => text.includes("<conversation-checkpoint>")))
          throw new Error("[payload] compaction fired but no checkpoint message reached the provider request")
        if (!(texts.at(-1) ?? "").includes("Resume immediately"))
          throw new Error(
            `[payload] post-compaction request does not end with the resume directive; final user text: ${JSON.stringify(texts.at(-1))}`,
          )
      } else {
        // This fixture remains below the declared context window, so every request sees full history.
        expectEqual("request count", records.length, TURNS)
        for (let turn = 1; turn <= TURNS; turn++) {
          const texts = requestUserTexts(records[turn - 1]!.request)
          expectEqual(`request #${turn - 1} user texts`, JSON.stringify(texts), JSON.stringify(prompts.slice(0, turn)))
        }
        expectEqual("unconsumed behaviors (armed summarizer only)", ctx.provider.queued(), 1)
      }
    }),
  )
})
