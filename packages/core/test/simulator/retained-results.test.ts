import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import type { LLMRequest } from "@turenlabs/llm"
import { SessionMessage } from "@turenlabs/core/session/message"
import { ToolResultStore } from "@turenlabs/core/tool-result-store"
import { ApplicationTools } from "@turenlabs/core/tool/application-tools"
import { Tool } from "@turenlabs/core/tool/tool"
import { reply, replyWithTool, requestUserTexts, simulate, toolCallEvents, type ScenarioContext } from "./harness"

const matches = (fragment: string) => (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes(fragment))
const parts = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  ctx.services.store.context(sessionID).pipe(
    Effect.orDie,
    Effect.map((messages) =>
      messages.flatMap((message) =>
        message.type === "assistant"
          ? message.content.filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
          : [],
      ),
    ),
  )
const captured = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  parts(ctx, sessionID).pipe(
    Effect.map((tools) => {
      const read = tools.find((tool) => tool.name === "read")
      if (read?.state.status !== "completed") throw new Error("Source capture did not complete")
      const reference = ToolResultStore.referenceOf(read.state.structured)
      if (!reference) throw new Error("Source capture has no reference")
      return reference
    }),
  )

describe("retained results in real Session execution", () => {
  for (const child of [false, true]) {
    simulate(`${child ? "spawned child" : "normal Session"} discovers, reads and computes its capture`, (ctx) =>
      Effect.gen(function* () {
        const applications = yield* ApplicationTools.Service
        const calls: Tool.Context[] = []
        yield* applications.register({
          read: Tool.withPermission(
            Tool.make({
              description: "Return a deterministic large structured read fixture",
              input: Schema.Struct({}),
              output: Schema.Array(Schema.Struct({ value: Schema.Number, note: Schema.String })),
              execute: (_, context) =>
                Effect.sync(() => {
                  calls.push(context)
                  return Array.from({ length: 256 }, (_, value) => ({ value, note: "ordinary data ".repeat(24) }))
                }),
              toModelOutput: () => [{ type: "text", text: "256 captured rows" }],
            }),
            "read",
          ),
        })
        const rootText = "Root retained evidence probe"
        const ownerText = child ? "Child retained evidence probe" : rootText
        const ownerID = Effect.gen(function* () {
          if (!child) return ctx.sessionID
          const tasks = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
          return tasks[0]!.childSessionID
        })
        const reference = Effect.gen(function* () {
          return yield* captured(ctx, yield* ownerID)
        })
        if (child)
          ctx.provider.enqueue(
            replyWithTool(
              "spawn_agent",
              { agent: "explore", description: "Retained evidence child", prompt: ownerText },
              { match: matches(rootText), label: "root-spawn" },
            ),
            {
              match: matches(rootText),
              label: "root-wait",
              events: Effect.gen(function* () {
                const tasks = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
                return toolCallEvents("wait_agents", { task_ids: tasks.map((task) => task.id), timeout_ms: 15000 })
              }),
            },
            {
              match: matches(rootText),
              label: "root-foreign-read",
              events: Effect.gen(function* () {
                return toolCallEvents("result_read", { id: (yield* reference).id, channel: "structured" })
              }),
            },
            reply("Child evidence checked.", { match: matches(rootText), label: "root-final" }),
            reply("Child completion noted.", { match: matches("reached a terminal state"), label: "settle-advisory" }),
          )
        ctx.provider.enqueue(
          replyWithTool("read", {}, { match: matches(ownerText), label: "source-read" }),
          replyWithTool("result_list", {}, { match: matches(ownerText), label: "list-captures" }),
          {
            match: matches(ownerText),
            label: "read-capture",
            events: Effect.gen(function* () {
              return toolCallEvents("result_read", { id: (yield* reference).id, channel: "structured", maxBytes: 1024 })
            }),
          },
          replyWithTool(
            "tool_search",
            { query: "result_compute" },
            { match: matches(ownerText), label: "discover-compute" },
          ),
          replyWithTool(
            "tool_load",
            { tools: ["result_compute"] },
            { match: matches(ownerText), label: "load-compute" },
          ),
          {
            match: matches(ownerText),
            label: "compute-capture",
            events: Effect.gen(function* () {
              return toolCallEvents("result_compute", {
                id: (yield* reference).id,
                code: "return { count: data.length, sum: data.reduce((sum, row) => sum + row.value, 0) }",
              })
            }),
          },
          reply("Retained evidence complete.", { match: matches(ownerText), label: "owner-final" }),
        )
        yield* ctx.user.prompt(rootText)
        yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: child ? 11 : 7 })
        const owner = yield* ownerID
        const tools = yield* parts(ctx, owner)
        const readback = tools.find((tool) => tool.name === "result_read")
        expect(readback?.state.status).toBe("completed")
        if (readback?.state.status !== "completed") throw new Error("Readback did not complete")
        expect(readback.state.structured.content).toContain('"value":0')
        const computation = tools.find((tool) => tool.name === "result_compute")
        expect(computation?.state.status).toBe("completed")
        if (computation?.state.status !== "completed") throw new Error("Computation did not complete")
        expect(computation.state.structured.computation).toMatchObject({ ok: true, value: { count: 256, sum: 32640 } })
        expect(calls.map((call) => call.sessionID)).toEqual([owner])
        const requests = ctx.provider.requests().filter((record) => matches(ownerText)(record.request))
        expect(requests[0].request.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["result_list", "result_read"]),
        )
        expect(
          requests.find((record) => record.label === "compute-capture")!.request.tools.map((tool) => tool.name),
        ).toContain("result_compute")
        if (child) {
          expect((yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID }))[0].status).toBe("completed")
          const foreign = (yield* parts(ctx)).find((tool) => tool.name === "result_read")
          expect(foreign?.state.status).toBe("error")
          expect(JSON.stringify(foreign?.state)).toContain("Retained tool result is unavailable")
        }
      }),
    )
  }
})
