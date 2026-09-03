import { expect, test } from "bun:test"
import type { DirectorySDK } from "@/context/sdk"
import { compactSessionV2, createSessionV2TranscriptCommands } from "./session-v2-commands"
import { clearSessionV2Revert, stageSessionV2Revert } from "./session-v2-revert"

// `compact` was previously withheld from this set alongside `fork`, because the only available
// implementation was V1's, which reads the V1 message tables and can silently omit messages
// recorded after a session was adopted into V2. That is no longer the tradeoff: `session.compact`
// now routes to POST /api/session/:id/compact, which summarises the durable V2 transcript itself
// and answers a refusal with a typed reason instead of a no-op. `fork` still has no V2
// implementation, so it stays absent.
test("visible transcript commands route undo, redo and compact through V2 and omit unsafe fork", async () => {
  const calls: string[] = []
  const client = {
    v2: {
      session: {
        interrupt: async () => {
          calls.push("interrupt")
        },
        compact: async () => {
          calls.push("compact")
        },
        revert: {
          stage: async () => {
            calls.push("stage")
            return { data: { data: { messageID: "msg_boundary" } } }
          },
          clear: async () => {
            calls.push("clear")
          },
        },
      },
    },
  } as unknown as DirectorySDK["client"]
  const pending: Promise<unknown>[] = []
  const commands = createSessionV2TranscriptCommands({
    command: (option) => ({ ...option, category: "Session" }),
    showNew: false,
    onNew: () => undefined,
    onUndo: () => {
      pending.push(stageSessionV2Revert(client, { sessionID: "ses_v2", messageID: "msg_boundary" }))
    },
    onRedo: () => {
      pending.push(clearSessionV2Revert(client, "ses_v2"))
    },
    onCompact: () => {
      pending.push(compactSessionV2(client, "ses_v2"))
    },
    canUndo: true,
    canRedo: true,
    canCompact: true,
    labels: {
      new: "New",
      undo: "Undo",
      undoDescription: "Undo the last turn",
      redo: "Redo",
      redoDescription: "Redo the last turn",
      compact: "Compact session",
      compactDescription: "Summarize the session to reduce context size",
    },
  })

  expect(commands.map((command) => command.id)).toEqual(["session.undo", "session.redo", "session.compact"])
  expect(commands.map((command) => command.slash)).toEqual(["undo", "redo", "compact"])
  commands[0]?.onSelect?.()
  await pending.shift()
  commands[1]?.onSelect?.()
  await pending.shift()
  commands[2]?.onSelect?.()
  await pending.shift()

  // Compaction does not interrupt first: the server refuses a busy session with a reason rather
  // than tearing down a turn the user is watching.
  expect(calls).toEqual(["interrupt", "stage", "interrupt", "clear", "compact"])
})

test("compact is disabled while a session has no transcript to summarize", () => {
  const commands = createSessionV2TranscriptCommands({
    command: (option) => ({ ...option, category: "Session" }),
    showNew: false,
    onNew: () => undefined,
    onUndo: () => undefined,
    onRedo: () => undefined,
    onCompact: () => undefined,
    canUndo: false,
    canRedo: false,
    canCompact: false,
    labels: {
      new: "New",
      undo: "Undo",
      undoDescription: "Undo the last turn",
      redo: "Redo",
      redoDescription: "Redo the last turn",
      compact: "Compact session",
      compactDescription: "Summarize the session to reduce context size",
    },
  })

  expect(commands.find((command) => command.id === "session.compact")?.disabled).toBe(true)
})
