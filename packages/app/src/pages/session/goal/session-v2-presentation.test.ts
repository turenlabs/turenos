import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionInputAdmitted, SessionMessage } from "@turenlabs/sdk/v2/client"
import { MessageComment } from "../timeline/message-comment"
import {
  mergeSessionV2Presentation,
  presentSessionV2Messages,
  type SessionV2Presentation,
} from "./session-v2-presentation"

const present = (messages: SessionMessage[], pendingInputs?: SessionInputAdmitted[]) =>
  presentSessionV2Messages({
    sessionID: "ses_goal",
    directory: "/repo",
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    messages,
    pendingInputs,
  })

// The exact predicate the shipped timeline uses to emit its "Session compacted" divider
// (timeline/rows.ts: `userParts.some((p) => p.type === "compaction")` on a user message).
// Asserted here rather than by driving constructMessageRows directly, because that module
// pulls in session-ui, whose Shiki worker is a Vite-only `?worker&url` import that bun
// cannot resolve. Rendering behavior is covered by the browser-facing session tests.
const dividerTurns = (presentation: SessionV2Presentation) =>
  presentation.messages
    .filter((message) => message.role === "user")
    .filter((message) =>
      (presentation.parts.find((entry) => entry.id === message.id)?.parts ?? []).some(
        (part) => part.type === "compaction",
      ),
    )
    .map((message) => message.id)

const user: SessionMessage = {
  id: "msg_user",
  type: "user",
  text: "Ship the goal",
  time: { created: 1 },
  files: [{ uri: "data:text/plain;base64,Zm9yZ2U=", mime: "text/plain", name: "goal.txt" }],
}

