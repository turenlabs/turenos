import { TurnInterruption } from "@turenlabs/client/turn-interruption"
import type {
  FilePart,
  Message,
  Part,
  SessionInputAdmitted,
  SessionMessage,
  SessionMessageAssistantTool,
  ToolPart,
} from "@turenlabs/sdk/v2/client"

export type SessionV2Presentation = {
  messages: Message[]
  parts: Array<{ id: string; parts: Part[] }>
}

type ShellMessage = Extract<SessionMessage, { type: "shell" }> & {
  timeout?: number
  status?: "running" | "completed" | "cancelled" | "timed_out" | "failed"
  exitCode?: number
  truncated?: boolean
  error?: string
}

export function presentSessionV2Messages(input: {
  sessionID: string
  directory: string
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  messages: SessionMessage[]
  pendingInputs?: readonly SessionInputAdmitted[]
}): SessionV2Presentation {
  const messages: Message[] = []
  const parts: Array<{ id: string; parts: Part[] }> = []
  const selection = {
    agent: input.agent,
    model: input.model,
  }
  let userID: string | undefined
  let userIndex: number | undefined

  const appendUser = (
    message: Extract<SessionMessage, { type: "user" }>,
    agent = selection.agent,
    model = selection.model,
  ) => {
    userID = message.id
    userIndex = messages.length
    messages.push({
      id: message.id,
      sessionID: input.sessionID,
      role: "user",
      time: message.time,
      agent,
      model,
    })
    parts.push({
      id: message.id,
      parts: [
        ...(message.parts !== undefined
          ? message.parts.map((part) => ({
              id: part.id,
              sessionID: input.sessionID,
              messageID: message.id,
              type: "text" as const,
              text: part.text,
              synthetic: part.synthetic,
              ignored: part.ignored,
              metadata: part.metadata,
            }))
          : message.text
            ? [
                {
                  id: `${message.id}_text`,
                  sessionID: input.sessionID,
                  messageID: message.id,
                  type: "text" as const,
                  text: message.text,
                },
              ]
            : []),
        ...(message.files ?? []).map(
          (file, index): FilePart => ({
            id: `${message.id}_file_${index}`,
            sessionID: input.sessionID,
            messageID: message.id,
            type: "file",
            mime: file.mime,
            filename: file.name,
            url: file.uri,
            source: file.source
              ? {
                  type: "file",
                  path: file.name ?? file.uri,
                  text: { value: file.source.text, start: file.source.start, end: file.source.end },
                }
              : undefined,
          }),
        ),
        ...(message.agents ?? []).map((attached, index) => ({
          id: `${message.id}_agent_${index}`,
          sessionID: input.sessionID,
          messageID: message.id,
          type: "agent" as const,
          name: attached.name,
          source: attached.source
            ? {
                value: attached.source.text,
                start: attached.source.start,
                end: attached.source.end,
              }
            : undefined,
        })),
      ],
    })
  }

  input.messages.forEach((message) => {
    if (message.type === "agent-switched") {
      selection.agent = message.agent
      return
    }
    if (message.type === "model-switched") {
      selection.model = {
        providerID: message.model.providerID,
        modelID: message.model.id,
        variant: message.model.variant,
      }
      return
    }
    if (message.type === "user") {
      // Background updates are admitted as user-context inputs so the model can reconcile them, but
      // they are internal coordination traffic rather than a turn the user authored.
      if ((message.source ?? "user") !== "user") return
      appendUser(message)
      return
    }
    if (message.type === "shell") {
      const shell = message as ShellMessage
      const assistantID = `${shell.id}_result`
      userID = shell.id
      userIndex = messages.length
      messages.push({
        id: shell.id,
        sessionID: input.sessionID,
        role: "user",
        time: { created: shell.time.created },
        agent: selection.agent,
        model: selection.model,
      })
      parts.push({
        id: shell.id,
        parts: [
          {
            id: `${shell.id}_command`,
            sessionID: input.sessionID,
            messageID: shell.id,
            type: "text",
            text: shell.command,
          },
        ],
      })
      messages.push({
        id: assistantID,
        sessionID: input.sessionID,
        role: "assistant",
        parentID: shell.id,
        time: shell.time,
        modelID: selection.model.modelID,
        providerID: selection.model.providerID,
        variant: selection.model.variant,
        mode: selection.agent,
        agent: selection.agent,
        path: { cwd: input.directory, root: input.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: shell.time.completed ? "tool-calls" : undefined,
      })
      parts.push({ id: assistantID, parts: [presentShell(input.sessionID, assistantID, shell)] })
      return
    }
    if (message.type === "compaction") {
      // Compaction changes model context, while the human transcript retains earlier turns.
      // V1 recorded compaction as a bare `role: "user"` message carrying a single
      // `compaction` part, and the shipped timeline still keys its "Session compacted"
      // divider off exactly that shape (timeline/rows.ts reads `userParts.some(p => p.type
      // === "compaction")`). V2 replaced it with a first-class `type: "compaction"`
      // message, so without this branch the boundary is invisible: the turn silently takes
      // longer, the model quietly forgets, and nothing marks where it happened.
      //
      // `userID` is reassigned so everything the retried turn produces parents to the
      // compaction pseudo-message and therefore renders *below* the divider, instead of
      // being grouped back under the pre-compaction prompt.
      userID = message.id
      userIndex = messages.length
      messages.push({
        id: message.id,
        sessionID: input.sessionID,
        role: "user",
        time: message.time,
        agent: selection.agent,
        model: selection.model,
      })
      parts.push({
        id: message.id,
        parts: [
          {
            id: `${message.id}_compaction`,
            sessionID: input.sessionID,
            messageID: message.id,
            type: "compaction",
            auto: message.reason === "auto",
          },
          {
            id: `${message.id}_summary`,
            sessionID: input.sessionID,
            messageID: message.id,
            type: "text",
            text: message.summary,
            synthetic: true,
            metadata: { compactionSummary: true },
          },
        ],
      })
      return
    }
    if (message.type !== "assistant" || !userID) return

    if (userIndex !== undefined) {
      const parent = messages[userIndex]
      if (parent?.role === "user")
        messages[userIndex] = {
          ...parent,
          agent: message.agent,
          model: {
            providerID: message.model.providerID,
            modelID: message.model.id,
            variant: message.model.variant,
          },
        }
    }

    messages.push({
      id: message.id,
      sessionID: input.sessionID,
      role: "assistant",
      time: message.time,
      parentID: userID,
      modelID: message.model.id,
      providerID: message.model.providerID,
      variant: message.model.variant,
      mode: message.agent,
      agent: message.agent,
      path: { cwd: input.directory, root: input.directory },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: message.finish,
      error: message.error
        ? {
            name: TurnInterruption.isTurnInterrupted(message.error.message) ? "MessageAbortedError" : "UnknownError",
            data: { message: message.error.message },
          }
        : undefined,
    })
    parts.push({
      id: message.id,
      parts: message.content.map((content): Part => {
        if (content.type === "text")
          return {
            id: content.id,
            sessionID: input.sessionID,
            messageID: message.id,
            type: "text",
            text: content.text,
          }
        if (content.type === "reasoning")
          return {
            id: content.id,
            sessionID: input.sessionID,
            messageID: message.id,
            type: "reasoning",
            text: content.text,
            metadata: content.providerMetadata,
            time: {
              start: content.time?.created ?? message.time.created,
              end: content.time?.completed,
            },
          }
        return presentTool(input.sessionID, message.id, content)
      }),
    })
  })

  const projected = new Set(messages.map((message) => message.id))
  input.pendingInputs?.forEach((pending) => {
    if (projected.has(pending.id)) return
    if ((pending.source ?? "user") !== "user") return
    projected.add(pending.id)
    appendUser(
      {
        id: pending.id,
        type: "user",
        text: pending.prompt.text,
        parts: pending.prompt.parts,
        files: pending.prompt.files,
        agents: pending.prompt.agents,
        time: { created: pending.timeCreated },
      },
      pending.agent ?? selection.agent,
      pending.model
        ? {
            providerID: pending.model.providerID,
            modelID: pending.model.id,
            variant: pending.model.variant,
          }
        : selection.model,
    )
  })

  return { messages, parts }
}

/**
 * True when `part` is a lean-page stub: the server elided the tool body (`content`/`structured`
 * past the wire threshold) and the full row is fetched on expand via `session.message`.
 */
export function isSessionV2ToolStub(part: Part): boolean {
  if (part.type !== "tool") return false
  const truncated = part.metadata?.truncated
  return typeof truncated === "object" && truncated !== null
}

/**
 * Tool lifecycle events can reach the renderer while a snapshot is in flight. Keep the furthest
 * lifecycle state, and keep a fully loaded body when the incoming copy is a stub of the same state.
 */
export function mergeSessionV2Parts(current: readonly Part[] | undefined, incoming: Part[]): Part[] {
  if (!current?.length || incoming.length === 0) return incoming
  const needsComparison = (part: Part): part is ToolPart =>
    part.type === "tool" && (toolStage(part) < 2 || isSessionV2ToolStub(part))
  // Large batches repay building the index; unrelated incoming parts do not.
  const comparisons = current.length * incoming.length > 4_096 ? incoming.filter(needsComparison).length : 0
  const indices =
    current.length * comparisons > 4_096
      ? { byID: new Map<string, number>(), byCallID: new Map<string, number>() }
      : undefined
  if (indices) {
    current.forEach((part, index) => {
      if (!indices.byID.has(part.id)) indices.byID.set(part.id, index)
      if (part.type === "tool" && !indices.byCallID.has(part.callID)) indices.byCallID.set(part.callID, index)
    })
  }

  return incoming.map((part) => {
    if (!needsComparison(part)) return part
    const existing = indices
      ? current[Math.min(indices.byID.get(part.id) ?? Infinity, indices.byCallID.get(part.callID) ?? Infinity)]
      : current.find((item) => item.id === part.id || (item.type === "tool" && item.callID === part.callID))
    if (existing?.type !== "tool") return part
    if (toolStage(existing) > toolStage(part)) return existing
    if (
      toolStage(existing) === toolStage(part) &&
      part.state.status !== "pending" &&
      isSessionV2ToolStub(part) &&
      !isSessionV2ToolStub(existing)
    )
      return existing
    return part
  })
}

function toolStage(part: ToolPart) {
  if (part.state.status === "pending") return 0
  if (part.state.status === "running") return 1
  return 2
}

export function mergeSessionV2Messages(input: {
  messages: Message[]
  incoming: Message[]
  previousOwnedMessageIDs: Set<string>
  preservedMessageIDs?: Set<string>
  removeMissing?: boolean
}) {
  const incoming = new Set(input.incoming.map((message) => message.id))
  const preserved = input.preservedMessageIDs ?? new Set<string>()
  const staleAssistants = new Set<string>()
  const current =
    input.removeMissing === false
      ? input.messages
      : input.messages.filter(
          (message) =>
            incoming.has(message.id) || !input.previousOwnedMessageIDs.has(message.id) || preserved.has(message.id),
        )

  return {
    messages: mergeIncrementalMessages(current, input.incoming, staleAssistants),
    staleAssistants,
    ownedMessageIDs:
      input.removeMissing === false ? new Set([...input.previousOwnedMessageIDs, ...incoming]) : incoming,
    removedMessageIDs:
      input.removeMissing === false
        ? []
        : [...input.previousOwnedMessageIDs].filter((id) => !incoming.has(id) && !preserved.has(id)),
  }
}

/**
 * Splice the two time-ordered lists by `time.created`, deduplicating on `id`. Incoming rows win
 * unless they would reopen a settled assistant step. For equal timestamps, existing rows that
 * have no incoming copy stay ahead of the incoming row.
 */
export function mergeIncrementalMessages(current: Message[], incoming: Message[], staleAssistants?: Set<string>) {
  if (current.length === 0) return incoming
  const incomingIDs = new Map(incoming.map((message, index) => [message.id, index]))
  let resolved = incoming
  const remaining = current.filter((message) => {
    const match = incomingIDs.get(message.id)
    if (match === undefined) return true
    const next = incoming[match]
    if (
      message.role === "assistant" &&
      message.time.completed !== undefined &&
      next?.role === "assistant" &&
      next.time.completed === undefined
    ) {
      if (resolved === incoming) resolved = incoming.slice()
      // An older page may know the real parent even when its copy of this step is stale.
      resolved[match] = { ...message, parentID: next.parentID }
      staleAssistants?.add(message.id)
    }
    return false
  })
  const merged: Message[] = []
  let index = 0
  for (const message of remaining) {
    while (index < incoming.length && incoming[index]!.time.created < message.time.created) {
      merged.push(resolved[index]!)
      index += 1
    }
    merged.push(message)
  }
  merged.push(...resolved.slice(index))
  return merged
}

function presentShell(sessionID: string, messageID: string, shell: ShellMessage): ToolPart {
  const base = {
    id: shell.callID,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: shell.callID,
    tool: "bash",
  }
  const input = { command: shell.command, ...(shell.timeout === undefined ? {} : { timeout: shell.timeout }) }
  const metadata = {
    output: shell.output,
    ...(shell.exitCode === undefined ? {} : { exit: shell.exitCode }),
    ...(shell.truncated === undefined ? {} : { truncated: shell.truncated }),
    ...(shell.status === undefined ? {} : { status: shell.status }),
  }
  if (!shell.time.completed || shell.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input,
        title: "",
        metadata,
        time: { start: shell.time.created },
      },
    }
  if (shell.status === "failed" || shell.status === "cancelled" || shell.status === "timed_out")
    return {
      ...base,
      state: {
        status: "error",
        input,
        error: shell.error ?? shell.output,
        metadata,
        time: { start: shell.time.created, end: shell.time.completed },
      },
    }
  return {
    ...base,
    state: {
      status: "completed",
      input,
      output: shell.output,
      title: "",
      metadata,
      time: { start: shell.time.created, end: shell.time.completed },
    },
  }
}

