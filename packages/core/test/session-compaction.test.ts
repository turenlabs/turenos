import { describe, expect, test } from "bun:test"
import {
  InvalidRequestReason,
  isContextOverflow,
  LLM,
  LLMError,
  LLMEvent,
  Message,
  Model,
  type LLMRequest,
} from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import type { Config } from "@turenlabs/core/config"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionCompaction } from "@turenlabs/core/session/compaction"
import { SessionMessage } from "@turenlabs/core/session/message"
import { TextPart } from "@turenlabs/core/session/prompt"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { DateTime, Deferred, Effect, Fiber, Schema, Stream } from "effect"

const created = DateTime.makeUnsafe(0)
const sessionID = SessionSchema.ID.make("ses_compaction")
const messageID = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const modelRef = ModelV2.Ref.make({ id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") })

const model = (limits?: { context?: number; input?: number; output?: number }, id = "model") =>
  Model.make({ id, provider: "provider", route: OpenAIChat.route.with({ limits: limits ?? {} }) })

type Entry = { readonly seq: number; readonly message: SessionMessage.Message }

let sequence = 0
const entry = (message: SessionMessage.Message): Entry => ({ seq: ++sequence, message })

const user = (id: string, text: string) =>
  SessionMessage.User.make({
    id: messageID(id),
    type: "user",
    text,
    parts: [TextPart.make({ id: `prt_${id}`, text })],
    time: { created },
  })

/**
 * Tool names whose textual payload never reaches `state.content` at runtime.
 *
 * `Tool.settle` (`src/tool/tool.ts:113-126`) fills `content` only for a tool that declares
 * `toModelOutput` or returns a bare string. `src/tool/subagent.ts` and `src/tool/goal.ts` declare
 * neither and return objects, and `src/tool/read.ts` declares one that returns `[]` for anything
 * that is not a supported image -- so for all of these the whole payload lands in `structured` and
 * `content` stays `[]`. Confirmed against the owner's dev database: 186 of 186 `read`, 11 of 11
 * `wait_agents`, 6 of 6 `spawn_agent` and 1 of 1 `send_agent` completed states have `content: []`.
 *
 * A fixture that puts text in `content` for one of these is unreachable in production. That is not
 * a harmless simplification: it is precisely why the previous per-tool budget test passed while
 * production dropped every subagent report, so building one is an error rather than a shortcut.
 */
const STRUCTURED_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // `read` left this set when it gained a text `toModelOutput`; rows written before
  // that change are still structured-only, which the legacy fixtures below cover.
  "wait_agents",
  "spawn_agent",
  "send_agent",
  "list_agents",
  "interrupt_agent",
  "get_goal",
  "create_goal",
  "update_goal",
])

const tool = (input: {
  readonly id: string
  readonly name: string
  /** Text the tool wrote into `state.content`. Only for tools that really do. */
  readonly output?: string
  readonly callInput?: Record<string, unknown>
  readonly pruned?: boolean
  readonly providerExecuted?: boolean
  readonly result?: unknown
  readonly structured?: Record<string, unknown>
}): SessionMessage.AssistantTool => {
  if (input.output !== undefined && input.output.length > 0 && STRUCTURED_ONLY_TOOLS.has(input.name))
    throw new Error(
      `${input.name} never writes state.content at runtime -- put the payload in \`structured\`, or this fixture tests a shape production cannot produce`,
    )
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    ...(input.providerExecuted ? { provider: { executed: true } } : {}),
    state: {
      status: "completed",
      input: input.callInput ?? {},
      content: input.output === undefined || input.output.length === 0 ? [] : [{ type: "text", text: input.output }],
      structured: input.structured ?? {},
      ...(input.result === undefined ? {} : { result: input.result }),
    },
    time: { created, ...(input.pruned ? { pruned: created } : {}) },
  }
}

/**
 * A completed `wait_agents` state exactly as production writes it.
 *
 * `session.next.tool.success` (`src/session/message-updater.ts:306-326`) stores the tool's
 * `structured` output and its `content` verbatim; `src/tool/subagent.ts` supplies
 * `WaitOutput = { tasks, timed_out }` with no `toModelOutput`, so `content` is `[]`. The per-task
 * fields below are `subagent.ts`'s `render()` output field for field.
 */
const waitAgents = (input: { readonly id: string; readonly report: string; readonly taskID?: string }) => {
  const taskID = input.taskID ?? "tsk_1"
  return tool({
    id: input.id,
    name: "wait_agents",
    callInput: { task_ids: [taskID] },
    structured: {
      tasks: [
        {
          task_id: taskID,
          session_id: "ses_child",
          agent: "review",
          description: "verify the port",
          status: "completed",
          result: input.report,
          result_truncated: false,
        },
      ],
      timed_out: false,
    },
  })
}

const assistant = (id: string, content: readonly SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({
    id: messageID(id),
    type: "assistant",
    agent: "build",
    model: modelRef,
    content: [...content],
    time: { created },
  })

const compactionMessage = (id: string, summary: string, recent: string, ledger?: readonly string[]) =>
  SessionMessage.Compaction.make({
    id: messageID(id),
    type: "compaction",
    reason: "auto",
    summary,
    recent,
    // Omitted, not empty, when absent: that is the shape of every checkpoint written before the
    // ledger landed, and the one this suite has to keep decoding.
    ...(ledger === undefined ? {} : { ledger }),
    time: { created },
  })

/**
 * The output a completed tool call still carries, as the provider would receive it.
 *
 * Mirrors `ToolOutput.toResultValue`: `content` when non-empty, `structured` otherwise. Reading
 * `content` alone would report an empty string for every structured-only tool and make a prune
 * assertion about one vacuously true.
 */
const toolOutputOf = (entries: readonly Entry[], message: string, call: string) => {
  const found = entries.find((item) => item.message.id === messageID(message))?.message
  if (found?.type !== "assistant") throw new Error(`no assistant message ${message}`)
  const part = found.content.find((item) => item.type === "tool" && item.id === call)
  if (part?.type !== "tool" || part.state.status !== "completed") throw new Error(`no completed tool ${call}`)
  if (part.state.content.length > 0)
    return part.state.content.map((item) => (item.type === "text" ? item.text : "")).join("")
  return Object.keys(part.state.structured ?? {}).length === 0 ? "" : JSON.stringify(part.state.structured)
}

const configWith = (compaction: Record<string, unknown>) =>
  [{ type: "document", info: { compaction } }] as unknown as readonly Config.Entry[]

const VALID_SUMMARY = `## Objective
- Continue the task

## Important Details
- (none)

## Work State
### Completed
- (none)

### Active
- Continue

### Blocked
- (none)

## Next Move
1. Continue
2. (none)

## Relevant Files
- (none)

## Durable Memories
- (none)`

//
// -- Serialization ---------------------------------------------------------------------------
//

describe("serialization", () => {
  test("compaction prompt preserves detailed work state and relevant files", () => {
    const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

    expect(prompt).toContain("## Work State\n### Completed")
    expect(prompt).toContain("### Active")
    expect(prompt).toContain("### Blocked")
    expect(prompt).toContain("## Relevant Files")
  })

  test("compaction describes tool media without embedding base64", () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    const serialized = SessionCompaction.serializeToolContent([
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ])

    expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
    expect(serialized).not.toContain(base64)
  })

  test("compaction keeps structured synthetic context and omits ignored user text", () => {
    const serialized = SessionCompaction.serializeMessage(
      SessionMessage.User.make({
        id: messageID("compaction_parts"),
        type: "user",
        text: "Visible\n\nSynthetic\n\nIgnored",
        parts: [
          TextPart.make({ id: "prt_visible", text: "Visible" }),
          TextPart.make({ id: "prt_synthetic", text: "Synthetic", synthetic: true }),
          TextPart.make({ id: "prt_ignored", text: "Ignored", ignored: true }),
        ],
        time: { created },
      }),
    )

    expect(serialized).toBe("[User]: Visible\nSynthetic")
    expect(serialized).not.toContain("Ignored")
  })

  test("compaction omits ignored-only user records while retaining attachments and agents", () => {
    const ignored = SessionMessage.User.make({
      id: messageID("compaction_ignored"),
      type: "user",
      text: "Aggregate text must not leak",
      parts: [TextPart.make({ id: "prt_compaction_ignored", text: "Ignored", ignored: true })],
      time: { created },
    })
    const contextual = SessionMessage.User.make({
      ...ignored,
      id: messageID("compaction_context"),
      files: [{ uri: "data:text/plain;base64,Zm9yZ2U=", mime: "text/plain", name: "forge.txt" }],
      agents: [{ name: "review" }],
    })

    expect(SessionCompaction.serializeMessage(ignored)).toBe("")
    expect(SessionCompaction.serializeMessage(contextual)).toBe("[Attached text/plain: forge.txt]\n[Agent: review]")
  })

  test("compaction preserves provider-native results and failed-tool evidence", () => {
    const provider = SessionCompaction.serializeMessage(
      assistant("provider_result", [
        tool({
          id: "call_provider_result",
          name: "web_search",
          providerExecuted: true,
          result: { finding: "PROVIDER-NATIVE-EVIDENCE" },
          structured: { ignored: "wrong carrier" },
        }),
      ]),
    )
    const failed = SessionCompaction.serializeMessage(
      assistant("failed_result", [
        {
          type: "tool",
          id: "call_failed_result",
          name: "bash",
          state: {
            status: "error",
            input: { command: "test" },
            content: [{ type: "text", text: "PARTIAL-FAILURE-EVIDENCE" }],
            structured: {},
            error: { type: "unknown", message: "command failed" },
          },
          time: { created },
        },
      ]),
    )

    expect(provider).toContain("PROVIDER-NATIVE-EVIDENCE")
    expect(provider).not.toContain("wrong carrier")
    expect(failed).toContain("command failed")
    expect(failed).toContain("PARTIAL-FAILURE-EVIDENCE")
  })
})

//
// -- Per-tool output budgets -----------------------------------------------------------------
//

describe("per-tool output budgets", () => {
  test("a structured-only tool result reaches the summarizer at all", () => {
    // The regression this whole section exists for. `serializeMessage` used to read only
    // `state.content`, which every subagent tool, every goal tool and every text `read` leaves
    // empty -- so the summarizer was handed a bare `[Tool result]: ` and the child's report was
    // not truncated to its budget, it was dropped to zero. Every budget keyed on such a tool was
    // therefore dead code, and the test that claimed otherwise built the payload in `content`.
    const report = `SUBAGENT-REPORT-HEAD${"r".repeat(9_000)}SUBAGENT-REPORT-TAIL`
    const serialized = SessionCompaction.serializeMessage(
      assistant("budgets", [waitAgents({ id: "call_wait", report })]),
    )

    expect(serialized).toContain("SUBAGENT-REPORT-HEAD")
    expect(serialized).toContain("SUBAGENT-REPORT-TAIL")
    expect(serialized).toContain("[Assistant tool call]: wait_agents")

    // The same hole swallowed every file the agent read: `read`'s `toModelOutput` returns `[]`
    // for anything that is not an image, so a text read is structured-only too.
    const body = `FILE-BODY-HEAD${"x".repeat(400)}FILE-BODY-TAIL`
    const read = SessionCompaction.serializeMessage(
      assistant("budgets_read", [
        tool({
          id: "call_read",
          name: "read",
          callInput: { path: "src/main.ts" },
          structured: { type: "file", path: "src/main.ts", content: body, encoding: "utf-8" },
        }),
      ]),
    )

    expect(read).toContain("FILE-BODY-HEAD")
    expect(read).toContain("FILE-BODY-TAIL")
  })

  test("an ordinary tool result is still capped at the default budget", () => {
    const listing = `LISTING-HEAD${"l".repeat(9_000)}LISTING-TAIL`
    const serialized = SessionCompaction.serializeMessage(
      assistant("default_budget", [tool({ id: "call_bash", name: "bash", output: listing })]),
    )

    expect(serialized.length).toBeLessThan(listing.length)
    expect(serialized.length).toBeLessThanOrEqual(SessionCompaction.toolOutputBudget("bash") + 200)
  })

  test("a result over its budget loses its middle, not its conclusion", () => {
    // Head-only truncation kept the least decision-relevant half: a maximal 100 000-char subagent
    // report kept its preamble and lost its findings, and a long build log kept its opening and
    // lost the error it died on.
    const report = `REPORT-START${"m".repeat(SessionCompaction.toolOutputBudget("wait_agents") + 20_000)}REPORT-END`
    const serialized = SessionCompaction.serializeMessage(
      assistant("budget_ceiling", [waitAgents({ id: "call_wait", report })]),
    )

    expect(serialized).toContain("REPORT-START")
    expect(serialized).toContain("REPORT-END")
    expect(serialized.length).toBeLessThan(report.length)

    const listing = `LISTING-HEAD${"l".repeat(9_000)}LISTING-TAIL`
    const capped = SessionCompaction.serializeMessage(
      assistant("default_ceiling", [tool({ id: "call_bash", name: "bash", output: listing })]),
    )

    expect(capped).toContain("LISTING-HEAD")
    expect(capped).toContain("LISTING-TAIL")
  })

  test("budgets are per tool name with a default for everything unlisted", () => {
    expect(SessionCompaction.toolOutputBudget("wait_agents")).toBeGreaterThan(
      SessionCompaction.toolOutputBudget("bash"),
    )
    expect(SessionCompaction.toolOutputBudget("skill")).toBeGreaterThan(SessionCompaction.toolOutputBudget("read"))
    expect(SessionCompaction.toolOutputBudget("bash")).toBe(SessionCompaction.toolOutputBudget("read"))
  })

  test("every budgeted tool actually populates the field its budget is keyed on", () => {
    // A budget keyed on a field the tool never writes is a silent no-op, which is exactly how
    // `wait_agents` shipped. `serializeToolOutput` reads whichever field the tool really uses, so
    // the guarantee to pin is that a budgeted tool's payload survives serialization at all.
    const payload = "BUDGETED-PAYLOAD"
    const cases: ReadonlyArray<SessionMessage.AssistantTool> = [
      waitAgents({ id: "call_wait", report: payload }),
      // V1 transcript adoption writes `content` for the old single-shot subagent tool
      // (`src/session/transcript-adoption.ts:656-658`), so `task` is content-shaped.
      tool({ id: "call_task", name: "task", output: payload }),
      tool({ id: "call_send", name: "send_agent", structured: { task: { result: payload } } }),
      tool({ id: "call_list", name: "list_agents", structured: { tasks: [{ result: payload }] } }),
      // `skill` declares `toModelOutput` (`src/tool/skill.ts:69`).
      tool({ id: "call_skill", name: "skill", output: payload }),
    ]

    for (const part of cases) {
      const serialized = SessionCompaction.serializeMessage(assistant(`budget_${part.id}`, [part]))
      expect([part.name, serialized.includes(payload)]).toEqual([part.name, true])
    }
  })
})

