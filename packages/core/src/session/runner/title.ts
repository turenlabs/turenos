export * as SessionRunnerTitle from "./title"

import { LLM, Message, type LLMClientShape } from "@turenlabs/llm"
import { Cause, DateTime, Duration, Effect } from "effect"
import { AgentV2 } from "../../agent"
import { EventV2 } from "../../event"
import { ToolVisibleError } from "../../tool/visible-error"
import { SessionCreation } from "../creation"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionRunnerModel } from "./model"

/**
 * Names a Session from its opening prompt, once, in the background.
 *
 * Every guarantee here is about staying out of the way. A title is a nicety; the turn that
 * triggered it is not. So this never blocks the turn, never retries inside itself, never leaves a
 * partial write, and never publishes anything at all unless it has a complete title in hand. A
 * Session whose titling fails keeps its placeholder name and is titled by the next turn instead.
 */
export interface Dependencies {
  readonly agents: AgentV2.Interface
  readonly events: EventV2.Interface
  readonly llm: Pick<LLMClientShape, "generate">
  readonly models: SessionRunnerModel.Interface
  readonly store: Pick<SessionStore.Interface, "get" | "context">
}

export interface Interface {
  /**
   * Title `sessionID` if it still needs one. Never fails and never blocks on a second attempt for
   * the same Session; fork it and forget it.
   */
  readonly ensure: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/**
 * A title is one line of at most fifty characters, but a thinking model spends its output budget on
 * reasoning before it emits a single visible token. Sized for the thinking rather than the title:
 * at 64 a DeepSeek-class model finishes on `length` mid-thought and returns no text at all, and the
 * Session keeps its placeholder name with nothing logged to say why.
 */
const MAX_OUTPUT_TOKENS = 2_048
/** The opening request is all the model needs to name the thread. The rest is cost and latency. */
const MAX_PROMPT_CHARS = 4_000
const MAX_TITLE_LENGTH = 100
/**
 * The whole attempt, provider call included. A model that never answers must not hold a fiber, a
 * connection or an in-flight slot open behind the user for longer than the turn itself took.
 */
const TIMEOUT = Duration.seconds(30)

/**
 * Reasoning models emit `<think>` blocks through the same text channel, and small models like to
 * add a preamble. Take the first non-empty line and nothing else.
 */
const clean = (text: string) => {
  const line = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  if (line === undefined) return undefined
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 3)}...` : line
}

/**
 * Subagent Sessions are not user-facing and are already named after the task that spawned them
 * (`SessionTask.resumeSpawn` passes the spawn description as the title), so they fail both halves
 * of this check. Titling them would burn a provider call to overwrite a better name.
 */
const eligible = (session: SessionSchema.Info) =>
  session.parentID === undefined && SessionCreation.isPlaceholderTitle(session.title)

export const make = (dependencies: Dependencies): Interface => {
  /**
   * Process-local and deliberately not durable. Its only job is to stop one Session accumulating
   * concurrent attempts across overlapping runs; losing it to a restart just means the next turn
   * tries again, which is the same recovery path as any other failure.
   */
  const inflight = new Set<SessionSchema.ID>()

  const generate = Effect.fn("SessionRunnerTitle.generate")(function* (sessionID: SessionSchema.ID) {
    const session = yield* dependencies.store.get(sessionID)
    if (!session || !eligible(session)) return
    const context = yield* dependencies.store.context(sessionID)
    const opening = context.find((message): message is SessionMessage.User => message.type === "user")
    const prompt = opening?.text.trim()
    if (!prompt) return
    // The hidden `title` agent has carried PROMPT_TITLE and its deny-everything ruleset since the
    // V2 agent registry landed, with nothing ever selecting it. Select it here rather than
    // inlining a prompt, so configuring `agents.title` keeps working the way it does for every
    // other agent. No system prompt means no registry, which means no titling.
    const selection = yield* dependencies.agents.select(AgentV2.ID.make("title"))
    if (!selection.info?.system) return
    const override = selection.info.model
    const titleSession = override
      ? { ...session, model: override }
      : session.model
        ? {
            ...session,
            // A title is background bookkeeping. Do not inherit the primary turn's expensive
            // reasoning variant, which can consume the whole title timeout before one line lands.
            model: { id: session.model.id, providerID: session.model.providerID },
          }
        : session
    const resolved = yield* dependencies.models.resolve(titleSession, selection.info.request, { defaultVariant: false })
    // `generate`, not `stream`: nobody is watching a title arrive, and one awaited response is one
    // fewer thing that can stall half-consumed. No tools are offered, which matches the agent's
    // ruleset and removes any chance of this turning into a loop.
    const response = yield* dependencies.llm.generate(
      LLM.request({
        model: resolved.model,
        system: selection.info.system,
        messages: [Message.user(`Generate a title for this conversation:\n${prompt.slice(0, MAX_PROMPT_CHARS)}`)],
        tools: [],
        generation: { maxTokens: MAX_OUTPUT_TOKENS },
      }),
    )
    const title = clean(response.text)
    if (!title)
      return yield* Effect.logWarning("Generated no usable Session title").pipe(
        Effect.annotateLogs({
          sessionID,
          finishReason: response.finishReason,
          textChars: response.text.length,
          reasoningChars: response.reasoning.length,
        }),
      )
    // Re-read before writing. Generation takes seconds, and a user who renamed the Session in the
    // meantime outranks the model.
    const current = yield* dependencies.store.get(sessionID)
    if (!current || !eligible(current)) return
    yield* dependencies.events.publish(
      SessionEvent.TitleUpdated,
      { sessionID, timestamp: yield* DateTime.now, title },
      // Explicit placement: this runs on a fiber forked from the runner's layer scope, and
      // `Effect.forkIn` inherits the forking fiber's context rather than the scope's.
      { location: session.location },
    )
  })

  const ensure = (sessionID: SessionSchema.ID) =>
    Effect.suspend(() => {
      if (inflight.has(sessionID)) return Effect.void
      inflight.add(sessionID)
      return generate(sessionID).pipe(
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () =>
            Effect.logWarning("Gave up generating a Session title").pipe(
              Effect.annotateLogs({ sessionID, timeout: Duration.format(TIMEOUT) }),
            ),
        }),
        Effect.catchCause((cause) =>
          // Shutdown interrupts this fiber by design; that is not a failure worth logging.
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Failed to generate a Session title").pipe(
                Effect.annotateLogs({ sessionID, error: ToolVisibleError.make(Cause.squash(cause)) }),
              ),
        ),
        Effect.ensuring(Effect.sync(() => inflight.delete(sessionID))),
      )
    })

  return { ensure }
}
