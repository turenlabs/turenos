// `forge run` without --attach serves the agent through the in-process handler and never
// calls Server.listen, so a credential left in process.env reaches the agent's shell children.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt, testModelID } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const CREDENTIALS = ["FORGE_SECRET_VAULT_KEY", "FORGE_SECRET_VAULT_KEY_ID", "FORGE_SERVER_PASSWORD"]

describe("forge run credential isolation (subprocess)", () => {
  cliIt.live(
    "agent shell commands cannot read server or vault credentials",
    ({ opencode, llm }) =>
      Effect.gen(function* () {
        // Quote-split the markers so the command text echoed back in the event can never satisfy the assertion.
        yield* llm.tool("bash", {
          command: CREDENTIALS.map(
            (name) => `printenv ${name} >/dev/null && echo '${name} pre''sent' || echo '${name} ab''sent'`,
          ).join("; "),
          description: "Check inherited credentials",
        })
        yield* llm.text("done")

        const result = yield* opencode.run("check the environment", {
          model: testModelID,
          format: "json",
          env: {
            FORGE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), permission: { bash: "allow" } }),
            FORGE_SERVER_PASSWORD: "run-server-secret",
            FORGE_SECRET_VAULT_KEY_ID: "run-test-key",
            FORGE_SECRET_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
          },
        })
        opencode.expectExit(result, 0, "run")

        const lines = opencode.parseJsonEvents(result.stdout).flatMap((event) => {
          if (event.type !== "tool_use") return []
          const part = event.part
          if (typeof part !== "object" || part === null || !("state" in part)) return []
          const state = part.state
          if (typeof state !== "object" || state === null || !("output" in state)) return []
          return typeof state.output === "string" ? state.output.split("\n").filter(Boolean) : []
        })
        expect(lines.toSorted()).toEqual(CREDENTIALS.map((name) => `${name} absent`))
      }),
    90_000,
  )
})