//
// -- Pruning ---------------------------------------------------------------------------------
//

describe("pruneEntries", () => {
  // PRUNE_PROTECT is 40k tokens (~160k chars) and PRUNE_MINIMUM is 20k tokens (~80k chars),
  // so these sizes are chosen to straddle both thresholds exactly once.
  const protectedOutput = "p".repeat(120_000) // 30k tokens: fits inside the protect window
  const staleOutput = "s".repeat(80_000) // 20k tokens each: the two oldest exceed it

  const history = () => [
    entry(user("u1", "first")),
    entry(assistant("a1", [tool({ id: "call_1", name: "bash", output: staleOutput })])),
    entry(user("u2", "second")),
    entry(
      assistant("a2", [
        tool({ id: "call_2", name: "bash", output: staleOutput }),
        tool({ id: "call_skill", name: "skill", output: "SKILL-INSTRUCTIONS" }),
        tool({ id: "call_provider", name: "web_search", output: "PROVIDER-RESULT", providerExecuted: true }),
      ]),
    ),
    entry(user("u3", "third")),
    entry(assistant("a3", [tool({ id: "call_3", name: "bash", output: protectedOutput })])),
    entry(user("u4", "fourth")),
    entry(assistant("a4", [tool({ id: "call_4", name: "bash", output: "RECENT-TURN-OUTPUT" })])),
    entry(user("u5", "fifth")),
    entry(assistant("a5", [tool({ id: "call_5", name: "bash", output: "CURRENT-TURN-OUTPUT" })])),
  ]

  test("frees stale tool output without touching protected content", () => {
    const result = SessionCompaction.pruneEntries(history(), { enabled: true })

    // Reclaimed: the two oldest bash results, both beyond the protect window.
    expect(toolOutputOf(result.entries, "a1", "call_1")).toBe(SessionCompaction.PRUNED_TEXT)
    expect(toolOutputOf(result.entries, "a2", "call_2")).toBe(SessionCompaction.PRUNED_TEXT)
    expect(result.count).toBe(2)
    expect(result.freed).toBeGreaterThan(SessionCompaction.PRUNE_MINIMUM)
    // The identities the durable `Compaction.Pruned` mark names, oldest first. The scan runs
    // newest to oldest, and an event whose entries read backwards against the transcript is
    // needlessly hard to line up in a log or a projection test.
    expect(result.cleared).toEqual([
      { assistantMessageID: messageID("a1"), callID: "call_1" },
      { assistantMessageID: messageID("a2"), callID: "call_2" },
    ])

    // Protected: skill output is behavioural instruction, not data.
    expect(toolOutputOf(result.entries, "a2", "call_skill")).toBe("SKILL-INSTRUCTIONS")
    // Protected: provider-executed results are echoed back and shape-checked by the provider.
    expect(toolOutputOf(result.entries, "a2", "call_provider")).toBe("PROVIDER-RESULT")
    // Protected: inside the PRUNE_PROTECT recency window.
    expect(toolOutputOf(result.entries, "a3", "call_3")).toBe(protectedOutput)
    // Protected: the current turn and the one before it are exempt outright.
    expect(toolOutputOf(result.entries, "a4", "call_4")).toBe("RECENT-TURN-OUTPUT")
    expect(toolOutputOf(result.entries, "a5", "call_5")).toBe("CURRENT-TURN-OUTPUT")
  })

  test("pruning is read-time only and leaves the caller's messages untouched", () => {
    const original = history()
    const result = SessionCompaction.pruneEntries(original, { enabled: true })

    expect(toolOutputOf(result.entries, "a1", "call_1")).toBe(SessionCompaction.PRUNED_TEXT)
    // The input array the runner also hands to the projector/desktop must be unchanged.
    expect(toolOutputOf(original, "a1", "call_1")).toBe(staleOutput)
  })

  test("a structured-only result is measured and cleared, not silently skipped", () => {
    // `ToolOutput.toResultValue` falls back to `structured` when `content` is empty, so measuring
    // content alone would report zero and prune would never reclaim a structured-only result --
    // and clearing content alone would ship the whole structured payload to the provider anyway.
    // `read` is the real case: 186 of 186 completed `read` states in the owner's dev database have
    // `content: []` with the file body in `structured`.
    const blob = "s".repeat(200_000)
    const entries = [
      entry(user("u1", "first")),
      entry(
        assistant("a1", [
          tool({ id: "call_struct", name: "read", callInput: { path: "big.txt" }, structured: { blob } }),
        ]),
      ),
      entry(user("u2", "second")),
      entry(assistant("a2", [])),
      entry(user("u3", "third")),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true })
    const cleared = result.entries.find((item) => item.message.id === messageID("a1"))?.message
    if (cleared?.type !== "assistant") throw new Error("expected assistant")
    const part = cleared.content[0]
    if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("expected completed tool")

    expect(result.count).toBe(1)
    expect(part.state.content).toEqual([{ type: "text", text: SessionCompaction.PRUNED_TEXT }])
    expect(part.state.structured).toEqual({})
    expect(JSON.stringify(part.state)).not.toContain(blob)
  })

  test("the turn exemption tracks compaction.keep.turns instead of V1's hardcoded 2", () => {
    // `select` honours the configured `turns`, so a hardcoded exemption of 2 meant "keep my last
    // five turns verbatim" was satisfied with sentinels: prune cleared turns 3 and 4 and `select`
    // then preserved the cleared version.
    const large = "s".repeat(200_000)
    const seven = () => {
      const rows: Entry[] = []
      for (let index = 1; index <= 7; index++) {
        rows.push(entry(user(`u${index}`, `turn ${index}`)))
        rows.push(entry(assistant(`a${index}`, [tool({ id: `call_${index}`, name: "bash", output: large })])))
      }
      return rows
    }
    const clearedTurns = (entries: readonly Entry[]) =>
      entries.flatMap((item) =>
        item.message.type === "assistant" &&
        item.message.content.some(
          (part) =>
            part.type === "tool" &&
            part.state.status === "completed" &&
            part.state.content.some((piece) => piece.type === "text" && piece.text === SessionCompaction.PRUNED_TEXT),
        )
          ? [String(item.message.id)]
          : [],
      )

    expect(clearedTurns(SessionCompaction.pruneEntries(seven(), { enabled: true }).entries)).toEqual([
      "msg_a1",
      "msg_a2",
      "msg_a3",
      "msg_a4",
      "msg_a5",
    ])

    const wide = SessionCompaction.pruneEntries(seven(), { enabled: true, turns: 5 })
    expect(clearedTurns(wide.entries)).toEqual(["msg_a1", "msg_a2"])

    // The preserved tail must be evidence, not sentinels.
    const selected = SessionCompaction.select(wide.entries, { tokens: 200_000, turns: 5 })
    if (!selected) throw new Error("expected a selection")
    expect(selected.recent).not.toContain(SessionCompaction.PRUNED_TEXT)

    // `keep.turns: 0` disables turn alignment in `select`; it is not a request to prune the turn
    // the model is answering right now, so V1's floor of 2 still applies.
    expect(clearedTurns(SessionCompaction.pruneEntries(seven(), { enabled: true, turns: 0 }).entries)).toEqual([
      "msg_a1",
      "msg_a2",
      "msg_a3",
      "msg_a4",
      "msg_a5",
    ])
  })

  test("does nothing when the reclaimable amount is below PRUNE_MINIMUM", () => {
    const small = [
      entry(user("u1", "first")),
      entry(assistant("a1", [tool({ id: "call_1", name: "bash", output: "small" })])),
      entry(user("u2", "second")),
      entry(assistant("a2", [tool({ id: "call_2", name: "bash", output: "small" })])),
      entry(user("u3", "third")),
    ]
    const result = SessionCompaction.pruneEntries(small, { enabled: true })

    expect(result.count).toBe(0)
    expect(result.freed).toBe(0)
    expect(result.entries).toBe(small)
  })

  test("does nothing when disabled, however much could be reclaimed", () => {
    const result = SessionCompaction.pruneEntries(history(), { enabled: false })

    expect(result.count).toBe(0)
    expect(toolOutputOf(result.entries, "a1", "call_1")).toBe(staleOutput)
  })

  test("stops at the newest compaction because that history already sits behind a summary", () => {
    const entries = [
      entry(user("u0", "before")),
      entry(assistant("a0", [tool({ id: "call_0", name: "bash", output: staleOutput })])),
      entry(compactionMessage("c1", VALID_SUMMARY, "recent")),
      ...history(),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true })

    expect(toolOutputOf(result.entries, "a0", "call_0")).toBe(staleOutput)
    expect(toolOutputOf(result.entries, "a1", "call_1")).toBe(SessionCompaction.PRUNED_TEXT)
  })

  test("clears stale shell surface output beyond the protect window, read-time only", () => {
    // Shell messages were the one payload prune could not reach: up to 1MB apiece, outside any
    // assistant message, and never behind a provider-measured turn — so repeated terminal dumps
    // accumulated until the provider overflowed. Cleared without a durable mark: the Shell
    // schema has none yet, so `cleared` must not name shell messages.
    const shell = (id: string, bytes: number) =>
      entry(
        SessionMessage.Shell.make({
          id: messageID(id),
          type: "shell",
          callID: `call_${id}`,
          command: "sqlite3 forge-dev.db 'select * from event'",
          output: "x".repeat(bytes),
          time: { created, completed: created },
        }),
      )
    const entries = [
      shell("stale_dump", 400_000),
      entry(user("shell_u1", "first")),
      entry(assistant("shell_a1", [{ type: "text", id: "txt_shell_1", text: "ok" }])),
      entry(user("shell_u2", "second")),
      shell("recent_dump", 400_000),
      entry(user("shell_u3", "third")),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true })

    const outputs = new Map(
      result.entries.flatMap((item) =>
        item.message.type === "shell" ? [[String(item.message.id), item.message.output] as const] : [],
      ),
    )
    expect(outputs.get("msg_stale_dump")).toBe(SessionCompaction.PRUNED_TEXT)
    // Inside the two-turn exemption: the dump the user just produced stays verbatim.
    expect(outputs.get("msg_recent_dump")).toBe("x".repeat(400_000))
    expect(result.freed).toBeGreaterThan(SessionCompaction.PRUNE_MINIMUM)
    expect(result.cleared).toEqual([])
    // The caller's rows are untouched; prune is a read-time view here as everywhere else.
    const original = entries.find((item) => item.message.id === messageID("stale_dump"))!.message
    expect(original.type === "shell" && original.output.length).toBe(400_000)
  })

  test("clears older byte-identical results even inside the protect window", () => {
    // Dedup is compression's text-domain analogue: a re-read file replayed the same bytes on
    // every turn, and prune could not touch the copies inside the protect window. Clearing an
    // older duplicate destroys nothing — the newer copy carries every byte — so it is exempt
    // from both the protect window and PRUNE_MINIMUM.
    const identical = "d".repeat(10_000) // 2.5k tokens/copy: far below PRUNE_PROTECT, prune stays inert
    const unique = "u".repeat(10_000)
    const entries = [
      entry(user("dd_u1", "one")),
      entry(assistant("dd_a1", [tool({ id: "dd_c1", name: "bash", output: identical })])),
      entry(user("dd_u2", "two")),
      entry(assistant("dd_a2", [tool({ id: "dd_c2", name: "bash", output: identical })])),
      entry(user("dd_u3", "three")),
      entry(assistant("dd_a3", [tool({ id: "dd_c3", name: "bash", output: unique })])),
      entry(user("dd_u4", "four")),
      entry(assistant("dd_a4", [tool({ id: "dd_c4", name: "bash", output: identical })])),
      entry(user("dd_u5", "five")),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true, dedup: true })

    // The exempt-window copy survives verbatim and justifies clearing the older two.
    expect(toolOutputOf(result.entries, "dd_a4", "dd_c4")).toBe(identical)
    expect(toolOutputOf(result.entries, "dd_a1", "dd_c1")).toBe(SessionCompaction.PRUNED_DUPLICATE_TEXT)
    expect(toolOutputOf(result.entries, "dd_a2", "dd_c2")).toBe(SessionCompaction.PRUNED_DUPLICATE_TEXT)
    // A false positive here would destroy bytes preserved nowhere else.
    expect(toolOutputOf(result.entries, "dd_a3", "dd_c3")).toBe(unique)
    // Read-time only: no durable mark ever names a duplicate clearing.
    expect(result.cleared).toEqual([])
    expect(result.count).toBe(2)
    expect(result.freed).toBeGreaterThan(0)

    // Off without the flag, and idempotent over its own view (sentinels are below the dedup
    // size floor, so a second pass changes nothing).
    const off = SessionCompaction.pruneEntries(entries, { enabled: true })
    expect(toolOutputOf(off.entries, "dd_a1", "dd_c1")).toBe(identical)
    const again = SessionCompaction.pruneEntries(result.entries, { enabled: true, dedup: true })
    expect(toolOutputOf(again.entries, "dd_a1", "dd_c1")).toBe(SessionCompaction.PRUNED_DUPLICATE_TEXT)
    expect(toolOutputOf(again.entries, "dd_a4", "dd_c4")).toBe(identical)
  })

  test("clears byte-identical results repeated within the current user turn", () => {
    const board = JSON.stringify({ notes: [{ title: "Stale audit", body: "b".repeat(8_000) }], total: 1 })
    const entries = [
      entry(user("same_turn_u1", "Finish the current certificate handoff")),
      entry(assistant("same_turn_a1", [tool({ id: "same_turn_c1", name: "board_read", output: board })])),
      entry(assistant("same_turn_a2", [tool({ id: "same_turn_c2", name: "board_read", output: board })])),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true, dedup: true })

    expect(toolOutputOf(result.entries, "same_turn_a1", "same_turn_c1")).toBe(SessionCompaction.PRUNED_DUPLICATE_TEXT)
    expect(toolOutputOf(result.entries, "same_turn_a2", "same_turn_c2")).toBe(board)
    expect(result.cleared).toEqual([])
    expect(result.count).toBe(1)
  })

  test("clears stale re-derivable tool inputs while preserving paths and recent bodies", () => {
    // Old write/apply_patch bodies replayed forever: outputs shed via prune, but the 8-20KB
    // the model itself placed in the call input had no shedding path at all. Cleared inputs
    // are re-derivable — the body is on disk, the patch is in the structured diff.
    const body = "b".repeat(120_000)
    const writeCall = (id: string, content: string): SessionMessage.AssistantTool => ({
      type: "tool",
      id,
      name: "write",
      state: {
        status: "completed",
        input: { path: `src/${id}.ts`, content },
        content: [{ type: "text", text: "ok" }],
        structured: {},
      },
      time: { created },
    })
    const entries = [
      entry(user("in_u1", "first")),
      entry(assistant("in_a1", [writeCall("call_old", body)])),
      entry(user("in_u2", "second")),
      entry(assistant("in_a2", [tool({ id: "call_bash_old", name: "bash", output: "s".repeat(80_000) })])),
      entry(user("in_u3", "third")),
      entry(assistant("in_a3", [writeCall("call_recent", body)])),
      entry(user("in_u4", "fourth")),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true, inputs: true })

    const stale = result.entries.find((item) => item.message.id === messageID("in_a1"))!.message
    if (stale.type !== "assistant" || stale.content[0]?.type !== "tool") throw new Error("expected tool")
    expect(stale.content[0].state.input).toEqual({
      path: "src/call_old.ts",
      content: SessionCompaction.PRUNED_INPUT_TEXT,
    })

    // Inside the turn exemption: the body the model just wrote stays verbatim.
    const recent = result.entries.find((item) => item.message.id === messageID("in_a3"))!.message
    if (recent.type !== "assistant" || recent.content[0]?.type !== "tool") throw new Error("expected tool")
    expect(recent.content[0].state.input).toEqual({ path: "src/call_recent.ts", content: body })

    // Read-time only and exemption-only: input clearing never feeds the shared protect budget
    // (the body is on disk), so nothing here crosses the output-prune thresholds and no durable
    // mark is written at all.
    expect(result.cleared).toEqual([])
    // Off by flag: an explicit pruneInputs: false leaves inputs whole even with prune on.
    const off = SessionCompaction.pruneEntries(entries, { enabled: true, inputs: false })
    const untouched = off.entries.find((item) => item.message.id === messageID("in_a1"))!.message
    if (untouched.type !== "assistant" || untouched.content[0]?.type !== "tool") throw new Error("expected tool")
    expect(untouched.content[0].state.input).toEqual({ path: "src/call_old.ts", content: body })
  })

  test("clears stale pasted screenshots while the newest image and text attachments survive", () => {
    // Every historical image replayed its full base64 on every turn with no shedding path —
    // eight pasted screenshots cost ~13k window tokens forever. Cleared attachments become a
    // named text note so the model can ask for a re-attach; `source.text` attachments are
    // content and are never touched.
    // 80KB base64 ≈ 20k wire tokens: inside the protect window on its own, so the newest image
    // survives, while the fillers' outputs push the running total past it for the old one.
    const image = (name: string) => ({ uri: `data:image/png;base64,${"A".repeat(80_000)}`, mime: "image/png", name })
    const textAttachment = {
      uri: "file:///notes.md",
      mime: "text/markdown",
      name: "notes.md",
      source: { text: "KEEP-THIS-TEXT", start: 0, end: 14 },
    }
    const withFiles = (id: string, files: ReadonlyArray<Record<string, unknown>>) =>
      entry(
        SessionMessage.User.make({
          id: messageID(id),
          type: "user",
          text: `prompt ${id}`,
          files: files as never,
          time: { created },
        }),
      )
    const filler = (index: number) => [
      entry(user(`media_u${index}`, `turn ${index}`)),
      entry(
        assistant(`media_a${index}`, [tool({ id: `call_media_${index}`, name: "bash", output: "s".repeat(200_000) })]),
      ),
    ]
    const entries = [
      withFiles("media_old", [image("old-shot.png"), textAttachment]),
      ...filler(1),
      ...filler(2),
      withFiles("media_recent", [image("recent-shot.png")]),
      entry(user("media_pending", "current")),
    ]
    const result = SessionCompaction.pruneEntries(entries, { enabled: true, media: true })

    const old = result.entries.find((item) => item.message.id === messageID("media_old"))!.message
    if (old.type !== "user" || !old.files) throw new Error("expected user files")
    expect(old.files[0]).toMatchObject({ uri: "cleared:old-shot.png", mime: "text/plain" })
    expect(JSON.stringify(old.files[0])).toContain("old-shot.png")
    expect(JSON.stringify(old.files[0])).not.toContain("AAAA")
    // Text attachments are content, not media.
    expect(old.files[1]).toMatchObject({ source: { text: "KEEP-THIS-TEXT" } })

    // The newest image is inside the exemption window and survives byte-for-byte.
    const recent = result.entries.find((item) => item.message.id === messageID("media_recent"))!.message
    if (recent.type !== "user" || !recent.files) throw new Error("expected user files")
    expect(recent.files[0]!.uri.startsWith("data:image/png")).toBe(true)

    // Read-time only, idempotent: a second pass over the pruned view changes nothing.
    const again = SessionCompaction.pruneEntries(result.entries, { enabled: true, media: true })
    const twice = again.entries.find((item) => item.message.id === messageID("media_old"))!.message
    if (twice.type !== "user" || !twice.files) throw new Error("expected user files")
    expect(twice.files[0]).toMatchObject({ uri: "cleared:old-shot.png" })
    // The original rows are untouched.
    const original = entries[0]!.message
    if (original.type !== "user" || !original.files) throw new Error("expected user files")
    expect(original.files[0]!.uri.startsWith("data:image/png")).toBe(true)
  })

  test("honours an existing durable prune mark even when pruning is disabled", () => {
    // The mark is written today only by V1 transcript adoption, and nothing on the V2 model path
    // reads it -- so an adopted session the user pruned in V1 re-sends its full tool output.
    const adopted = [
      entry(user("u1", "first")),
      entry(assistant("a1", [tool({ id: "call_1", name: "bash", output: staleOutput, pruned: true })])),
      entry(user("u2", "second")),
      entry(assistant("a2", [])),
      entry(user("u3", "third")),
    ]
    const result = SessionCompaction.pruneEntries(adopted, { enabled: false })

    expect(toolOutputOf(result.entries, "a1", "call_1")).toBe(SessionCompaction.PRUNED_TEXT)
    expect(result.count).toBe(1)
    // Honoured, not re-announced. Republishing a mark the part already carries would append a
    // durable event on every turn for the rest of the session's life.
    expect(result.cleared).toEqual([])
  })

  test("the cleared prefix only grows as history grows, so prompt-cache prefixes stay stable", () => {
    const cleared = (entries: readonly Entry[]) =>
      new Set(
        SessionCompaction.pruneEntries(entries, { enabled: true })
          .entries.flatMap((item) => (item.message.type === "assistant" ? [item] : []))
          .flatMap((item) =>
            item.message.type === "assistant"
              ? item.message.content.flatMap((part) =>
                  part.type === "tool" &&
                  part.state.status === "completed" &&
                  part.state.content.some((c) => c.type === "text" && c.text === SessionCompaction.PRUNED_TEXT)
                    ? [`${item.message.id}:${part.id}`]
                    : [],
                )
              : [],
          ),
      )

    const before = cleared(history())
    const after = cleared([
      ...history(),
      entry(user("u6", "sixth")),
      entry(assistant("a6", [tool({ id: "call_6", name: "bash", output: staleOutput })])),
    ])

    expect(before.size).toBeGreaterThan(0)
    for (const key of before) expect(after.has(key)).toBe(true)
    expect(after.size).toBeGreaterThanOrEqual(before.size)
  })
})

