import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { Tabs } from "@turenlabs/ui/tabs"
import { ResizeHandle } from "@turenlabs/ui/resize-handle"
import { IconButton } from "@turenlabs/ui/icon-button"
import { TooltipKeybind } from "@turenlabs/ui/tooltip"
import { TooltipV2 } from "@turenlabs/ui/v2/tooltip-v2"
import { KeybindV2 } from "@turenlabs/ui/v2/keybind-v2"

import { SortableTerminalTabV2 } from "@/components/session/session-sortable-terminal-tab-v2"
import { Terminal } from "@/components/terminal"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { useTerminal } from "@/context/terminal"
import { useSDK } from "@/context/sdk"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { createSizing, focusTerminalById } from "@/pages/session/helpers"
import { useParams } from "@solidjs/router"
import { getTerminalHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionPanelRenderHold, useSessionPanelRender } from "@/pages/session/session-panel-render"

export function TerminalPanelV2(
  props: {
    stacked?: boolean
    alwaysOpen?: boolean
    autoCreate?: boolean
    recoverOnConnectError?: boolean
    deferRender?: () => boolean
    onNew?: () => void
    onConnect?: (id: string) => void
    onConnectError?: (id: string, error: unknown) => void
  } = {},
) {
  const layout = useLayout()
  const terminal = useTerminal()
  const sdk = useSDK()
  const language = useLanguage()
  const command = useCommand()
  const settings = useSettings()
  const params = useParams()
  const { workspaceKey, view } = useSessionLayout()
  const panelRenderDeferred = useSessionPanelRender()
  const sessionID = createSessionPanelRenderHold(
    () => props.deferRender?.() ?? panelRenderDeferred(),
    () => params.id,
    params.id,
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const newLayout = createMemo(() => settings.general.newLayoutDesigns())
  const opened = createMemo(() => props.alwaysOpen || view().terminal.opened())
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const close = () => {
    if (props.alwaysOpen) return
    view().terminal.close()
  }
  const newTerminal = () => {
    if (props.onNew) {
      props.onNew()
      return
    }
    terminal.new({ focus: true })
  }
  let root: HTMLDivElement | undefined
  let tabList: HTMLDivElement | undefined

  onCleanup(() => terminal.cancelFocus())

  const [store, setStore] = createStore({
    autoCreated: false,
    recovered: {} as Record<string, boolean>,
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())
  const stacked = createMemo(() => isDesktop() && props.stacked)
  const panelHeight = createMemo(() =>
    isDesktop() ? (stacked() ? `${pane()}px` : "100%") : opened() ? `${pane()}px` : "0px",
  )
  const contentHeight = createMemo(() => (isDesktop() ? (stacked() ? `${pane()}px` : "100%") : `${pane()}px`))
  const newTerminalKeybind = createMemo(() => command.keybindParts("terminal.new"))

  onMount(() => {
    if (typeof window === "undefined") return

    const sync = () => setStore("view", window.visualViewport?.height ?? window.innerHeight)
    const port = window.visualViewport

    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  createEffect(() => {
    if (!opened()) {
      setStore("autoCreated", false)
      return
    }

    if (props.autoCreate === false) return
    if (!terminal.ready() || store.autoCreated) return
    const id = sessionID()
    if (id && terminal.all().some((pty) => pty.shared && pty.sessionID === id)) return
    if (!id && terminal.all().length !== 0) return
    const request = id ? terminal.shared(id) : terminal.new()
    void request.then((next) => {
      if (next) setStore("autoCreated", true)
    })
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (props.alwaysOpen) return
        if (prevCount === undefined || prevCount <= 0 || count !== 0) return
        if (!opened()) return
        close()
      },
    ),
  )

  createEffect(
    on(
      () => [opened(), terminal.active(), terminal.focusRequested(terminal.active())] as const,
      ([next, id, requested]) => {
        if (!next || !id || !requested) return
        focusTerminalById(id)
      },
    ),
  )

  createEffect(() => {
    if (opened()) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    if (!root?.contains(active)) return
    active.blur()
  })

  createEffect(() => {
    const dir = sdk().directory
    if (!dir) return
    if (!terminal.ready()) return
    language.locale()

    setTerminalHandoff(
      workspaceKey(),
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  const handoff = createMemo(() => {
    const dir = sdk().directory
    if (!dir) return []
    return getTerminalHandoff(workspaceKey()) ?? []
  })

  const all = terminal.all
  const ids = createMemo(() => all().map((pty) => pty.id))

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key]) return
    setStore("recovered", key, true)
    const shared = terminal.all().find((pty) => pty.id === id)
    if (shared?.shared && shared.sessionID) {
      terminal.remove(id)
      void terminal.shared(shared.sessionID, { focus: true })
      return
    }
    void clone(id)
  }

  const terminalRecoveryKey = (pty: { id: string; title: string; titleNumber: number }) => {
    return String(pty.titleNumber || pty.title || pty.id)
  }

  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    trim(id)
    props.onConnect?.(id)
  }

  const handleTerminalConnectError = (
    key: string,
    id: string,
    error: unknown,
    clone: (id: string) => Promise<void>,
  ) => {
    props.onConnectError?.(id, error)
    if (props.recoverOnConnectError === false) return
    recoverTerminal(key, id, clone)
  }

  const handleTerminalDragEnd = () => {
    const activeId = terminal.active()
    if (!activeId) return
    requestAnimationFrame(() => {
      if (terminal.active() !== activeId) return
      focusTerminalById(activeId)
    })
  }

  return (
    <aside
      ref={root}
      id="terminal-panel"
      role="region"
      aria-label={language.t("terminal.title")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="relative shrink-0 overflow-hidden bg-v2-background-bg-base"
      classList={{
        "w-full": !isDesktop() || stacked(),
        "min-w-0 h-full flex-1": isDesktop() && opened() && !stacked(),
        "w-0 h-full pointer-events-none": isDesktop() && !opened(),
        "rounded-[10px] shadow-[var(--v2-elevation-raised)]": isDesktop() && newLayout(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !isDesktop() && !size.active(),
      }}
      style={{ height: panelHeight() }}
    >
      <div classList={{ "md:hidden": !stacked(), hidden: stacked() }} onPointerDown={() => size.start()}>
        <ResizeHandle
          classList={{
            "-top-1": newLayout(),
          }}
          direction="vertical"
          size={pane()}
          min={100}
          max={max()}
          collapseThreshold={50}
          onResize={(next) => {
            size.touch()
            layout.terminal.resize(next)
          }}
          onCollapse={close}
        />
      </div>
      <div
        class="absolute inset-0 flex flex-col overflow-hidden"
        classList={{
          "border-t border-border-weak-base": opened() && !isDesktop(),
          "border-t border-border-weaker-base": opened() && stacked() && !newLayout(),
          "border-l border-border-weaker-base": opened() && isDesktop() && !newLayout(),
          "pointer-events-none": !opened(),
        }}
        style={{ height: contentHeight() }}
      >
        <Show
          when={terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weaker-base bg-v2-background-bg-base overflow-hidden">
                <For each={handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">{language.t("terminal.loading")}</div>
            </div>
          }
        >
          <DragDropProvider
            sensors={[
              PointerSensor.configure({
                activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                preventActivation: (event) =>
                  event.target instanceof Element &&
                  !!event.target.closest('[data-slot="tabs-trigger-close-button"], input, [contenteditable="true"]'),
              }),
            ]}
            modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => tabList ?? null })]}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
              Feedback.configure({ dropAnimation: null }),
            ]}
            onDragEnd={(event) => {
              const source = event.operation.source
              if (!event.canceled && isSortable(source) && source.initialIndex !== source.index) {
                terminal.move(source.id.toString(), source.index)
              }
              handleTerminalDragEnd()
            }}
          >
            <div class="flex flex-col h-full">
              <Tabs
                variant={newLayout() ? "normal" : "alt"}
                value={terminal.active()}
                onChange={(id) => terminal.open(id)}
                class={newLayout() ? "!h-[52px] !flex-none" : "!h-auto !flex-none"}
              >
                <Tabs.List
                  ref={tabList}
                  class={newLayout() ? undefined : "h-10 border-b border-border-weaker-base"}
                  onPointerDown={(event: PointerEvent & { currentTarget: HTMLDivElement }) => {
                    const active = document.activeElement
                    if (event.target === active) return
                    if (active instanceof HTMLInputElement && event.currentTarget.contains(active)) active.blur()
                  }}
                >
                  <For each={all()}>
                    {(pty, index) => (
                      <SortableTerminalTabV2 terminal={pty} index={index} newLayout={newLayout()} onClose={close} />
                    )}
                  </For>
                  <div class="h-full flex items-center justify-center">
                    <Show
                      when={newLayout()}
                      fallback={
                        <TooltipKeybind
                          title={language.t("command.terminal.new")}
                          keybind={command.keybind("terminal.new")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            onClick={newTerminal}
                            aria-label={language.t("command.terminal.new")}
                          />
                        </TooltipKeybind>
                      }
                    >
                      <TooltipV2
                        value={
                          <>
                            {language.t("command.terminal.new")}
                            <Show when={newTerminalKeybind().length > 0}>
                              <KeybindV2 keys={newTerminalKeybind()} variant="neutral" />
                            </Show>
                          </>
                        }
                        placement="bottom"
                        class="flex items-center"
                      >
                        <IconButton
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          onClick={newTerminal}
                          aria-label={language.t("command.terminal.new")}
                        />
                      </TooltipV2>
                    </Show>
                  </div>
                </Tabs.List>
              </Tabs>
              <div class="flex-1 min-h-0 relative">
                <Show when={opened() && terminal.active()} keyed>
                  {(id) => {
                    const ops = terminal.bind()
                    return (
                      <Show when={all().find((pty) => pty.id === id)}>
                        {(pty) => (
                          <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                            <Terminal
                              pty={pty()}
                              autoFocus={terminal.focusRequested(id)}
                              onAutoFocus={() => terminal.consumeFocus(id)}
                              class="!px-[14px]"
                              onConnect={() => markTerminalConnected(terminalRecoveryKey(pty()), id, ops.trim)}
                              onCleanup={ops.update}
                              onConnectError={(error) =>
                                handleTerminalConnectError(terminalRecoveryKey(pty()), id, error, ops.clone)
                              }
                            />
                          </div>
                        )}
                      </Show>
                    )
                  }}
                </Show>
              </div>
            </div>
          </DragDropProvider>
        </Show>
      </div>
    </aside>
  )
}
