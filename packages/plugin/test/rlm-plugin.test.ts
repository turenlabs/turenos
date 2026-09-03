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
})

function toolOutput(result: ToolResult) {
  if (typeof result === "string") return result
  return result.output
}