//
// -- Head/tail selection ---------------------------------------------------------------------
//

describe("select", () => {
  const conversation = () => [
    entry(user("u1", `FIRST-PROMPT${"a".repeat(4_000)}`)),
    entry(assistant("a1", [{ type: "text", id: "txt_1", text: `FIRST-ANSWER${"b".repeat(4_000)}` }])),
    entry(user("u2", `SECOND-PROMPT${"c".repeat(4_000)}`)),
    entry(assistant("a2", [{ type: "text", id: "txt_2", text: `SECOND-ANSWER${"d".repeat(4_000)}` }])),
    entry(user("u3", `THIRD-PROMPT${"e".repeat(4_000)}`)),
    entry(assistant("a3", [{ type: "text", id: "txt_3", text: `THIRD-ANSWER${"f".repeat(4_000)}` }])),
  ]

  test("never splits a message across the head/tail boundary", () => {
    const selected = SessionCompaction.select(conversation(), { tokens: 3_000, turns: 0 })
    if (!selected) throw new Error("expected a selection")

    // Every marker must appear exactly once, on exactly one side. The previous implementation
    // sliced the boundary message by character count and handed each half to a different reader.
    for (const marker of [
      "FIRST-PROMPT",
      "FIRST-ANSWER",
      "SECOND-PROMPT",
      "SECOND-ANSWER",
      "THIRD-PROMPT",
      "THIRD-ANSWER",
    ]) {
      const inHead = selected.head.includes(marker)
      const inRecent = selected.recent.includes(marker)
      expect(inHead !== inRecent).toBe(true)
    }
    expect(selected.head).not.toContain("[truncated]")
  })

  test("aligns the preserved tail to a whole turn when the budget allows", () => {
    const selected = SessionCompaction.select(conversation(), { tokens: 8_000, turns: 2 })
    if (!selected) throw new Error("expected a selection")

    // The tail must start at a user message, not mid-turn.
    expect(selected.recent.startsWith("[User]:")).toBe(true)
    expect(selected.recent).toContain("THIRD-PROMPT")
    expect(selected.recent).toContain("THIRD-ANSWER")
    expect(selected.head).toContain("FIRST-PROMPT")
  })

  test("preserves the in-flight user instruction when its turn outgrows the tail budget", () => {
    // One turn balloons on tool output past the whole token budget: the greedy
    // boundary opens the tail mid-turn (or empties it), past the turn's own
    // [User] line. The literal instruction must still survive in `recent`.
    const selected = SessionCompaction.select(
      [
        entry(user("u1", `EARLIER-PROMPT${"a".repeat(2_000)}`)),
        entry(assistant("a1", [{ type: "text", id: "txt_1", text: `EARLIER-ANSWER${"b".repeat(2_000)}` }])),
        entry(user("u2", `FINAL-INSTRUCTION${"c".repeat(600)}`)),
        entry(assistant("a2", [{ type: "text", id: "txt_2", text: `HUGE-TOOL-OUTPUT${"d".repeat(11_900)}` }])),
      ],
      { tokens: 3_000, turns: 2 },
    )
    if (!selected) throw new Error("expected a selection")
    expect(selected.recent).toContain("FINAL-INSTRUCTION")
    expect(selected.head).toContain("EARLIER-PROMPT")
  })

  test("the turn cap bounds the tail even when the token budget is generous", () => {
    const generous = SessionCompaction.select(conversation(), { tokens: 1_000_000, turns: 1 })
    if (!generous) throw new Error("expected a selection")

    expect(generous.recent).toContain("THIRD-PROMPT")
    expect(generous.recent).not.toContain("SECOND-PROMPT")
    expect(generous.head).toContain("SECOND-PROMPT")
  })

  test("the token cap binds first when it is tighter than the turn cap", () => {
    const tight = SessionCompaction.select(conversation(), { tokens: 3_000, turns: 10 })
    if (!tight) throw new Error("expected a selection")

    expect(tight.recent).not.toContain("FIRST-PROMPT")
    expect(tight.head).toContain("FIRST-PROMPT")
  })

  test("a tail that would swallow the whole history is abandoned so there is something to summarize", () => {
    const selected = SessionCompaction.select(conversation(), { tokens: 1_000_000, turns: 10 })
    if (!selected) throw new Error("expected a selection")

    expect(selected.recent).toBe("")
    expect(selected.head).toContain("FIRST-PROMPT")
    expect(selected.head).toContain("THIRD-ANSWER")
  })

  test("returns nothing when there is no conversation left to summarize", () => {
    expect(SessionCompaction.select([], { tokens: 8_000, turns: 2 })).toBeUndefined()
    expect(
      SessionCompaction.select([entry(compactionMessage("c1", VALID_SUMMARY, "recent"))], { tokens: 8_000, turns: 2 }),
    ).toBeUndefined()
  })

  test("automatic compaction keeps the unanswered turn as original message rows", () => {
    const firstUser = entry(user("boundary_u1", "OLDER-INSTRUCTION"))
    const firstAssistant = entry(
      assistant("boundary_a1", [{ type: "text", id: "boundary_text", text: "OLDER-ANSWER" }]),
    )
    const current = entry(user("boundary_u2", "CURRENT-EXACT-INSTRUCTION"))
    const selected = SessionCompaction.select([firstUser, firstAssistant, current], {
      tokens: 1_000_000,
      turns: 10,
      preserveCurrentTurn: true,
    })

    expect(selected).toMatchObject({ recent: "", throughSeq: firstAssistant.seq })
    expect(selected?.head).toContain("OLDER-INSTRUCTION")
    expect(selected?.head).not.toContain("CURRENT-EXACT-INSTRUCTION")
  })
})

