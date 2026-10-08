import { Show, createEffect, createMemo, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useSearchParams } from "@solidjs/router"
import { Tooltip } from "@turenlabs/ui/tooltip"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@turenlabs/ui/v2/dialog-v2"
import { NewSessionDesignView } from "@/components/session"
import { PromptInput } from "@/components/prompt-input"
import { StatusPopoverV2 } from "@/components/status-popover"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  createPromptProjectController,
} from "@/components/prompt-project-selector"
import { useComments } from "@/context/comments"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { usePlatform } from "@/context/platform"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { useSessionKey } from "@/pages/session/session-layout"
import { TerminalPanelV2 } from "@/pages/session/terminal-panel-v2"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useCommand, useCommandPalette } from "@/context/command"
import { useSurfaceCommands } from "@/pages/session/use-surface-commands"
import { useSettingsCommand } from "@/components/settings-dialog"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { useLocal } from "@/context/local"
import { createPromptModelSelection } from "@/pages/session/composer/prompt-model-selection"
import { createSessionGoalController } from "@/pages/session/goal/session-goal-controller"
import { DailyTips, TipCatalog } from "@/pages/new-session/daily-tip"
import { tipStorage } from "@/pages/new-session/tip-preferences"

/**
 * The `/new-session` draft page. Unlike `session.tsx`, this only renders the prompt
 * composer for a brand-new session — no terminal, review pane, file tree, or message
 * timeline. Submitting promotes the draft into a real session (see prompt-input/submit).
 */
