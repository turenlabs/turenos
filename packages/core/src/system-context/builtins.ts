export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { SessionContextManagement } from "../session/context-management"
import { SessionTodoGuidance } from "../session/todo-guidance"
import { Reflection } from "../reflection"
import { VisualizationGuidance } from "../tool/visualization-guidance"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.project.directory}`,
      `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      "</env>",
    ].join("\n")
    const memoryGuidance = [
      "Durable project memory is available through the memory tools.",
      "Search memory when prior decisions, constraints, preferences, or diagnosed failures may affect the task.",
      "Write memory only for stable information likely to matter in a later session; do not store secrets, routine progress, transient state, or facts already maintained in source-controlled documentation.",
      "Permanently forget memory only when the user explicitly requests it.",
    ].join("\n")
    const responseGuidance = [
      "Use ASD-STE100 Simplified Technical English as the writing guide for all agent-authored English prose, including progress updates, explanations, final answers, and prose written to files.",
      "Use short sentences with one main idea. Use active voice and direct instructions. Keep procedural sentences to 20 words or fewer and descriptive sentences to 25 words or fewer.",
      "Use simple words with one clear meaning. Use the same technical name for the same thing. Avoid idioms, figurative language, jargon, and unnecessary words.",
      "Give each instruction as a separate step. State conditions before actions. Make the actor, action, and object clear.",
      "Preserve code, commands, paths, identifiers, API names, exact quotations, and raw tool output. Keep necessary technical terms and explain unfamiliar terms in simple words.",
      "For other languages or explicitly requested wording, preserve the requested language or wording and use clear, direct prose where possible.",
      "Before sending a response or writing prose to a file, silently check it against this guidance and revise unclear or long sentences. Do not describe this check in the response.",
      "This is STE-guided writing, not verified ASD-STE100 compliance. Do not claim compliance without a check against the standard's rules and approved vocabulary.",
      "Keep every reply as short as the task allows. Lead with the answer or outcome, remove repetition, and omit background the user does not need.",
      "Prefer short paragraphs and compact lists. Use a Markdown table instead of long prose or a long list when several items share comparable fields, but do not use a table for simple information.",
      "Put the most important information first and keep optional detail clearly secondary. Assume the user is scanning, not reading an essay.",
      'Do not reflexively agree with the user or mirror their wording. Avoid filler such as "You\'re right" or "Exactly"; acknowledge only when it adds a concrete fact, and disagree or qualify when evidence warrants it.',
      "When you are about to finish a turn without another tool call, write the response as a useful session handoff.",
      "Lead with one plain-language outcome sentence that stands on its own in a compact session view.",
      "Follow with at most three concise bullets covering concrete results, changed artifacts, or verification that matters to the user.",
      "If the user must act, end with `Next: ...`; if progress is blocked, end with `Blocked: ...`. Otherwise do not invent a next action.",
      "Do not lead with tool logs, implementation narration, or validation command output. Put optional detail after the handoff.",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/visualization-guidance"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(VisualizationGuidance.SYSTEM),
        baseline: (guidance) => guidance,
        update: (_previous, guidance) => guidance,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/response-guidance"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(responseGuidance),
        baseline: (guidance) => guidance,
        update: (_previous, guidance) => guidance,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment].join("\n"),
        update: (_previous, environment) => ["The environment you are running in is now:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Today's date: ${date}`,
        update: (_previous, date) => `Today's date is now: ${date}`,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/memory-guidance"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(memoryGuidance),
        baseline: (guidance) => guidance,
        update: (_previous, guidance) => guidance,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/context-guidance"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(SessionContextManagement.GUIDANCE),
        baseline: (guidance) => guidance,
        update: (_previous, guidance) => guidance,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/todo-guidance"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(SessionTodoGuidance.SYSTEM),
        baseline: (guidance) => guidance,
        update: (_previous, guidance) => guidance,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/reflection-guidance"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(Reflection.GUIDANCE),
        baseline: (guidance) => guidance,
        update: (_previous, guidance) => guidance,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer: builtIns,
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node],
})