//
// -- Prompt fitting --------------------------------------------------------------------------
//

describe("fitPrompt", () => {
  test("makes a single enormous message compactable instead of permanently stuck", () => {
    // One huge tool result or one pasted file used to exceed the context, fail the size guard,
    // and fail it identically on every later turn -- the session could never be compacted again.
    const head = `HEAD-MARKER${"x".repeat(1_000_000)}TAIL-MARKER`
    const fitted = SessionCompaction.fitPrompt({ previousSummary: undefined, priorRecent: undefined, head }, 40_000)

    expect(fitted.elided).toBe(true)
    expect(fitted.prompt.length).toBeLessThanOrEqual(40_000)
    expect(fitted.prompt).toContain("## Work State")
    // Both ends survive: the oldest context states the objective, the newest states the state.
    expect(fitted.prompt).toContain("HEAD-MARKER")
    expect(fitted.prompt).toContain("TAIL-MARKER")
  })

  test("leaves a prompt that already fits completely alone", () => {
    const fitted = SessionCompaction.fitPrompt(
      { previousSummary: "prior", priorRecent: "recent", head: "history" },
      100_000,
    )

    expect(fitted.elided).toBe(false)
    expect(fitted.prompt).toContain("<previous-summary>")
    expect(fitted.prompt).toContain("recent")
    expect(fitted.prompt).toContain("history")
  })

  test("bounds every carried source without deleting the previous checkpoint", () => {
    const previousSummary = `SUMMARY${"s".repeat(20_000)}`
    const priorRecent = `PRIOR-RECENT${"r".repeat(20_000)}`
    const head = `HEAD${"h".repeat(20_000)}`

    const roomy = SessionCompaction.fitPrompt({ previousSummary, priorRecent, head }, 45_000)
    expect(roomy.prompt).toContain("PRIOR-RECENT")
    expect(roomy.prompt).toContain("SUMMARY")

    const tight = SessionCompaction.fitPrompt({ previousSummary, priorRecent, head }, 26_000)
    expect(tight.prompt.length).toBeLessThanOrEqual(26_000)
    expect(tight.prompt).toContain("PRIOR-RECENT")
    expect(tight.prompt).toContain("SUMMARY")
    expect(tight.prompt).toContain("HEAD")

    const desperate = SessionCompaction.fitPrompt({ previousSummary, priorRecent, head }, 6_000)
    expect(desperate.prompt.length).toBeLessThanOrEqual(6_000)
    expect(desperate.prompt).toContain("PRIOR-RECENT")
    expect(desperate.prompt).toContain("<previous-summary>")
    expect(desperate.prompt).toContain("SUMMARY")
    expect(desperate.prompt).toContain("HEAD")
  })

  test("the fallback checkpoint is a structurally valid summary", () => {
    // It is fed to the same consumers as a written summary — including the next compaction, which
    // anchors on it — so it has to satisfy the same structural contract.
    const summary = SessionCompaction.fallbackSummary({
      head: "[User] do the thing\n\n[Assistant] on it",
      detail: "Provider request failed with HTTP 400",
    })
    expect(SessionCompaction.validSummary(summary)).toBe(true)
    expect(summary).toContain("do the thing")
    expect(summary).toContain("HTTP 400")
  })

  test("the fallback checkpoint survives a head that already contains summary headings", () => {
    // Heads routinely carry an older checkpoint verbatim, and `validSummary` requires each heading
    // exactly once — an unescaped `## Objective` in the excerpt would make the fallback itself
    // invalid, which is the one thing this path cannot afford.
    const summary = SessionCompaction.fallbackSummary({
      head: `## Objective\n- ship it\n\n## Next Move\n1. keep going\n\n### Blocked\n- nothing`,
      partial: "## Objective\n- half-written",
    })
    expect(SessionCompaction.validSummary(summary)).toBe(true)
    expect(summary).toContain("ship it")
  })

  test("the fallback checkpoint stays small enough to replay every turn", () => {
    const summary = SessionCompaction.fallbackSummary({ head: "x".repeat(5_000_000), detail: "y".repeat(5_000) })
    expect(summary.length).toBeLessThan(40_000)
  })
})

//
// -- Configuration ---------------------------------------------------------------------------
//

describe("settings", () => {
  const engine = (compaction: Record<string, unknown>) =>
    SessionCompaction.make({
      events: { publish: () => Effect.succeed(undefined) } as never,
      llm: { stream: () => Stream.empty },
      config: Effect.succeed(configWith(compaction)),
    })
  const settingsOf = (compaction: Record<string, unknown>) => Effect.runSync(engine(compaction).settings)

  test("prune is on by default and configurable off", () => {
    // Off-by-default meant a default install replayed every stale tool result and shell dump
    // on every turn until a full LLM compaction — nothing reduced replay cost out of the box.
    expect(settingsOf({}).prune).toBe(true)
    expect(settingsOf({ prune: false }).prune).toBe(false)
  })

  test("dedup is on by default after the context-bench adoption", () => {
    expect(settingsOf({}).dedupOutputs).toBe(true)
    expect(settingsOf({ dedupOutputs: false }).dedupOutputs).toBe(false)
  })

  test("input and media pruning are on by default after their context-bench adoptions", () => {
    expect(settingsOf({}).pruneInputs).toBe(true)
    expect(settingsOf({}).pruneMedia).toBe(true)
    expect(settingsOf({ pruneInputs: false }).pruneInputs).toBe(false)
    expect(settingsOf({ pruneMedia: false }).pruneMedia).toBe(false)
  })

  test("the fact ledger is on by default after the compaction A/B adoption", () => {
    // +121% fact recall for +44% context tokens, and the only strategy of the five swept whose
    // recall does not decay across compaction generations.
    expect(settingsOf({}).ledger).toBe(true)
    expect(settingsOf({ ledger: false }).ledger).toBe(false)
  })

  test("reads compaction.keep.turns alongside keep.tokens", () => {
    expect(settingsOf({}).turns).toBe(2)
    expect(settingsOf({ keep: { turns: 5, tokens: 1_234 } }).turns).toBe(5)
    expect(settingsOf({ keep: { turns: 5, tokens: 1_234 } }).tokens).toBe(1_234)
  })

  test("clamps absurd values in code rather than rejecting the document", () => {
    // A bounded Schema range would make `Config.loadFile` drop the whole document, silently
    // discarding every other setting the user wrote.
    const settings = settingsOf({ keep: { turns: 10_000, tokens: 999_999_999 }, buffer: 999_999_999 })
    expect(settings.turns).toBeLessThanOrEqual(50)
    expect(settings.tokens).toBeLessThanOrEqual(200_000)
    expect(settings.buffer).toBeLessThanOrEqual(500_000)
  })

  test("later documents win per field", () => {
    const layered = SessionCompaction.make({
      events: { publish: () => Effect.succeed(undefined) } as never,
      llm: { stream: () => Stream.empty },
      config: Effect.succeed([
        { type: "document", info: { compaction: { prune: true, auto: false } } },
        { type: "document", info: { compaction: { auto: true } } },
      ] as unknown as readonly Config.Entry[]),
    })

    const layeredSettings = Effect.runSync(layered.settings)
    expect(layeredSettings.auto).toBe(true)
    expect(layeredSettings.prune).toBe(true)
  })

  test("settings are read per call, not frozen at construction", () => {
    // The runner builds this service once per Location layer. A captured array froze compaction
    // config until restart — and made the simulator's per-scenario overrides benchmark the
    // *previous* scenario's settings, which shipped a wrong A/B table before this regression.
    let prune = true
    const live = SessionCompaction.make({
      events: { publish: () => Effect.succeed(undefined) } as never,
      llm: { stream: () => Stream.empty },
      config: Effect.sync(() => configWith({ prune })),
    })
    expect(Effect.runSync(live.settings).prune).toBe(true)
    prune = false
    expect(Effect.runSync(live.settings).prune).toBe(false)
  })
})

//
// -- Engine behaviour ------------------------------------------------------------------------
//

type Published = { readonly type: string; readonly data: Record<string, unknown> }

const engine = (options: {
  readonly events: LLMEvent[]
  readonly fail?: boolean
  readonly failures?: readonly (LLMError | undefined)[]
  readonly summarizer?: SessionCompaction.Summarizer
  readonly config?: readonly Config.Entry[]
  /**
   * One response per provider call, consumed in order.
   *
   * A compaction makes two: the summary, then the fact extraction whose bullets become ledger
   * lines. `events` alone answers both calls identically, which is fine for tests that ignore the
   * ledger and useless for tests that are about it.
   */
  readonly queue?: LLMEvent[][]
}) => {
  const published: Published[] = []
  const requests: LLMRequest[] = []
  const pending = [...(options.queue ?? [])]
  const stream = (request: LLMRequest) => {
    const requestIndex = requests.length
    requests.push(request)
    const next = options.queue === undefined ? options.events : (pending.shift() ?? [])
    const events = Stream.fromArray([
      ...next,
      ...(next.some(LLMEvent.is.finish) ? [] : [LLMEvent.finish({ reason: "stop" })]),
    ])
    const failure = options.failures?.[requestIndex]
    return failure || options.fail
      ? Stream.concat(
          events,
          Stream.fail(
            failure ??
              new LLMError({
                module: "test",
                method: "stream",
                reason: new InvalidRequestReason({ message: "boom" }),
              }),
          ),
        )
      : events
  }
  return {
    published,
    requests,
    compaction: SessionCompaction.make({
      events: {
        publish: ((definition: { type: string }, data: Record<string, unknown>) =>
          Effect.sync(() => {
            published.push({ type: definition.type, data })
            return data
          })) as never,
      } as never,
      llm: { stream },
      config: Effect.succeed(options.config ?? []),
      ...(options.summarizer ? { summarizer: () => Effect.succeed(options.summarizer!) } : {}),
    }),
  }
}

const history = () => [
  entry(user("u1", "do the thing")),
  entry(assistant("a1", [{ type: "text", id: "t", text: "ok" }])),
]

const delta = (text: string) => LLMEvent.textDelta({ id: "blk_1", text })

