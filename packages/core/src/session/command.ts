export * as SessionCommand from "./command"

import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { CommandV2 } from "../command"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SkillV2 } from "../skill"
import { PromptInput } from "@turenlabs/schema/prompt-input"
import { TextPartID } from "./prompt"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionCommand.NotFoundError", {
  command: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    const hint = this.available.length ? ` Available commands: ${this.available.join(", ")}` : ""
    return `Command not found: "${this.command}".${hint}`
  }
}

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()(
  "SessionCommand.AgentNotFoundError",
  {
    command: Schema.String,
    agent: Schema.String,
  },
) {
  override get message() {
    return `Command "${this.command}" references unavailable agent "${this.agent}"`
  }
}

export class UnsupportedError extends Schema.TaggedErrorClass<UnsupportedError>()("SessionCommand.UnsupportedError", {
  command: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Command "${this.command}" is not supported by the durable Session runtime: ${this.reason}`
  }
}

export type Error = NotFoundError | AgentNotFoundError | UnsupportedError

export type ResolveInput = {
  readonly command: string
  readonly arguments: string
  readonly agent?: AgentV2.ID
  readonly sessionAgent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly files?: ReadonlyArray<PromptInput.FileAttachment>
}

export type Resolved = {
  readonly prompt: PromptInput.Prompt
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
}

export interface Interface {
  readonly resolve: (input: ResolveInput) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionCommand") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const commands = yield* CommandV2.Service
    const agents = yield* AgentV2.Service
    const skills = yield* SkillV2.Service

    return Service.of({
      resolve: Effect.fn("SessionCommand.resolve")(function* (input) {
        const configured = yield* commands.get(input.command)
        const skill = configured ? undefined : (yield* skills.list()).find((item) => item.name === input.command)
        const command = configured ?? skillCommand(skill)
        if (!command)
          return yield* new NotFoundError({
            command: input.command,
            available: [
              ...(yield* commands.list()).map((item) => item.name),
              ...(yield* skills.list()).map((item) => item.name),
            ].toSorted(),
          })
        if (inlineShell.test(command.template))
          return yield* new UnsupportedError({
            command: input.command,
            reason:
              "inline shell interpolation is disabled because it cannot be reconciled safely after an interrupted retry",
          })

        const selectedAgent = command.agent ?? input.agent
        const agent = selectedAgent ? yield* agents.get(AgentV2.ID.make(selectedAgent)) : undefined
        if (selectedAgent && !agent)
          return yield* new AgentNotFoundError({ command: input.command, agent: selectedAgent })
        if (command.subtask === true || (agent?.mode === "subagent" && command.subtask !== false))
          return yield* new UnsupportedError({
            command: input.command,
            reason: "subtask commands require the durable subagent runtime",
          })
        const skillAgent = skill ? (agent ?? (yield* agents.resolve(input.sessionAgent))) : undefined
        if (skill && skillAgent && (skillAgent.tools === false || SkillV2.available([skill], skillAgent).length === 0))
          return yield* new UnsupportedError({
            command: input.command,
            reason: "the selected agent cannot load this skill",
          })

        const raw = input.arguments.match(argument) ?? []
        const values = raw.map((value) => value.replace(trimQuotes, ""))
        const placeholders = command.template.match(positional) ?? []
        const last = placeholders.reduce((maximum, item) => Math.max(maximum, Number(item.slice(1))), 0)
        const expanded = command.template.replaceAll(positional, (_, index: string) => {
          const position = Number(index)
          if (position > values.length) return ""
          return position === last ? values.slice(position - 1).join(" ") : (values[position - 1] ?? "")
        })
        const hasArguments = command.template.includes("$ARGUMENTS")
        const replaced = expanded.replaceAll("$ARGUMENTS", input.arguments)
        const details = input.arguments.trim()
        const text =
          placeholders.length === 0 && !hasArguments && details ? `${replaced}\n\n${input.arguments}` : replaced
        if (!text.trim())
          return yield* new UnsupportedError({ command: input.command, reason: "the expanded command is empty" })

        const invocation = skill ? `/${skill.name}${details ? ` ${details}` : ""}` : undefined
        const prompt = invocation
          ? {
              text: invocation,
              parts: [
                { id: TextPartID.create(), text: invocation },
                { id: TextPartID.create(), text: command.template, synthetic: true },
              ],
              ...(input.files?.length ? { files: [...input.files] } : {}),
            }
          : {
              text: text.trim(),
              ...(input.files?.length ? { files: [...input.files] } : {}),
            }

        return {
          prompt,
          ...(selectedAgent ? { agent: AgentV2.ID.make(selectedAgent) } : {}),
          ...(command.model
            ? { model: command.model }
            : command.agent && agent?.model
              ? { model: agent.model }
              : input.model
                ? { model: input.model }
                : {}),
        }
      }),
    })
  }),
)

const inlineShell = /!`[^`]+`/
const argument = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const positional = /\$(\d+)/g
const trimQuotes = /^["']|["']$/g

function skillCommand(skill: SkillV2.Info | undefined) {
  if (!skill) return undefined
  return {
    name: skill.name,
    description: skill.description,
    template: `Use the \`${skill.name}\` skill for this request. Invoke it with the skill tool before doing the work.`,
    agent: undefined,
    model: undefined,
    source: "skill" as const,
    subtask: false,
    hints: [],
  }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [CommandV2.node, AgentV2.node, SkillV2.node],
})
