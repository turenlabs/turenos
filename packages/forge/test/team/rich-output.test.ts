import { afterEach, expect } from "bun:test"
import { Context, Effect, Schema } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Team } from "@turenlabs/schema/team"
import { SessionMessage } from "@turenlabs/schema/session-message"
import { Global } from "@turenlabs/core/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

const it = testEffect(TestLLMServer.layer).live

function request(directory: string, route: string, body?: unknown) {
  return Effect.promise(() => HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-forge-directory": directory, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), Context.empty() as Context.Context<unknown>)).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
    Effect.flatMap((response) => Effect.promise(() => response.json())),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it("publishes all task assistant IDs, not the prompt or another task's output", () => Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir({ git: true, config: { model: "rich-fixture/chat" } })),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )
  const configFile = path.join(Global.Path.config, "forge.json")
  const original = yield* Effect.promise(() => fs.readFile(configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  }))
  const api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url, settings: { apiKey: "fixture" } }
  yield* Effect.acquireRelease(
    Effect.promise(() => Bun.write(configFile, JSON.stringify({ providers: { "rich-fixture": {
      api,
      models: { chat: { api: { ...api, id: "chat" }, capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 2000 } } },
    } } }))),
    () => Effect.promise(async () => {
      if (original === undefined) {
        await fs.rm(configFile, { force: true })
        return
      }
      await Bun.write(configFile, original)
    }),
  )
  yield* Effect.promise(() => Bun.write(path.join(tmp.path, "evidence.txt"), "Evidence"))
  const mate = Schema.decodeUnknownSync(Team.Teammate)(yield* request(tmp.path, "/api/team/teammate", {
    name: "Writer", handle: "writer", role: "Writer", mission: "Review evidence", directory: tmp.path,
    model: { id: "chat", providerID: "rich-fixture" },
  }))
  yield* llm.push(reply().text("Earlier provider output").tool("read", { filePath: path.join(tmp.path, "evidence.txt") }))
  yield* llm.text("Final provider output")
  const admitted = Schema.decodeUnknownSync(Team.Posted)(yield* request(tmp.path, "/api/team/message", {
    id: "msg_rich_scope", text: "@writer Review evidence.txt. Do not change factory setup.",
  }))
  const task = admitted.tasks[0]!
  const settled = yield* pollWithTimeout(request(tmp.path, "/api/team").pipe(
    Effect.map(Schema.decodeUnknownSync(Team.State)),
    Effect.map((state) => state.tasks.find((value) => value.id === task.id && ["succeeded", "failed", "stale"].includes(value.status))),
  ), "Rich Team task did not settle", "20 seconds")
  expect(settled.status).toBe("succeeded")
  const state = Schema.decodeUnknownSync(Team.State)(yield* request(tmp.path, "/api/team"))
  const output = state.messages.find((message) => message.replyTo === admitted.message.id)!
  const transcript = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(SessionMessage.Message) }))(
    yield* request(tmp.path, `/api/session/${task.sessionID}/message?order=asc`),
  ).data
  const assistants = transcript.filter((message) => message.type === "assistant")
  expect(assistants.length).toBeGreaterThanOrEqual(2)
  expect(output.sourceMessageIDs).toEqual(assistants.map((message) => message.id))
  for (const messageID of output.sourceMessageIDs ?? []) {
    const projected = Schema.decodeUnknownSync(Schema.Struct({ data: SessionMessage.Message }))(
      yield* request(tmp.path, `/api/session/${task.sessionID}/message/${messageID}`),
    ).data
    expect(projected.type).toBe("assistant")
    expect(projected).toEqual(assistants.find((message) => message.id === messageID)!)
  }
  expect(output.sourceMessageIDs).not.toContain(`msg_team_${task.id}`)
  expect(output.text).toBe("Final provider output")
  const input = JSON.stringify(yield* llm.inputs)
  expect(input).toContain(`roomID=${mate.roomID}`)
  expect(input).toContain(`teammateID=${mate.id}`)
  expect(input).toContain("handle=@writer")
  expect(input).toContain("Do not call them implicitly")
  yield* llm.text("Second task output")
  const second = Schema.decodeUnknownSync(Team.Posted)(yield* request(tmp.path, "/api/team/message", {
    id: "msg_rich_other", text: "@writer Report again.",
  }))
  const secondOutput = yield* pollWithTimeout(request(tmp.path, "/api/team").pipe(
    Effect.map(Schema.decodeUnknownSync(Team.State)),
    Effect.map((value) => value.messages.find((message) => message.replyTo === second.message.id)),
  ), "Second Team output did not publish", "20 seconds")
  expect(secondOutput.sourceMessageIDs?.length).toBeGreaterThan(0)
  expect(secondOutput.sourceMessageIDs?.some((id) => output.sourceMessageIDs?.includes(id))).toBe(false)
}))