describe("compaction outcomes", () => {
  test("a successful compaction publishes started, deltas and ended", async () => {
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    const outcome = await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
    )

    expect(outcome).toEqual({ ok: true })
    expect(harness.published.map((item) => item.type)).toEqual([
      "session.next.compaction.started",
      "session.next.compaction.delta",
      "session.next.compaction.ended",
    ])
    // The summariser already accumulated these chunks and threw the stream away.
    expect(harness.published.filter((item) => item.type.endsWith(".delta")).map((item) => item.data["text"])).toEqual([
      VALID_SUMMARY,
    ])
    const started = harness.published[0]!.data
    const ended = harness.published.at(-1)!.data
    expect(ended["messageID"]).toBe(started["messageID"])
    expect(ended["text"]).toBe(VALID_SUMMARY)
  })

  test("every declined path reports a distinguishable reason", async () => {
    const run = (harness: ReturnType<typeof engine>, entries: readonly Entry[], limits?: { context?: number }) =>
      Effect.runPromise(harness.compaction.compact({ sessionID, entries, model: model(limits) }))

    // No declared context window: there is no budget to compact against.
    expect(await run(engine({ events: [delta("s")] }), history())).toEqual({
      ok: false,
      reason: "unknownContextWindow",
    })
    // Nothing to summarize.
    expect(await run(engine({ events: [delta("s")] }), [], { context: 200_000 })).toEqual({
      ok: false,
      reason: "emptyConversation",
    })
    // A context smaller than a single summary is genuinely uncompactable.
    expect(await run(engine({ events: [delta("s")] }), history(), { context: 100 })).toEqual({
      ok: false,
      reason: "contextTooLarge",
    })
    // The provider reported an error mid-stream.
    expect(
      await run(engine({ events: [delta("partial"), LLMEvent.providerError({ message: "429" })] }), history(), {
        context: 200_000,
      }),
    ).toEqual({ ok: false, reason: "providerFailed" })
    // The request itself failed.
    expect(await run(engine({ events: [], fail: true }), history(), { context: 200_000 })).toEqual({
      ok: false,
      reason: "providerFailed",
    })
    // The model returned nothing usable.
    expect(await run(engine({ events: [delta("   \n ")] }), history(), { context: 200_000 })).toEqual({
      ok: false,
      reason: "emptySummary",
    })
  })

  test("a declined compaction publishes no ended event", async () => {
    const harness = engine({ events: [delta("partial"), LLMEvent.providerError({ message: "429" })] })
    await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
    )

    expect(harness.published.some((item) => item.type === "session.next.compaction.ended")).toBe(false)
    expect(harness.published.some((item) => item.type === "session.next.compaction.started")).toBe(true)
  })

  test("retries a summary context overflow with a progressively smaller prompt", async () => {
    const overflow = new LLMError({
      module: "test",
      method: "stream",
      reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
    })
    const harness = engine({
      events: [],
      queue: [[], [delta(VALID_SUMMARY)]],
      failures: [overflow, undefined],
      config: configWith({ ledger: false }),
    })
    const entries = [
      entry(user("overflow_summary_u", "summarize this history")),
      entry(
        assistant("overflow_summary_a", [
          { type: "text", id: "overflow_summary_text", text: `HEAD${"x".repeat(800_000)}TAIL` },
        ]),
      ),
      entry(user("overflow_summary_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 200_000, output: 10_000 })

    expect(
      await Effect.runPromise(
        harness.compaction.compactAfterOverflow({
          sessionID,
          entries,
          model: sessionModel,
          request: LLM.request({ model: sessionModel, messages: [Message.user("current instruction")] }),
        }),
      ),
    ).toBe(true)
    expect(harness.requests).toHaveLength(2)
    expect(JSON.stringify(harness.requests[1]!.messages).length).toBeLessThan(
      JSON.stringify(harness.requests[0]!.messages).length,
    )
    expect(harness.published.at(-1)?.type).toBe("session.next.compaction.ended")
  })

  test("bounds repeated summary failures and still writes a checkpoint", async () => {
    // Bounded retries, then a floor. This used to end in a terminal failure, which is exactly the
    // shape that bricked a real session: automatic compaction only runs when the turn no longer
    // fits, so "we could not summarize" means "this session can never take another turn". The
    // fallback checkpoint is a bad summary and a working session.
    const overflow = () =>
      new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
      })
    const harness = engine({
      events: [],
      failures: [overflow(), overflow(), overflow(), undefined],
      config: configWith({ ledger: false }),
    })
    const entries = [
      entry(user("bounded_overflow_u", "summarize")),
      entry(
        assistant("bounded_overflow_a", [
          { type: "text", id: "bounded_overflow_text", text: `HEAD${"x".repeat(800_000)}TAIL` },
        ]),
      ),
      entry(user("bounded_overflow_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 200_000, output: 10_000 })

    expect(
      await Effect.runPromise(
        harness.compaction.compactAfterOverflow({
          sessionID,
          entries,
          model: sessionModel,
          request: LLM.request({ model: sessionModel, messages: [Message.user("current instruction")] }),
        }),
      ),
    ).toBe(true)
    expect(harness.requests).toHaveLength(3)
    expect(harness.published.filter((event) => event.type === "session.next.compaction.failed")).toHaveLength(0)
    const ended = harness.published.at(-1)!
    expect(ended.type).toBe("session.next.compaction.ended")
    const text = ended.data["text"] as string
    // Structurally a checkpoint, and honest about what it is.
    expect(SessionCompaction.validSummary(text)).toBe(true)
    expect(text).toContain("written by TurenOS, not by a model")
    expect(text).toContain("prompt too long")
    // The excerpt is real history, not an apology.
    expect(text).toContain("HEAD")
  })

  test("shrinks the prompt when the provider rejects it as an oversized string", async () => {
    // The classification bug that made a 1 952-message session permanently uncompactable. OpenAI's
    // Responses API validates string lengths before it counts tokens, so a summarization prompt
    // over its 1 048 576-character cap comes back as `string_above_max_length` — a sentence with
    // no mention of context anywhere in it. It classified as a plain invalid request, the
    // shrink-and-retry loop never engaged, and every attempt sent the identical oversized prompt.
    const body = `Provider request failed with HTTP 400: {"error":{"message":"Invalid 'input[0].content[0].text': string too long. Expected a string with maximum length 1048576, but got a string with length 1891965 instead.","type":"invalid_request_error","param":"input[0].content[0].text","code":"string_above_max_length"}}`
    // The classifier is what the executor consults to build the reason, so assert it here rather
    // than hard-coding the classification the fix produces.
    expect(isContextOverflow(body)).toBe(true)
    const oversized = new LLMError({
      module: "test",
      method: "stream",
      reason: new InvalidRequestReason({
        message: body,
        classification: isContextOverflow(body) ? "context-overflow" : undefined,
      }),
    })
    const harness = engine({
      events: [],
      queue: [[], [delta(VALID_SUMMARY)]],
      failures: [oversized, undefined],
      config: configWith({ ledger: false }),
    })
    const entries = [
      entry(user("oversized_u", "summarize this history")),
      entry(assistant("oversized_a", [{ type: "text", id: "oversized_text", text: `HEAD${"x".repeat(800_000)}TAIL` }])),
      entry(user("oversized_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 200_000, output: 10_000 })

    expect(
      await Effect.runPromise(
        harness.compaction.compactAfterOverflow({
          sessionID,
          entries,
          model: sessionModel,
          request: LLM.request({ model: sessionModel, messages: [Message.user("current instruction")] }),
        }),
      ),
    ).toBe(true)
    expect(harness.requests).toHaveLength(2)
    expect(JSON.stringify(harness.requests[1]!.messages).length).toBeLessThan(
      JSON.stringify(harness.requests[0]!.messages).length,
    )
    expect(harness.published.at(-1)?.type).toBe("session.next.compaction.ended")
    expect(harness.published.at(-1)?.data["text"]).toBe(VALID_SUMMARY)
  })

  test("keeps the summarization prompt under the provider's string limit on a huge-window model", async () => {
    // The measured failure: gpt-5.6-sol declares a 1.05M-token window and a 922k-token input cap,
    // so the token budget alone allows a 3.68M-character prompt — and `Token.estimate` counts four
    // characters per token, which under-counts dense JSON besides. The real session produced a
    // 1 891 965-character prompt against a 1 048 576-character provider cap and could never
    // summarize. Characters are a limit in their own right, not a proxy for tokens.
    const harness = engine({ events: [delta(VALID_SUMMARY)], config: configWith({ ledger: false }) })
    const entries = [
      entry(user("string_cap_u", "summarize this history")),
      entry(
        assistant("string_cap_a", [{ type: "text", id: "string_cap_text", text: `HEAD${"y".repeat(4_000_000)}TAIL` }]),
      ),
      entry(user("string_cap_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 1_050_000, input: 922_000, output: 128_000 })

    expect(await Effect.runPromise(harness.compaction.compact({ sessionID, entries, model: sessionModel }))).toEqual({
      ok: true,
    })
    const sent = harness.requests[0]!.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.length).toBeLessThanOrEqual(1_048_576)
  })

  test("retries any provider failure that produced no summary, not only recognised overflows", async () => {
    // The deeper flaw behind the classification bug: the retry engaged only for a failure the
    // classifier already understood, so every unrecognised provider error — including the one that
    // actually happened — got exactly one attempt at the largest possible prompt.
    const unclassified = () =>
      new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidRequestReason({ message: "Provider request failed with HTTP 400" }),
      })
    const harness = engine({
      events: [],
      queue: [[], [delta(VALID_SUMMARY)]],
      failures: [unclassified(), undefined],
      config: configWith({ ledger: false }),
    })
    const entries = [
      entry(user("unclassified_u", "summarize this history")),
      entry(
        assistant("unclassified_a", [
          { type: "text", id: "unclassified_text", text: `HEAD${"z".repeat(800_000)}TAIL` },
        ]),
      ),
      entry(user("unclassified_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 200_000, output: 10_000 })

    expect(
      await Effect.runPromise(
        harness.compaction.compactAfterOverflow({
          sessionID,
          entries,
          model: sessionModel,
          request: LLM.request({ model: sessionModel, messages: [Message.user("current instruction")] }),
        }),
      ),
    ).toBe(true)
    expect(harness.requests).toHaveLength(2)
    expect(harness.published.at(-1)?.data["text"]).toBe(VALID_SUMMARY)
  })

  test("manual compaction of a stuck session retries harder than the automatic path", async () => {
    // A user typing `/compact` on a session that cannot take a turn is explicitly asking to lose
    // fidelity to get a working session back, so the manual path keeps halving after the automatic
    // one has fallen back.
    const fail = () =>
      new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
      })
    const entries = () => [
      entry(user("aggressive_u", "summarize this history")),
      entry(
        assistant("aggressive_a", [{ type: "text", id: "aggressive_text", text: `HEAD${"q".repeat(800_000)}TAIL` }]),
      ),
      entry(user("aggressive_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 200_000, output: 10_000 })
    const failures = [fail(), fail(), fail(), fail(), fail(), undefined]

    const auto = engine({ events: [], failures: [...failures], config: configWith({ ledger: false }) })
    await Effect.runPromise(
      auto.compaction.compactAfterOverflow({
        sessionID,
        entries: entries(),
        model: sessionModel,
        request: LLM.request({ model: sessionModel, messages: [Message.user("current instruction")] }),
      }),
    )

    const manual = engine({ events: [], failures: [...failures], config: configWith({ ledger: false }) })
    await Effect.runPromise(manual.compaction.compact({ sessionID, entries: entries(), model: sessionModel }))

    expect(auto.requests).toHaveLength(3)
    expect(manual.requests).toHaveLength(5)
    // Both still end in a checkpoint rather than a dead session.
    expect(auto.published.at(-1)?.type).toBe("session.next.compaction.ended")
    expect(manual.published.at(-1)?.type).toBe("session.next.compaction.ended")
  })

  test("compacts a session whose provider rejects every prompt over its character cap", async () => {
    // The production failure end to end, against a provider that enforces the cap that actually
    // exists rather than one the test picked: a 1.05M-token model, a head far past 1 048 576
    // characters, and a 400 for any prompt over it. Every attempt used to send the same oversized
    // prompt, so the session could never be compacted again by any means.
    const CAP = 1_048_576
    const published: { readonly type: string; readonly data: Record<string, unknown> }[] = []
    const sizes: number[] = []
    const compaction = SessionCompaction.make({
      events: {
        publish: ((definition: { type: string }, data: Record<string, unknown>) =>
          Effect.sync(() => {
            published.push({ type: definition.type, data })
            return data
          })) as never,
      } as never,
      llm: {
        stream: (request: LLMRequest) => {
          const size = request.messages
            .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
            .reduce((total, text) => total + text.length, 0)
          sizes.push(size)
          if (size <= CAP) return Stream.fromArray([delta(VALID_SUMMARY), LLMEvent.finish({ reason: "stop" })])
          return Stream.fail(
            new LLMError({
              module: "test",
              method: "stream",
              reason: new InvalidRequestReason({
                message: `Provider request failed with HTTP 400: {"error":{"message":"Invalid 'input[0].content[0].text': string too long. Expected a string with maximum length ${CAP}, but got a string with length ${size} instead.","code":"string_above_max_length"}}`,
                classification: "context-overflow",
              }),
            }),
          )
        },
      },
      config: Effect.succeed(configWith({ ledger: false })),
    })
    const entries = [
      entry(user("cap_u", "summarize this history")),
      entry(assistant("cap_a", [{ type: "text", id: "cap_text", text: `HEAD${"w".repeat(3_000_000)}TAIL` }])),
      entry(user("cap_pending", "current instruction")),
    ]
    const sessionModel = model({ context: 1_050_000, input: 922_000, output: 128_000 })

    expect(await Effect.runPromise(compaction.compact({ sessionID, entries, model: sessionModel }))).toEqual({
      ok: true,
    })
    // The very first prompt already respects the cap, so no attempt is wasted on a request the
    // provider was always going to refuse.
    expect(sizes[0]).toBeLessThanOrEqual(CAP)
    expect(sizes).toHaveLength(1)
    expect(published.at(-1)?.type).toBe("session.next.compaction.ended")
    expect(published.at(-1)?.data["text"]).toBe(VALID_SUMMARY)
  })

  test("a small manual compaction still reports the real failure instead of a mechanical checkpoint", async () => {
    // The fallback is a rescue, not a policy. Nothing is broken on a session that is comfortably
    // within budget, so replacing a healthy history with an excerpt would be a downgrade — the
    // user gets the truth and keeps their transcript.
    const harness = engine({ events: [], fail: true, config: configWith({ ledger: false }) })
    const outcome = await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
    )

    expect(outcome).toEqual({ ok: false, reason: "providerFailed" })
    expect(harness.published.some((item) => item.type === "session.next.compaction.ended")).toBe(false)
    const failure = harness.published.find((item) => item.type === "session.next.compaction.failed")!
    // The provider's own words reach the durable timeline: `providerFailed` alone covers everything
    // from an expired key to a rejected prompt, and the log line did not carry the message at all.
    expect(failure.data["detail"]).toContain("boom")
  })

  test("a declined overflow recovery leaves a durable breadcrumb", async () => {
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    // Nothing to summarize: recovery must decline, and the decline must reach the durable
    // timeline rather than only a log line — a terminal provider overflow with no visible
    // recovery attempt is otherwise undiagnosable from the UI.
    expect(
      await Effect.runPromise(
        harness.compaction.compactAfterOverflow({ sessionID, entries: [], model: model({ context: 200_000 }) }),
      ),
    ).toBe(false)
    expect(harness.published.map((item) => item.type)).toEqual(["session.next.compaction.failed"])
    expect(harness.published[0]!.data).toMatchObject({ mode: "auto", reason: "emptyConversation" })
  })

  test("overflow recovery still compacts when the catalog declares no context window", async () => {
    // The gate needs a declared window to fire, but overflow recovery does not: the provider
    // itself confirmed the window is exhausted. A window-less catalog entry used to make the
    // gate skip at debug AND recovery decline at warn — a bare terminal overflow with no
    // durable trace, which is exactly how the gpt-5.6-luna failure presented. Manual
    // compaction keeps the explicit refusal.
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    // An older completed turn plus the unanswered prompt: the current turn is preserved as
    // structured rows, so recovery needs real history behind it to summarize.
    const entries = [...history(), entry(user("windowless_pending", "current instruction"))]
    expect(
      await Effect.runPromise(harness.compaction.compactAfterOverflow({ sessionID, entries, model: model() })),
    ).toBe(true)
    expect(harness.published.at(-1)?.type).toBe("session.next.compaction.ended")

    const manual = engine({ events: [delta(VALID_SUMMARY)] })
    expect(
      await Effect.runPromise(manual.compaction.compact({ sessionID, entries: history(), model: model() })),
    ).toEqual({ ok: false, reason: "unknownContextWindow" })
  })

  test("a truncated or malformed summary fails without advancing the cutoff", async () => {
    const truncated = engine({
      events: [delta("## Objective\n- partial"), LLMEvent.finish({ reason: "length" })],
    })
    const outcome = await Effect.runPromise(
      truncated.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
    )

    expect(outcome).toEqual({ ok: false, reason: "invalidSummary" })
    expect(truncated.published.map((item) => item.type)).toEqual([
      "session.next.compaction.started",
      "session.next.compaction.delta",
      "session.next.compaction.failed",
    ])

    const malformed = engine({ events: [delta("I ignored the required structure")] })
    expect(
      await Effect.runPromise(
        malformed.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
      ),
    ).toEqual({ ok: false, reason: "invalidSummary" })
    expect(malformed.published.some((item) => item.type === "session.next.compaction.ended")).toBe(false)
    expect(
      SessionCompaction.validSummary(
        "## Objective\n## Important Details\n## Work State\n### Completed\n### Active\n### Blocked\n## Next Move\n## Relevant Files\n## Durable Memories",
      ),
    ).toBe(false)
  })

  test("does not replace an existing checkpoint when only the unanswered turn remains", async () => {
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    const current = entry(user("after_checkpoint", "CURRENT-MUST-SURVIVE"))
    const request = {
      model: model({ context: 20_000, output: 1_000 }),
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(100_000) }] }],
      tools: [],
    } as unknown as LLMRequest
    const compacted = await Effect.runPromise(
      harness.compaction.compactIfNeeded({
        sessionID,
        entries: [entry(compactionMessage("existing", VALID_SUMMARY, "")), current],
        model: request.model,
        request,
      }),
    )

    expect(compacted).toBe(false)
    // The refusal itself is now durable: a gate-triggered attempt that finds nothing behind
    // the unanswered turn records why it declined instead of leaving no trace.
    expect(harness.published.map((item) => item.type)).toEqual(["session.next.compaction.failed"])
    expect(harness.published[0]!.data).toMatchObject({ mode: "auto", reason: "emptyConversation" })
  })

  test("a single enormous message compacts instead of failing forever", async () => {
    // Assistant text carries no per-tool budget and no schema bound, so one enormous response is
    // the case that used to leave a session permanently uncompactable with nothing logged.
    const huge = [
      entry(user("u1", "explain everything")),
      entry(assistant("a1", [{ type: "text", id: "txt_huge", text: "x".repeat(4_000_000) }])),
    ]
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    const outcome = await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: huge, model: model({ context: 200_000 }) }),
    )

    expect(outcome).toEqual({ ok: true })
    // The prompt was made to fit rather than rejected.
    expect(harness.requests[0]!.messages[0]!.content).toBeDefined()
  })

  test("the pre-flight gate stays quiet and declines when automatic compaction is off", async () => {
    const harness = engine({ events: [delta("s")], config: configWith({ auto: false }) })
    const request = { model: model({ context: 200_000 }), messages: [], tools: [] } as unknown as LLMRequest
    const compacted = await Effect.runPromise(
      harness.compaction.compactIfNeeded({
        sessionID,
        entries: history(),
        model: model({ context: 200_000 }),
        request,
      }),
    )

    expect(compacted).toBe(false)
    expect(harness.published).toEqual([])
  })

  test("the pre-flight gate declines while the conversation is still under budget", async () => {
    const harness = engine({ events: [delta("s")] })
    const request = { model: model({ context: 200_000 }), messages: [], tools: [] } as unknown as LLMRequest
    const compacted = await Effect.runPromise(
      harness.compaction.compactIfNeeded({
        sessionID,
        entries: history(),
        model: model({ context: 200_000 }),
        request,
      }),
    )

    expect(compacted).toBe(false)
    expect(harness.published).toEqual([])
  })
})

//
// -- Subagent reports through the whole pipeline ----------------------------------------------
//

describe("a subagent report survives prune and compaction", () => {
  const FINDINGS = "FINDINGS-locking-order-inverted-in-run-coordinator"

  /**
   * A real `wait_agents` result stranded far enough back that prune would otherwise clear it.
   * The bash outputs are deliberately distinct: identical filler would make the older one a
   * dedup target and this suite asserts *prune* semantics, not dedup's.
   */
  const withReport = (report: string) => [
    entry(user("u1", "review the coordinator")),
    entry(assistant("a1", [waitAgents({ id: "call_wait", report })])),
    entry(user("u2", "and the second wave")),
    entry(assistant("a2", [tool({ id: "call_bash", name: "bash", output: "s".repeat(200_000) })])),
    entry(user("u3", "keep going")),
    entry(assistant("a3", [tool({ id: "call_bash2", name: "bash", output: "t".repeat(200_000) })])),
    entry(user("u4", "now write it up")),
  ]

  test("prune leaves the report alone while still reclaiming ordinary tool output", async () => {
    // Before: `wait_agents` was absent from PRUNE_PROTECTED_TOOLS, so a 200k report became a
    // 33-char sentinel on the very next turn.
    const report = `${FINDINGS}${"r".repeat(200_000)}`
    const harness = engine({ events: [delta("s")], config: configWith({ prune: true }) })
    const pruned = await Effect.runPromise(harness.compaction.prune(sessionID, withReport(report)))

    expect(toolOutputOf(pruned, "a1", "call_wait")).toContain(FINDINGS)
    // Prune is still doing its job on everything reproducible.
    expect(toolOutputOf(pruned, "a2", "call_bash")).toBe(SessionCompaction.PRUNED_TEXT)
  })

  test("the summarizer is shown the report, not an empty tool result", async () => {
    // Before: `serializeMessage` read only `state.content`, which `wait_agents` never fills, so
    // the summarization prompt carried `[Tool result]: ` and nothing else.
    const report = `${FINDINGS}${"r".repeat(9_000)}`
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    const outcome = await Effect.runPromise(
      harness.compaction.compact({
        sessionID,
        entries: withReport(report),
        model: model({ context: 200_000 }),
      }),
    )

    expect(outcome).toEqual({ ok: true })
    expect(JSON.stringify(harness.requests[0]!.messages)).toContain(FINDINGS)
  })

  test("prune and the summarizer together still deliver the findings", async () => {
    // The compound failure: prune cleared the report and the runner then handed the pruned
    // entries to the summarizer, so the summary was built from the sentinel and the findings
    // could not re-enter context by any path -- not as raw output, not as a summary bullet.
    const report = `${FINDINGS}${"r".repeat(200_000)}`
    const harness = engine({ events: [delta(VALID_SUMMARY)], config: configWith({ prune: true }) })
    const pruned = await Effect.runPromise(harness.compaction.prune(sessionID, withReport(report)))
    await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: pruned, model: model({ context: 200_000 }) }),
    )

    const prompt = JSON.stringify(harness.requests[0]!.messages)
    expect(prompt).toContain(FINDINGS)
    expect(prompt).not.toContain(
      `wait_agents({"task_ids":["tsk_1"]})\\n[Tool result]: ${SessionCompaction.PRUNED_TEXT}`,
    )
  })
})