export default function NewSessionPage() {
  const prompt = usePrompt()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const comments = useComments()
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()
  const dialog = useDialog()
  const command = useCommand()
  const tipCommands = {
    keybind: command.keybind,
    available: (id: string) =>
      command.options.some((option) => option.id === id && !option.disabled && !!option.onSelect),
    run: command.trigger,
  }
  useSettingsCommand()
  const tipsStorage = tipStorage(platform)
  const route = useSessionKey()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const local = useLocal()
  const model = createPromptModelSelection({ agent: local.agent.current })
  const goal = createSessionGoalController({
    sessionID: () => route.params.id,
    sessionKey: route.sessionKey,
    onInterrupted: (outcome) =>
      showToast({
        title: language.t("session.recovery.interrupted"),
        description:
          "next" in outcome && outcome.next === "scheduled"
            ? language.t("session.recovery.interrupted.scheduled", { reason: outcome.reason })
            : outcome.reason,
      }),
    onRecoveryError: (failure) =>
      showToast({
        persistent: true,
        variant: "error",
        title: language.t("session.recovery.failed"),
        description: language.t("session.recovery.failed.description"),
        actions: [
          { label: language.t("session.recovery.retry"), onClick: failure.retry },
          { label: language.t("common.dismiss"), onClick: "dismiss" },
        ],
      }),
  })

  useComposerCommands({ model, goal: { toggle: goal.toggleMode } })

  let inputRef: HTMLDivElement | undefined

  const surface = useSurfaceCommands({ focusInput: () => inputRef?.focus() })
  const terminalOpen = surface.opened

  const inputController = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    queryOptions: serverSync().queryOptions,
    model,
  })
  const projectControls = createPromptProjectControls()
  const projectController = createPromptProjectController({
    controls: projectControls,
    onDone: () => inputRef?.focus(),
  })

  useCommandPalette(() => {
    void import("@/components/dialog-select-file").then(({ DialogSelectFile }) => {
      void dialog.show(() => <DialogSelectFile />)
    })
  })

  function openTips() {
    void dialog.show(() => (
      <Dialog size="normal" class="max-h-[min(80vh,620px)] w-[min(92vw,560px)]">
        <DialogHeader>
          <DialogTitle>{language.t("tips.dialog.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody class="min-h-0 overflow-y-auto p-4">
          <TipCatalog
            translate={language.t}
            commands={{
              ...tipCommands,
              run: (id) => {
                dialog.close()
                command.trigger(id)
              },
            }}
          />
        </DialogBody>
      </Dialog>
    ))
  }

  const [store, setStore] = createStore<{ worktree?: string }>({})
  const rightMount = useTitlebarRightMount()

  const showWorkspaceBar = createMemo(() => sync().project?.vcs === "git")
  const newSessionWorktree = createMemo(() => {
    if (!showWorkspaceBar()) return "main"
    if (store.worktree) return store.worktree
    const project = sync().project
    if (project && pathKey(sdk().directory) !== pathKey(project.worktree)) return sdk().directory
    return "main"
  })
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const localBranch = createMemo(() => serverSync().child(projectRoot())[0].vcs?.branch)
  const selectedBranch = createMemo(() => {
    const worktree = newSessionWorktree()
    if (worktree === "main" || worktree === "create") return localBranch()
    return serverSync().child(worktree)[0].vcs?.branch ?? localBranch()
  })

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  createEffect(() => {
    if (!prompt.ready()) return
    requestAnimationFrame(() => inputRef?.focus())
  })
  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-1">
              <Show when={settings.visibility.status()}>
                <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                  <StatusPopoverV2 />
                </Tooltip>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <div class="@container relative flex flex-col min-w-0 min-h-0 h-full flex-1">
          <div class="flex-1 min-h-0 overflow-hidden">
            <NewSessionDesignView>
              <div class={NEW_SESSION_CONTENT_WIDTH}>
                <Show
                  when={prompt.ready()}
                  fallback={
                    <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak pointer-events-none">
                      {language.t("prompt.loading")}
                    </div>
                  }
                >
                  <div class="flex flex-col" classList={{ "gap-8": showWorkspaceBar(), "gap-3": !showWorkspaceBar() }}>
                    <PromptInput
                      controls={inputController()}
                      variant="new-session"
                      ref={(el) => {
                        inputRef = el
                      }}
                      newSessionWorktree={newSessionWorktree()}
                      onNewSessionWorktreeReset={() => setStore("worktree", undefined)}
                      onSubmit={() => comments.clear()}
                      goal={goal}
                      toolbar={
                        <Show when={!projectController.selected()}>
                          <PromptProjectAddButton controller={projectController} />
                        </Show>
                      }
                    />
                    <Show when={projectController.selected()}>
                      <div
                        class="flex min-h-7 min-w-0 items-center gap-0 text-v2-text-text-faint"
                        classList={{
                          "flex-col justify-center sm:flex-row": showWorkspaceBar(),
                          "justify-start": !showWorkspaceBar(),
                        }}
                      >
                        <PromptProjectSelector
                          controller={projectController}
                          placement={showWorkspaceBar() ? "bottom" : "bottom-start"}
                        />
                        <Show when={showWorkspaceBar()}>
                          <PromptWorkspaceSelector
                            value={newSessionWorktree()}
                            projectRoot={projectRoot()}
                            workspaces={sync().project?.sandboxes ?? []}
                            branch={selectedBranch()}
                            onChange={(value) =>
                              setStore(
                                "worktree",
                                value === "main" && pathKey(sync().project?.worktree ?? "") !== pathKey(sdk().directory)
                                  ? sync().project?.worktree
                                  : value,
                              )
                            }
                            onDone={() => inputRef?.focus()}
                          />
                        </Show>
                      </div>
                    </Show>
                  </div>
                </Show>
                <DailyTips
                  storage={tipsStorage}
                  translate={language.t}
                  commands={tipCommands}
                  openTips={openTips}
                  onSaveFailed={() => showToast({ variant: "error", title: language.t("tips.saveFailed") })}
                />
              </div>
            </NewSessionDesignView>
          </div>
        </div>
        <Show when={terminalOpen()}>
          <div class="min-w-0 min-h-0 shrink-0 md:h-full md:flex-1 border-t border-v2-border-border-base md:border-t-0 md:border-l">
            <TerminalPanelV2 />
          </div>
        </Show>
      </div>
    </div>
  )
}
