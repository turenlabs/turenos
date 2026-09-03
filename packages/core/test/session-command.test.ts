import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { CommandV2 } from "@turenlabs/core/command"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionCommand } from "@turenlabs/core/session/command"
import { SkillV2 } from "@turenlabs/core/skill"
import { AbsolutePath } from "@turenlabs/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AgentV2.node, CommandV2.node, SkillV2.node, SessionCommand.node])),
)

describe("SessionCommand", () => {
  it.effect("expands quoted positional arguments and carries files into a V2 prompt", () =>
    Effect.gen(function* () {
      const commands = yield* CommandV2.Service
      const agents = yield* AgentV2.Service
      const resolver = yield* SessionCommand.Service
      const build = AgentV2.ID.make("build")
      const selected = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("provider"),
        id: ModelV2.ID.make("selected"),
        variant: ModelV2.VariantID.make("high"),
      })
      yield* agents.transform((draft) =>
        draft.update(build, (agent) => {
          agent.mode = "primary"
        }),
      )
      yield* commands.transform((draft) =>
        draft.update("ship", (command) => {
          command.template = "Ship $1 to $2"
        }),
      )

      expect(
        yield* resolver.resolve({
          command: "ship",
          arguments: '"Forge Desktop" "release branch"',
          agent: build,
          model: selected,
          files: [{ uri: "data:text/plain;base64,Zm9yZ2U=", name: "forge.txt" }],
        }),
      ).toEqual({
        prompt: {
          text: "Ship Forge Desktop to release branch",
          files: [{ uri: "data:text/plain;base64,Zm9yZ2U=", name: "forge.txt" }],
        },
        agent: build,
        model: selected,
      })
    }),
  )

  it.effect("honors command agent and model overrides before the caller selection", () =>
    Effect.gen(function* () {
      const commands = yield* CommandV2.Service
      const agents = yield* AgentV2.Service
      const resolver = yield* SessionCommand.Service
      const reviewer = AgentV2.ID.make("reviewer")
      const configured = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("anthropic"),
        id: ModelV2.ID.make("review-model"),
        variant: ModelV2.VariantID.make("low"),
      })
      yield* agents.transform((draft) =>
        draft.update(reviewer, (agent) => {
          agent.mode = "primary"
          agent.model = configured
        }),
      )
      yield* commands.transform((draft) =>
        draft.update("review", (command) => {
          command.template = "Review $ARGUMENTS"
          command.agent = reviewer
        }),
      )

      expect(
        yield* resolver.resolve({
          command: "review",
          arguments: "the storage layer",
          agent: AgentV2.ID.make("build"),
        }),
      ).toEqual({
        prompt: { text: "Review the storage layer" },
        agent: reviewer,
        model: configured,
      })
    }),
  )

  it.effect("appends arguments when the template has no placeholders", () =>
    Effect.gen(function* () {
      const commands = yield* CommandV2.Service
      const resolver = yield* SessionCommand.Service
      yield* commands.transform((draft) =>
        draft.update("explain", (command) => {
          command.template = "Explain this"
        }),
      )

      expect(yield* resolver.resolve({ command: "explain", arguments: "carefully" })).toMatchObject({
        prompt: { text: "Explain this\n\ncarefully" },
      })
    }),
  )

  it.effect("resolves an installed skill when no command exists", () =>
    Effect.gen(function* () {
      const skills = yield* SkillV2.Service
      const resolver = yield* SessionCommand.Service
      yield* skills.transform((draft) =>
        draft.source(
          SkillV2.EmbeddedSource.make({
            type: "embedded",
            skill: SkillV2.Info.make({
              name: "threat-intel-brief",
              description: "Produce a sourced threat intelligence brief",
              location: AbsolutePath.make("/builtin/threat-intel-brief.md"),
              content: "Corroborate indicators and report confidence.",
            }),
          }),
        ),
      )

      const resolved = yield* resolver.resolve({ command: "threat-intel-brief", arguments: "8.8.8.8" })

      expect(resolved.prompt).toEqual({
        text: "/threat-intel-brief 8.8.8.8",
        parts: [
          { id: expect.stringMatching(/^prt_/), text: "/threat-intel-brief 8.8.8.8" },
          {
            id: expect.stringMatching(/^prt_/),
            text: "Use the `threat-intel-brief` skill for this request. Invoke it with the skill tool before doing the work.",
            synthetic: true,
          },
        ],
      })
      expect(JSON.stringify(resolved)).not.toContain("Corroborate indicators and report confidence.")
    }),
  )

  it.effect("rejects an installed skill when the selected agent cannot load it", () =>
    Effect.gen(function* () {
      const skills = yield* SkillV2.Service
      const agents = yield* AgentV2.Service
      const resolver = yield* SessionCommand.Service
      const restricted = AgentV2.ID.make("restricted")
      yield* skills.transform((draft) =>
        draft.source(
          SkillV2.EmbeddedSource.make({
            type: "embedded",
            skill: SkillV2.Info.make({
              name: "threat-intel-brief",
              location: AbsolutePath.make("/builtin/threat-intel-brief.md"),
              content: "Corroborate indicators and report confidence.",
            }),
          }),
        ),
      )
      yield* agents.transform((draft) =>
        draft.update(restricted, (agent) => {
          agent.mode = "primary"
          agent.tools = false
        }),
      )

      expect(
        yield* resolver
          .resolve({ command: "threat-intel-brief", arguments: "8.8.8.8", sessionAgent: restricted })
          .pipe(Effect.flip),
      ).toEqual(
        new SessionCommand.UnsupportedError({
          command: "threat-intel-brief",
          reason: "the selected agent cannot load this skill",
        }),
      )

      yield* agents.transform((draft) =>
        draft.update(restricted, (agent) => {
          agent.tools = true
          agent.permissions = [{ action: "skill", resource: "threat-intel-brief", effect: "deny" }]
        }),
      )

      expect(
        yield* resolver
          .resolve({ command: "threat-intel-brief", arguments: "8.8.8.8", agent: restricted })
          .pipe(Effect.flip),
      ).toEqual(
        new SessionCommand.UnsupportedError({
          command: "threat-intel-brief",
          reason: "the selected agent cannot load this skill",
        }),
      )
    }),
  )

  it.effect("fails closed for inline shell and subtask command semantics", () =>
    Effect.gen(function* () {
      const commands = yield* CommandV2.Service
      const agents = yield* AgentV2.Service
      const resolver = yield* SessionCommand.Service
      const reviewer = AgentV2.ID.make("reviewer")
      yield* agents.transform((draft) =>
        draft.update(reviewer, (agent) => {
          agent.mode = "subagent"
        }),
      )
      yield* commands.transform((draft) => {
        draft.update("inline", (command) => {
          command.template = "Inspect !`git status`"
        })
        draft.update("review", (command) => {
          command.template = "Review"
          command.agent = reviewer
        })
      })

      expect(yield* resolver.resolve({ command: "inline", arguments: "" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionCommand.UnsupportedError,
      )
      expect(yield* resolver.resolve({ command: "review", arguments: "" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionCommand.UnsupportedError,
      )
    }),
  )

  it.effect("returns an actionable command registry error without admitting fallback text", () =>
    Effect.gen(function* () {
      const commands = yield* CommandV2.Service
      const resolver = yield* SessionCommand.Service
      yield* commands.transform((draft) =>
        draft.update("known", (command) => {
          command.template = "Known"
        }),
      )

      expect(yield* resolver.resolve({ command: "missing", arguments: "" }).pipe(Effect.flip)).toEqual(
        new SessionCommand.NotFoundError({ command: "missing", available: ["known"] }),
      )
    }),
  )
})