//
// -- Anchored fact ledger --------------------------------------------------------------------
//

describe("appendLedger", () => {
  test("appends new facts without rewriting, reordering, or merging existing lines", () => {
    const first = SessionCompaction.appendLedger([], ["- /a/one.ts owns the port", "- the user forbade rewrites"])
    const second = SessionCompaction.appendLedger(first, ["- /b/two.ts owns the retry"])
    const third = SessionCompaction.appendLedger(second, ["- ENOENT: no such file or directory, open '/c/three'"])

    // The whole mechanism: every earlier line is byte-identical three generations later, and the
    // order it entered in is the order it is still in. A summary cannot make that promise.
    expect(third).toEqual([
      "- /a/one.ts owns the port",
      "- the user forbade rewrites",
      "- /b/two.ts owns the retry",
      "- ENOENT: no such file or directory, open '/c/three'",
    ])
    expect(third.slice(0, first.length)).toEqual([...first])
    // Inputs are never mutated in place, so a caller holding an older ledger still holds it.
    expect(first).toEqual(["- /a/one.ts owns the port", "- the user forbade rewrites"])
  })

  test("drops a fact identical to one already carried instead of spending the bound twice", () => {
    const previous = ["- /a/one.ts owns the port", "- the user forbade rewrites"]
    // A path or an instruction restated in a later segment is the same fact. Re-appending it
    // would push a genuinely older fact out of the bound to make room for a duplicate.
    const result = SessionCompaction.appendLedger(previous, [
      "- the user forbade rewrites",
      "- /d/four.ts is new",
      "- /d/four.ts is new",
    ])
    expect(result).toEqual(["- /a/one.ts owns the port", "- the user forbade rewrites", "- /d/four.ts is new"])
  })

  test("evicts the oldest lines at the bound rather than compressing what it keeps", () => {
    const line = (index: number) => `- fact ${String(index).padStart(4, "0")}: ${"x".repeat(90)}`
    const bound = 1_000
    let ledger: readonly string[] = []
    for (let index = 0; index < 200; index++) ledger = SessionCompaction.appendLedger(ledger, [line(index)], bound)

    expect(ledger.join("\n").length).toBeLessThanOrEqual(bound)
    // FIFO: the newest facts survive whole, the oldest are gone entirely. Nothing in between --
    // a partially rewritten fact is a fact that is no longer true.
    expect(ledger.at(-1)).toBe(line(199))
    expect(ledger.every((entry) => entry.length === line(0).length)).toBe(true)
    expect(ledger).not.toContain(line(0))

    // The production bound holds hundreds of real-sized facts before evicting anything.
    const wide = Array.from({ length: 400 }, (_, index) => line(index))
    expect(SessionCompaction.appendLedger([], wide, SessionCompaction.LEDGER_MAX_CHARS).length).toBeGreaterThan(200)
  })

  test("accounts for separators when one append evicts several old lines", () => {
    const previous = ["- old one", "- old two", "- keep one"]
    const added = ["- keep two"]
    const retained = ["- keep one", "- keep two"]
    const bound = retained.join("\n").length

    expect(SessionCompaction.appendLedger(previous, added, bound)).toEqual(retained)
    expect(previous).toEqual(["- old one", "- old two", "- keep one"])
  })

  test("preserves the assembled ledger when the bound is NaN", () => {
    const previous = ["- existing fact"]

    expect(SessionCompaction.appendLedger(previous, ["- added fact"], Number.NaN)).toEqual([
      "- existing fact",
      "- added fact",
    ])
    expect(previous).toEqual(["- existing fact"])
  })
})

describe("parseLedgerLines", () => {
  test("keeps bullets and discards everything the extractor was not asked for", () => {
    expect(
      SessionCompaction.parseLedgerLines(
        [
          "Here are the facts:",
          "- /a/one.ts owns the port",
          "",
          "  - the user forbade rewrites  ",
          "- no",
          "## Objective",
          `- ${"x".repeat(2_000)}`,
        ].join("\n"),
      ),
    ).toEqual(["- /a/one.ts owns the port", "- the user forbade rewrites"])
  })

  test("bounds one segment's contribution so a single extraction cannot flood the ledger", () => {
    const flood = Array.from({ length: 500 }, (_, index) => `- fact number ${index}`).join("\n")
    expect(SessionCompaction.parseLedgerLines(flood)).toHaveLength(60)
  })
})