describe("presentSessionV2Messages", () => {
  test("adapts V2 user and assistant context into the existing timeline model", () => {
    const result = present([
      user,
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
        time: { created: 2, completed: 4 },
        finish: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 2, cache: { read: 3, write: 0 } },
        content: [
          { id: "text_1", type: "text", text: "Done" },
          { id: "reason_1", type: "reasoning", text: "Checked", time: { created: 2, completed: 3 } },
        ],
      },
    ])

    expect(result.messages).toEqual([
      expect.objectContaining({ id: "msg_user", role: "user" }),
      expect.objectContaining({
        id: "msg_assistant",
        role: "assistant",
        parentID: "msg_user",
        tokens: { input: 10, output: 20, reasoning: 2, cache: { read: 3, write: 0 } },
      }),
    ])
    expect(result.parts.find((item) => item.id === "msg_user")?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Ship the goal" }),
      expect.objectContaining({ type: "file", filename: "goal.txt" }),
    ])
    expect(result.parts.find((item) => item.id === "msg_assistant")?.parts).toEqual([
      expect.objectContaining({ id: "text_1", type: "text", text: "Done" }),
      expect.objectContaining({ id: "reason_1", type: "reasoning", text: "Checked" }),
    ])
  })

  test("carries agent/model switches into subsequent user presentation", () => {
    const result = present([
      { id: "msg_agent", type: "agent-switched", agent: "research", time: { created: 1 } },
      {
        id: "msg_model",
        type: "model-switched",
        model: { providerID: "other", id: "next", variant: "high" },
        time: { created: 2 },
      },
      { ...user, time: { created: 3 } },
    ])

    expect(result.messages).toEqual([
      expect.objectContaining({
        agent: "research",
        model: { providerID: "other", modelID: "next", variant: "high" },
      }),
    ])
  })

  test("restores durable pending inputs after a fresh transcript load", () => {
    const result = present(
      [
        user,
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "provider", id: "model" },
          time: { created: 2, completed: 3 },
          content: [{ id: "text_1", type: "text", text: "Still working" }],
        },
      ],
      [
        {
          admittedSeq: 4,
          id: "msg_queued",
          sessionID: "ses_goal",
          prompt: {
            text: "Use the faster path",
            files: [{ uri: "data:text/plain;base64,ZmFzdA==", mime: "text/plain", name: "hint.txt" }],
          },
          delivery: "queue",
          agent: "research",
          model: { providerID: "other", id: "next", variant: "high" },
          timeCreated: 4,
        },
      ],
    )

    expect(result.messages.at(-1)).toMatchObject({
      id: "msg_queued",
      role: "user",
      time: { created: 4 },
      agent: "research",
      model: { providerID: "other", modelID: "next", variant: "high" },
    })
    expect(result.parts.at(-1)).toEqual({
      id: "msg_queued",
      parts: [
        expect.objectContaining({ type: "text", text: "Use the faster path" }),
        expect.objectContaining({ type: "file", filename: "hint.txt" }),
      ],
    })
  })

  test("does not duplicate an input that was promoted during snapshot loading", () => {
    const result = present(
      [user],
      [
        {
          admittedSeq: 1,
          id: user.id,
          sessionID: "ses_goal",
          prompt: { text: user.text },
          delivery: "queue",
          timeCreated: 1,
        },
      ],
    )

    expect(result.messages.map((message) => message.id)).toEqual([user.id])
    expect(result.parts.map((entry) => entry.id)).toEqual([user.id])
  })

  test("uses the assistant route as the authoritative user-message receipt", () => {
    const result = present([
      user,
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "other", id: "next", variant: "high" },
        time: { created: 2, completed: 3 },
        content: [{ id: "text_1", type: "text", text: "Done" }],
      },
    ])

    expect(result.messages[0]).toMatchObject({
      role: "user",
      agent: "build",
      model: { providerID: "other", modelID: "next", variant: "high" },
    })
  })

  test("parents every assistant in a long alternating transcript to its current user", () => {
    const transcript = Array.from({ length: 250 }, (_, index): SessionMessage[] => [
      {
        ...user,
        id: `msg_user_${index}`,
        time: { created: index * 2 },
      },
      {
        id: `msg_assistant_${index}`,
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: `model_${index}` },
        time: { created: index * 2 + 1 },
        content: [{ id: `text_${index}`, type: "text", text: "Done" }],
      },
    ]).flat()

    const result = present(transcript)

    expect(result.messages).toHaveLength(500)
    expect(
      result.messages
        .filter((message) => message.role === "assistant")
        .map((message) => [message.id, message.parentID]),
    ).toEqual(Array.from({ length: 250 }, (_, index) => [`msg_assistant_${index}`, `msg_user_${index}`]))
    expect(
      result.messages
        .filter((message) => message.role === "user")
        .map((message) => [message.id, message.model.modelID]),
    ).toEqual(Array.from({ length: 250 }, (_, index) => [`msg_user_${index}`, `model_${index}`]))
  })

  test("restores authoritative structured text IDs and review annotations after reload", () => {
    const result = present([
      {
        ...user,
        text: "aggregate text must not replace structured text",
        parts: [
          { id: "prt_visible", text: "Ship the goal" },
          {
            id: "prt_comment",
            text: "Review line 4",
            synthetic: true,
            ignored: true,
            metadata: {
              forgeComment: {
                path: "src/goal.ts",
                selection: { startLine: 4, startChar: 0, endLine: 4, endChar: 8 },
                comment: "Keep this bounded",
                origin: "review",
              },
            },
          },
        ],
      },
    ])
    const parts = result.parts.find((item) => item.id === user.id)?.parts ?? []

    expect(parts).toEqual([
      expect.objectContaining({ id: "prt_visible", type: "text", text: "Ship the goal" }),
      expect.objectContaining({
        id: "prt_comment",
        type: "text",
        text: "Review line 4",
        synthetic: true,
        ignored: true,
      }),
      expect.objectContaining({ type: "file", filename: "goal.txt" }),
    ])
    expect(MessageComment.fromPart(parts[1]!)).toEqual({
      path: "src/goal.ts",
      selection: { startLine: 4, endLine: 4 },
      comment: "Keep this bounded",
    })
  })

  test("adapts bounded structured tool states without exposing a shell surface", () => {
    const result = present([
      user,
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
        time: { created: 2 },
        content: [
          {
            id: "call_1",
            type: "tool",
            name: "read",
            provider: { executed: true },
            time: { created: 2, ran: 3, completed: 4 },
            state: {
              status: "completed",
              input: { path: "README.md" },
              structured: { lines: 3 },
              content: [{ type: "text", text: "TurenOS" }],
              attachments: [],
            },
          },
        ],
      },
    ])
    const tool = result.parts.find((item) => item.id === "msg_assistant")?.parts[0]

    expect(tool).toMatchObject({
      type: "tool",
      tool: "read",
      metadata: { providerExecuted: true },
      state: {
        status: "completed",
        input: { path: "README.md" },
        output: "TurenOS",
      },
    })
  })

  // Prune clears old tool output out of the provider request and marks the part `time.pruned`.
  // The transcript keeps the bytes, so the mark is the only thing that can tell the timeline the
  // model no longer has them — dropping it here is what let a 200k-character result render as if
  // it were still in context. `session-ui`'s `toolResultCleared` reads it as `time.compacted`.
  test("carries the prune mark onto the presented tool result", () => {
    const assistant = (pruned?: number) => ({
      id: "msg_assistant",
      type: "assistant" as const,
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2 },
      content: [
        {
          id: "call_1",
          type: "tool" as const,
          name: "bash",
          time: { created: 2, ran: 3, completed: 4, ...(pruned === undefined ? {} : { pruned }) },
          state: {
            status: "completed" as const,
            input: { command: "ls" },
            structured: {},
            content: [{ type: "text" as const, text: "a\nb" }],
          },
        },
      ],
    })
    const state = (message: ReturnType<typeof assistant>) =>
      (present([user, message]).parts.find((item) => item.id === "msg_assistant")?.parts[0] as any)?.state

    expect(state(assistant(1700000000000)).time).toMatchObject({ start: 3, end: 4, compacted: 1700000000000 })
    // Still the real output: prune destroys nothing, and the note beside it is what says the
    // model can no longer see this.
    expect(state(assistant(1700000000000)).output).toBe("a\nb")
    expect(state(assistant()).time.compacted).toBeUndefined()
  })

  test("presents a durable shell command as one deterministic user turn and bash tool result", () => {
    const result = present([
      {
        id: "msg_shell",
        type: "shell",
        callID: "call_shell",
        command: "printf forge",
        timeout: 120_000,
        output: "forge",
        status: "completed",
        exitCode: 0,
        truncated: false,
        time: { created: 1, completed: 2 },
      } as unknown as SessionMessage,
    ])

    expect(result.messages).toEqual([
      expect.objectContaining({ id: "msg_shell", role: "user" }),
      expect.objectContaining({
        id: "msg_shell_result",
        role: "assistant",
        parentID: "msg_shell",
        finish: "tool-calls",
      }),
    ])
    expect(result.parts.find((item) => item.id === "msg_shell")?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "printf forge" }),
    ])
    expect(result.parts.find((item) => item.id === "msg_shell_result")?.parts).toEqual([
      expect.objectContaining({
        id: "call_shell",
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "printf forge", timeout: 120_000 },
          output: "forge",
          title: "",
          metadata: { output: "forge", exit: 0, truncated: false, status: "completed" },
          time: { start: 1, end: 2 },
        },
      }),
    ])
  })

  test("keeps running and cancelled shell states actionable without duplicate transcript rows", () => {
    const running = present([
      {
        id: "msg_shell_running",
        type: "shell",
        callID: "call_running",
        command: "sleep 10",
        output: "",
        status: "running",
        time: { created: 1 },
      } as unknown as SessionMessage,
    ])
    const cancelled = present([
      {
        id: "msg_shell_cancelled",
        type: "shell",
        callID: "call_cancelled",
        command: "sleep 10",
        output: "User cancelled the shell command.",
        status: "cancelled",
        error: "User cancelled the shell command.",
        time: { created: 1, completed: 2 },
      } as unknown as SessionMessage,
    ])

    expect(running.messages).toHaveLength(2)
    expect(running.parts.find((item) => item.id === "msg_shell_running_result")?.parts[0]).toMatchObject({
      state: { status: "running", input: { command: "sleep 10" } },
    })
    expect(cancelled.messages).toHaveLength(2)
    expect(cancelled.parts.find((item) => item.id === "msg_shell_cancelled_result")?.parts[0]).toMatchObject({
      state: {
        status: "error",
        input: { command: "sleep 10" },
        error: "User cancelled the shell command.",
      },
    })
  })

  test("clears pre-checkpoint rows and re-parents the retried turn below the compaction boundary", () => {
    const result = present([
      user,
      {
        id: "msg_before",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
        time: { created: 2, completed: 3 },
        finish: "stop",
        content: [{ id: "prt_before", type: "text", text: "Pre-compaction work" }],
      },
      {
        id: "msg_compaction",
        type: "compaction",
        reason: "auto",
        summary: "## Objective\n- ship it",
        recent: "[User]: Ship the goal",
        time: { created: 4 },
      },
      {
        id: "msg_after",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
        time: { created: 5, completed: 6 },
        finish: "stop",
        content: [{ id: "prt_after", type: "text", text: "Post-compaction work" }],
      },
    ])

    expect(
      result.messages.map((message) => [
        message.id,
        message.role,
        message.role === "assistant" ? message.parentID : undefined,
      ]),
    ).toEqual([
      ["msg_compaction", "user", undefined],
      ["msg_after", "assistant", "msg_compaction"],
    ])
    expect(result.parts.find((entry) => entry.id === "msg_compaction")?.parts).toEqual([
      {
        id: "msg_compaction_compaction",
        sessionID: "ses_goal",
        messageID: "msg_compaction",
        type: "compaction",
        auto: true,
      },
    ])

    expect(dividerTurns(result)).toEqual(["msg_compaction"])
  })

  test("marks a manually requested compaction as non-automatic", () => {
    const result = present([
      user,
      {
        id: "msg_compaction",
        type: "compaction",
        reason: "manual",
        summary: "summary",
        recent: "recent",
        time: { created: 2 },
      },
    ])

    expect(result.parts.find((entry) => entry.id === "msg_compaction")?.parts[0]).toMatchObject({
      type: "compaction",
      auto: false,
    })
    expect(dividerTurns(result)).toEqual(["msg_compaction"])
  })

  test("ignores system-only context and assistants without a visible user parent", () => {
    expect(
      present([
        { id: "msg_system", type: "system", text: "hidden", time: { created: 1 } },
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "provider", id: "model" },
          time: { created: 2 },
          content: [{ id: "text_1", type: "text", text: "hidden" }],
        },
      ]),
    ).toEqual({ messages: [], parts: [] })
  })

  test("reconciles an optimistic first prompt once without duplicating visible user input", () => {
    const optimistic = {
      id: user.id,
      sessionID: "ses_goal",
      role: "user" as const,
      time: { created: 0 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    }
    const result = mergeSessionV2Presentation({
      messages: [optimistic],
      parts: {
        [user.id]: [
          {
            id: `${user.id}_optimistic`,
            sessionID: "ses_goal",
            messageID: user.id,
            type: "text",
            text: "Ship the goal",
          },
        ],
      },
      previousOwnedMessageIDs: new Set(),
      presentation: present([user]),
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ id: user.id, role: "user", time: { created: 1 } })
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]?.id).toBe(user.id)
    expect(result.parts[0]?.parts[0]).toMatchObject({
      id: `${user.id}_text`,
      text: "Ship the goal",
    })
  })

  test("preserves an admitted optimistic prompt across a snapshot gap", () => {
    const optimistic = {
      id: user.id,
      sessionID: "ses_goal",
      role: "user" as const,
      time: { created: 0 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    }
    const optimisticPart = {
      id: `${user.id}_optimistic`,
      sessionID: "ses_goal",
      messageID: user.id,
      type: "text" as const,
      text: "Ship the goal",
    }
    const result = mergeSessionV2Presentation({
      messages: [optimistic],
      parts: { [user.id]: [optimisticPart] },
      previousOwnedMessageIDs: new Set([user.id]),
      presentation: { messages: [], parts: [] },
      preservedMessageIDs: new Set([user.id]),
    })

    expect(result.messages).toEqual([optimistic])
    expect(result.parts).toEqual([{ id: user.id, parts: [optimisticPart] }])
    expect(result.removedMessageIDs).toEqual([])
  })

  test("preserves visible history when a partial live window follows a context snapshot", () => {
    const firstUser = { ...user, id: "msg_first", time: { created: 1 } }
    const firstAssistant: SessionMessage = {
      id: "msg_first_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2, completed: 3 },
      content: [{ id: "prt_first", type: "text", text: "Earlier work" }],
    }
    const secondUser = { ...user, id: "msg_second", time: { created: 4 } }
    const secondAssistant: SessionMessage = {
      id: "msg_second_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 5 },
      content: [{ id: "prt_second", type: "text", text: "Still working" }],
    }
    // The windowed loader starts at the newest page, while context reads return the full
    // transcript. The merge must put the older context before this currently visible tail.
    const initial = present([secondUser, secondAssistant])
    const context = present([firstUser, firstAssistant, secondUser, secondAssistant])
    const mergedContext = mergeSessionV2Presentation({
      messages: initial.messages,
      parts: Object.fromEntries(initial.parts.map((entry) => [entry.id, entry.parts])),
      previousOwnedMessageIDs: new Set(initial.messages.map((message) => message.id)),
      presentation: context,
      removeMissing: false,
    })
    expect(mergedContext.messages.map((message) => message.id)).toEqual([
      "msg_first",
      "msg_first_assistant",
      "msg_second",
      "msg_second_assistant",
    ])
    const partial = present([secondUser, secondAssistant])
    const refreshed = mergeSessionV2Presentation({
      messages: mergedContext.messages,
      parts: Object.fromEntries(mergedContext.parts.map((entry) => [entry.id, entry.parts])),
      previousOwnedMessageIDs: mergedContext.ownedMessageIDs,
      presentation: partial,
      removeMissing: false,
    })

    expect(refreshed.messages.map((message) => message.id)).toEqual([
      "msg_first",
      "msg_first_assistant",
      "msg_second",
      "msg_second_assistant",
    ])
  })

  test("keeps preserved rows before incoming rows with the same timestamp", () => {
    const older = present([
      { ...user, id: "msg_older_1", time: { created: 10 } },
      { ...user, id: "msg_older_2", time: { created: 10 } },
    ])
    const newer = present([{ ...user, id: "msg_newer", time: { created: 10 } }])
    const result = mergeSessionV2Presentation({
      messages: older.messages,
      parts: {},
      previousOwnedMessageIDs: new Set(),
      presentation: newer,
      removeMissing: false,
    })

    expect(result.messages.map((message) => message.id)).toEqual(["msg_older_1", "msg_older_2", "msg_newer"])
  })

  test("keeps a newer optimistic row after an authoritative history window", () => {
    const history = present([{ ...user, id: "msg_history", time: { created: 10 } }])
    const optimistic = { ...history.messages[0]!, id: "msg_optimistic", time: { created: 20 } }
    const result = mergeSessionV2Presentation({
      messages: [...history.messages, optimistic],
      parts: {},
      previousOwnedMessageIDs: new Set(history.messages.map((message) => message.id)),
      preservedMessageIDs: new Set([optimistic.id]),
      presentation: history,
    })

    expect(result.messages.map((message) => message.id)).toEqual(["msg_history", "msg_optimistic"])
  })

  test("removes compacted V2 rows while preserving legacy timeline rows", () => {
    const legacy = {
      id: "msg_legacy",
      sessionID: "ses_goal",
      role: "user" as const,
      time: { created: 0 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    } satisfies Message
    const legacyPart = {
      id: "prt_legacy",
      sessionID: "ses_goal",
      messageID: legacy.id,
      type: "text" as const,
      text: "Earlier context",
    } satisfies Part
    const result = mergeSessionV2Presentation({
      messages: [legacy, { ...legacy, id: "msg_old_v2" }],
      parts: { [legacy.id]: [legacyPart], msg_old_v2: [{ ...legacyPart, id: "prt_old", messageID: "msg_old_v2" }] },
      previousOwnedMessageIDs: new Set(["msg_old_v2"]),
      presentation: { messages: [], parts: [] },
    })

    expect(result.messages).toEqual([legacy])
    expect(result.parts).toEqual([{ id: legacy.id, parts: [legacyPart] }])
    expect(result.removedMessageIDs).toEqual(["msg_old_v2"])
  })

  test("preserves authoritative API order when branded IDs are not chronological", () => {
    const laterIDFirst = present([
      { ...user, id: "msg_z_later_lexically" },
      { ...user, id: "msg_a_earlier_lexically", time: { created: 2 } },
    ])
    const result = mergeSessionV2Presentation({
      messages: [
        {
          id: "msg_a_earlier_lexically",
          sessionID: "ses_goal",
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
        {
          id: "msg_z_later_lexically",
          sessionID: "ses_goal",
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      ],
      parts: {},
      previousOwnedMessageIDs: new Set(["msg_a_earlier_lexically", "msg_z_later_lexically"]),
      presentation: laterIDFirst,
    })

    expect(result.messages.map((message) => message.id)).toEqual(["msg_z_later_lexically", "msg_a_earlier_lexically"])
    expect(result.parts.map((entry) => entry.id)).toEqual(["msg_z_later_lexically", "msg_a_earlier_lexically"])
  })
})
