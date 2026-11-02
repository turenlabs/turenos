// `forge run` auto-rejects permission requests so a headless run never blocks. A subagent
// started by the task tool asks from its own child session, and an unanswered ask waits
// forever, so the run must answer asks from the sessions it spawned as well as its own.
import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { cliIt, testModelID } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

describe("forge run permission requests (subprocess)", () => {
  cliIt.live(
    "auto-rejects a permission request from a subagent session",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        // The test preload points FORGE_DB at memory; share a file and one vault key so the
        // enforcement toggle written through `serve` is what `run` reads.
        const env = {
          FORGE_DB: path.join(home, "forge.db"),
          FORGE_SECRET_VAULT_KEY_ID: "run-permission-key",
          FORGE_SECRET_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
          FORGE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)),
        }
        // Without enforcement every "ask" resolves to allow, so turn checks on first.
        // `serve` holds the database owner lock, so it stops before `run` starts.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* opencode.serve({ env })
            const response = yield* HttpClientRequest.put(`${server.url}/global/permission-checks`).pipe(
              HttpClientRequest.bodyJson({ enforced: true }),
              Effect.flatMap(HttpClient.execute),
            )
            expect(response.status).toBe(200)
          }),
        )

        yield* llm.tool("task", { description: "Read hosts", prompt: "read /etc/hosts", subagent_type: "general" })
        // Reading outside the project asks for `external_directory` in the child session.
        yield* llm.tool("read", { filePath: "/etc/hosts" })
        yield* llm.text("child done")
        yield* llm.text("parent done")

        const result = yield* opencode.run("delegate a read", {
          model: testModelID,
          format: "json",
          timeoutMs: 30_000,
          env,
        })
        opencode.expectExit(result, 0, "run")
        expect(result.stderr).toMatch(/permission requested: external_directory \(.*\); auto-rejecting/)
        expect(
          opencode.parseJsonEvents(result.stdout).flatMap((event) => {
            if (event.type !== "tool_use") return []
            const part = event.part
            if (typeof part !== "object" || part === null || !("tool" in part) || !("state" in part)) return []
            const state = part.state
            if (typeof state !== "object" || state === null || !("status" in state)) return []
            return [{ tool: part.tool, status: state.status }]
          }),
        ).toEqual([{ tool: "task", status: "completed" }])
      }),
    90_000,
  )
})
