import { castDraft, produce } from "immer"
import { DateTime, Effect } from "effect"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"

export type MemoryState = {
  messages: SessionMessage.Message[]
}

/** The scalar fields a settled step writes on an assistant message. `snapshot` merges into the stored one. */
export type AssistantFields = {
  readonly completed?: DateTime.Utc
  readonly finish?: string
  readonly cost?: number
  readonly tokens?: SessionMessage.Assistant["tokens"]
  readonly error?: SessionMessage.Assistant["error"]
  readonly snapshot?: {
    readonly end: string | undefined
    readonly files: NonNullable<SessionMessage.Assistant["snapshot"]>["files"]
  }
}

/**
 * Assistant messages change through a closed set of patch operations so an adapter never has to read,
 * rebuild or rewrite the parts an event does not touch. Every operation is a no-op when the message is
 * missing or is not an assistant message of this Session.
 */
export interface Adapter {
  /** Newest assistant message that has not completed, or undefined when the newest one has. */
  readonly getCurrentAssistantID: () => Effect.Effect<SessionMessage.ID | undefined>
  /** Newest part of the message with this type and id. */
  readonly getPart: (
    messageID: SessionMessage.ID,
    type: SessionMessage.AssistantContent["type"],
    id: string,
  ) => Effect.Effect<SessionMessage.AssistantContent | undefined>
  readonly appendPart: (messageID: SessionMessage.ID, part: SessionMessage.AssistantContent) => Effect.Effect<void>
  /** Replaces the newest part with the same type and id as `part`. */
  readonly replacePart: (messageID: SessionMessage.ID, part: SessionMessage.AssistantContent) => Effect.Effect<void>
  readonly setFields: (messageID: SessionMessage.ID, fields: AssistantFields) => Effect.Effect<void>
  /** Marks completed tool parts of these calls that are not already marked; the first mark wins. */
  readonly markPruned: (
    messageID: SessionMessage.ID,
    callIDs: ReadonlySet<string>,
    timestamp: DateTime.Utc,
  ) => Effect.Effect<void>
  readonly getCurrentShell: (callID: string) => Effect.Effect<SessionMessage.Shell | undefined>
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Message) => Effect.Effect<void>
}

