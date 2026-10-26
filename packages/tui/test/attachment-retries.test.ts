import { expect, test } from "bun:test"
import { ClientError, type SessionsPromptInput } from "@turenlabs/client"
import { BoxRenderable, TextareaRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createMentions } from "../src/mentions"
import { attachmentSummary } from "../src/mentions/outside"
import { promptPayload, recordSearch } from "../src/prompt-files"
import { createRequests } from "../src/requests"
import type { RequestContext } from "../src/requests/context"
import type { ReplyEditor } from "../src/requests/reply"
import { showAttachments } from "../src/requests/attachments"
import { connect } from "../src/server"
import { createSlashCommands } from "../src/slash"
import { createDashboardState, type MessageDraft, type ModalState } from "../src/state"
import { cleanup, session } from "./support"

test("missing file searches belong to their connection, directory and workspace", () => {
  const first = connect({ url: "http://127.0.0.1:4096" })
  const second = connect({ url: "http://127.0.0.1:4096" })
  cleanup.push(first.close, second.close)
  const location = { directory: "/srv/p", workspaceID: "wrk_a" }
  recordSearch(first.missingFiles, location, "a.ts", false)
  const scope = { missingFiles: first.missingFiles, workspaceID: location.workspaceID }
  expect(promptPayload("read @a.ts", location.directory, scope).files).toBeUndefined()
  expect(promptPayload("read @a.ts", "/srv/other", scope).files).toHaveLength(1)
  expect(promptPayload("read @a.ts", location.directory, { ...scope, workspaceID: "wrk_b" }).files).toHaveLength(1)
  expect(
    promptPayload("read @a.ts", location.directory, { ...scope, missingFiles: second.missingFiles }).files,
  ).toHaveLength(1)
  expect(promptPayload("read @a.ts", location.directory).files).toHaveLength(1)
})

test("a frozen attachment preview ignores later search results, including an empty original payload", () => {
  const scope = { missingFiles: new Set<string>() }
  const location = { directory: "/srv/p" }
  const text = "read @a.ts now"
  const original = promptPayload(text, location.directory, scope)
  recordSearch(scope.missingFiles, location, "a.ts", false)
  expect(attachmentSummary(text, location.directory, scope, original.files)).toBe("Attaches a.ts")
  recordSearch(scope.missingFiles, location, "a.ts", true)
  expect(attachmentSummary(text, location.directory, scope, [])).toBeUndefined()
})

async function sender(kind: "launch" | "reply", refused: boolean) {
  const connection = connect({ url: "http://127.0.0.1:4096" })
  cleanup.push(connection.close)
  const captured: SessionsPromptInput[] = []
  // Keep the real launch/reply submission logic; replace only the server boundary, without a listener.
  connection.client.sessions.get = async () => session()
  connection.client.sessions.create = async (input) => ({ ...session(), id: input?.id ?? session().id })
  connection.client.sessions.prompt = async (input) => {
    captured.push(structuredClone(input))
    throw new ClientError("UnexpectedStatus", { cause: { status: refused ? 400 : 503 } })
  }
  if (kind === "launch") {
    const start = connection.launch()
    return { connection, captured, send: () => start({ directory: "/srv/main", prompt: "read @a.ts now" }) }
  }
  const view = await createTestRenderer({ width: 100, height: 32 })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  state.connected = true
  state.selected = "ses_main"
  state.snapshot = {
    location: { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } },
    sessions: [session()],
    active: {},
    terminals: [],
    terminalsAvailable: true,
    loops: [],
    inventoryErrors: { terminals: "", automations: "" },
    terminalFolderErrors: [],
    updated: 2,
    more: false,
  }
  const dialogs = createDialogs(view.renderer, state, createLayout(view.renderer, state), {
    rememberPosition() {},
    cancelPosition() {},
    changed() {},
    async submitted() {},
    say() {},
  })
  const slash = createSlashCommands(
    view.renderer,
    state,
    connection,
    () => [],
    () => {},
  )
  const mentions = createMentions(view.renderer, state, connection)
  const requests = createRequests(
    view.renderer,
    state,
    connection,
    dialogs,
    () => {},
    () => {},
    slash,
    mentions,
  )
  requests.followup()
  state.modal!.editor!.setText("read @a.ts now")
  return { connection, captured, send: () => state.modal!.submit!() }
}

