import { SelectRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { SessionsPendingInputsOutput } from "@turenlabs/client"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { errorText, type Connection, type Session } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Input = SessionsPendingInputsOutput[number]

/** Messages you sent that the server has admitted but not yet delivered to the agent. */
export function waiting(inputs: readonly Input[] | undefined) {
  return (inputs ?? []).filter((input) => !input.source || input.source === "user")
}

/**
 * The desktop's queued follow-up dock: a queued message can be delivered now, taken back into the
 * reply editor, or discarded before the agent reads it.
 */
export function createQueueControls(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  drafts: {
    /** Why the text cannot become the session's reply draft, if it cannot. */
    blocker: (sessionID: string, text: string) => string | undefined
    restore: (session: Session, messageID: string, text: string) => boolean
    reply: () => void
  },
) {
  function open() {
    const session = state.snapshot?.sessions.find((item) => item.id === state.selected)
    if (state.tab !== "sessions" || !session) return say("Select a session first.")
    if (!dialogs.navigate()) return
    const dialog = dialogs.open("Queued messages", false, 26)
    if (!dialog) return
    dialog.recipient = session
    const text = new TextRenderable(renderer, {
      content: "Loading…",
      fg: color.text,
      wrapMode: "word",
      selectable: true,
    })
    dialog.form.add(text)
    const list = new SelectRenderable(renderer, {
      height: 8,
      flexShrink: 0,
      options: [],
      showSelectionIndicator: true,
      backgroundColor: color.panel,
      textColor: color.text,
      descriptionColor: color.muted,
      selectedBackgroundColor: color.selected,
      selectedTextColor: color.accent,
    })
    dialog.frame.add(list, dialog.frame.getChildren().indexOf(dialog.error))
    dialogs.track(dialog, list)
    let inputs: Input[] = []
    let armed = ""
    let request = 0
    let acting = false
    const keys = "Enter send now · Ctrl+E edit · Ctrl+D discard · Ctrl+R refresh · Esc close"

    async function refresh(note = "") {
      const version = ++request
      try {
        const result = waiting(await connection.client.sessions.pendingInputs({ sessionID: session!.id }))
        if (version !== request || state.modal !== dialog) return
        inputs = result.toSorted((a, b) => a.admittedSeq - b.admittedSeq)
        list.options = inputs.map((input) => ({
          name: label(input.prompt.text, 90),
          description: `${input.delivery === "queue" ? "Queued until the agent is idle" : "Steering · delivered at the next step"} · ${new Date(input.timeCreated).toLocaleTimeString()}`,
        }))
        list.visible = inputs.length > 0
        text.content = inputs.length
          ? `For: ${label(session!.title || session!.id, 100)}\n\n${display(inputs[list.getSelectedIndex()]?.prompt.text ?? "", 4000)}`
          : "Nothing is waiting. Messages the agent has already read appear in the transcript."
        dialog!.error.content = `${note ? `${note}\n` : ""}${inputs.length ? keys : "Ctrl+R refresh · Esc close"}`
      } catch (error) {
        if (version !== request || state.modal !== dialog) return
        list.visible = false
        text.content = `Queued messages unavailable: ${errorText(error)}`
        dialog!.error.content = "Ctrl+R retry · Esc close"
      }
    }

    async function act(kind: "steer" | "edit" | "cancel") {
      const input = inputs[list.getSelectedIndex()]
      if (!input || acting) return
      // Cancelling removes the message from the server, so check it can reopen before cancelling it.
      const blocked = kind === "edit" ? drafts.blocker(session!.id, input.prompt.text) : undefined
      if (blocked) {
        dialog!.error.content = `${blocked} Enter sends it now instead.\n${keys}`
        return
      }
      acting = true
      try {
        const messageID = input.id
        const done =
          kind === "steer"
            ? await connection.client.sessions.inputSteer({ sessionID: session!.id, messageID })
            : await connection.client.sessions.inputCancel({ sessionID: session!.id, messageID })
        if (state.modal !== dialog) return
        if (!done) return await refresh("The agent already received that message.")
        if (kind === "edit" && !drafts.restore(session!, messageID, input.prompt.text)) return keep(input)
        if (kind === "edit") {
          dialogs.close(false)
          return drafts.reply()
        }
        await refresh(kind === "steer" ? "Sent now; the agent reads it at its next step." : "Discarded.")
      } catch (error) {
        if (state.modal === dialog) dialog!.error.content = `! ${errorText(error)}\n${keys}`
      } finally {
        acting = false
      }
    }

    /** A draft appeared while the message was being cancelled: keep its text on screen to copy. */
    function keep(input: Input) {
      dialog!.refresh = undefined
      inputs = []
      list.visible = false
      text.content = `Removed from the queue, but it could not reopen in the reply editor. Select it and press Ctrl+Y to copy it before closing.\n\n${display(input.prompt.text, 32000)}`
      dialog!.error.content = "Ctrl+Y copies the selection · Esc close"
    }

    async function discard() {
      const id = inputs[list.getSelectedIndex()]?.id ?? ""
      if (armed === id) {
        armed = ""
        return act("cancel")
      }
      armed = id
      dialog!.error.content = `Ctrl+D again discards this message.\n${keys}`
    }

    list.on("selectionChanged", () => {
      armed = ""
      const input = inputs[list.getSelectedIndex()]
      if (input) text.content = `For: ${label(session.title || session.id, 100)}\n\n${display(input.prompt.text, 4000)}`
    })
    dialog.refresh = () => void refresh()
    dialog.key = (key) => {
      const action = matchesKey(key, "r", { ctrl: true })
        ? () => refresh()
        : matchesKey(key, "e", { ctrl: true })
          ? () => act("edit")
          : matchesKey(key, "d", { ctrl: true })
            ? discard
            : matchesKey(key, "enter")
              ? () => act("steer")
              : undefined
      if (!action) return false
      void action()
      return true
    }
    list.focus()
    void refresh()
  }

  return { open }
}