describe("the ledger on the durable checkpoint", () => {
  const ledgerFacts = (...facts: readonly string[]) => [delta(facts.map((fact) => `- ${fact}`).join("\n"))]
  const endedLedger = (harness: ReturnType<typeof engine>) =>
    harness.published.filter((item) => item.type === "session.next.compaction.ended").at(-1)?.data["ledger"]

  test("accumulates across generations instead of being rewritten each time", async () => {
    const harness = engine({
      events: [],
      queue: [
        [delta(VALID_SUMMARY)],
        ledgerFacts("/a/one.ts owns the port"),
        [delta(VALID_SUMMARY)],
        ledgerFacts("/b/two.ts owns the retry"),
        [delta(VALID_SUMMARY)],
        ledgerFacts("/c/three.ts owns the gate"),
      ],
    })
    let ledger: readonly string[] = []
    for (let generation = 1; generation <= 3; generation++) {
      // The runner hands compaction the newest checkpoint followed by the segment after it, which
      // is what makes generation N+1's carried ledger generation N's published one.
      const entries = [
        ...(generation === 1 ? [] : [entry(compactionMessage(`cp${generation}`, VALID_SUMMARY, "", ledger))]),
        ...history(),
      ]
      const outcome = await Effect.runPromise(
        harness.compaction.compact({ sessionID, entries, model: model({ context: 200_000 }) }),
      )
      expect(outcome).toEqual({ ok: true })
      ledger = endedLedger(harness) as readonly string[]
    }

    expect(ledger).toEqual(["- /a/one.ts owns the port", "- /b/two.ts owns the retry", "- /c/three.ts owns the gate"])
    // Generation one's fact was never re-sent to a model after the compaction that produced it.
    const summarizationPrompts = harness.requests
      .filter((request) => JSON.stringify(request.messages).includes("anchored summary"))
      .map((request) => JSON.stringify(request.messages))
    expect(summarizationPrompts).toHaveLength(3)
    expect(summarizationPrompts.some((prompt) => prompt.includes("/a/one.ts owns the port"))).toBe(false)
  })

  test("extracts from the newest segment only, never from the carried ledger", async () => {
    const harness = engine({ events: [], queue: [[delta(VALID_SUMMARY)], ledgerFacts("newest segment fact")] })
    await Effect.runPromise(
      harness.compaction.compact({
        sessionID,
        entries: [entry(compactionMessage("cp", VALID_SUMMARY, "", ["- carried fact"])), ...history()],
        model: model({ context: 200_000 }),
      }),
    )

    const extraction = harness.requests.find((request) =>
      JSON.stringify(request.messages).includes("Extract every durable, checkable fact"),
    )
    expect(extraction).toBeDefined()
    const prompt = JSON.stringify(extraction!.messages)
    expect(prompt).toContain("do the thing")
    expect(prompt).not.toContain("carried fact")
    expect(endedLedger(harness)).toEqual(["- carried fact", "- newest segment fact"])
  })

  test("a checkpoint with no ledger carries none forward and still compacts", async () => {
    // The adoption case: every checkpoint written before the ledger landed decodes with the field
    // absent, and reading it must be an empty carry rather than a crash or a lost compaction.
    const legacy = compactionMessage("legacy", VALID_SUMMARY, "prior recent")
    expect(legacy.ledger).toBeUndefined()
    const decoded = Schema.decodeUnknownSync(SessionMessage.Message)({
      id: "msg_legacy_row",
      type: "compaction",
      reason: "auto",
      summary: VALID_SUMMARY,
      recent: "prior recent",
      time: { created: 0 },
    })
    expect(decoded.type === "compaction" && decoded.ledger).toBeUndefined()

    const harness = engine({ events: [], queue: [[delta(VALID_SUMMARY)], ledgerFacts("first fact after adoption")] })
    expect(
      await Effect.runPromise(
        harness.compaction.compact({
          sessionID,
          entries: [entry(legacy), ...history()],
          model: model({ context: 200_000 }),
        }),
      ),
    ).toEqual({ ok: true })
    expect(endedLedger(harness)).toEqual(["- first fact after adoption"])
  })

  test("a failed extraction leaves the checkpoint intact and the carried ledger untouched", async () => {
    // The ledger is an enrichment of a checkpoint that is already correct. Losing it must never
    // cost the summary, and must never silently drop the facts earlier segments contributed.
    const harness = engine({
      events: [],
      queue: [[delta(VALID_SUMMARY)], [delta("I could not find any facts.")]],
    })
    expect(
      await Effect.runPromise(
        harness.compaction.compact({
          sessionID,
          entries: [entry(compactionMessage("cp", VALID_SUMMARY, "", ["- carried fact"])), ...history()],
          model: model({ context: 200_000 }),
        }),
      ),
    ).toEqual({ ok: true })
    expect(endedLedger(harness)).toEqual(["- carried fact"])
  })

  test("a compaction that never commits spends nothing on extraction", async () => {
    const harness = engine({ events: [delta("I ignored the required structure")] })
    expect(
      await Effect.runPromise(
        harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
      ),
    ).toEqual({ ok: false, reason: "invalidSummary" })
    expect(harness.requests).toHaveLength(1)
  })

  test("extracts facts while the valid summary is still streaming", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const summaryRelease = yield* Deferred.make<void>()
        const extractionStarted = yield* Deferred.make<void>()
        const compaction = SessionCompaction.make({
          events: { publish: (() => Effect.void) as never } as never,
          llm: {
            stream: (request) => {
              const extraction = JSON.stringify(request.messages).includes("Extract every durable, checkable fact")
              if (extraction)
                return Stream.concat(
                  Stream.fromEffect(
                    Deferred.succeed(extractionStarted, undefined).pipe(
                      Effect.as(delta("- packages/core/src/session/compaction.ts owns compaction orchestration")),
                    ),
                  ),
                  Stream.fromArray([LLMEvent.finish({ reason: "stop" })]),
                )
              return Stream.concat(
                Stream.concat(
                  // `validSummary` trims the response and each heading, so the overlap gate must
                  // accept the same harmless leading whitespace rather than strand the child.
                  Stream.fromArray([delta("\n  ## Objective\n")]),
                  Stream.fromEffect(
                    Deferred.await(summaryRelease).pipe(Effect.as(delta(VALID_SUMMARY.slice("## Objective\n".length)))),
                  ),
                ),
                Stream.fromArray([LLMEvent.finish({ reason: "stop" })]),
              )
            },
          },
          config: Effect.succeed([]),
        })
        const running = yield* compaction
          .compact({ sessionID, entries: history(), model: model({ context: 200_000 }) })
          .pipe(Effect.forkChild({ startImmediately: true }))

        // The summary is blocked after its valid first heading. Sequential extraction never
        // reaches this latch; the optimized path starts it while the summary is still open.
        yield* Deferred.await(extractionStarted).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(summaryRelease, undefined)
        expect(yield* Fiber.join(running)).toEqual({ ok: true })
      }),
    )
  })

  test("cancels in-flight extraction when a promising summary is later truncated", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const extractionStarted = yield* Deferred.make<void>()
        const extractionInterrupted = yield* Deferred.make<void>()
        const compaction = SessionCompaction.make({
          events: { publish: (() => Effect.void) as never } as never,
          llm: {
            stream: (request) => {
              const extraction = JSON.stringify(request.messages).includes("Extract every durable, checkable fact")
              if (extraction)
                return Stream.fromEffect(
                  Deferred.succeed(extractionStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(extractionInterrupted, undefined)),
                  ),
                )
              return Stream.concat(
                Stream.fromArray([delta("## Objective\n- partial")]),
                Stream.fromEffect(
                  Deferred.await(extractionStarted).pipe(Effect.as(LLMEvent.finish({ reason: "length" }))),
                ),
              )
            },
          },
          config: Effect.succeed([]),
        })

        const outcome = yield* compaction
          .compact({ sessionID, entries: history(), model: model({ context: 200_000 }) })
          .pipe(Effect.timeout("1 second"))
        expect(outcome).toEqual({ ok: false, reason: "invalidSummary" })
        yield* Deferred.await(extractionInterrupted).pipe(Effect.timeout("1 second"))
      }),
    )
  })

  test("publishes a failed checkpoint when interrupted after the summary finishes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const extractionStarted = yield* Deferred.make<void>()
        const published: Published[] = []
        const compaction = SessionCompaction.make({
          events: {
            publish: ((definition: { type: string }, data: Record<string, unknown>) =>
              Effect.sync(() => {
                published.push({ type: definition.type, data })
                return data
              })) as never,
          } as never,
          llm: {
            stream: (request) =>
              JSON.stringify(request.messages).includes("Extract every durable, checkable fact")
                ? Stream.fromEffect(Deferred.succeed(extractionStarted, undefined).pipe(Effect.andThen(Effect.never)))
                : Stream.fromArray([delta(VALID_SUMMARY), LLMEvent.finish({ reason: "stop" })]),
          },
          config: Effect.succeed([]),
        })
        const running = yield* compaction
          .compact({ sessionID, entries: history(), model: model({ context: 200_000 }) })
          .pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(extractionStarted).pipe(Effect.timeout("1 second"))
        yield* Fiber.interrupt(running)
        expect(published.map((event) => event.type)).toEqual([
          "session.next.compaction.started",
          "session.next.compaction.delta",
          "session.next.compaction.failed",
        ])
        expect(published.at(-1)?.data).toMatchObject({ mode: "manual", reason: "interrupted" })
      }),
    )
  })

  test("compaction.ledger: false keeps the checkpoint ledger-less and makes no second call", async () => {
    const harness = engine({ events: [delta(VALID_SUMMARY)], config: configWith({ ledger: false }) })
    expect(
      await Effect.runPromise(
        harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
      ),
    ).toEqual({ ok: true })
    expect(harness.requests).toHaveLength(1)
    expect(endedLedger(harness)).toBeUndefined()
  })
})

describe("compaction agent", () => {
  test("uses the compaction agent's system prompt and model override", async () => {
    const override = model({ context: 500_000 }, "compaction-model")
    const harness = engine({
      events: [delta(VALID_SUMMARY)],
      summarizer: { model: override, system: "PROMPT_COMPACTION" },
    })
    await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
    )

    const request = harness.requests[0]!
    expect(String(request.model.id)).toBe("compaction-model")
    expect(request.system.map((part) => part.text)).toEqual(["PROMPT_COMPACTION"])
  })

  test("degrades to the session model and no system prompt when no summarizer is wired", async () => {
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    await Effect.runPromise(
      harness.compaction.compact({ sessionID, entries: history(), model: model({ context: 200_000 }) }),
    )

    const request = harness.requests[0]!
    expect(String(request.model.id)).toBe("model")
    expect(request.system).toEqual([])
  })

  test("fits the complete prompt to a smaller compaction model", async () => {
    const override = model({ context: 8_000, input: 4_000, output: 512 }, "small-compaction-model")
    const harness = engine({
      events: [delta(VALID_SUMMARY)],
      summarizer: { model: override, system: "COMPACTION-SYSTEM".repeat(100) },
    })
    const oversized = [
      entry(user("small_model_u", "summarize")),
      entry(
        assistant("small_model_a", [{ type: "text", id: "small_model_text", text: `HEAD${"x".repeat(100_000)}TAIL` }]),
      ),
    ]

    expect(
      await Effect.runPromise(
        harness.compaction.compact({ sessionID, entries: oversized, model: model({ context: 200_000 }) }),
      ),
    ).toEqual({ ok: true })
    const request = harness.requests[0]!
    const promptCharacters =
      request.system.reduce((total, part) => total + part.text.length, 0) + JSON.stringify(request.messages).length
    expect(promptCharacters / 4).toBeLessThanOrEqual(4_000)
    expect(request.generation?.maxTokens).toBe(512)
  })
})

describe("prune wiring", () => {
  const engineWith = (compaction: Record<string, unknown>) =>
    SessionCompaction.make({
      events: { publish: () => Effect.succeed(undefined) } as never,
      llm: { stream: () => Stream.empty },
      config: Effect.succeed(configWith(compaction)),
    })

  // 25k tokens each: the newest fits inside PRUNE_PROTECT, the two older ones exceed it and
  // together clear PRUNE_MINIMUM. Distinct fillers on purpose: identical ones would hand the
  // older calls to dedup, and this suite asserts prune's own wiring.
  const large = "s".repeat(100_000)
  const prunable = () => [
    entry(user("u1", "first")),
    entry(assistant("a1", [tool({ id: "call_1", name: "bash", output: large })])),
    entry(user("u2", "second")),
    entry(assistant("a2", [tool({ id: "call_2", name: "bash", output: "t".repeat(100_000) })])),
    entry(user("u3", "third")),
    entry(assistant("a3", [tool({ id: "call_3", name: "bash", output: "u".repeat(100_000) })])),
    entry(user("u4", "fourth")),
    entry(assistant("a4", [tool({ id: "call_4", name: "bash", output: "recent" })])),
    entry(user("u5", "fifth")),
  ]

  test("prunes by default and honours an explicit prune: false", async () => {
    const off = await Effect.runPromise(engineWith({ prune: false }).prune(sessionID, prunable()))
    expect(toolOutputOf(off, "a1", "call_1")).toBe(large)

    const on = await Effect.runPromise(engineWith({}).prune(sessionID, prunable()))
    expect(toolOutputOf(on, "a1", "call_1")).toBe(SessionCompaction.PRUNED_TEXT)
  })

  test("preserves any extra fields the runner carries on each entry", async () => {
    const entries = prunable()
    const result = await Effect.runPromise(engineWith({ prune: true }).prune(sessionID, entries))

    expect(result.map((item) => item.seq)).toEqual(entries.map((item) => item.seq))
  })
})

//
// -- The threshold compaction actually decides on ---------------------------------------------
//

/**
 * These assert the number the *decision* uses, not the number the context panel
 * shows. The two are supposed to be the same value, and that being true is the
 * claim under test -- a correct figure in the panel and a stale one in the gate
 * is the failure mode this suite exists to catch.
 *
 * Every limit below is transcribed from the real catalog
 * (`https://models.dev/api.json`), not composed to fit the assertion.
 */