export function presentTool(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const metadata = {
    // `truncated` marks a lean-page stub: the server elided this tool's body and the full row is
    // fetched on expand. It rides part metadata so merge guards can tell stubs from full parts.
    ...(tool.truncated === undefined ? {} : { truncated: tool.truncated }),
    ...(tool.provider?.executed ? { providerExecuted: true } : {}),
    ...(tool.provider?.metadata ?? {}),
    ...(tool.time.pruned ? { prunedAt: tool.time.pruned } : {}),
  }
  const base = {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: tool.id,
    tool: tool.name,
    metadata,
  }
  if (tool.state.status === "pending")
    return {
      ...base,
      state: {
        status: "pending",
        input: {},
        raw: tool.state.input,
      },
    }
  if (tool.state.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input: tool.state.input,
        title: tool.name,
        metadata: {
          structured: tool.state.structured,
          output: toolOutput(tool.state.content),
        },
        time: { start: tool.time.ran ?? tool.time.created },
      },
    }
  if (tool.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: tool.state.input,
        error: tool.state.error.message,
        metadata: {
          structured: tool.state.structured,
          output: toolOutput(tool.state.content),
        },
        time: {
          start: tool.time.ran ?? tool.time.created,
          end: tool.time.completed ?? tool.time.ran ?? tool.time.created,
        },
      },
    }
  return {
    ...base,
    state: {
      status: "completed",
      input: tool.state.input,
      output: toolOutput(tool.state.content),
      title: tool.name,
      metadata: {
        structured: tool.state.structured,
        outputPaths: tool.state.outputPaths,
        result: tool.state.result,
      },
      time: {
        start: tool.time.ran ?? tool.time.created,
        end: tool.time.completed ?? tool.time.ran ?? tool.time.created,
        compacted: tool.time.pruned,
      },
      attachments: (tool.state.attachments ?? []).map((file, index) => ({
        id: `${tool.id}_file_${index}`,
        sessionID,
        messageID,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
      })),
    },
  }
}

function toolOutput(
  content: SessionMessageAssistantTool["state"] extends infer State
    ? State extends { content: infer Content }
      ? Content
      : never
    : never,
) {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (item.type === "text") return item.text
      return item.name ? `[${item.name}](${item.uri})` : item.uri
    })
    .join("\n")
}
