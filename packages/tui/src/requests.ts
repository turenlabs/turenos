import { SelectRenderable, TextRenderable, TextAttributes, type CliRenderer, type InputRenderable } from "@opentui/core"
import type { Connection, Session } from "./server"
import { display } from "./messages"
import { label, type DashboardState, type MessageDraft, type ModalState } from "./state"
import { color } from "./theme"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import type { SlashCommands } from "./slash"
import type { Mentions } from "./mentions"
import { promptPayload } from "./prompt-files"

export function createRequests(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string) => void,
  openSession: (id: string, inspect?: boolean, session?: Session) => void,
  slash: SlashCommands,
  mentions: Mentions,
) {
  const messages = new Map<string, MessageDraft>()
  const owned = new Set<string>()
  const shownQuestions = new Set<string>()
  const questionDrafts = new Map<
    string,
    {
      signature: string
      selections: Set<number>[]
      custom: string[]
      customOn: boolean[]
      cursors: number[]
      page: number
      review: boolean
      reject: boolean
      editing: boolean
      cursor: number
    }
  >()

  function owner(sessionID: string) {
    const detail = state.detail?.sessionID === sessionID ? state.detail : undefined
    return [...(detail?.tasks.data ?? []), ...(detail?.tasks.active ?? [])].find(
      (task) => task.childSessionID === sessionID,
    )
  }

  function replyBlocked(sessionID: string) {
    return owned.has(sessionID) || !!owner(sessionID)
  }

  function recipient(dialog: ModalState, sessionID: string) {
    const session = state.snapshot?.sessions.find((item) => item.id === sessionID)
    dialog.recipient = session
    dialog.form.add(
      new TextRenderable(renderer, {
        content: [label(session?.title ?? sessionID), label(session?.location.directory ?? ""), label(sessionID)].join(
          "\n",
        ),
        fg: color.muted,
        wrapMode: "word",
      }),
    )
  }

  function followup() {
    if (state.tab !== "sessions" || !state.selected) return say("Select a session first.")
    const sessionID = state.selected
    const session = state.snapshot?.sessions.find((session) => session.id === sessionID)
    if (!session) return say("This session is no longer available. Refresh the list.")
    if (replyBlocked(sessionID)) {
      const rootID = owner(sessionID)?.rootSessionID
      const target = rootID ?? session.parentID
      const dialog = dialogs.open("Task-owned subagent", false, 24)
      if (!dialog) return
      dialog.recipient = session
      const draft = messages.get(sessionID)
      if (target && target !== sessionID)
        dialog.form.add(
          new TextRenderable(renderer, {
            content: `[ Open ${rootID ? "main" : "parent"} session and reply ]`,
            fg: color.bg,
            bg: color.accent,
            wrapMode: "word",
            flexShrink: 0,
            onMouseDown: (event) => {
              event.preventDefault()
              if (event.button === 0) void dialogs.submit()
            },
          }),
        )
      dialog.form.add(
        new TextRenderable(renderer, {
          content: `This subagent is controlled by its owning task and cannot accept direct replies.\n\n${target ? `Open its ${rootID ? "main" : "parent"} session to give instructions instead.\nTarget: ${label(state.snapshot?.sessions.find((item) => item.id === target)?.title ?? target, 200)}` : "Open Tasks (t) to locate the owning main session."}\n\nNo message will be sent.${draft ? `\n\nSaved child draft (not moved or sent):\n${display(draft.text, 32000)}` : ""}`,
          fg: color.text,
          wrapMode: "word",
        }),
      )
      dialog.error.content =
        target && target !== sessionID
          ? `Enter Open ${rootID ? "main" : "parent"} + reply · Esc close${draft ? "\nChild draft stays here; Ctrl+Y copies selected text." : ""}`
          : "Esc close · t Tasks"
      if (target && target !== sessionID) {
        dialog.submit = async () => {
          if (!state.connected) throw new Error("Reconnect before opening the owning session.")
          const current = await connection.client.sessions.get({ sessionID: target })
          if (!state.closed) openSession(current.id, false, current)
        }
        dialog.afterSubmit = () => {
          if (!state.closed && !state.modal && state.selected === target) followup()
        }
        dialog.key = (key) => {
          if (!matchesKey(key, "enter")) return false
          void dialogs.submit()
          return true
        }
      }
      dialog.form.focus()
      return
    }
    if (!messages.has(sessionID) && messages.size >= 16)
      return say("16 message drafts are saved. Send or discard one before starting another.")
    const dialog = dialogs.open("Reply", false, 24, true)
    if (!dialog) return
    dialog.recipient = session
    const draft: MessageDraft = messages.get(sessionID) ?? {
      text: "",
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      recipient: session,
      delivery: "steer",
    }
    draft.recipient = session
    if (draft.submitted !== undefined) draft.text = draft.submitted
    messages.set(sessionID, draft)
    const heading = new TextRenderable(renderer, {
      content: "",
      fg: color.muted,
      height: 1,
      truncate: true,
      wrapMode: "none",
    })
    dialog.form.add(heading)
    const delivery = () => {
      heading.content = `${draft.delivery === "queue" ? "Queue" : "Steer"} · Reply to ${label(session.title, 100)}${session.revert ? " · undo staged" : ""}`
      heading.fg = session.revert ? color.warning : color.muted
      dialog.error.content = session.revert
        ? "Enter Send + commit undo · Alt+Enter newline\nEsc keep · F4 discard · Ctrl+T mode"
        : "Enter Send · Shift/Alt+Enter newline\nEsc keep · F4 discard · Ctrl+T mode"
    }
    dialog.key = (key) => {
      if (!matchesKey(key, "t", { ctrl: true })) return false
      if (draft.submitted !== undefined) {
        dialog.error.content = "Retry keeps the original delivery mode. F4 discards the local draft."
        return true
      }
      draft.delivery = draft.delivery === "steer" ? "queue" : "steer"
      delivery()
      return true
    }
    const task = dialogs.prompt(dialog, "Your message", draft.text, draft.cursor)
    dialog.editor = task
    dialog.editorLocked = () => draft.submitted !== undefined
    task.height = Math.max(3, Math.min(6, task.lineInfo.lineSources.length))
    task.marginBottom = 0
    const contentChanged = task.onContentChange
    const resizeTask = () => {
      const height = Math.max(3, Math.min(6, task.lineInfo.lineSources.length))
      if (task.height === height) return
      task.height = height
      dialogs.resize()
    }
    task.onContentChange = (event) => {
      contentChanged?.(event)
      resizeTask()
    }
    task.onSizeChange = resizeTask
    dialog.save = () => {
      draft.text = draft.submitted ?? task.plainText
      draft.cursor = task.cursorOffset
      if (!draft.text && draft.submitted === undefined) messages.delete(sessionID)
      say("Message draft kept · f to resume")
    }
    dialog.discard = () => {
      messages.delete(sessionID)
    }
    dialog.submit = async () => {
      if (!state.connected) throw new Error("Reconnect before sending. Your draft is kept.")
      if (replyBlocked(sessionID))
        throw new Error("This is a task-owned subagent. Draft kept. Press Esc, then f to open its owning session.")
      if (!task.plainText.trim() || task.plainText.length > 32000)
        throw new Error("Enter a message between 1 and 32,000 characters.")
      if (draft.submitted !== undefined && draft.submitted !== task.plainText)
        throw new Error("Retry the original message. Escape keeps its request ID; F4 discards the local draft.")
      const current = await connection.client.sessions.get({ sessionID })
      if (draft.submitted === undefined && current.revert?.messageID !== session.revert?.messageID)
        throw new Error("The undo position changed. Your draft is kept; close and reopen Reply before sending.")
      if (draft.submitted === undefined) {
        const shell = /^!(.+)/s.exec(task.plainText)?.[1]?.trim()
        // A shell command is not a prompt, so it cannot carry the staged revert
        // that this editor promises to commit on send.
        if (shell && current.revert)
          throw new Error("Commit or clear the staged undo before running a shell command. Your draft is kept.")
        draft.shell = shell
        if (!shell)
          draft.command = await connection.resolveCommand(
            task.plainText,
            current.location.directory,
            current.location.workspaceID,
          )
      }
      if ((draft.command || draft.shell) && draft.delivery === "queue")
        throw new Error(
          `${draft.shell ? "Shell commands" : "Slash commands"} do not support Queue. Press Ctrl+T to choose Steer before sending.`,
        )
      draft.text = task.plainText
      draft.submitted = draft.text
      try {
        if (draft.shell) await connection.shell(sessionID, draft.id, draft.shell)
        else if (draft.command)
          await connection.client.sessions.command({ sessionID, id: draft.id, ...draft.command, resume: true })
        else
          await connection.client.sessions.prompt({
            sessionID,
            id: draft.id,
            prompt: promptPayload(draft.text, current.location.directory),
            delivery: draft.delivery,
          })
      } catch (error) {
        if (error && typeof error === "object" && "kind" in error && error.kind === "session_task_owned") {
          owned.add(sessionID)
          throw new Error("This is a task-owned subagent. Draft kept. Press Esc, then f to open its owning session.")
        }
        throw error
      }
      messages.delete(sessionID)
      say(draft.shell ? "Shell command sent to the server." : "Reply sent.")
    }
    delivery()
    slash.attach(
      dialog,
      task,
      () => session.location,
      () => draft.submitted !== undefined,
    )
    mentions.attach(
      dialog,
      task,
      () => session.location,
      () => draft.submitted !== undefined,
    )
    dialogs.resize()
    task.focus()
  }

  function permission() {
    const request = state.detail?.permissions[0]
    if (!request || state.detail?.sessionID !== state.selected)
      return say("No pending permission for the selected session.")
    const dialog = dialogs.open("Permission request", false, Math.min(28, 18 + request.resources.length), true)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content: "Permission request",
        fg: color.text,
        attributes: TextAttributes.BOLD,
        height: 1,
        flexShrink: 0,
      }),
    )
    recipient(dialog, request.sessionID)
    dialog.form.add(
      new TextRenderable(renderer, {
        content: `${display(request.action)}\n\n${request.resources.map((resource) => display(resource, 1000)).join("\n")}`,
        fg: color.text,
        wrapMode: "word",
      }),
    )
    // "Always" saves the server's own rule for this request, so it is offered only when the server names one.
    const always = request.save?.length
      ? `Also allow ${request.save.map((pattern) => display(pattern, 200)).join(", ")} from now on`
      : undefined
    const choice = new SelectRenderable(renderer, {
      height: always ? 6 : 4,
      options: [
        { name: "Reject", description: "Do not allow this operation" },
        { name: "Allow once", description: "Allow only this request" },
        ...(always ? [{ name: "Allow always", description: label(always, 300) }] : []),
      ],
      backgroundColor: color.bg,
      textColor: color.text,
      descriptionColor: color.muted,
      selectedTextColor: color.accent,
      selectedBackgroundColor: color.selected,
    })
    dialog.form.add(choice)
    dialogs.track(dialog, choice)
    dialog.submit = async () => {
      await connection.client.permissions.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        reply: (["reject", "once", "always"] as const)[choice.getSelectedIndex()] ?? "reject",
      })
      say(choice.getSelectedIndex() === 2 ? "Allowed; the server saved this rule." : "Permission response sent.")
    }
    dialog.error.content = "Ctrl+S Send · Esc close · PgUp/PgDn scroll"
    dialogs.resize()
    choice.focus()
  }

  function question(reject = false) {
    const request = state.detail?.questions[0]
    if (!request || state.detail?.sessionID !== state.selected || request.sessionID !== state.selected)
      return say("No pending question for the selected session.")
    const dialog = dialogs.open("Answer agent", false, 16, true)
    if (!dialog) return
    const { sessionID, id: requestID, questions } = request
    const key = `${sessionID}:${requestID}`
    dialog.questionKey = key
    dialog.recipient = state.snapshot?.sessions.find((session) => session.id === sessionID)
    shownQuestions.add(key)
    if (shownQuestions.size > 256) shownQuestions.delete(shownQuestions.values().next().value!)
    dialog.onNavigate = () => shownQuestions.delete(key)
    dialog.refresh = () => {
      if (
        state.modal === dialog &&
        !dialog.busy &&
        state.detail?.sessionID === sessionID &&
        !state.detail.questions.some((item) => item.id === requestID)
      ) {
        questionDrafts.delete(key)
        dialogs.close(false)
        say("Question is no longer pending.")
      }
    }
    const signature = JSON.stringify(
      questions.map((item) => [
        item.header,
        item.question,
        item.multiple,
        item.custom,
        item.options.map((option) => [option.label, option.description]),
      ]),
    )
    const previous = questionDrafts.get(key)
    const draft =
      previous?.signature === signature
        ? previous
        : {
            signature,
            selections: questions.map(() => new Set<number>()),
            custom: questions.map(() => ""),
            customOn: questions.map(() => false),
            cursors: questions.map(() => 0),
            page: 0,
            review: false,
            reject: false,
            editing: false,
            cursor: 0,
          }
    questionDrafts.delete(key)
    questionDrafts.set(key, draft)
    if (questionDrafts.size > 16) questionDrafts.delete(questionDrafts.keys().next().value!)
    const { selections, custom, customOn, cursors } = draft
    let page = draft.page
    let review = draft.review
    reject = reject || draft.reject
    let editing: InputRenderable | undefined
    let picker: SelectRenderable | undefined
    const heading = new TextRenderable(renderer, {
      content: "",
      fg: color.accent,
      height: 1,
      flexShrink: 0,
      truncate: true,
      wrapMode: "none",
    })
    dialog.frame.add(heading, 0)
    const answers = () =>
      questions.map((question, index) =>
        [
          ...question.options.filter((_, option) => selections[index]!.has(option)).map((option) => option.label),
          ...(customOn[index] && custom[index]!.trim() ? [custom[index]!.trim()] : []),
        ].filter((answer, index, values) => values.indexOf(answer) === index),
      )
    const complete = () => questions.length > 0 && answers().every((answer) => answer.length > 0)
    const text = (content: string, accent = false) => {
      const node = new TextRenderable(renderer, {
        content,
        fg: accent ? color.accent : color.text,
        wrapMode: "word",
        flexShrink: 0,
      })
      dialog.form.add(node)
      return node
    }
    const keepCustom = () => {
      if (editing) {
        custom[page] = editing.value
        draft.cursor = editing.cursorOffset
      }
    }
    dialog.save = () => {
      keepCustom()
      Object.assign(draft, { page, review, reject, editing: !!editing })
    }
    const editCustom = (restore = false) => {
      if (editing) return editing.focus()
      editing = dialogs.input(dialog, "Your answer", custom[page], "Type your answer")
      if (restore) editing.cursorOffset = Math.min(draft.cursor, editing.plainText.length)
      dialog.error.content = "Enter Save custom answer\nCtrl+B Back to choices\nCtrl+K Sessions · Esc close"
      dialogs.resize()
      editing.focus()
    }
    const advance = () => {
      if (!answers()[page]?.length) {
        dialog.error.content = "Choose an answer before continuing.\nEsc close · Ctrl+R Reject"
        return
      }
      if (page < questions.length - 1) page++
      else if (complete()) review = true
      else {
        page = answers().findIndex((answer) => !answer.length)
      }
      render()
    }
    const render = () => {
      editing = undefined
      picker = undefined
      dialog.fields = []
      dialog.index = 0
      for (const child of dialog.form.getChildren()) child.destroyRecursively()
      dialog.form.scrollTo(0)
      dialog.error.height = 3
      heading.content = reject
        ? "Reject question request?"
        : review
          ? "Review answers"
          : `Question ${page + 1} of ${questions.length} · ${label(questions[page]?.header ?? "", 80)}`
      if (reject) {
        text("No answers will be sent. Ctrl+S confirms rejection; Ctrl+R returns to your answers.")
        dialog.error.content = "Ctrl+S Confirm rejection\nCtrl+R Answer instead\nCtrl+K Sessions · Esc close"
        dialog.form.focus()
      } else if (review) {
        answers().forEach((answer, index) => {
          text(`${index + 1}. ${display(questions[index]!.question)}`)
          text(answer.map((value) => `• ${display(value)}`).join("\n"), true)
        })
        text("[ Submit answers — Enter / Ctrl+S ]", true).onMouseDown = (event) => {
          event.preventDefault()
          if (event.button === 0 && !dialog.busy) void dialogs.submit()
        }
        dialog.error.content =
          "Enter / Ctrl+S Submit answers\n← Edit · PgUp/PgDn Scroll\nCtrl+K Sessions · Ctrl+R Reject · Esc close"
        dialog.form.focus()
      } else {
        const question = questions[page]
        if (!question) {
          text("This request has no questions. Close or reject it.")
          dialog.error.content = "Ctrl+R Reject · Esc close"
          dialog.form.focus()
          dialogs.resize()
          return
        }
        text(display(question.question))
        text(question.multiple ? "Choose one or more answers" : "Choose one answer", true)
        const options = () => [
          ...question.options.map((option, index) => ({
            name: `${selections[page]!.has(index) ? "[x]" : "[ ]"} ${display(option.label)}`,
            description: "",
          })),
          ...(question.custom !== false
            ? [
                {
                  name: `${customOn[page] ? "[x]" : "[ ]"} Type your own answer`,
                  description: "",
                },
              ]
            : []),
        ]
        const choice = new SelectRenderable(renderer, {
          height: Math.max(1, Math.min(3, options().length)),
          flexShrink: 0,
          options: options(),
          selectedIndex: cursors[page],
          showDescription: false,
          backgroundColor: color.bg,
          textColor: color.text,
          selectedTextColor: color.accent,
          selectedBackgroundColor: color.selected,
          showScrollIndicator: true,
        })
        picker = choice
        dialog.form.add(choice)
        dialogs.track(dialog, choice)
        const description = text("")
        const describe = () => {
          const index = choice.getSelectedIndex()
          cursors[page] = index
          const option = question.options[index]
          description.content = option
            ? `${display(option.label)}\n${display(option.description)}`
            : `Type your own answer${custom[page] ? `\n${display(custom[page]!)}` : ""}`
        }
        choice.on("selectionChanged", describe)
        describe()
        const select = (toggle: boolean) => {
          if (dialog.busy) return
          const index = choice.getSelectedIndex()
          if (index === question.options.length && question.custom !== false) {
            if (toggle && question.multiple && customOn[page]) {
              customOn[page] = false
              render()
              return
            }
            editCustom()
            return
          }
          if (!question.options[index]) return
          if (question.multiple) {
            if (selections[page]!.has(index)) selections[page]!.delete(index)
            else selections[page]!.add(index)
            choice.options = options()
            choice.setSelectedIndex(index)
          } else {
            selections[page]!.clear()
            selections[page]!.add(index)
            customOn[page] = false
            advance()
          }
        }
        choice.on("itemSelected", () => {
          if (question.multiple && (choice.getSelectedIndex() < question.options.length || customOn[page])) advance()
          else select(false)
        })
        dialog.error.content = `${question.multiple ? "↑↓ Move · Space Toggle · Enter Next" : "↑↓ Move · Enter Select"}\n←/→ Question · PgUp/PgDn Scroll\nCtrl+K Sessions · Ctrl+R Reject · Esc close`
        // Handle Space here; native Select owns arrow movement, not toggling.
        choice.onKeyDown = (key) => {
          if (!matchesKey(key, "space") || editing) return
          key.preventDefault()
          select(true)
        }
        if (draft.editing) {
          draft.editing = false
          editCustom(true)
        } else choice.focus()
      }
      dialogs.resize()
    }
    dialog.key = (key) => {
      if (matchesKey(key, "r", { ctrl: true })) {
        keepCustom()
        reject = !reject
        render()
        return true
      }
      if (reject) return matchesKey(key, "enter")
      if (editing) {
        if (matchesKey(key, "b", { ctrl: true })) {
          keepCustom()
          render()
          return true
        }
        if (!matchesKey(key, "enter")) return false
        keepCustom()
        if (!custom[page]!.trim()) {
          dialog.error.content = "Enter a non-empty answer.\nCtrl+B Back to choices · Esc close"
          return true
        }
        customOn[page] = true
        if (!questions[page]!.multiple) {
          selections[page]!.clear()
          advance()
        } else render()
        return true
      }
      if (matchesKey(key, "left")) {
        if (review) review = false
        else page = Math.max(0, page - 1)
        render()
        return true
      }
      if (matchesKey(key, "right") && !review) {
        advance()
        return true
      }
      if (matchesKey(key, "enter")) {
        if (review) void dialogs.submit()
        else picker?.selectCurrent()
        return true
      }
      return false
    }
    // Shared submission shortcuts run before dialog.key. Never let them skip
    // unanswered questions, an uncommitted custom entry, or the review screen.
    dialog.beforeSubmit = () => {
      if (reject || review) return false
      if (editing) {
        dialog.error.content = "Press Enter to save your custom answer first.\nEsc close"
        return true
      }
      if (complete()) {
        review = true
        render()
      } else {
        dialog.error.content = "Answer every question before reviewing.\n←/→ Navigate · Esc close"
      }
      return true
    }
    dialog.submit = async () => {
      if (reject) {
        await connection.client.questions.reject({ sessionID, requestID })
        questionDrafts.delete(key)
        say("Question rejected.")
        return
      }
      if (!review || editing || !complete()) throw new Error("Answer every question and review before submitting.")
      await connection.client.questions.reply({ sessionID, requestID, answers: answers() })
      questionDrafts.delete(key)
      say("Answers sent.")
    }
    render()
  }

  function interrupt() {
    if (state.tab !== "sessions" || !state.selected) return say("Select a session to interrupt.")
    const id = state.selected
    const dialog = dialogs.open("Interrupt session", false, 19, true)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content: "Interrupt session",
        fg: color.text,
        attributes: TextAttributes.BOLD,
        height: 1,
        flexShrink: 0,
      }),
    )
    recipient(dialog, id)
    dialog.form.add(
      new TextRenderable(renderer, {
        content: "Stop the current work in this session?\n\nType stop, then Ctrl+S to confirm.",
        fg: color.text,
      }),
    )
    const confirmation = dialogs.input(dialog, "Confirmation")
    dialog.submit = async () => {
      if (confirmation.value !== "stop") throw new Error("Type stop to confirm interruption.")
      await connection.client.sessions.interrupt({ sessionID: id })
      say("Session interrupted.")
    }
    dialog.error.content = "Ctrl+S Send · Esc close"
    dialogs.resize()
    confirmation.focus()
  }

  function kill() {
    if (state.tab !== "sessions" || !state.selected) return say("Select a session to kill.")
    const id = state.selected
    const dialog = dialogs.open("Kill session", false, 20, true)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content: "Kill session",
        fg: color.text,
        attributes: TextAttributes.BOLD,
        height: 1,
        flexShrink: 0,
      }),
    )
    recipient(dialog, id)
    dialog.form.add(
      new TextRenderable(renderer, {
        content:
          "Interrupt this session and cancel its active subagent tasks?\nCancelled tasks cannot resume.\n\nType kill, then Ctrl+S to confirm.",
        fg: color.text,
      }),
    )
    const confirmation = dialogs.input(dialog, "Confirmation")
    dialog.submit = async () => {
      if (confirmation.value !== "kill") throw new Error("Type kill to confirm.")
      await connection.client.sessions.interrupt({ sessionID: id })
      const tasks = await connection.client.sessions.taskList({ sessionID: id, limit: 50 })
      const active = [...new Map([...tasks.data, ...tasks.active].map((task) => [task.id, task])).values()].filter(
        (task) => ["queued", "starting", "running"].includes(task.status),
      )
      let cancelled = 0
      for (const task of active) {
        try {
          await connection.client.sessions.taskCancel({
            sessionID: id,
            taskID: task.id,
            expectedRevision: task.revision,
          })
          cancelled++
        } catch {
          // The task may finish between listing and cancellation; the session
          // interrupt above already stops new work.
        }
      }
      say(`Session killed.${cancelled ? ` Cancelled ${cancelled} active task${cancelled === 1 ? "" : "s"}.` : ""}`)
    }
    dialog.error.content = "Ctrl+S Kill · Esc close"
    dialogs.resize()
    confirmation.focus()
  }

  /** The desktop's kill switch: interrupts every running session on this server. */
  function stopAll() {
    const dialog = dialogs.open("Stop all agents", false, 18)
    if (!dialog) return
    dialog.form.add(
      new TextRenderable(renderer, {
        content:
          "Interrupt every running session on this server, including other clients' work?\nQueued messages stay queued; nothing is deleted.\n\nType stop all, then Ctrl+S to confirm.",
        fg: color.text,
        wrapMode: "word",
      }),
    )
    const confirmation = dialogs.input(dialog, "Confirmation")
    dialog.submit = async () => {
      if (confirmation.value !== "stop all") throw new Error("Type stop all to confirm.")
      const result = await connection.client.sessions.interruptAll()
      if (result.failed) throw new Error(`${result.failed} session(s) did not stop; ${result.interrupted} stopped.`)
      say(result.interrupted ? `Stopped ${result.interrupted} session(s).` : "Nothing was running.")
    }
    dialog.error.content = "Ctrl+S Stop all · Esc close"
    confirmation.focus()
  }

  /** Why `text` cannot become the session's reply draft, or nothing when it can. */
  function restoreBlocker(sessionID: string, text: string) {
    const previous = messages.get(sessionID)
    if (!text.trim()) return "The message is empty."
    if (text.length > 32000) return "The message is longer than the reply editor's 32,000 characters."
    if (previous?.submitted !== undefined || previous?.text.trim())
      return "Send or discard your reply draft first; it would be replaced."
    if (!previous && messages.size >= 16) return "16 message drafts are saved. Send or discard one first."
    return undefined
  }

  return {
    restoreBlocker,
    restoreDraft(session: Session, messageID: string, text: string) {
      if (restoreBlocker(session.id, text)) return false
      messages.set(session.id, {
        text: display(text, 32000),
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        recipient: session,
        delivery: "steer",
        restoredFrom: messageID,
      })
      return true
    },
    clearRestoredDraft(sessionID: string, messageID: string, text: string) {
      const draft = messages.get(sessionID)
      if (draft?.restoredFrom === messageID && draft.submitted === undefined && draft.text === display(text, 32000))
        messages.delete(sessionID)
    },
    replyBlocked,
    offerQuestion() {
      const detail = state.detail
      const request = detail?.questions[0]
      if (
        state.closed ||
        !state.connected ||
        state.modal ||
        state.searching ||
        state.tab !== "sessions" ||
        !detail ||
        detail.sessionID !== state.selected ||
        detail.permissions.length ||
        !request ||
        request.sessionID !== state.selected ||
        shownQuestions.has(`${request.sessionID}:${request.id}`)
      )
        return
      question()
    },
    followup,
    permission,
    question,
    interrupt,
    kill,
    stopAll,
    hasDraft: (id: string) => messages.has(id),
    /** Adds text, such as an @file mention, to the end of the session's reply draft. */
    mention(session: Session, text: string) {
      const draft = messages.get(session.id)
      if (draft?.submitted !== undefined || (!draft && messages.size >= 16)) return false
      if (!draft) {
        messages.set(session.id, {
          text,
          id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
          recipient: session,
          delivery: "steer",
        })
        return true
      }
      const next = `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}${text}`
      if (next.length > 32000) return false
      draft.text = next
      draft.cursor = next.length
      return true
    },
    /** Drops a saved draft whose session no longer exists. */
    forget: (id: string) => messages.delete(id),
    savedSessions: () => [...messages.values()].map((draft) => draft.recipient),
    updateRecipient: (session: Session) => {
      const draft = messages.get(session.id)
      if (draft) draft.recipient = session
    },
  }
}