describe("the pre-flight gate budgets against the model's real window", () => {
  /** A request whose JSON estimates to roughly `tokens`. */
  const requestOf = (tokens: number, limits: { context?: number; input?: number; output?: number }) =>
    ({
      model: model(limits),
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(tokens * 4) }] }],
      tools: [],
    }) as unknown as LLMRequest

  const gate = (tokens: number, limits: { context?: number; input?: number; output?: number }) => {
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    return Effect.runPromise(
      harness.compaction.compactIfNeeded({
        sessionID,
        entries: [...history(), entry(user("pending", "answer this current instruction"))],
        model: model(limits),
        request: requestOf(tokens, limits),
      }),
    )
  }

  // claude-opus-5: { context: 1000000, output: 128000 }. Forge used to publish
  // 200k for the `opus` CLI alias, so a 400k-token conversation -- comfortably
  // inside the real window -- was compacted away every turn.
  const OPUS_5 = { context: 1_000_000, output: 128_000 }

  test("a conversation inside Opus 5's 1M window is left alone", async () => {
    expect(await gate(400_000, OPUS_5)).toBe(false)
  })

  test("the same conversation would have been compacted against the old 200k figure", async () => {
    // Pins the regression itself: this is the number the gate used to see.
    expect(await gate(400_000, { context: 200_000, output: 64_000 })).toBe(true)
  })

  test("a conversation genuinely over Opus 5's window still compacts", async () => {
    // The reserve is capped at 32k rather than Opus's 128k output limit, so the prompt budget
    // is 968k. 900k used to compact here; it now correctly does not (see the reserve-cap test).
    expect(await gate(990_000, OPUS_5)).toBe(true)
  })

  // gpt-5.6-sol: { context: 1050000, input: 922000, output: 128000 }.
  //
  // With the reserve capped at 32k the naive budget would be 1018k; the published 922k input
  // cap is now the binding constraint and must be honoured on its own.
  const GPT_5_6_SOL = { context: 1_050_000, input: 922_000, output: 128_000 }

  test("gpt-5.6's input cap binds on its own now that the reserve is capped", async () => {
    expect(await gate(950_000, GPT_5_6_SOL)).toBe(true)
    // Without the input cap the same prompt fits the capped-reserve budget of 1018k.
    expect(await gate(950_000, { context: 1_050_000, output: 128_000 })).toBe(false)
    expect(await gate(700_000, GPT_5_6_SOL)).toBe(false)
  })

  // github-copilot/gpt-5-mini: { context: 264000, input: 128000, output: 64000 }.
  // Here the cap genuinely binds -- context minus output is 200000, but the
  // model accepts only 128000 of prompt. Ten models in the live catalog are
  // like this, and for every one of them V2 used to overshoot.
  const COPILOT_GPT_5_MINI = { context: 264_000, input: 128_000, output: 64_000 }

  test("a prompt over a binding input cap compacts even though it fits context minus output", async () => {
    // 160k fits 264000-64000=200000 but exceeds the 128000 the model accepts.
    expect(await gate(160_000, COPILOT_GPT_5_MINI)).toBe(true)
    // Dropping the cap -- exactly what V2 used to compute -- calls it fine, and
    // the request would then be refused by the provider.
    expect(await gate(160_000, { context: 264_000, output: 64_000 })).toBe(false)
  })

  test("a prompt under a binding input cap is left alone", async () => {
    expect(await gate(100_000, COPILOT_GPT_5_MINI)).toBe(false)
  })

  // k3: { context: 1048576, output: 131072 }. No input cap, and none invented.
  test("a model with no published input cap budgets against context alone", async () => {
    expect(await gate(700_000, { context: 1_048_576, output: 131_072 })).toBe(false)
    expect(await gate(1_030_000, { context: 1_048_576, output: 131_072 })).toBe(true)
  })

  test("uses the effective configured generation limit instead of the catalog maximum", async () => {
    const configured = Model.make({
      id: "configured-output",
      provider: "provider",
      route: OpenAIChat.route.with({
        limits: { context: 1_000_000, output: 128_000 },
        generation: { maxTokens: 4_000 },
      }),
    })
    const request = {
      model: configured,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(900_000 * 4) }] }],
      tools: [],
    } as unknown as LLMRequest
    const harness = engine({ events: [delta(VALID_SUMMARY)] })

    expect(
      await Effect.runPromise(
        harness.compaction.compactIfNeeded({
          sessionID,
          entries: [...history(), entry(user("configured_pending", "current"))],
          model: configured,
          request,
        }),
      ),
    ).toBe(false)
  })

  /** A completed turn exactly as the projector stores it: provider-reported usage attached. */
  const measuredTurn = (
    id: string,
    tokens: { input: number; read?: number; write?: number; output?: number; reasoning?: number },
    atMillis = 1,
  ) =>
    entry(
      SessionMessage.Assistant.make({
        id: messageID(id),
        type: "assistant",
        agent: "build",
        model: modelRef,
        content: [{ type: "text", id: `txt_${id}`, text: "measured reply" }],
        tokens: {
          input: tokens.input,
          output: tokens.output ?? 0,
          reasoning: tokens.reasoning ?? 0,
          cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
        },
        time: { created: DateTime.makeUnsafe(atMillis) },
      }),
    )

  const gateWith = (entries: readonly Entry[], request: LLMRequest) => {
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    return Effect.runPromise(harness.compaction.compactIfNeeded({ sessionID, entries, model: request.model, request }))
  }

  /** One-user-message request, by default against a 200k/10k model. */
  const requestCarrying = (
    content: ReadonlyArray<Record<string, unknown>>,
    limits: { context: number; input?: number; output: number } = { context: 200_000, output: 10_000 },
  ) =>
    ({
      model: model(limits),
      system: [],
      messages: [{ role: "user", content }],
      tools: [],
    }) as unknown as LLMRequest

  test("one attached image no longer counts as its base64 length", async () => {
    // A resized screenshot is ~135k base64 chars. The old estimator read a single one as ~34k
    // tokens — and a larger original as hundreds of thousands — so a session holding one image
    // compacted on every turn. The provider prices the image at ~1.6k tokens.
    const request = requestCarrying([
      { type: "text", text: "inspect this screenshot" },
      { type: "media", mediaType: "image/png", data: `data:image/png;base64,${"A".repeat(800_000)}` },
    ])

    // 800k chars read as raw text is 200k estimated tokens, over any budget this model has.
    expect(await gateWith([...history(), entry(user("image_pending", "look"))], request)).toBe(false)
  })

  test("provider-reported occupancy triggers compaction when the character estimate looks small", async () => {
    // The gate must budget with the same number the context panel shows: the newest completed
    // turn's provider-reported window total, not a re-estimate of the request JSON.
    const request = requestCarrying([{ type: "text", text: "tiny" }])
    const entries = [
      entry(user("occupied_u1", "start")),
      measuredTurn("occupied_a1", { input: 150_000, read: 40_000, output: 5_000 }),
      entry(user("occupied_pending", "current instruction")),
    ]

    expect(await gateWith(entries, request)).toBe(true)
  })

  test("provider-reported occupancy prevents premature compaction when the estimate is inflated", async () => {
    // Dense JSON histories over-estimate badly; the provider already counted them exactly.
    const request = requestCarrying([{ type: "text", text: "x".repeat(800_000) }])
    const entries = [
      entry(user("cheap_u1", "start")),
      measuredTurn("cheap_a1", { input: 25_000, read: 4_000, output: 1_000 }),
      entry(user("cheap_pending", "current instruction")),
    ]

    expect(await gateWith(entries, request)).toBe(false)
  })

  test("a baseline measured before the newest checkpoint is not trusted", async () => {
    // A preserved-tail turn measured its occupancy against the pre-compaction window. Trusting
    // it would report the freed context as still occupied and re-compact immediately.
    const request = requestCarrying([{ type: "text", text: "tiny" }])
    const checkpoint = entry(
      SessionMessage.Compaction.make({
        id: messageID("stale_checkpoint"),
        type: "compaction",
        reason: "auto",
        summary: VALID_SUMMARY,
        recent: "",
        time: { created: DateTime.makeUnsafe(5) },
      }),
    )
    const entries = [
      checkpoint,
      measuredTurn("stale_a1", { input: 150_000, read: 40_000, output: 5_000 }, 1),
      entry(user("stale_pending", "current instruction")),
    ]

    expect(await gateWith(entries, request)).toBe(false)
  })

  test("a large output limit no longer reserves a third of the window", async () => {
    // The reserve used to be the full output limit: a 200k/128k model budgeted only 72k of
    // prompt and compacted at ~68% occupancy for turns that emit a few thousand tokens. The
    // reserve is capped at 32k; `clampOutput` shrinks the wire allowance inside that band.
    const limits = { context: 200_000, output: 128_000 }
    const halfway = [
      entry(user("cap_u1", "start")),
      measuredTurn("cap_a1", { input: 95_000, output: 5_000 }),
      entry(user("cap_pending", "current instruction")),
    ]
    expect(await gateWith(halfway, requestCarrying([{ type: "text", text: "tiny" }], limits))).toBe(false)

    const nearWindow = [
      entry(user("cap_u2", "start")),
      measuredTurn("cap_a2", { input: 165_000, output: 5_000 }),
      entry(user("cap_pending_2", "current instruction")),
    ]
    expect(await gateWith(nearWindow, requestCarrying([{ type: "text", text: "tiny" }], limits))).toBe(true)
  })

  test("tool results settled on the baseline turn count toward occupancy", async () => {
    // The baseline's usage was measured before its tool results existed, and the delta slice
    // starts after the baseline — so a large result settled on that very turn was invisible.
    const baseline = entry(
      SessionMessage.Assistant.make({
        id: messageID("settled_a1"),
        type: "assistant",
        agent: "build",
        model: modelRef,
        content: [tool({ id: "call_settled", name: "bash", output: "s".repeat(200_000) })],
        tokens: { input: 130_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1) },
      }),
    )
    const entries = [entry(user("settled_u1", "start")), baseline, entry(user("settled_pending", "current"))]

    // 132k reported plus a 50k-token tool result exceeds the 180k budget; without counting the
    // result the gate would sit at 132k and wave the request through into an overflow.
    expect(await gateWith(entries, requestCarrying([{ type: "text", text: "tiny" }]))).toBe(true)
  })

  test("shell surface output counts at wire size, not the summarization elision", async () => {
    // Shell messages never produce a provider-measured turn, so the baseline never advances
    // past them — and `serializeMessage` bounds their output to ~2k chars while the wire ships
    // up to 1MB. Repeated terminal sqlite dumps accumulated gate-invisible megabytes until a
    // 1.05M-window gpt-5.6-luna session overflowed at ~79k reported tokens.
    const shellDump = (id: string, bytes: number) =>
      entry(
        SessionMessage.Shell.make({
          id: messageID(id),
          type: "shell",
          callID: `call_${id}`,
          command: "sqlite3 forge-dev.db 'select * from event'",
          output: "x".repeat(bytes),
          time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
        }),
      )
    const base = [
      entry(user("shell_u1", "start")),
      measuredTurn("shell_a1", { input: 28_000, read: 50_000, output: 200 }),
    ]
    const request = requestCarrying([{ type: "text", text: "tiny" }])

    // The unanswered prompt always trails the shell traffic in a real session, and recovery
    // needs history behind the current turn to summarize.
    const pending = entry(user("shell_pending", "current instruction"))

    // ~79k measured + three 300KB dumps (~225k wire tokens) is far over the 180k budget.
    const heavy = [...base, shellDump("dump1", 300_000), shellDump("dump2", 300_000), shellDump("dump3", 300_000)]
    expect(await gateWith([...heavy, pending], request)).toBe(true)

    // Small shell traffic stays under budget: the fix prices real bytes, it does not panic.
    expect(await gateWith([...base, shellDump("small", 2_000), pending], request)).toBe(false)
  })

  test("an unmeasured delta turn's tool result counts whole, not at its summarization budget", async () => {
    // A failed or foreign-model turn after the baseline carries no usage, so its tool results
    // land in the estimated delta — where the summarization view caps them at 2k chars while
    // the wire replays them in full.
    const entries = [
      entry(user("delta_u1", "start")),
      measuredTurn("delta_a1", { input: 100_000, read: 0, output: 1_000 }),
      entry(assistant("delta_a2", [tool({ id: "call_delta", name: "bash", output: "s".repeat(400_000) })])),
      entry(user("delta_pending", "current instruction")),
    ]

    // 101k measured + ~100k of tool output exceeds the 180k budget; the old delta priced the
    // result at ~500 tokens and waved the request through into a provider overflow.
    expect(await gateWith(entries, requestCarrying([{ type: "text", text: "tiny" }]))).toBe(true)
  })

  test("the gate measures the pruned view the request was built from, not raw history", async () => {
    // Prune runs before request assembly, so the wire request no longer carries what prune
    // cleared. Measuring the unpruned history re-counted every freed byte and re-triggered
    // compaction the request no longer needed — undoing prune's entire purpose.
    // The stale output sits two whole turns back — outside the turn exemption prune honours —
    // and after the measured baseline, so it lands in the estimated delta on both views.
    const heavy = [
      entry(user("measured_u1", "start")),
      measuredTurn("measured_a1", { input: 20_000, output: 500 }),
      entry(user("measured_u2", "continue")),
      entry(assistant("measured_a2", [tool({ id: "call_stale", name: "bash", output: "s".repeat(700_000) })])),
      entry(user("measured_u3", "next")),
      entry(assistant("measured_a3", [{ type: "text", id: "txt_measured", text: "ok" }])),
      entry(user("measured_pending", "current instruction")),
    ]
    const pruned = SessionCompaction.pruneEntries(heavy, { enabled: true }).entries
    const request = requestCarrying([{ type: "text", text: "tiny" }])

    expect(await gateWith(heavy, request)).toBe(true)
    const harness = engine({ events: [delta(VALID_SUMMARY)] })
    expect(
      await Effect.runPromise(
        harness.compaction.compactIfNeeded({
          sessionID,
          entries: heavy,
          model: request.model,
          request,
          measured: pruned,
        }),
      ),
    ).toBe(false)
  })

  test("a shell dump ahead of the prompt is summarized and cut, not preserved on the wire", async () => {
    // The keep/cut decision now prices real bytes: a 400KB dump can no longer hide inside an
    // 8k keep budget at its 2KB summarization size. It lands in the head — bounded to ~2KB in
    // the summary prompt — and `throughSeq` cuts the raw megabytes out of every later request.
    // This is the direct answer to "won't clear even with a compact": it clears.
    const dump = entry(
      SessionMessage.Shell.make({
        id: messageID("select_shell"),
        type: "shell",
        callID: "call_select_shell",
        command: "sqlite3 forge-dev.db 'select * from event'",
        output: "x".repeat(400_000),
        time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
      }),
    )
    const selected = SessionCompaction.select(
      [entry(user("select_u1", "start")), dump, entry(user("select_pending", "current instruction"))],
      { tokens: 8_000, turns: 2, preserveCurrentTurn: true },
    )

    if (!selected) throw new Error("expected a selection")
    expect(selected.throughSeq).toBe(dump.seq)
    expect(selected.head.length).toBeLessThan(10_000)
    expect(selected.head).toContain("[Shell]")
  })

  test("an in-flight turn larger than the clamp budget is summarized instead of held verbatim", () => {
    // Measured on a real 24/7 corpus: this clamp fired on 156/275 compactions and
    // forced a median 33.5k extra tokens into the tail, so compaction freed almost
    // nothing and marathon sessions compacted repeatedly. A turn past the budget
    // must fall back to the token-aligned split.
    const huge = entry(
      assistant("select_huge_turn", [{ type: "text", id: "txt_huge_turn", text: "y".repeat(400_000) }]),
    )
    const selected = SessionCompaction.select(
      [entry(user("clamp_u_old", "earlier instruction")), huge, entry(user("clamp_u_now", "current instruction"))],
      { tokens: 8_000, turns: 2, preserveCurrentTurn: true },
    )

    if (!selected) throw new Error("expected a selection")
    // The oversized turn is summarized (head), not dragged into the verbatim tail.
    expect(selected.head).toContain("y".repeat(64))
    expect(selected.recent.length).toBeLessThan(50_000)
  })

  test("clampOutput shrinks the wire allowance only inside the reserve band", async () => {
    const limits = { context: 200_000, output: 64_000 }
    const healthy = LLM.request({ model: model(limits), messages: [Message.user("tiny")], tools: [] })
    expect(
      SessionCompaction.clampOutput({
        entries: [entry(user("clamp_u1", "start")), measuredTurn("clamp_a1", { input: 45_000, output: 5_000 })],
        model: healthy.model,
        request: healthy,
      }),
    ).toBe(healthy)

    const crowded = LLM.request({ model: model(limits), messages: [Message.user("tiny")], tools: [] })
    const clamped = SessionCompaction.clampOutput({
      entries: [entry(user("clamp_u2", "start")), measuredTurn("clamp_a2", { input: 145_000, output: 5_000 })],
      model: crowded.model,
      request: crowded,
    })
    // 150k occupied of 200k leaves ~50k: below the 64k allowance, above the 32k the gate
    // guarantees — so the request survives providers that validate prompt + max_tokens.
    expect(clamped).not.toBe(crowded)
    expect(clamped.generation?.maxTokens).toBeGreaterThan(32_000)
    expect(clamped.generation?.maxTokens).toBeLessThan(64_000)
  })
})
