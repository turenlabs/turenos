// After a prompt finishes, `forge acp` sends a usage update through the default
// usage service before it answers. Building that service synchronously threw,
// so every finished prompt reached the editor as a JSON-RPC error. A failed
// update is now only logged, so the test also checks that the update arrives.
import { describe, expect } from "bun:test"
import type { NewSessionResponse, PromptResponse, SessionNotification } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { cliIt, testModelID } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"
import { expectOk } from "./acp-test-client"
import { createAcpClient, initialize } from "./helpers"

describe("forge acp prompt subprocess", () => {
  cliIt.live(
    "a finished prompt sends a usage update and returns end_turn",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { FORGE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), model: testModelID }) },
        )
        yield* initialize(acp)
        const session = expectOk(yield* acp.request<NewSessionResponse>("session/new", { cwd: home, mcpServers: [] }))
        yield* llm.text("hello back", { usage: { input: 30, output: 5 } })

        const prompt = yield* acp.requestWithNotifications<PromptResponse>("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        })

        expect(expectOk(prompt.response).stopReason).toBe("end_turn")
        expect(
          prompt.notifications
            .flatMap((item) => (item.method === "session/update" ? [item.params as SessionNotification] : []))
            .filter((item) => item.update.sessionUpdate === "usage_update"),
        ).toEqual([
          {
            sessionId: session.sessionId,
            // The test model is free and has a 100k context (test/lib/test-provider.ts).
            update: { sessionUpdate: "usage_update", used: 30, size: 100_000, cost: { amount: 0, currency: "USD" } },
          },
        ])
      }),
    90_000,
  )
})
