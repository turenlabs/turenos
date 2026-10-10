import { finite, id, record, string } from "./guards"
import type { Assistant, Change, Data } from "./types"

/** `session.next.step.started`: the first sight of an assistant message. */
export function stepStarted(d: Data, info: Assistant | undefined, settled: boolean): Change | undefined {
  if (
    !string(d.agent) ||
    !record(d.model) ||
    !id(d.model.id) ||
    !id(d.model.providerID) ||
    (d.model.variant !== undefined && !string(d.model.variant))
  )
    return
  if (info) return
  return {
    settled,
    info: {
      id: d.assistantMessageID,
      type: "assistant",
      agent: d.agent,
      model: {
        id: d.model.id,
        providerID: d.model.providerID,
        ...(d.model.variant === undefined ? {} : { variant: d.model.variant }),
      },
      content: [],
      time: { created: d.timestamp },
    },
  }
}

/** `session.next.step.ended` and `.failed` settle the message. */
export function stepSettled(type: string, d: Data, info: Assistant | undefined, settled: boolean): Change | undefined {
  if (!info || settled) return
  if (type === "session.next.step.failed") {
    if (!record(d.error) || d.error.type !== "unknown" || !string(d.error.message)) return
    return {
      settled: true,
      info: {
        ...info,
        finish: "error",
        error: { type: "unknown", message: d.error.message },
        time: { ...info.time, completed: d.timestamp },
      },
    }
  }
  if (
    !string(d.finish) ||
    !finite(d.cost) ||
    !record(d.tokens) ||
    !finite(d.tokens.input) ||
    !finite(d.tokens.output) ||
    !finite(d.tokens.reasoning) ||
    !record(d.tokens.cache) ||
    !finite(d.tokens.cache.read) ||
    !finite(d.tokens.cache.write)
  )
    return
  return {
    settled: true,
    info: {
      ...info,
      finish: d.finish,
      cost: d.cost,
      tokens: {
        input: d.tokens.input,
        output: d.tokens.output,
        reasoning: d.tokens.reasoning,
        cache: { read: d.tokens.cache.read, write: d.tokens.cache.write },
      },
      time: { ...info.time, completed: d.timestamp },
    },
  }
}
