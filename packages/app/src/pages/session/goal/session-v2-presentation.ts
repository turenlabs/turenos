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

export type SessionV2TimelineProjection = SessionV2Presentation & {
  ownedMessageIDs: Set<string>
  removedMessageIDs: string[]
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
      // Board updates are admitted as user-context inputs so the model can reconcile them, but
      // they are internal coordination traffic rather than a turn the user authored.
      if (message.source === "subagent_board") return
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
            name: "UnknownError",
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
    if (pending.source === "subagent_board") return
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

export function mergeSessionV2Presentation(input: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  previousOwnedMessageIDs: Set<string>
  presentation: SessionV2Presentation
  preservedMessageIDs?: Set<string>
  removeMissing?: boolean
}): SessionV2TimelineProjection {
  const incoming = new Set(input.presentation.messages.map((message) => message.id))
  const preserved = input.preservedMessageIDs ?? new Set<string>()
  const messages =
    input.removeMissing === false
      ? mergeIncrementalMessages(input.messages, input.presentation.messages)
      : mergeIncrementalMessages(
          input.messages.filter(
            (message) =>
              (!input.previousOwnedMessageIDs.has(message.id) || preserved.has(message.id)) &&
              !incoming.has(message.id),
          ),
          input.presentation.messages,
        )
  const parts =
    input.removeMissing === false
      ? mergeIncrementalParts(input.parts, input.presentation.parts)
      : [
          ...Object.entries(input.parts).flatMap(([messageID, value]) => {
            if (
              !value ||
              (input.previousOwnedMessageIDs.has(messageID) && !preserved.has(messageID)) ||
              incoming.has(messageID)
            )
              return []
            return [{ id: messageID, parts: value }]
          }),
          ...input.presentation.parts,
        ]

  return {
    messages,
    parts,
    ownedMessageIDs:
      input.removeMissing === false ? new Set([...input.previousOwnedMessageIDs, ...incoming]) : incoming,
    removedMessageIDs:
      input.removeMissing === false
        ? []
        : [...input.previousOwnedMessageIDs].filter((id) => !incoming.has(id) && !preserved.has(id)),
  }
}

function mergeIncrementalMessages(current: Message[], incoming: Message[]) {
  const incomingIDs = new Set(incoming.map((message) => message.id))
  const preserved = current.filter((message) => !incomingIDs.has(message.id))
  const messages = incoming.slice()
  preserved.toReversed().forEach((message) => {
    const index = messages.findIndex((item) => item.time.created >= message.time.created)
    if (index === -1) messages.push(message)
    else messages.splice(index, 0, message)
  })
  return messages
}

function mergeIncrementalParts(
  current: Record<string, Part[] | undefined>,
  incoming: Array<{ id: string; parts: Part[] }>,
) {
  const parts = new Map(
    Object.entries(current).flatMap(([messageID, value]) => (value ? [[messageID, value] as const] : [])),
  )
  incoming.forEach((entry) => parts.set(entry.id, entry.parts))
  return [...parts].map(([id, value]) => ({ id, parts: value }))
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

function presentTool(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const metadata = {
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
