import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@turenlabs/core/global"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Team } from "@turenlabs/schema/team"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { extractTeamTaskOutput, teamTaskIDForResponse } from "../../src/team/runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"

const it = testEffect(TestLLMServer.layer).live
const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, method = "GET", body?: unknown) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      method,
      headers: { "x-forge-directory": directory, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  )
}

function state(directory: string, roomID?: string) {
  return Effect.promise(() => request(roomID ? `/api/team?roomID=${roomID}` : "/api/team", directory)).pipe(
    Effect.flatMap((response) => Effect.promise(() => response.json())),
    Effect.map(Schema.decodeUnknownSync(Team.State)),
  )
}

function setup(llmURL: string, tools = false) {
  return Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true, config: { model: "team-fixture/chat" } })),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const configFile = path.join(Global.Path.config, "forge.json")
    const original = yield* Effect.promise(() =>
      fs.readFile(configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      }),
    )
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        Bun.write(
          configFile,
          JSON.stringify({
            providers: {
              "team-fixture": {
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llmURL,
                  settings: { apiKey: "fixture-key" },
                },
                models: {
                  chat: {
                    api: {
                      id: "chat",
                      type: "aisdk",
                      package: "@ai-sdk/openai-compatible",
                      url: llmURL,
                      settings: { apiKey: "fixture-key" },
                    },
                    capabilities: { tools, input: ["text"], output: ["text"] },
                    limit: { context: 32_000, output: 2_000 },
                  },
                },
              },
            },
          }),
        ),
      ),
      () =>
        Effect.promise(async () => {
          if (original === undefined) await fs.rm(configFile, { force: true })
          else await Bun.write(configFile, original)
        }),
    )
    return tmp
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("TeamRuntime dispatch", () => {
  it("publishes the final response after user and machine continuation boundaries", () =>
    Effect.sync(() => {
      const assistant = (id: string, text: string, file: string): SessionMessage.Assistant =>
        ({
          id,
          type: "assistant",
          content: [{ id: `text_${id}`, type: "text", text }],
          snapshot: { files: [file] },
          time: { completed: 1 },
        }) as unknown as SessionMessage.Assistant
      const user = { type: "user" } as SessionMessage.Message
      const earlier = assistant("msg_earlier", "Earlier private response", "earlier.txt")
      const intermediate = assistant("msg_intermediate", "Intermediate private response", "intermediate.txt")
      const final = assistant("msg_final", "Actual completed response", "final.txt")
      const messages = [earlier, user, intermediate, user, final]

      const output = extractTeamTaskOutput(messages, final)

      expect(output.text).toBe("Actual completed response")
      expect(output.artifacts).toEqual([{ type: "changed", path: "final.txt" }])
    }))

  it("attributes a Session response to the nearest preceding Team task prompt", () =>
    Effect.sync(() => {
      const user = (id: string) => ({ id, type: "user" }) as unknown as SessionMessage.Message
      const assistant = (id: string) => ({ id, type: "assistant" }) as unknown as SessionMessage.Message
      const messages = [
        user("msg_team_old_task"),
        assistant("msg_old_task_response"),
        user("msg_team_runtime_followup"),
        assistant("msg_followup_response"),
        user("msg_team_new_task"),
        assistant("msg_new_task_response"),
      ]

      const taskIDs = new Set(["old_task", "new_task"])
      expect(teamTaskIDForResponse(messages, "msg_old_task_response", taskIDs)).toBe("old_task")
      expect(teamTaskIDForResponse(messages, "msg_followup_response", taskIDs)).toBe("old_task")
      expect(teamTaskIDForResponse(messages, "msg_new_task_response", taskIDs)).toBe("new_task")
      expect(teamTaskIDForResponse(messages, "msg_missing_response", taskIDs)).toBeUndefined()
    }))

  it("replies to a greeting once and shares that conversation with the next teammate task", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url)
      const created = yield* Effect.promise(() =>
        request("/api/team/room", tmp.path, "POST", { name: "runtime-chat-room" }),
      )
      expect(created.status).toBe(200)
      const room = Schema.decodeUnknownSync(Team.Room)(yield* Effect.promise(() => created.json()))
      for (const handle of ["coordinator", "researcher"]) {
        const response = yield* Effect.promise(() =>
          request("/api/team/teammate", tmp.path, "POST", {
            roomID: room.id,
            name: handle,
            handle,
            role: "Teammate",
            mission: "Reply to team messages.",
            directory: tmp.path,
            model: { id: "chat", providerID: "team-fixture" },
          }),
        )
        expect(response.status).toBe(200)
      }
      yield* llm.text("Hello. What would you like the team to do?")
      const response = yield* Effect.promise(() =>
        request("/api/team/message", tmp.path, "POST", {
          id: "tmsg_runtime_greeting",
          roomID: room.id,
          text: "Hey team",
        }),
      )
      expect(response.status).toBe(200)
      const posted = Schema.decodeUnknownSync(Team.Posted)(yield* Effect.promise(() => response.json()))
      expect(posted.tasks).toHaveLength(1)
      const greeted = yield* pollWithTimeout(
        state(tmp.path, room.id).pipe(
          Effect.map((current) =>
            current.tasks.find((task) => task.id === posted.tasks[0]!.id)?.status === "succeeded" ? current : undefined,
          ),
        ),
        "Coordinator greeting did not finish",
        "20 seconds",
      )
      expect(greeted.messages.some((message) => message.text.includes("What would you like"))).toBe(true)
      expect(greeted.factoryRuns).toEqual([])
      expect(yield* llm.calls).toBe(1)
      yield* llm.text("I can review the change.")
      const directed = yield* Effect.promise(() =>
        request("/api/team/message", tmp.path, "POST", {
          id: "tmsg_runtime_directed",
          roomID: room.id,
          text: "@researcher review this change",
        }),
      )
      expect(directed.status).toBe(200)
      const assignment = Schema.decodeUnknownSync(Team.Posted)(yield* Effect.promise(() => directed.json()))
      expect(assignment.tasks).toHaveLength(1)
      expect(assignment.tasks[0]!.teammateID).not.toBe(posted.tasks[0]!.teammateID)
      yield* pollWithTimeout(
        state(tmp.path, room.id).pipe(
          Effect.map((current) =>
            current.tasks.find((task) => task.id === assignment.tasks[0]!.id)?.status === "succeeded"
              ? true
              : undefined,
          ),
        ),
        "Directed task did not finish",
        "20 seconds",
      )
      const inputs = JSON.stringify(yield* llm.inputs)
      expect(inputs).toContain("Hey team")
      expect(inputs).toContain("What would you like the team to do?")
      expect(yield* llm.calls).toBe(2)
    }))

  it("runs a delegated task in a second native Session and publishes both results", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url, true)
      const created = yield* Effect.promise(() =>
        request("/api/team/room", tmp.path, "POST", { name: "handoff-runtime-room" }),
      )
      const room = Schema.decodeUnknownSync(Team.Room)(yield* Effect.promise(() => created.json()))
      const teammates = yield* Effect.forEach(
        ["coordinator", "researcher"],
        (handle) =>
          Effect.promise(() =>
            request("/api/team/teammate", tmp.path, "POST", {
              roomID: room.id,
              name: handle,
              handle,
              role: "Teammate",
              mission: "Complete the assigned room task.",
              directory: tmp.path,
              model: { id: "chat", providerID: "team-fixture" },
            }),
          ).pipe(
            Effect.flatMap((response) => Effect.promise(() => response.json())),
            Effect.map(Schema.decodeUnknownSync(Team.Teammate)),
          ),
        { concurrency: "unbounded" },
      )
      const parentRequest = "@coordinator assign the researcher a bounded checkout review"
      const childRequest = "Check one checkout guard for the coordinator."
      const isParentSession = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("handle=@coordinator")
      const isChildSession = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes(`Complete this bounded task from teammate @coordinator: ${childRequest}`)
      yield* llm.pushMatch(
        isParentSession,
        reply().tool("team_collaborate", { targetHandle: "researcher", text: childRequest }),
      )
      yield* llm.pushFactory(isParentSession, (hit) => {
        const messages = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
        )(hit.body.messages)
        const delegated = messages.findLast((message) => message.role === "tool")
        const posted = Schema.decodeUnknownSync(Team.Posted)(
          Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(String(delegated?.content)),
        )
        return reply().tool("team_wait", { taskIDs: posted.tasks.map((task) => task.id), timeoutMs: 10000 })
      })
      yield* llm.pushMatch(
        isParentSession,
        reply().text("I checked the researcher result: the checkout guard is present.").stop(),
      )
      yield* llm.pushMatch(isChildSession, reply().text("The checkout guard is present.").stop().item())

      const posted = yield* Effect.promise(() =>
        request("/api/team/message", tmp.path, "POST", {
          id: "tmsg_runtime_handoff",
          roomID: room.id,
          text: parentRequest,
        }),
      )
      const parent = Schema.decodeUnknownSync(Team.Posted)(yield* Effect.promise(() => posted.json())).tasks[0]!
      const coordinator = teammates.find((teammate) => teammate.handle === "coordinator")!
      const researcher = teammates.find((teammate) => teammate.handle === "researcher")!
      const child = yield* pollWithTimeout(
        state(tmp.path, room.id).pipe(
          Effect.map((current) => current.tasks.find((task) => task.teammateID === researcher.id)),
        ),
        "Coordinator did not create the delegated task",
        "20 seconds",
      )
      const settled = yield* pollWithTimeout(
        state(tmp.path, room.id).pipe(
          Effect.map((current) => {
            const parentTask = current.tasks.find((task) => task.id === parent.id)
            const childTask = current.tasks.find((task) => task.id === child.id)
            return parentTask?.status === "succeeded" && childTask?.status === "succeeded" ? current : undefined
          }),
        ),
        "Delegated Team tasks did not finish",
        "30 seconds",
      )

      expect(child.sessionID).toMatch(/^ses_team_/)
      expect(child.sessionID).not.toBe(parent.sessionID)
      expect(settled.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            teammateID: coordinator.id,
            text: "I checked the researcher result: the checkout guard is present.",
          }),
          expect.objectContaining({ teammateID: researcher.id, text: "The checkout guard is present." }),
        ]),
      )
      expect(
        (yield* llm.inputs).some((input) =>
          JSON.stringify(input).includes(`Complete this bounded task from teammate @coordinator: ${childRequest}`),
        ),
      ).toBe(true)
      const parentInputs = (yield* llm.inputs).filter((input) => JSON.stringify(input).includes("handle=@coordinator"))
      expect(parentInputs.some((input) => JSON.stringify(input).includes("The checkout guard is present."))).toBe(true)
      expect(parentInputs).toHaveLength(3)
    }))

  it("answers a delegated teammate question before integrating its result", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url, true)
      const created = yield* Effect.promise(() =>
        request("/api/team/room", tmp.path, "POST", { name: "conversation-runtime-room" }),
      )
      const room = Schema.decodeUnknownSync(Team.Room)(yield* Effect.promise(() => created.json()))
      yield* Effect.forEach(["coordinator", "researcher"], (handle) =>
        Effect.promise(() =>
          request("/api/team/teammate", tmp.path, "POST", {
            roomID: room.id,
            name: handle,
            handle,
            role: "Teammate",
            mission: "Ask for missing evidence and check the result.",
            directory: tmp.path,
            model: { id: "chat", providerID: "team-fixture" },
          }),
        ),
      )
      const conversation = { requestID: "", taskIDs: [] as string[], questionID: "" }
      const parent = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("handle=@coordinator")
      const child = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("handle=@researcher")
      const output = (hit: { body: Record<string, unknown> }) => {
        const messages = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
        )(hit.body.messages)
        return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
          String(messages.findLast((message) => message.role === "tool")?.content),
        )
      }
      yield* llm.pushMatch(
        parent,
        reply().tool("team_collaborate", {
          targetHandle: "researcher",
          text: "Check the approved dependency version.",
        }),
      )
      yield* llm.pushFactory(parent, (hit) => {
        const posted = Schema.decodeUnknownSync(Team.Posted)(output(hit))
        conversation.requestID = posted.message.id
        conversation.taskIDs = posted.tasks.map((task) => task.id)
        return reply().tool("team_wait", { taskIDs: conversation.taskIDs, after: posted.message.seq, timeoutMs: 10000 })
      })
      yield* llm.pushFactory(parent, (hit) => {
        const waited = Schema.decodeUnknownSync(
          Schema.Struct({
            messages: Schema.Array(Team.Message),
            tasks: Schema.Array(Team.Task),
            timedOut: Schema.Boolean,
          }),
        )(output(hit))
        expect(waited.timedOut).toBe(false)
        const question = waited.messages.find((message) => message.text === "Which dependency version should I check?")!
        expect(question.replyTo).toBe(conversation.requestID)
        expect(waited.tasks[0]?.status).toBe("running")
        conversation.questionID = question.id
        return reply().tool("team_post", { text: "Check version 2.4.0 from the lockfile.", replyTo: question.id })
      })
      yield* llm.pushFactory(parent, () =>
        reply().tool("team_wait", { taskIDs: conversation.taskIDs, timeoutMs: 10000 }),
      )
      yield* llm.pushFactory(parent, (hit) => {
        const waited = Schema.decodeUnknownSync(
          Schema.Struct({
            results: Schema.Array(Team.Message),
            tasks: Schema.Array(Team.Task),
            timedOut: Schema.Boolean,
          }),
        )(output(hit))
        expect(waited.timedOut).toBe(false)
        expect(waited.tasks[0]?.status).toBe("succeeded")
        expect(waited.results.some((message) => message.text === "Version 2.4.0 is pinned in the lockfile.")).toBe(true)
        return reply().text("I verified the research result: version 2.4.0 is pinned.").stop()
      })
      yield* llm.pushFactory(child, () =>
        reply().tool("team_post", {
          text: "Which dependency version should I check?",
          replyTo: conversation.requestID,
        }),
      )
      yield* llm.pushFactory(child, (hit) => {
        const question = Schema.decodeUnknownSync(Team.Message)(output(hit))
        return reply().tool("team_wait", { after: question.seq, timeoutMs: 10000 })
      })
      yield* llm.pushFactory(child, (hit) => {
        const waited = Schema.decodeUnknownSync(
          Schema.Struct({ messages: Schema.Array(Team.Message), timedOut: Schema.Boolean }),
        )(output(hit))
        expect(waited.timedOut).toBe(false)
        expect(waited.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              text: "Check version 2.4.0 from the lockfile.",
              replyTo: conversation.questionID,
            }),
          ]),
        )
        return reply().text("Version 2.4.0 is pinned in the lockfile.").stop()
      })
      const posted = yield* Effect.promise(() =>
        request("/api/team/message", tmp.path, "POST", {
          id: "tmsg_runtime_conversation",
          roomID: room.id,
          text: "@coordinator ask the researcher to check the approved dependency.",
        }),
      )
      expect(posted.status).toBe(200)
      const settled = yield* pollWithTimeout(
        state(tmp.path, room.id).pipe(
          Effect.map((current) =>
            current.tasks.length === 2 && current.tasks.every((task) => task.status === "succeeded")
              ? current
              : undefined,
          ),
        ),
        "Teammate question and answer did not complete",
        "25 seconds",
      )
      expect(
        settled.messages.filter((message) => message.text === "Which dependency version should I check?"),
      ).toHaveLength(1)
      expect(
        settled.messages.filter((message) => message.text === "Check version 2.4.0 from the lockfile."),
      ).toHaveLength(1)
      expect(
        settled.messages.some((message) => message.text === "I verified the research result: version 2.4.0 is pinned."),
      ).toBe(true)
      expect((yield* llm.inputs).filter((input) => parent({ body: input }))).toHaveLength(5)
      expect((yield* llm.inputs).filter((input) => child({ body: input }))).toHaveLength(3)
    }))

  it("runs a configured factory through plan, selected work, and acceptance check", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url)
      const teammateResponse = yield* Effect.promise(() =>
        request("/api/team/teammate", tmp.path, "POST", {
          name: "Factory Worker",
          handle: "factoryworker",
          role: "Implementer",
          mission: "Complete the assigned factory work.",
          directory: tmp.path,
          model: { id: "chat", providerID: "team-fixture" },
        }),
      )
      const teammate = Schema.decodeUnknownSync(Team.Teammate)(yield* Effect.promise(() => teammateResponse.json()))
      const initial = yield* state(tmp.path)
      const room = initial.room
      const config: Team.FactoryConfig = {
        outcome: "Review the dependency change.",
        parameters: { package: "example" },
        constraints: "Use the repository evidence.",
        acceptanceCriteria: "Return a concise evidence-backed result.",
        directory: tmp.path,
        coordinatorTeammateID: teammate.id,
        teammateIDs: [teammate.id],
      }
      const configured = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory`, tmp.path, "PUT", config),
      )
      expect(configured.status).toBe(200)
      yield* llm.text(JSON.stringify({ assignments: [{ teammateID: teammate.id, prompt: "Inspect the dependency." }] }))
      yield* llm.text("The dependency is pinned and has no known advisory.")
      yield* llm.text(JSON.stringify({ status: "accepted", summary: "The result meets the acceptance criteria." }))

      const payload = { id: "frun_factory_integration", request: "Focus on runtime impact." }
      const started = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory/run`, tmp.path, "POST", payload),
      )
      expect(started.status).toBe(200)
      const run = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => started.json()))
      const retry = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory/run`, tmp.path, "POST", payload),
      )
      expect(Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => retry.json()))).toEqual(run)
      const conflict = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory/run`, tmp.path, "POST", { ...payload, request: "different" }),
      )
      expect(conflict.status).toBe(409)
      const settled = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => request(`/api/team/factory-run/${run.id}`, tmp.path))
          const current = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => response.json()))
          return current.status === "running" ? undefined : current
        }),
        "Factory run did not settle",
        "30 seconds",
      )
      expect(settled.status, JSON.stringify({ settled, hits: yield* llm.hits, inputs: yield* llm.inputs })).toBe(
        "succeeded",
      )
      expect(settled.result).toContain("meets the acceptance criteria")
      expect(yield* llm.hits).toHaveLength(3)
      const cancelled = yield* Effect.promise(() => request(`/api/team/factory-run/${run.id}/cancel`, tmp.path, "POST"))
      expect(Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => cancelled.json())).status).toBe(
        "succeeded",
      )
      expect(
        (yield* state(tmp.path)).tasks
          .filter((task) => run.taskIDs.includes(task.id))
          .every((task) => task.status === "succeeded"),
      ).toBe(true)
    }))

  it("delivers factory predecessors and shares a worker-built tool with the boss", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url, true)
      const room = (yield* state(tmp.path)).room
      const members = yield* Effect.forEach(["builder", "verifier", "boss"], (handle) =>
        Effect.promise(() =>
          request("/api/team/teammate", tmp.path, "POST", {
            roomID: room.id,
            name: handle,
            handle,
            role: "Factory teammate",
            mission: "Build and verify a reusable repository tool.",
            directory: tmp.path,
            model: { id: "chat", providerID: "team-fixture" },
          }),
        ).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json())),
          Effect.map(Schema.decodeUnknownSync(Team.Teammate)),
        ),
      )
      const configured = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory`, tmp.path, "PUT", {
          outcome: "Build and independently verify a repository guard tool.",
          parameters: {},
          constraints: "Use the shared repository. Do not publish externally.",
          acceptanceCriteria: "Verifier and boss must run the worker-built tool.",
          directory: tmp.path,
          coordinatorTeammateID: members[2]!.id,
          teammateIDs: members.map((member) => member.id),
        }),
      )
      expect(configured.status).toBe(200)
      const planning = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("Return only FactoryPlan JSON")
      const checking = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("Return only FactoryCheck JSON")
      const assignment = (text: string) => (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes(`Assignment: ${text}`)
      yield* llm.pushMatch(
        planning,
        reply()
          .text(
            JSON.stringify({
              assignments: [
                { teammateID: members[2]!.id, prompt: "Approve the verified guard.", dependsOn: [members[1]!.id] },
                { teammateID: members[1]!.id, prompt: "Independently run the guard.", dependsOn: [members[0]!.id] },
                { teammateID: members[0]!.id, prompt: "Build the guard tool." },
              ],
            }),
          )
          .stop(),
      )
      yield* llm.pushMatch(
        assignment("Build the guard tool."),
        reply().tool("write", {
          path: "factory-guard.ts",
          content: 'console.log("factory-guard-ok")\n',
        }),
      )
      yield* llm.pushMatch(
        assignment("Build the guard tool."),
        reply().text("Builder ledger: factory-guard.ts; invoke bun factory-guard.ts; output factory-guard-ok.").stop(),
      )
      yield* llm.pushFactory(assignment("Independently run the guard."), (hit) => {
        expect(JSON.stringify(hit.body)).toContain("Builder ledger: factory-guard.ts")
        return reply().tool("bash", { command: "bun factory-guard.ts" })
      })
      yield* llm.pushFactory(assignment("Independently run the guard."), (hit) => {
        expect(JSON.stringify(hit.body)).toContain("factory-guard-ok")
        return reply()
          .text("Verification record: independently ran bun factory-guard.ts; observed factory-guard-ok.")
          .stop()
      })
      yield* llm.pushFactory(assignment("Approve the verified guard."), (hit) => {
        expect(JSON.stringify(hit.body)).toContain("Verification record: independently ran")
        return reply().tool("write", {
          path: "factory-review.ts",
          content: 'import "./factory-guard"\nconsole.log("factory-review-ok")\n',
        })
      })
      yield* llm.pushMatch(
        assignment("Approve the verified guard."),
        reply().tool("bash", { command: "bun factory-review.ts" }),
      )
      yield* llm.pushFactory(assignment("Approve the verified guard."), (hit) => {
        const messages = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
        )(hit.body.messages)
        expect(String(messages.findLast((message) => message.role === "tool")?.content)).toContain("factory-review-ok")
        return reply()
          .text("Editorial draft: approved after inspecting the verification record and running the guard.")
          .stop()
      })
      yield* llm.pushFactory(checking, (hit) => {
        expect(JSON.stringify(hit.body)).toContain("Builder ledger: factory-guard.ts")
        expect(JSON.stringify(hit.body)).toContain("Verification record: independently ran")
        expect(JSON.stringify(hit.body)).toContain("Editorial draft: approved")
        return reply()
          .text(
            JSON.stringify({
              status: "accepted",
              summary: "All predecessor outputs delivered; tool reused and verified.",
            }),
          )
          .stop()
      })
      const started = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory/run`, tmp.path, "POST", { id: "frun_dependency_tool" }),
      )
      expect(started.status).toBe(200)
      const run = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => started.json()))
      const settled = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => request(`/api/team/factory-run/${run.id}`, tmp.path))
          const value = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => response.json()))
          return value.status === "running" ? undefined : value
        }),
        "Factory dependency chain did not finish",
        "40 seconds",
      )
      expect(settled.status, JSON.stringify(settled)).toBe("succeeded")
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "factory-guard.ts")).text())).toContain(
        "factory-guard-ok",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "factory-review.ts")).text())).toContain(
        "factory-review-ok",
      )
      expect(
        (yield* llm.inputs).filter((input) => assignment("Approve the verified guard.")({ body: input })),
      ).toHaveLength(3)
    }))

  it("fails a factory plan that assigns an unselected teammate", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url)
      const teammateResponse = yield* Effect.promise(() =>
        request("/api/team/teammate", tmp.path, "POST", {
          name: "Factory Coordinator",
          handle: "factorycoordinator",
          role: "Coordinator",
          mission: "Plan and check the work.",
          directory: tmp.path,
          model: { id: "chat", providerID: "team-fixture" },
        }),
      )
      const teammate = Schema.decodeUnknownSync(Team.Teammate)(yield* Effect.promise(() => teammateResponse.json()))
      const room = (yield* state(tmp.path)).room
      const configured = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory`, tmp.path, "PUT", {
          outcome: "Review the dependency.",
          parameters: {},
          constraints: "Use repository evidence.",
          acceptanceCriteria: "Findings must be supported.",
          directory: tmp.path,
          coordinatorTeammateID: teammate.id,
          teammateIDs: [teammate.id],
        }),
      )
      expect(configured.status).toBe(200)
      yield* llm.text(JSON.stringify({ assignments: [{ teammateID: "unknown-teammate", prompt: "Do the work." }] }))
      const started = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory/run`, tmp.path, "POST", { id: "frun_invalid_plan" }),
      )
      const run = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => started.json()))
      const settled = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => request(`/api/team/factory-run/${run.id}`, tmp.path))
          const current = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => response.json()))
          return current.status === "running" ? undefined : current
        }),
        "Invalid factory plan did not settle",
        "20 seconds",
      )
      expect(settled.status).toBe("failed")
      expect(settled.error).toContain("FactoryPlan")
      expect(yield* llm.calls).toBe(1)
    }))

  it("cancels a live factory run and interrupts its pending coordinator prompt", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.hang
      const tmp = yield* setup(llm.url)
      const teammateResponse = yield* Effect.promise(() =>
        request("/api/team/teammate", tmp.path, "POST", {
          name: "Cancellation Coordinator",
          handle: "cancelcoordinator",
          role: "Coordinator",
          mission: "Plan and check the work.",
          directory: tmp.path,
          model: { id: "chat", providerID: "team-fixture" },
        }),
      )
      const teammate = Schema.decodeUnknownSync(Team.Teammate)(yield* Effect.promise(() => teammateResponse.json()))
      const room = (yield* state(tmp.path)).room
      const configured = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory`, tmp.path, "PUT", {
          outcome: "Review the cancellation path.",
          parameters: {},
          constraints: "Use repository evidence.",
          acceptanceCriteria: "Return a supported result.",
          directory: tmp.path,
          coordinatorTeammateID: teammate.id,
          teammateIDs: [teammate.id],
        }),
      )
      expect(configured.status).toBe(200)
      const started = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory/run`, tmp.path, "POST", { id: "frun_cancel_live" }),
      )
      const run = Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => started.json()))
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* llm.calls) > 0 ? true : undefined
        }),
        "Factory coordinator did not start",
        "20 seconds",
      )
      const cancelledResponse = yield* Effect.promise(() =>
        request(`/api/team/factory-run/${run.id}/cancel`, tmp.path, "POST"),
      )
      expect(
        Schema.decodeUnknownSync(Team.FactoryRun)(yield* Effect.promise(() => cancelledResponse.json())).status,
      ).toBe("cancelled")
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* llm.aborts) > 0 ? true : undefined
        }),
        "Factory cancellation did not interrupt the pending provider turn",
        "5 seconds",
      )
      expect((yield* state(tmp.path)).tasks.filter((task) => run.taskIDs.includes(task.id))).toMatchObject([
        { status: "cancelled" },
      ])
      expect(yield* llm.calls).toBe(1)
    }))

  it("runs a scheduled factory with the coordinator Session and no Loop model turn", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* setup(llm.url)
      const teammateResponse = yield* Effect.promise(() =>
        request("/api/team/teammate", tmp.path, "POST", {
          name: "Scheduled Coordinator",
          handle: "scheduledcoordinator",
          role: "Coordinator",
          mission: "Plan and check the assigned work.",
          directory: tmp.path,
          model: { id: "chat", providerID: "team-fixture" },
        }),
      )
      const teammate = Schema.decodeUnknownSync(Team.Teammate)(yield* Effect.promise(() => teammateResponse.json()))
      const room = (yield* state(tmp.path)).room
      const configured = yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory`, tmp.path, "PUT", {
          outcome: "Review the scheduled change.",
          parameters: { change: "scheduled" },
          constraints: "Use repository evidence.",
          acceptanceCriteria: "The result meets the stated outcome.",
          directory: tmp.path,
          coordinatorTeammateID: teammate.id,
          teammateIDs: [teammate.id],
        }),
      )
      expect(configured.status).toBe(200)
      yield* llm.text(JSON.stringify({ assignments: [{ teammateID: teammate.id, prompt: "Review the change." }] }))
      yield* llm.text("The change is complete.")
      yield* llm.text(JSON.stringify({ status: "accepted", summary: "The change meets the outcome." }))
      const created = yield* Effect.promise(() =>
        request("/api/loop", tmp.path, "POST", {
          name: "Scheduled factory",
          prompt: "Run the configured factory.",
          location: { directory: tmp.path },
          intervalSeconds: 3600,
          factoryRoomID: room.id,
          paused: true,
        }),
      )
      expect(created.status).toBe(200)
      const loop = (yield* Effect.promise(() => created.json())) as { id: string; factoryRoomID?: string }
      expect(loop.factoryRoomID).toBe(room.id)
      const started = yield* Effect.promise(() => request(`/api/loop/${loop.id}/run`, tmp.path, "POST"))
      expect(started.status).toBe(200)
      const run = (yield* Effect.promise(() => started.json())) as { id: string; sessionID?: string }
      const settled = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => request(`/api/loop/${loop.id}/run/${run.id}`, tmp.path))
          const current = (yield* Effect.promise(() => response.json())) as {
            status: string
            sessionID?: string
            outputs?: Record<string, { text: string; json?: unknown }>
          }
          return current.status === "claimed" || current.status === "running" ? undefined : current
        }),
        "Scheduled factory Loop run did not settle",
        "30 seconds",
      )
      const factoryResponse = yield* Effect.promise(() => request(`/api/team/factory-run/frun_${run.id}`, tmp.path))
      const factory = yield* Effect.promise(() => factoryResponse.json())
      const teamState = yield* state(tmp.path)
      expect(
        settled.status,
        JSON.stringify({ settled, factory, tasks: teamState.tasks, hits: yield* llm.hits, inputs: yield* llm.inputs }),
      ).toBe("succeeded")
      expect(settled.sessionID).toMatch(/^ses_team_/)
      expect(settled.outputs?.factory?.text).toContain("meets the outcome")
      expect(settled.outputs?.factory?.json).toEqual({ factoryRunID: `frun_${run.id}`, status: "succeeded" })
      expect(yield* llm.calls).toBe(3)
    }))

  it("runs a case-normalized trailing-hyphen mention once and reconciles an exact retry", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("The dependency review is ready.")
      const tmp = yield* setup(llm.url)
      const teammateResponse = yield* Effect.promise(() =>
        request("/api/team/teammate", tmp.path, "POST", {
          name: "Review Partner",
          handle: "reviewer-",
          role: "Security reviewer",
          mission: "Review dependency risks and report concise evidence.",
          directory: tmp.path,
          model: { id: "chat", providerID: "team-fixture" },
        }),
      )
      expect(teammateResponse.status).toBe(200)
      const teammate = Schema.decodeUnknownSync(Team.Teammate)(yield* Effect.promise(() => teammateResponse.json()))
      const message = { id: "msg_team_runtime_retry", text: "@REVIEWER- review the locked dependency." }
      const posted = yield* Effect.promise(() => request("/api/team/message", tmp.path, "POST", message))
      expect(posted.status).toBe(200)
      const created = Schema.decodeUnknownSync(Team.Posted)(yield* Effect.promise(() => posted.json()))
      expect(created.tasks).toHaveLength(1)
      const task = created.tasks[0]!

      const settled = yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* state(tmp.path)).tasks.find(
            (task) => task.id === created.tasks[0]!.id && ["succeeded", "failed", "stale"].includes(task.status),
          )
        }),
        "Team task did not settle",
        "20 seconds",
      )
      expect(settled.status, JSON.stringify({ task: settled, hits: yield* llm.hits, inputs: yield* llm.inputs })).toBe(
        "succeeded",
      )
      const completed = yield* state(tmp.path)
      expect(completed.messages).toContainEqual(
        expect.objectContaining({ teammateID: teammate.id, text: "The dependency review is ready." }),
      )
      expect(completed.messages.filter((roomMessage) => roomMessage.replyTo === message.id)).toHaveLength(1)
      expect(completed.tasks.filter((task) => task.messageID === message.id)).toHaveLength(1)
      expect(
        (yield* llm.inputs).filter((input) => JSON.stringify(input).includes(`User message: ${message.text}`)),
      ).toHaveLength(1)

      const retry = yield* Effect.promise(() => request("/api/team/message", tmp.path, "POST", message))
      expect(retry.status).toBe(200)
      yield* Effect.sleep("250 millis")
      const retried = yield* state(tmp.path)
      expect(retried.tasks.filter((task) => task.messageID === message.id)).toHaveLength(1)
      expect(retried.messages.filter((roomMessage) => roomMessage.replyTo === message.id)).toHaveLength(1)
      expect(
        (yield* llm.inputs).filter((input) => JSON.stringify(input).includes(`User message: ${message.text}`)),
      ).toHaveLength(1)

      const followup = {
        id: "msg_team_runtime_followup",
        prompt: { text: "Please add one follow-up detail." },
      }
      yield* llm.pushMatch(
        (hit) => hit.body.stream === true && JSON.stringify(hit.body).includes("Please add one follow-up detail."),
        reply().text("The follow-up detail is available.").stop(),
      )
      const followupResponse = yield* Effect.promise(() =>
        request(`/api/session/${task.sessionID}/prompt`, tmp.path, "POST", followup),
      )
      expect(followupResponse.status).toBe(200)
      const followupOutput = yield* pollWithTimeout(
        state(tmp.path).pipe(
          Effect.map((current) =>
            current.messages.find((roomMessage) => roomMessage.text === "The follow-up detail is available."),
          ),
        ),
        "Completed teammate Session follow-up did not reach the room",
        "20 seconds",
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const messagesResponse = yield* Effect.promise(() =>
              request(`/api/session/${task.sessionID}/message?limit=100`, tmp.path),
            )
            const messages = yield* Effect.promise(() => messagesResponse.json())
            const current = yield* state(tmp.path)
            return yield* Effect.fail(
              new Error(`${error}; sessionMessages=${JSON.stringify(messages)}; room=${JSON.stringify(current)}`),
            )
          }),
        ),
      )
      expect(followupOutput.sourceMessageIDs).toHaveLength(1)

      const callsBeforeRetry = yield* llm.calls
      const followupRetry = yield* Effect.promise(() =>
        request(`/api/session/${task.sessionID}/prompt`, tmp.path, "POST", followup),
      )
      expect(followupRetry.status).toBe(200)
      yield* Effect.sleep("250 millis")
      const afterFollowupRetry = yield* state(tmp.path)
      expect(
        afterFollowupRetry.messages.filter((roomMessage) => roomMessage.text === "The follow-up detail is available."),
      ).toHaveLength(1)
      expect(yield* llm.calls).toBe(callsBeforeRetry)
    }))

  it("cancels an active provider turn without replay", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.hang
      const tmp = yield* setup(llm.url)
      const teammateResponse = yield* Effect.promise(() =>
        request("/api/team/teammate", tmp.path, "POST", {
          name: "Cancel Partner",
          handle: "cancelpartner",
          role: "Security reviewer",
          mission: "Review suspicious package activity.",
          directory: tmp.path,
          model: { id: "chat", providerID: "team-fixture" },
        }),
      )
      const teammate = Schema.decodeUnknownSync(Team.Teammate)(yield* Effect.promise(() => teammateResponse.json()))
      const posted = yield* Effect.promise(() =>
        request("/api/team/message", tmp.path, "POST", {
          id: "msg_team_runtime_cancel",
          text: "@cancelpartner inspect this package now.",
        }),
      )
      const task = Schema.decodeUnknownSync(Team.Posted)(yield* Effect.promise(() => posted.json())).tasks[0]!
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* llm.calls) > 0 ? true : undefined
        }),
        "Team provider turn did not start",
        "20 seconds",
      )

      const cancelled = yield* Effect.promise(() => request(`/api/team/task/${task.id}/cancel`, tmp.path, "POST"))
      expect(cancelled.status).toBe(200)
      expect(Schema.decodeUnknownSync(Team.Task)(yield* Effect.promise(() => cancelled.json())).status).toBe(
        "cancelled",
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* llm.aborts) > 0 ? true : undefined
        }),
        "Cancelled Session did not interrupt its provider request",
        "5 seconds",
      )
      yield* Effect.sleep("2 seconds")
      expect((yield* state(tmp.path)).tasks.filter((task) => task.teammateID === teammate.id)).toMatchObject([
        { status: "cancelled" },
      ])
      expect(yield* llm.calls).toBe(1)
    }))
})