export function memory(state: MemoryState): Adapter {
  const assistantIndex = (messageID: SessionMessage.ID) =>
    state.messages.findLastIndex((message) => message.id === messageID)
  // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
  const latestAssistantIndex = () => state.messages.findLastIndex((message) => message.type === "assistant")
  const activeShellIndex = (callID: string) =>
    state.messages.findLastIndex((message) => message.type === "shell" && message.callID === callID)
  const assistant = (messageID: SessionMessage.ID) => {
    const message = state.messages[assistantIndex(messageID)]
    return message?.type === "assistant" ? message : undefined
  }
  const partIndex = (message: SessionMessage.Assistant, type: SessionMessage.AssistantContent["type"], id: string) =>
    message.content.findLastIndex((part) => part.type === type && part.id === id)
  const patch = (
    messageID: SessionMessage.ID,
    recipe: (message: SessionMessage.Assistant) => SessionMessage.Assistant,
  ) =>
    Effect.sync(() => {
      const index = assistantIndex(messageID)
      const current = state.messages[index]
      if (current?.type !== "assistant") return
      state.messages[index] = recipe(current)
    })

  return {
    getCurrentAssistantID() {
      return Effect.sync(() => {
        const assistant = state.messages[latestAssistantIndex()]
        return assistant?.type === "assistant" && !assistant.time.completed ? assistant.id : undefined
      })
    },
    getPart(messageID, type, id) {
      return Effect.sync(() => {
        const message = assistant(messageID)
        if (!message) return
        return message.content[partIndex(message, type, id)]
      })
    },
    appendPart(messageID, part) {
      return patch(messageID, (message) => produce(message, (draft) => void draft.content.push(castDraft(part))))
    },
    replacePart(messageID, part) {
      return patch(messageID, (message) => {
        const index = partIndex(message, part.type, part.id)
        if (index < 0) return message
        return produce(message, (draft) => void (draft.content[index] = castDraft(part)))
      })
    },
    setFields(messageID, fields) {
      return patch(messageID, (message) =>
        produce(message, (draft) => {
          if (fields.completed !== undefined) draft.time.completed = fields.completed
          if (fields.finish !== undefined) draft.finish = fields.finish
          if (fields.cost !== undefined) draft.cost = fields.cost
          if (fields.tokens !== undefined) draft.tokens = fields.tokens
          if (fields.error !== undefined) draft.error = fields.error
          if (fields.snapshot)
            draft.snapshot = {
              ...draft.snapshot,
              end: fields.snapshot.end,
              files: fields.snapshot.files ? Array.from(fields.snapshot.files) : undefined,
            }
        }),
      )
    },
    markPruned(messageID, callIDs, timestamp) {
      return patch(messageID, (message) =>
        produce(message, (draft) => {
          for (const item of draft.content) {
            if (item.type !== "tool" || !callIDs.has(item.id)) continue
            if (item.state.status !== "completed") continue
            // Re-marking would move the timestamp backwards or forwards on a replay and make the
            // mark's meaning ("when the model stopped seeing this") depend on how many times the
            // event was projected. First mark wins.
            if (item.time.pruned !== undefined) continue
            item.time.pruned = timestamp
          }
        }),
      )
    },
    getCurrentShell(callID) {
      return Effect.sync(() => {
        const index = activeShellIndex(callID)
        if (index < 0) return
        const shell = state.messages[index]
        return shell?.type === "shell" ? shell : undefined
      })
    },
    updateShell(shell) {
      return Effect.sync(() => {
        const index = activeShellIndex(shell.callID)
        if (index < 0) return
        const current = state.messages[index]
        if (current?.type !== "shell") return
        state.messages[index] = shell
      })
    },
    appendMessage(message) {
      return Effect.sync(() => {
        state.messages.push(message)
      })
    },
  }
}