for (const kind of ["launch", "reply"] as const) {
  for (const found of [false, true]) {
    test(`${kind} freezes ${found ? "attached" : "empty"} files after an ambiguous admission`, async () => {
      const f = await sender(kind, false)
      const location = { directory: "/srv/main" }
      recordSearch(f.connection.missingFiles, location, "a.ts", found)
      await expect(f.send()).rejects.toBeDefined()
      recordSearch(f.connection.missingFiles, location, "a.ts", !found)
      await expect(f.send()).rejects.toBeDefined()
      expect(f.captured).toHaveLength(2)
      expect(f.captured[1]).toEqual(f.captured[0])
      expect(f.captured[0]!.prompt.files?.length ?? 0).toBe(found ? 1 : 0)
    })

    test(`${kind} recomputes ${found ? "attached" : "empty"} files after a definite refusal`, async () => {
      const f = await sender(kind, true)
      const location = { directory: "/srv/main" }
      recordSearch(f.connection.missingFiles, location, "a.ts", found)
      await expect(f.send()).rejects.toBeDefined()
      recordSearch(f.connection.missingFiles, location, "a.ts", !found)
      await expect(f.send()).rejects.toBeDefined()
      expect(f.captured).toHaveLength(2)
      expect(f.captured[1]!.id).toBe(f.captured[0]!.id)
      expect(f.captured[0]!.prompt.files?.length ?? 0).toBe(found ? 1 : 0)
      expect(f.captured[1]!.prompt.files?.length ?? 0).toBe(found ? 0 : 1)
    })
  }
}

/** The line `showAttachments` adds under `task`, with the @ list open when `mentionRows` is above zero. */
function attachmentLine(
  renderer: CliRenderer,
  connection: unknown,
  task: ReplyEditor,
  recipient: MessageDraft["recipient"],
  mentionRows = 0,
) {
  const error = new TextRenderable(renderer, { content: "" })
  const frame = new BoxRenderable(renderer, {})
  frame.add(error)
  renderer.root.add(frame)
  // dialog.recipient is deliberately unset: the line must follow the draft, which names the workspace.
  const dialog = { frame, error, mentionRows } as unknown as ModalState
  const ctx = { renderer, connection, dialogs: { resize() {} } } as unknown as RequestContext
  showAttachments(ctx, dialog, task, { text: "", id: "msg_a", recipient, delivery: "steer" })
  return frame.getChildren().find((child) => child !== error) as TextRenderable
}

test("the attachment line reads missing files for the reply recipient's own workspace", async () => {
  const view = await createTestRenderer({ width: 90, height: 20 })
  cleanup.push(() => view.renderer.destroy())
  const connection = connect({ url: "http://127.0.0.1:4096" })
  cleanup.push(connection.close)
  const recipient = { ...session(), location: { directory: "/srv/main", workspaceID: "wrk_a" } }
  recordSearch(connection.missingFiles, recipient.location, "a.ts", false)
  const task = { plainText: "read @a.ts", cursorOffset: 0 } as unknown as ReplyEditor
  const line = attachmentLine(view.renderer, connection, task, recipient)
  const expected = attachmentSummary("read @a.ts", recipient.location.directory, {
    missingFiles: connection.missingFiles,
    workspaceID: "wrk_a",
  })
  expect(expected).not.toBe(attachmentSummary("read @a.ts", recipient.location.directory))
  expect(line.plainText).toBe(expected!)
})

test("while the @ list is open, the attachment line leaves out the search at a caret after wide text", async () => {
  const view = await createTestRenderer({ width: 90, height: 20 })
  cleanup.push(() => view.renderer.destroy())
  const task = new TextareaRenderable(view.renderer, { initialValue: "请看 @au 然后 @b.ts" })
  view.renderer.root.add(task)
  // Right after `@au`: the editor counts two cells for each CJK character.
  task.cursorOffset = 8
  const line = attachmentLine(view.renderer, { missingFiles: new Set() }, task, session(), 1)
  expect(line.plainText).toBe("Attaches b.ts")
})
