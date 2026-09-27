import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@turenlabs/sdk"
import type { PluginInput } from "../src/index"
import type { ToolContext, ToolResult } from "../src/tool"
import { createRlmPlugin } from "../src/rlm-plugin"

describe("RLM plugin", () => {
  test("externalizes tagged context and exposes bounded search and read tools", async () => {
    const hooks = await createRlmPlugin()({} as PluginInput)
    const info: UserMessage = {
      id: "message-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }
    const part = {
      id: "part-1",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "text" as const,
      text: [
        "Compare these notes.",
        '<!-- rlm-context name="notes" -->',
        "alpha",
        "rotation happens daily",
        "omega",
        "<!-- /rlm-context -->",
      ].join("\n"),
    }
    const messages = [{ info, parts: [part] }]

    await hooks["experimental.chat.messages.transform"]!({}, { messages })

    expect(part.text).toContain("Compare these notes.")
    expect(part.text).not.toContain("rotation happens daily")

    const contextID = /id=([^ ]+)/.exec(part.text)?.[1]
    expect(contextID).toBeDefined()

    const permissions: string[] = []
    const toolContext: ToolContext = {
      sessionID: info.sessionID,
      messageID: "assistant-1",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata() {},
      async ask(input) {
        permissions.push(input.permission)
      },
    }

    const search = await hooks.tool!.rlm_context_search.execute({ query: "rotation", contextID }, toolContext)
    expect(toolOutput(search)).toContain("rotation happens daily")

    const read = await hooks.tool!.rlm_context_read.execute({ contextID, startLine: 2, lineCount: 1 }, toolContext)
    expect(toolOutput(read)).toContain("rotation happens daily")
    expect(permissions).toEqual(["rlm.context.read", "rlm.context.read"])
  })

  test("does not expose a context to another session", async () => {
    const hooks = await createRlmPlugin()({} as PluginInput)
    const info: UserMessage = {
      id: "message-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }
    const part = {
      id: "part-1",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "text" as const,
      text: "<!-- rlm-context -->\nprivate\n<!-- /rlm-context -->",
    }

    await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info, parts: [part] }] })
    const contextID = /id=([^ ]+)/.exec(part.text)?.[1]
    const tool = hooks.tool!.rlm_context_read

    await expect(
      tool.execute(
        { contextID: contextID!, startLine: 1 },
        {
          sessionID: "session-2",
          messageID: "assistant-1",
          agent: "build",
          directory: "/tmp",
          worktree: "/tmp",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      ),
    ).rejects.toThrow("Unknown RLM context")
  })

  test("returns the highest-scoring search lines in line order when scores tie", async () => {
    const hooks = await createRlmPlugin({ maxSearchResults: 51 })({} as PluginInput)
    const info: UserMessage = {
      id: "message-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }
    const part = {
      id: "part-1",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "text" as const,
      text: [
        "<!-- rlm-context -->",
        "needle",
        "phrase needle",
        "needle elsewhere",
        "needle phrase exact",
        "phrase needle",
        "unrelated",
        "<!-- /rlm-context -->",
      ].join("\n"),
    }

    await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info, parts: [part] }] })

    const contextID = /id=([^ ]+)/.exec(part.text)?.[1]
    const toolContext: ToolContext = {
      sessionID: info.sessionID,
      messageID: "assistant-1",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    }
    const search = await hooks.tool!.rlm_context_search.execute({ query: "needle phrase", contextID, limit: 3 }, toolContext)
    const output = JSON.parse(toolOutput(search)) as { results: Array<{ line: number }> }

    expect(output.results.map((result) => result.line)).toEqual([4, 2, 5])

    const allMatches = await hooks.tool!.rlm_context_search.execute({ query: "needle phrase", contextID }, toolContext)
    const allOutput = JSON.parse(toolOutput(allMatches)) as { results: Array<{ line: number }> }
    expect(allOutput.results.map((result) => result.line)).toEqual([4, 2, 5, 1, 3])
  })
})

function toolOutput(result: ToolResult) {
  if (typeof result === "string") return result
  return result.output
}