export function update(adapter: Adapter, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    yield* SessionEvent.All.match(event, {
      "session.next.agent.switched": (event) => {
        return adapter.appendMessage(
          SessionMessage.AgentSwitched.make({
            id: event.data.messageID,
            type: "agent-switched",
            metadata: event.metadata,
            agent: event.data.agent,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.model.switched": (event) => {
        return adapter.appendMessage(
          SessionMessage.ModelSwitched.make({
            id: event.data.messageID,
            type: "model-switched",
            metadata: event.metadata,
            model: event.data.model,
            time: { created: event.data.timestamp },
          }),
        )
      },
      // Neither renaming nor relocating a Session changes what was said in it.
      "session.execution.settled": () => Effect.void,
      "session.next.title.updated": () => Effect.void,
      "session.next.moved": () => Effect.void,
      "session.next.harness.proposal.created": () => Effect.void,
      "session.next.harness.proposal.status": () => Effect.void,
      "session.next.harness.snapshot.created": () => Effect.void,
      "session.next.harness.reloaded": () => Effect.void,
      "session.next.prompted": (event) => {
        return adapter.appendMessage(
          SessionMessage.User.make({
            id: event.data.messageID,
            type: "user",
            metadata: event.metadata,
            source: event.data.source,
            text: event.data.prompt.text,
            parts: event.data.prompt.parts,
            files: event.data.prompt.files,
            agents: event.data.prompt.agents,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.prompt.admitted": () => Effect.void,
      "session.next.task.updated": () => Effect.void,
      "session.next.task.operation.updated": () => Effect.void,
      "session.next.context.updated": (event) =>
        adapter.appendMessage(
          SessionMessage.System.make({
            id: event.data.messageID,
            type: "system",
            text: event.data.text,
            time: { created: event.data.timestamp },
          }),
        ),
      "session.next.synthetic": (event) => {
        return adapter.appendMessage(
          SessionMessage.Synthetic.make({
            sessionID: event.data.sessionID,
            text: event.data.text,
            id: event.data.messageID,
            type: "synthetic",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.started": (event) => {
        return adapter.appendMessage(
          SessionMessage.Shell.make({
            id: event.data.messageID,
            type: "shell",
            metadata: event.metadata,
            callID: event.data.callID,
            command: event.data.command,
            timeout: event.data.timeout,
            output: "",
            status: "running",
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.shell.ended": (event) => {
        return Effect.gen(function* () {
          const currentShell = yield* adapter.getCurrentShell(event.data.callID)
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.output = event.data.output
                draft.status = event.data.status
                draft.exitCode = event.data.exitCode
                draft.truncated = event.data.truncated
                draft.error = event.data.error
                draft.time.completed = event.data.timestamp
              }),
            )
          }
        })
      },
      "session.next.step.started": (event) => {
        return Effect.gen(function* () {
          const currentAssistantID = yield* adapter.getCurrentAssistantID()
          if (currentAssistantID) yield* adapter.setFields(currentAssistantID, { completed: event.data.timestamp })
          yield* adapter.appendMessage(
            SessionMessage.Assistant.make({
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              time: { created: event.data.timestamp },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        })
      },
      "session.next.step.ended": (event) => {
        return adapter.setFields(event.data.assistantMessageID, {
          completed: event.data.timestamp,
          finish: event.data.finish,
          cost: event.data.cost,
          tokens: event.data.tokens,
          snapshot:
            event.data.snapshot || event.data.files ? { end: event.data.snapshot, files: event.data.files } : undefined,
        })
      },
      "session.next.step.failed": (event) => {
        return adapter.setFields(event.data.assistantMessageID, {
          completed: event.data.timestamp,
          finish: "error",
          error: event.data.error,
        })
      },
      "session.next.text.started": (event) => {
        return adapter.appendPart(
          event.data.assistantMessageID,
          SessionMessage.AssistantText.make({ type: "text", id: event.data.textID, text: "" }),
        )
      },
      "session.next.text.delta": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "text", event.data.textID)
          if (match?.type !== "text") return
          yield* adapter.replacePart(event.data.assistantMessageID, { ...match, text: match.text + event.data.delta })
        })
      },
      "session.next.text.ended": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "text", event.data.textID)
          if (match?.type !== "text") return
          yield* adapter.replacePart(event.data.assistantMessageID, { ...match, text: event.data.text })
        })
      },
      "session.next.tool.input.started": (event) => {
        return adapter.appendPart(
          event.data.assistantMessageID,
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: event.data.callID,
            name: event.data.name,
            time: { created: event.data.timestamp },
            state: SessionMessage.ToolStatePending.make({ status: "pending", input: "" }),
          }),
        )
      },
      "session.next.tool.input.delta": () => Effect.void,
      "session.next.tool.input.ended": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "tool", event.data.callID)
          if (match?.type !== "tool" || match.state.status !== "pending") return
          yield* adapter.replacePart(event.data.assistantMessageID, {
            ...match,
            state: { ...match.state, input: event.data.text },
          })
        })
      },
      "session.next.tool.called": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "tool", event.data.callID)
          if (match?.type !== "tool") return
          yield* adapter.replacePart(event.data.assistantMessageID, {
            ...match,
            provider: event.data.provider,
            time: { ...match.time, ran: event.data.timestamp },
            state: SessionMessage.ToolStateRunning.make({
              status: "running",
              input: event.data.input,
              structured: {},
              content: [],
            }),
          })
        })
      },
      "session.next.tool.progress": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "tool", event.data.callID)
          if (match?.type !== "tool" || match.state.status !== "running") return
          yield* adapter.replacePart(event.data.assistantMessageID, {
            ...match,
            state: { ...match.state, structured: event.data.structured, content: [...event.data.content] },
          })
        })
      },
      "session.next.tool.success": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "tool", event.data.callID)
          if (match?.type !== "tool" || match.state.status !== "running") return
          yield* adapter.replacePart(event.data.assistantMessageID, {
            ...match,
            provider: {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            },
            time: { ...match.time, completed: event.data.timestamp },
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: match.state.input,
              structured: event.data.structured,
              content: [...event.data.content],
              outputPaths: event.data.outputPaths ? [...event.data.outputPaths] : [],
              result: event.data.result,
            }),
          })
        })
      },
      "session.next.tool.failed": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "tool", event.data.callID)
          if (match?.type !== "tool" || (match.state.status !== "pending" && match.state.status !== "running")) return
          yield* adapter.replacePart(event.data.assistantMessageID, {
            ...match,
            provider: {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            },
            time: { ...match.time, completed: event.data.timestamp },
            state: SessionMessage.ToolStateError.make({
              status: "error",
              error: event.data.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.data.result,
            }),
          })
        })
      },
      "session.next.reasoning.started": (event) => {
        return adapter.appendPart(
          event.data.assistantMessageID,
          SessionMessage.AssistantReasoning.make({
            type: "reasoning",
            id: event.data.reasoningID,
            text: "",
            providerMetadata: event.data.providerMetadata,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.reasoning.delta": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "reasoning", event.data.reasoningID)
          if (match?.type !== "reasoning") return
          yield* adapter.replacePart(event.data.assistantMessageID, { ...match, text: match.text + event.data.delta })
        })
      },
      "session.next.reasoning.ended": (event) => {
        return Effect.gen(function* () {
          const match = yield* adapter.getPart(event.data.assistantMessageID, "reasoning", event.data.reasoningID)
          if (match?.type !== "reasoning") return
          yield* adapter.replacePart(event.data.assistantMessageID, {
            ...match,
            text: event.data.text,
            time: { created: match.time?.created ?? event.data.timestamp, completed: event.data.timestamp },
            providerMetadata: event.data.providerMetadata ?? match.providerMetadata,
          })
        })
      },
      "session.next.retried": () => Effect.void,
      "session.next.compaction.started": () => Effect.void,
      "session.next.compaction.delta": () => Effect.void,
      "session.next.compaction.ended": (event) => {
        return adapter.appendMessage(
          SessionMessage.Compaction.make({
            id: event.data.messageID,
            type: "compaction",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: event.data.text,
            recent: event.data.recent,
            // Undefined for every checkpoint written before the ledger landed, and for one whose
            // extraction produced nothing. Both stay ledger-less rather than gaining an empty one.
            ledger: event.data.ledger,
            throughSeq: event.data.throughSeq,
            time: { created: event.data.timestamp },
          }),
        )
      },
      "session.next.compaction.failed": () => Effect.void,
      "session.next.compaction.pruned": (event) => {
        // Mark only -- `state.content` is deliberately left intact, exactly as V1 did
        // (`forge/src/session/compaction.ts:281` set `state.time.compacted` and left the output in
        // the store). The point of prune is that the model stops seeing the output while the user
        // keeps their history: labelled, not deleted. It also keeps `pruneEntries` free to
        // re-derive the same decision from the stored transcript on the next turn.
        const grouped = new Map<SessionMessage.ID, Set<string>>()
        for (const entry of event.data.entries) {
          const calls = grouped.get(entry.assistantMessageID)
          if (calls) calls.add(entry.callID)
          else grouped.set(entry.assistantMessageID, new Set([entry.callID]))
        }
        return Effect.forEach(grouped, ([messageID, calls]) =>
          adapter.markPruned(messageID, calls, event.data.timestamp),
        ).pipe(Effect.asVoid)
      },
      "session.next.revert.staged": () => Effect.void,
      "session.next.revert.cleared": () => Effect.void,
      "session.next.revert.committed": () => Effect.void,
      "session.next.goal.updated": () => Effect.void,
      "session.next.goal.cleared": () => Effect.void,
    })
  })
}

export * as SessionMessageUpdater from "./message-updater"
