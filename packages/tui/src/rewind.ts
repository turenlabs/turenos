import {
  BoxRenderable,
  InputRenderable,
  SelectRenderable,
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
} from "@opentui/core"
import type { MessagesListOutput } from "@turenlabs/client"
import type { Dialogs } from "./dialogs"
import { changeSummary, diffLines, type DiffTone } from "./diff"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

const tone: Record<DiffTone, string> = {
  added: color.added,
  removed: color.removed,
  meta: color.muted,
  context: color.text,
}

export function createRewindControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  hooks: {
    blocked: (id: string) => boolean
    changed: (session: Session) => void
    restoreDraft: (session: Session, messageID: string, text: string) => boolean
    clearRestoredDraft: (sessionID: string, messageID: string, text: string) => void
  },
) {
  function open(action: "undo" | "redo") {
    const selected =
      state.tab === "sessions" ? state.snapshot?.sessions.find((session) => session.id === state.selected) : undefined
    if (!selected) return say("Select a session first.", true)
    if (!state.connected) return say("Reconnect before changing this session.", true)
    if (hooks.blocked(selected.id)) return say("Task-owned subagent: use its owning session. Nothing changed.", true)
    if (state.closed || !dialogs.navigate()) return
    const opened = dialogs.open(action === "undo" ? "Undo conversation?" : "Redo conversation?", false, 32)
    if (!opened) return
    const dialog = opened
    const session = structuredClone(selected)
    const initialBoundary = boundary(session.revert)
    dialog.recipient = session
    dialog.frame.add(
      new TextRenderable(renderer, {
        content: `Confirm stops active work in this session.\n${action === "redo" && hasFiles(session.revert) ? "Redo restores staged files NOW." : "File mode restores affected files NOW."}\nNext reply commits any remaining undo stage.`,
        height: 3,
        flexShrink: 0,
        fg: color.error,
        wrapMode: "word",
      }),
      0,
    )
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `For: ${label(session.title || session.id, 100)}`,
        fg: color.muted,
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
      }),
    )
    const preview = new TextRenderable(renderer, {
      content: "Loading session and recent messages (read-only). Nothing has been changed.",
      fg: color.text,
      wrapMode: "word",
    })
    dialog.form.add(preview)
    // Both controls can restore files immediately, so what they would touch is
    // shown before the confirmation rather than behind it.
    const summary = changeSummary(session.revert)
    const changes = new TextRenderable(renderer, {
      content: "",
      visible: !!summary,
      fg: color.text,
      wrapMode: "none",
      selectable: true,
    })
    dialog.form.add(changes)
    let expanded = false
    const renderChanges = () => {
      if (!summary || changes.isDestroyed) return
      const lines = expanded ? diffLines(session.revert) : []
      changes.content = new StyledText([
        fg(color.warning)(`Staged file changes: ${summary}\n`),
        fg(color.muted)(`Ctrl+D ${expanded ? "hides" : "shows"} the staged patch\n`),
        ...lines.map((line) => fg(tone[line.tone])(`${line.text}\n`)),
      ])
      changes.height = 2 + lines.length
    }
    renderChanges()
    dialog.error.content = "Loading (read-only) ... Esc cancel"
    let target: { id: string; text: string } | undefined
    let previous: { id: string; text: string } | undefined
    let ready = false
    let loading = false
    let attempted = false
    let intent: { messageID?: string; files: boolean } | undefined
    let acknowledged: Session["revert"]
    let hasAcknowledgement = false
    let files: SelectRenderable | undefined
    let confirmation: InputRenderable | undefined

    function owned() {
      if (state.closed || state.modal !== dialog) throw new Error("Confirmation is no longer open.")
      if (!state.connected) throw new Error("Reconnect before changing this session.")
      if (hooks.blocked(session.id)) throw new Error("Task-owned subagent: use its owning session. Nothing changed.")
    }

    async function fresh(unchanged: boolean) {
      owned()
      const current = await connection.client.sessions.get({ sessionID: session.id })
      owned()
      if (!sameSession(session, current)) throw new Error("Session identity changed. Close and reopen this control.")
      if (unchanged && boundary(current.revert) !== initialBoundary)
        throw new Error("Staged boundary changed. Close and reopen this control.")
      return current
    }

    async function load() {
      if (loading || ready || attempted) return
      loading = true
      target = undefined
      previous = undefined
      try {
        await fresh(true)
        if (action === "redo" && !session.revert) throw new Error("Nothing staged to redo.")
        const messages: MessagesListOutput["data"][number][] = []
        const seen = new Set<string>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        // The API's descending cursor traversal is sequence order, not UUID order.
        for (let page = 0; page < 10; page++) {
          const result = await connection.client.messages.list({
            sessionID: session.id,
            limit: 30,
            order: cursor ? undefined : "desc",
            cursor,
          })
          owned()
          if (result.data.length > 30)
            throw new Error("Server exceeded the 30-message inspection page limit. Nothing changed.")
          for (const message of result.data) {
            if (seen.has(message.id)) continue
            seen.add(message.id)
            messages.push(message)
          }
          const position = session.revert ? messages.findIndex((item) => item.id === session.revert!.messageID) : -1
          const real = (message: MessagesListOutput["data"][number]) =>
            message.type === "user" && (!message.source || message.source === "user")
          if (session.revert && position >= 0) {
            const at = messages[position]!
            if (!real(at) || at.type !== "user")
              throw new Error("Staged boundary is not a user prompt. Close and inspect this session.")
            previous = { id: at.id, text: at.text }
            const choice =
              action === "undo" ? messages.slice(position + 1).find(real) : messages.slice(0, position).findLast(real)
            if (choice?.type === "user") target = { id: choice.id, text: choice.text }
            if (target || action === "redo") break
          } else if (!session.revert) {
            const choice = messages.find(real)
            if (choice?.type === "user") target = { id: choice.id, text: choice.text }
            if (target) break
          }
          const next = result.cursor.next
          if (!next || cursors.has(next)) break
          cursors.add(next)
          cursor = next
        }
        if (session.revert && !previous)
          throw new Error("Staged boundary is outside the bounded 300-message window. Nothing changed.")
        if (action === "undo" && !target)
          throw new Error("No earlier user prompt in the bounded 300-message window. Nothing changed.")
        await fresh(true)
        preview.content = `${action === "undo" ? "Undo from" : target ? "Redo up to" : "Clear stage after"} prompt:\n${display((target ?? previous)!.text, 4000)}\n\nConfirmation stops active work in this captured session first. ${action === "redo" && hasFiles(session.revert) ? "Redo restores staged files NOW (or reapplies the next file boundary)." : "Conversation-only leaves files untouched; conversation + files restores files NOW."}\nThe next reply commits the remaining staged boundary. No reply is sent now; existing drafts are kept.\n\nSession: ${session.id}\nDirectory: ${label(session.location.directory, 200)}`
        const controls = new BoxRenderable(renderer, {
          height: action === "undo" ? 4 : 2,
          flexShrink: 0,
          flexDirection: "column",
        })
        dialog.frame.add(controls, dialog.frame.getChildren().indexOf(dialog.error))
        if (action === "undo") {
          files = new SelectRenderable(renderer, {
            height: 2,
            options: [
              { name: "Conversation only", description: "Default: files false; no file changes" },
              { name: "Conversation + files", description: "Restore affected files NOW" },
            ],
            showDescription: false,
            showSelectionIndicator: true,
            backgroundColor: color.panel,
            textColor: color.text,
            selectedBackgroundColor: color.selected,
            selectedTextColor: color.accent,
          })
          controls.add(files)
          dialogs.track(dialog, files)
        }
        controls.add(
          new TextRenderable(renderer, {
            content: `Type ${action} to confirm, then Ctrl+S`,
            fg: color.muted,
            height: 1,
          }),
        )
        confirmation = new InputRenderable(renderer, {
          placeholder: action,
          maxLength: 32,
          width: "100%",
          backgroundColor: color.bg,
          focusedBackgroundColor: color.selected,
          textColor: color.text,
          placeholderColor: color.muted,
        })
        controls.add(confirmation)
        dialogs.track(dialog, confirmation)
        dialog.error.content = `Type ${action} + Ctrl+S confirm; Enter does not confirm\nTab chooses file mode / confirmation.${summary ? " Ctrl+D staged patch." : ""} Esc cancel`
        ready = true
        confirmation.focus()
      } catch (error) {
        if (state.closed || state.modal !== dialog) return
        preview.content = `Cannot inspect rewind: ${errorText(error)}`
        dialog.error.content = "Read-only; nothing changed. Ctrl+R retry / Esc close"
      } finally {
        loading = false
      }
    }

    dialog.submit = async () => {
      owned()
      if (!ready || !confirmation) throw new Error("Wait for read-only inspection to finish successfully.")
      if (confirmation.value !== action) throw new Error(`Type ${action} exactly, then Ctrl+S.`)
      if (intent && action === "undo" && (files?.getSelectedIndex() === 1) !== intent.files)
        throw new Error("Retry keeps the original file mode. Close and reopen this control to change it.")
      if (!intent) {
        const withFiles = action === "undo" ? files?.getSelectedIndex() === 1 : hasFiles(session.revert)
        if (!withFiles && hasFiles(session.revert))
          throw new Error("An existing file undo would restore files. Redo first or select Conversation + files.")
        intent = { messageID: target?.id, files: withFiles }
      }
      if (!attempted && action === "undo" && (files?.getSelectedIndex() === 1) !== intent.files)
        throw new Error("Retry with the original file mode, or close and inspect this session.")
      if (!attempted) {
        await fresh(true)
        await connection.client.sessions.interrupt({ sessionID: session.id })
        owned()
        await fresh(true)
        // From this point onward, retries are GET-only, even if the response is lost.
        attempted = true
        try {
          if (intent.messageID) {
            acknowledged = await connection.client.sessions.stage({
              sessionID: session.id,
              messageID: intent.messageID,
              files: intent.files,
            })
          } else {
            await connection.client.sessions.clear({ sessionID: session.id })
          }
          hasAcknowledgement = true
        } catch (error) {
          throw new Error(
            `Outcome unknown: ${errorText(error)} Retry checks GET only; no write will be repeated. Close and inspect this session if unconfirmed.`,
          )
        }
      }
      const updated = await fresh(false)
      if (intent.messageID && intent.files && !hasAcknowledgement)
        throw new Error(
          "File restoration is unconfirmed after the lost response. No write will be repeated; close and inspect the session and files.",
        )
      const matches = intent.messageID
        ? updated.revert?.messageID === intent.messageID && (!intent.files ? !hasFiles(updated.revert) : true)
        : !updated.revert
      if (!matches || (hasAcknowledgement && intent.messageID && boundary(updated.revert) !== boundary(acknowledged)))
        throw new Error(
          "Outcome is not confirmed. Retry only checks GET; no write will be repeated. Close and inspect this session.",
        )
      hooks.changed(updated)
      if (action === "undo" && target) {
        const restored = hooks.restoreDraft(updated, target.id, target.text)
        say(
          `Undo confirmed. ${restored ? "Prompt restored as a draft; nothing sent." : "Existing draft kept; nothing sent."}`,
        )
      } else {
        if (previous) hooks.clearRestoredDraft(session.id, previous.id, previous.text)
        say("Redo confirmed. Ordinary reply drafts are unchanged; nothing sent.")
      }
    }
    dialog.key = (key) => {
      if (matchesKey(key, "enter")) return true
      if (matchesKey(key, "d", { ctrl: true }) && summary) {
        expanded = !expanded
        renderChanges()
        dialogs.resize()
        return true
      }
      if (matchesKey(key, "r", { ctrl: true }) && !attempted) {
        void load()
        return true
      }
      return false
    }
    dialog.form.focus()
    void load()
  }
  return { undo: () => open("undo"), redo: () => open("redo") }
}

function sameSession(left: Session, right: Session) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.parentID === right.parentID &&
    left.subpath === right.subpath &&
    left.time.created === right.time.created &&
    left.location.directory === right.location.directory &&
    left.location.workspaceID === right.location.workspaceID
  )
}

function hasFiles(revert: Session["revert"]) {
  return !!(revert?.files?.length || revert?.diff)
}

function boundary(revert: Session["revert"]) {
  return JSON.stringify(
    revert
      ? [
          revert.messageID,
          revert.partID,
          revert.snapshot,
          revert.diff,
          revert.files?.map((file) => [file.path, file.status, file.additions, file.deletions, file.patch]),
        ]
      : null,
  )
}
