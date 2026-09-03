import { useNavigate } from "@solidjs/router"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { previewSelectedLines } from "@turenlabs/session-ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { showToast } from "@/utils/toast"
import { errorMessage } from "@/pages/layout/helpers"
import { sessionTurnActivity } from "@/pages/session/goal/session-v2-timeline-controller"
import { findLast } from "@turenlabs/core/util/array"
import { createSessionTabs } from "@/pages/session/helpers"
import { extractPromptFromParts } from "@/utils/prompt"
import { UserMessage } from "@turenlabs/sdk/v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionOwnership } from "./session-ownership"
import { applySessionV2Revert, clearSessionV2Revert, stageSessionV2Revert } from "./session-v2-revert"
import { compactSessionV2, createSessionV2TranscriptCommands } from "./session-v2-commands"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  review?: () => boolean
  fileBrowser?: () => boolean
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const settings = useSettings()
  const sync = useSync()
  const terminal = useTerminal()
  const layout = useLayout()
  const navigate = useNavigate()
  const { params, sessionKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const openDialog = async <T,>(load: () => Promise<T>, show: (value: T) => void) => {
    const owner = sessionOwnership.capture()
    const value = await load()
    owner.run(() => show(value))
  }
  const runCommand = async <T,>(input: {
    owner: ReturnType<ReturnType<typeof createSessionOwnership>["capture"]>
    prompt: T
    request: () => Promise<unknown>
    updatePrompt: (prompt: T) => void
    updateViewport: () => void
  }) => {
    await input.request()
    input.updatePrompt(input.prompt)
    input.owner.run(input.updateViewport)
  }

  const info = () => {
    const id = params.id
    if (!id) return
    return sync().session.get(id)
  }
  const hasReview = () => !!params.id
  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: actions.review,
    hasReview,
    fileBrowser: actions.fileBrowser,
  })
  const activeFileTab = tabState.activeFileTab
  const closableTab = tabState.closableTab
  const shown = settings.visibility.fileTree

  const messages = () => {
    const id = params.id
    if (!id) return []
    return sync().data.message[id] ?? []
  }
  const userMessages = () => messages().filter((m) => m.role === "user") as UserMessage[]
  const visibleUserMessages = () => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  }

  const showAllFiles = () => {
    if (layout.fileTree.tab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path, selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const unshare = async () => {
    const sessionID = params.id
    if (!sessionID) return

    await sdk()
      .client.session.unshare({ sessionID })
      .then(() =>
        showToast({
          title: language.t("toast.session.unshare.success.title"),
          description: language.t("toast.session.unshare.success.description"),
          variant: "success",
        }),
      )
      .catch(() =>
        showToast({
          title: language.t("toast.session.unshare.failed.title"),
          description: language.t("toast.session.unshare.failed.description"),
          variant: "error",
        }),
      )
  }

  const openFile = () => {
    void openDialog(
      () => import("@/components/dialog-select-file"),
      (x) => dialog.show(() => <x.DialogSelectFile onOpenFile={showAllFiles} />),
    )
  }

  const closeTab = () => {
    const tab = closableTab()
    if (!tab) return
    tabs().close(tab)
  }

  const addSelection = () => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = file.selectedLines(path) as SelectedLineRange | null | undefined
    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  const closeTerminal = async () => {
    const id = terminal.active()
    if (!id) return
    const last = terminal.all().length === 1
    await terminal.close(id)
    if (last && terminal.all().length === 0) view().terminal.close()
  }

  const compact = async () => {
    const sessionID = params.id
    if (!sessionID) return
    // Optimistic, because the durable stream is not a complete account of a manual compaction: it
    // runs outside any turn, and the declines that happen before summarization starts publish no
    // event at all. Without this the transcript never acknowledged the `/compact` the user ran --
    // several seconds of silence, then a toast.
    sessionTurnActivity.setCompacting(sessionID, true)
    sessionTurnActivity.setCompactionFailure(sessionID, undefined)
    await compactSessionV2(sdk().client, sessionID)
      .then(() =>
        showToast({
          title: language.t("toast.session.compact.success.title"),
          description: language.t("toast.session.compact.success.description"),
          variant: "success",
        }),
      )
      // The server answers a refused compaction with the reason in the message. Surface it
      // verbatim -- a manual action that quietly does nothing is the failure mode being fixed --
      // and leave it in the transcript as well as the toast, which a user who looked away misses.
      .catch((err) => {
        const description = errorMessage(err, language.t("toast.session.compact.failed.title"))
        sessionTurnActivity.setCompactionFailure(sessionID, {
          reason: "providerFailed",
          // The transcript notice says "Compaction failed" itself; the server says it again in its
          // message. One is enough.
          detail: description.replace(/^session compaction failed:\s*/i, ""),
        })
        showToast({
          title: language.t("toast.session.compact.failed.title"),
          description,
          variant: "error",
        })
      })
      // A compaction that declines before it starts publishes nothing, so the busy mark this
      // request set has no closing event and would hang until the next model step. The request
      // settling is that close: `compact` refuses to run beside a turn, so no other turn owns this
      // session's status while it runs.
      .finally(() => {
        sessionTurnActivity.setCompacting(sessionID, false)
        sync().set("session_status", sessionID, { type: "idle" })
      })
  }

  const undo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const client = sdk().client
    const directory = sdk().directory
    const promptSession = prompt.capture()
    const revert = info()?.revert?.messageID
    const messages = userMessages()
    const message = findLast(messages, (x) => !revert || x.id < revert)
    if (!message) return
    const parts = sync().data.part[message.id]

    await runCommand({
      owner,
      prompt: promptSession,
      request: () =>
        stageSessionV2Revert(client, { sessionID, messageID: message.id }).then((revert) => {
          const session = sync().session.get(sessionID)
          if (session) sync().session.remember(applySessionV2Revert(session, revert))
        }),
      updatePrompt: (promptSession) => {
        if (parts) promptSession.set(extractPromptFromParts(parts, { directory }))
      },
      updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id < message.id)),
    })
  }

  const redo = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const owner = sessionOwnership.capture()
    const client = sdk().client
    const messages = userMessages()
    const promptSession = prompt.capture()

    const revertMessageID = info()?.revert?.messageID
    if (!revertMessageID) return

    const next = messages.find((x) => x.id > revertMessageID)
    if (!next) {
      await runCommand({
        owner,
        prompt: promptSession,
        request: () =>
          clearSessionV2Revert(client, sessionID).then(() => {
            const session = sync().session.get(sessionID)
            if (session) sync().session.remember(applySessionV2Revert(session, undefined))
          }),
        updatePrompt: (promptSession) => promptSession.reset(),
        updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id >= revertMessageID)),
      })
      return
    }

    await runCommand({
      owner,
      prompt: promptSession,
      request: () =>
        stageSessionV2Revert(client, { sessionID, messageID: next.id }).then((revert) => {
          const session = sync().session.get(sessionID)
          if (session) sync().session.remember(applySessionV2Revert(session, revert))
        }),
      updatePrompt: () => undefined,
      updateViewport: () => setActiveMessage(findLast(messages, (x) => x.id < next.id)),
    })
  }

  const unshareCmds = () => {
    if (!params.id || info()?.shared !== true) return []
    return [
      sessionCommand({
        id: "session.unshare",
        title: language.t("command.session.unshare"),
        description: language.t("command.session.unshare.description"),
        slash: "unshare",
        onSelect: unshare,
      }),
    ]
  }

  const sessionCmds = () =>
    createSessionV2TranscriptCommands({
      command: sessionCommand,
      showNew: !settings.general.newLayoutDesigns(),
      onNew: () => navigate(`/${params.dir}/session`),
      onUndo: undo,
      onRedo: redo,
      onCompact: compact,
      canUndo: !!params.id && visibleUserMessages().length > 0,
      canRedo: !!params.id && !!info()?.revert?.messageID,
      canCompact: !!params.id && visibleUserMessages().length > 0,
      labels: {
        new: language.t("command.session.new"),
        undo: language.t("command.session.undo"),
        undoDescription: language.t("command.session.undo.description"),
        redo: language.t("command.session.redo"),
        redoDescription: language.t("command.session.redo.description"),
        compact: language.t("command.session.compact"),
        compactDescription: language.t("command.session.compact.description"),
      },
    })

  const fileCmds = () => {
    const tab = closableTab()
    return [
      fileCommand({
        id: "file.open",
        title: language.t("command.file.open"),
        description: language.t("palette.search.placeholder"),
        keybind: "mod+p",
        slash: "open",
        onSelect: openFile,
      }),
      // Distinct id from the window-level `tab.close` (titlebar.tsx `tabs` registry) so
      // both can be registered at once without tripping the duplicate-id warning in
      // command.tsx. `when` makes this one win the shared mod+w binding explicitly -
      // closing the open file view should take precedence over closing the whole
      // window tab - the same pattern `terminal.close` uses below.
      tab &&
        fileCommand({
          id: "file.close",
          title: language.t("command.tab.close"),
          keybind: "mod+w",
          when: () => true,
          onSelect: closeTab,
        }),
    ].filter((v) => !!v)
  }

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  // `terminal.toggle`, `terminal.new` and `input.focus` are surface-scoped and shared
  // with the draft composer - see `useSurfaceCommands`.
  const viewCmds = () => [
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => view().reviewPanel.toggle(),
    }),
    ...(shown()
      ? [
          viewCommand({
            id: "fileTree.toggle",
            title: language.t("command.fileTree.toggle"),
            keybind: "mod+\\",
            onSelect: () => layout.fileTree.toggle(),
          }),
        ]
      : []),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.close",
      title: language.t("terminal.close"),
      keybind: "mod+w",
      hidden: true,
      when: (event) => event.target instanceof Element && !!event.target.closest('[data-component="terminal"]'),
      onSelect: closeTerminal,
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...unshareCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
  ])
}
