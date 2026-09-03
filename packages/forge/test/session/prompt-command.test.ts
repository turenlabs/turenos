import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { resolveCommand } from "../../src/session/prompt"

describe("SessionPrompt command resolution", () => {
  test("falls back to an installed skill when no project command exists", async () => {
    const command = await Effect.runPromise(
      resolveCommand(
        { get: () => Effect.succeed(undefined) },
        {
          get: (name) =>
            Effect.succeed({
              name,
              description: "Produce a sourced threat intelligence brief",
              location: "<extension:turenlabs/threat-intel-brief>",
              content: "Skill instructions",
            }),
        },
        "threat-intel-brief",
      ),
    )

    expect(command).toMatchObject({
      name: "threat-intel-brief",
      source: "skill",
      subtask: false,
      template: expect.stringContaining("Invoke it with the skill tool"),
    })
  })

  test("keeps a real project command ahead of a colliding skill", async () => {
    const configured = {
      name: "review",
      template: "Run the project review command",
      hints: [],
      source: "command" as const,
    }
    const command = await Effect.runPromise(
      resolveCommand(
        { get: () => Effect.succeed(configured) },
        { get: () => Effect.die("skill lookup should not run") },
        "review",
      ),
    )
    expect(command).toBe(configured)
  })
})
