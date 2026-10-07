import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import type { LLMRequest } from "@turenlabs/llm"
import { AgentV2 } from "@turenlabs/core/agent"
import { SessionExecutionControl } from "@turenlabs/core/session/execution-control"
import { SessionMessage } from "@turenlabs/core/session/message"
import { ApplicationTools } from "@turenlabs/core/tool/application-tools"
import { TeamBoardTool } from "@turenlabs/core/tool/team-board"
import { Tool } from "@turenlabs/core/tool/tool"
import { reply, replyWithTool, requestUserTexts, simulate, toolCallEvents, type ScenarioContext } from "./harness"

const specialistName = "fixture_quartz_specialist"
const matchText = (fragment: string) => (request: LLMRequest) =>
  requestUserTexts(request).some((text) => text.includes(fragment))
const toolNames = (request: LLMRequest) => request.tools.map((tool) => tool.name)

const registerTools = (calls: Tool.Context[]) =>
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const boardTools = yield* TeamBoardTool.Service
    const board = yield* boardTools.forExecution({ control: SessionExecutionControl.noop })
    yield* applications.register({
      ...board,
      [specialistName]: Tool.make({
        deferred: true,
        description: "Return the inert fixture quartz specialist report.",
        input: Schema.Struct({}),
        output: Schema.Struct({ report: Schema.String }),
        execute: (_, context) =>
          Effect.sync(() => {
            calls.push(context)
            return { report: "quartz fixture complete" }
          }),
      }),
    })
  })

const toolParts = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  ctx.services.store.context(sessionID).pipe(
    Effect.orDie,
    Effect.map((messages) =>
      messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part): part is SessionMessage.AssistantTool => part.type === "tool"),
    ),
  )

const waitForChildren = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  Effect.gen(function* () {
    const children = yield* ctx.services.tasks.list({ parentSessionID: sessionID })
    return toolCallEvents("wait_agents", { task_ids: children.map((task) => task.id), timeout_ms: 15_000 })
  })

const settleReply = () =>
  reply("Child completion noted.", { match: matchText("reached a terminal state"), label: "settle-advisory" })

const expectBasicTools = (request: LLMRequest) => {
  expect(toolNames(request)).toEqual(
    expect.arrayContaining([
      "question",
      TeamBoardTool.readName,
      TeamBoardTool.postName,
      "wait_agents",
      "notify_parent",
      "room_read",
      "room_post",
      "room_claim",
      "room_wait",
      "tool_search",
      "tool_load",
    ]),
  )
}

const expectSpecialistSuccess = (parts: SessionMessage.AssistantTool[]) => {
  const search = parts.find((part) => part.name === "tool_search")
  expect(search?.state.status).toBe("completed")
  if (search?.state.status !== "completed") throw new Error("Expected completed specialist search")
  expect(search.state.structured.matches).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: specialistName })]),
  )
  const load = parts.find((part) => part.name === "tool_load")
  expect(load?.state.status).toBe("completed")
  if (load?.state.status !== "completed") throw new Error("Expected completed specialist load")
  expect(load.state.structured.selected).toContain(specialistName)
  const call = parts.find((part) => part.name === specialistName)
  expect(call?.state.status).toBe("completed")
  if (call?.state.status !== "completed") throw new Error("Expected completed specialist call")
  expect(call.state.structured).toEqual({ report: "quartz fixture complete" })
}

const specialistBehaviors = (fragment: string) => [
  replyWithTool("tool_search", { query: specialistName }, { match: matchText(fragment), label: `${fragment}-search` }),
  replyWithTool("tool_load", { tools: [specialistName] }, { match: matchText(fragment), label: `${fragment}-load` }),
  replyWithTool(specialistName, {}, { match: matchText(fragment), label: `${fragment}-call` }),
  reply("Specialist probe complete.", { match: matchText(fragment), label: `${fragment}-final` }),
]

describe("real spawned Session tool policy", () => {
  simulate("normal Session discovers, loads, and calls an application specialist", (ctx) =>
    Effect.gen(function* () {
      const calls: Tool.Context[] = []
      yield* registerTools(calls)
      ctx.provider.enqueue(...specialistBehaviors("Normal quartz probe"))
      yield* ctx.user.prompt("Normal quartz probe.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })
      const requests = ctx.provider.requests()
      expect(toolNames(requests[0].request)).not.toContain(specialistName)
      expect(toolNames(requests.find((record) => record.label === "Normal quartz probe-call")!.request)).toContain(
        specialistName,
      )
      expectSpecialistSuccess(yield* toolParts(ctx))
      expect(calls.map((call) => call.sessionID)).toEqual([ctx.sessionID])
    }),
  )

  for (const depth of [1, 2]) {
    simulate(`real depth-${depth} child excludes specialists but keeps basic tools`, (ctx) =>
      Effect.gen(function* () {
        const calls: Tool.Context[] = []
        yield* registerTools(calls)
        const rootText = `Root quartz depth ${depth}`
        const childText = `Restricted quartz depth ${depth}`
        const orchestratorText = "Middle quartz coordinator"
        ctx.provider.enqueue(
          replyWithTool(
            "spawn_agent",
            {
              agent: "explore",
              description: "Quartz policy child",
              prompt: depth === 1 ? childText : orchestratorText,
              ...(depth === 2 ? { orchestrate: true } : {}),
            },
            { match: matchText(rootText), label: "root-spawn" },
          ),
          { match: matchText(rootText), label: "root-wait", events: waitForChildren(ctx) },
          reply("Root probe complete.", { match: matchText(rootText), label: "root-final" }),
          replyWithTool(TeamBoardTool.readName, {}, { match: matchText(childText), label: "child-board-read" }),
          ...specialistBehaviors(childText),
          settleReply(),
          settleReply(),
        )
        if (depth === 2) {
          ctx.provider.enqueue(
            replyWithTool(
              "spawn_agent",
              { agent: "explore", description: "Quartz nested child", prompt: childText },
              { match: matchText(orchestratorText), label: "middle-spawn" },
            ),
            {
              match: matchText(orchestratorText),
              label: "middle-wait",
              events: Effect.gen(function* () {
                const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
                return yield* waitForChildren(ctx, children[0].childSessionID)
              }),
            },
            reply("Middle probe complete.", { match: matchText(orchestratorText), label: "middle-final" }),
          )
        }
        yield* ctx.user.prompt(`${rootText}.`)
        yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: depth === 1 ? 7 : 10 })
        const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
        expect(children).toHaveLength(1)
        expect(children[0].status).toBe("completed")
        const descendants =
          depth === 1 ? children : yield* ctx.services.tasks.list({ parentSessionID: children[0].childSessionID })
        expect(descendants).toHaveLength(1)
        const child = descendants[0]
        expect(child.depth).toBe(depth)
        expect(child.status).toBe("completed")
        yield* ctx.invariants.settled(child.childSessionID, { expect: "idle", minRequests: depth === 1 ? 7 : 10 })
        const requests = ctx.provider.requests().filter((record) => matchText(childText)(record.request))
        expect(requests.length).toBeGreaterThanOrEqual(4)
        for (const record of requests) {
          expectBasicTools(record.request)
          expect(toolNames(record.request)).not.toContain(specialistName)
        }
        const parts = yield* toolParts(ctx, child.childSessionID)
        const boardRead = parts.find((part) => part.name === TeamBoardTool.readName)
        expect(boardRead?.state.status).toBe("completed")
        if (boardRead?.state.status !== "completed") throw new Error("Expected completed child board read")
        expect(boardRead.state.structured.notes).toEqual([])
        const search = parts.find((part) => part.name === "tool_search")
        expect(search?.state.status).toBe("completed")
        if (search?.state.status !== "completed") throw new Error("Expected completed restricted search")
        expect(search.state.structured.matches).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ key: specialistName })]),
        )
        expect(search.state.structured.selected).not.toContain(specialistName)
        const load = parts.find((part) => part.name === "tool_load")
        expect(load?.state.status).toBe("error")
        expect(JSON.stringify(load?.state)).toContain(`Tool is not available: ${specialistName}`)
        const direct = parts.find((part) => part.name === specialistName)
        expect(direct?.state.status).toBe("error")
        expect(JSON.stringify(direct?.state)).toContain(`Unknown tool: ${specialistName}`)
        expect(calls).toEqual([])
      }),
    )
  }

  simulate("real child discovers and calls an explicitly granted application specialist", (ctx) =>
    Effect.gen(function* () {
      const calls: Tool.Context[] = []
      yield* registerTools(calls)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.update(AgentV2.ID.make("explore"), (agent) => {
          agent.permissions = [
            { action: "*", resource: "*", effect: "allow" },
            { action: specialistName, resource: "*", effect: "allow" },
          ]
        })
      })
      ctx.provider.enqueue(
        replyWithTool(
          "spawn_agent",
          { agent: "explore", description: "Granted quartz child", prompt: "Granted quartz probe." },
          { match: matchText("Root granted quartz"), label: "root-spawn" },
        ),
        { match: matchText("Root granted quartz"), label: "root-wait", events: waitForChildren(ctx) },
        reply("Granted child complete.", { match: matchText("Root granted quartz"), label: "root-final" }),
        ...specialistBehaviors("Granted quartz probe"),
        settleReply(),
      )
      yield* ctx.user.prompt("Root granted quartz.")
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 7 })
      const children = yield* ctx.services.tasks.list({ parentSessionID: ctx.sessionID })
      expect(children).toHaveLength(1)
      expect(children[0].status).toBe("completed")
      yield* ctx.invariants.settled(children[0].childSessionID, { expect: "idle", minRequests: 7 })
      expectSpecialistSuccess(yield* toolParts(ctx, children[0].childSessionID))
      const requests = ctx.provider.requests().filter((record) => matchText("Granted quartz probe")(record.request))
      expectBasicTools(requests[0].request)
      expect(toolNames(requests[0].request)).toContain(specialistName)
      expect(toolNames(requests.find((record) => record.label === "Granted quartz probe-call")!.request)).toContain(
        specialistName,
      )
      expect(calls.map((call) => call.sessionID)).toEqual([children[0].childSessionID])
    }),
  )
})
