import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createUniqueId,
  For,
  JSX,
  onCleanup,
  Show,
  ValidComponent,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { isRemovedProvider, popularProviders } from "@/hooks/use-providers"
import { Button } from "@turenlabs/ui/button"
import { IconButton } from "@turenlabs/ui/icon-button"
import { ScrollView } from "@turenlabs/ui/scroll-view"
import { Tag } from "@turenlabs/ui/tag"
import { Dialog } from "@turenlabs/ui/dialog"
import { List } from "@turenlabs/ui/list"
import { Tooltip } from "@turenlabs/ui/tooltip"
import { Icon } from "@turenlabs/ui/v2/icon"
import { Tag as TagV2 } from "@turenlabs/ui/v2/badge-v2"
import { MenuV2 } from "@turenlabs/ui/v2/menu-v2"
import { TooltipV2 } from "@turenlabs/ui/v2/tooltip-v2"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { createEventListener } from "@solid-primitives/event-listener"
import { matchesModelSearch } from "./dialog-select-model-search"
import { modelCapabilitySummary } from "./model-selection-display"
import { useSettingsDialog } from "./settings-dialog"

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]
type ModelPickerState = Pick<ModelState, "current" | "list" | "recent" | "set" | "visible">

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"

const sortModelGroups = (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
  const aIndex = popularProviders.indexOf(a.category)
  const bIndex = popularProviders.indexOf(b.category)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0

  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelPickerState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => !isRemovedProvider(m.provider.id))
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          openDelay={0}
          value={<ModelTooltip model={item} latest={item.latest} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelPickerState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const showProviders = useSettingsDialog("providers")

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    showProviders()
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelPickerState
  selected?: { providerID: string; modelID: string }
  onSelect?: (model: { providerID: string; modelID: string }) => void
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: () => void
}) {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = createStore({ open: false, search: "", active: "" })
  const contentID = createUniqueId()
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let restoreTrigger = true

  const allModels = createMemo(() =>
    model
      .list()
      .filter((item) => !isRemovedProvider(item.provider.id))
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (props.provider ? item.provider.id === props.provider : true)),
  )
  const models = createMemo(() => {
    const search = store.search.trim()
    const filtered = search
      ? allModels().filter((item) =>
          matchesModelSearch(search, [item.name, item.id, item.provider.name, modelCapabilitySummary(item)]),
        )
      : allModels()

    return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  })
  const groups = createMemo(() => {
    const recent = store.search.trim()
      ? []
      : model
          .recent()
          .filter(
            (item): item is ModelItem => !!item && models().some((candidate) => modelKey(candidate) === modelKey(item)),
          )
    const recentKeys = new Set(recent.map(modelKey))
    const byProvider = new Map<string, ModelItem[]>()
    for (const item of models().filter((item) => !recentKeys.has(modelKey(item)))) {
      byProvider.set(item.provider.id, [...(byProvider.get(item.provider.id) ?? []), item])
    }
    const providers = Array.from(byProvider, ([category, items]) => ({ category, items }))
      .sort(sortModelGroups)
      .map((group) => ({ ...group, label: group.items[0].provider.name }))
    if (recent.length === 0) return providers
    return [{ category: "recent", label: "Recent", items: recent }, ...providers]
  })
  const keys = () => [...groups().flatMap((group) => group.items.map(modelKey)), manageKey]
  const current = () => {
    if (props.selected) return `${props.selected.providerID}:${props.selected.modelID}`
    const value = model.current()
    return value ? `${value.provider.id}:${value.id}` : undefined
  }
  const initialActive = () => {
    const selected = current()
    const options = keys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`) : undefined
  const afterClose = (callback: () => void) => {
    const complete = () => {
      if (contentRef?.isConnected) {
        requestAnimationFrame(complete)
        return
      }
      requestAnimationFrame(() => requestAnimationFrame(callback))
    }
    requestAnimationFrame(complete)
  }
  const setOpen = (open: boolean) => {
    if (open) {
      restoreTrigger = true
      setStore({ open: true, active: initialActive() })
      setTimeout(() =>
        requestAnimationFrame(() => {
          if (!store.open) return
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  const select = (item: ModelItem) => {
    if (props.onSelect) {
      props.onSelect({ modelID: item.id, providerID: item.provider.id })
      return
    }
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
  }
  const selectModel = (item: ModelItem) => {
    restoreTrigger = false
    select(item)
    setOpen(false)
    props.onClose?.()
  }
  const manage = () => {
    restoreTrigger = false
    setOpen(false)
    afterClose(() => {
      void import("./dialog-manage-models").then((x) => {
        dialog.show(() => <x.DialogManageModelsV2 />)
      })
    })
  }
  const selectActive = () => {
    const item = models().find((item) => modelKey(item) === store.active)
    if (item) {
      selectModel(item)
      return
    }
    if (store.active === manageKey) manage()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    const search = value.trim()
    const first = [...allModels()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((item) =>
        matchesModelSearch(search, [item.name, item.id, item.provider.name, modelCapabilitySummary(item)]),
      )
    setStore({ search: value, active: first ? modelKey(first) : manageKey })
  }

  createEffect(() => {
    if (!store.open) return
    createEventListener(
      document,
      "keydown",
      (event: KeyboardEvent) => handleDocumentSearchKeydown(searchRef, event, store.search, setSearch),
      true,
    )
  })

  return (
    <MenuV2 open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content
          id={contentID}
          ref={(el: HTMLDivElement) => (contentRef = el)}
          class="w-[calc(100vw-16px)] max-w-[368px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={() => (restoreTrigger = false)}
          onFocusOutside={() => (restoreTrigger = false)}
          onCloseAutoFocus={(event) => {
            if (!restoreTrigger) event.preventDefault()
          }}
        >
          <div class="flex flex-col gap-0.5 px-3 pb-2 pt-3">
            <div class="text-[13px] font-[530] leading-5 text-v2-text-text-strong">Choose a model</div>
            <div class="text-[11px] font-[440] leading-4 text-v2-text-text-faint">
              Pick based on the kind of work you are doing. Your recent choices stay at the top.
            </div>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <div class="flex h-7 items-center gap-2 rounded-sm pl-3 pr-2.5 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                role="combobox"
                aria-expanded="true"
                aria-controls={contentID}
                aria-autocomplete="list"
                aria-activedescendant={store.active ? `${contentID}-${store.active}` : undefined}
                placeholder={language.t("dialog.model.search.placeholder")}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") {
                    restoreTrigger = false
                    event.stopPropagation()
                    setOpen(false)
                    return
                  }
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    restoreTrigger = false
                    setOpen(false)
                    afterClose(() => props.onClose?.())
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveActive(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveActive(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    selectActive()
                  }
                }}
              />
              <Show when={store.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setSearch("")}
                  aria-label={language.t("common.clear")}
                >
                  <Icon name="close" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <ScrollView data-slot="model-selector-scroll" class="max-h-[320px] min-h-0">
            <div class="flex flex-col p-0.5 pt-0">
              <Show
                when={models().length > 0}
                fallback={
                  <div class="flex h-12 items-center px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint">
                    {language.t("dialog.model.empty")}
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <MenuV2.Group>
                      <MenuV2.GroupLabel class="gap-2 px-3">
                        <span class="min-w-0 truncate">{group.label}</span>
                      </MenuV2.GroupLabel>
                      <MenuV2.RadioGroup value={current()}>
                        <For each={group.items}>
                          {(item) => (
                            <TooltipV2
                              class="w-full"
                              placement="right-start"
                              gutter={6}
                              openDelay={0}
                              value={<ModelTooltip model={item} latest={item.latest} v2 />}
                            >
                              <MenuV2.RadioItem
                                id={`${contentID}-${modelKey(item)}`}
                                value={modelKey(item)}
                                data-option-key={modelKey(item)}
                                data-selected-model={current() === modelKey(item) ? true : undefined}
                                class="!h-auto min-h-12 scroll-my-6 w-full !py-1.5"
                                classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === modelKey(item) }}
                                onMouseEnter={() => {
                                  setStore("active", modelKey(item))
                                  setTimeout(() => searchRef?.focus())
                                }}
                                onSelect={() => selectModel(item)}
                              >
                                <div class="flex min-w-0 flex-1 flex-col">
                                  <span class="truncate text-[13px] leading-5">{item.name}</span>
                                  <span class="truncate text-[11px] font-[440] leading-4 text-v2-text-text-faint">
                                    {modelCapabilitySummary(item)}
                                  </span>
                                </div>
                                <Show when={item.latest}>
                                  <TagV2 class="shrink-0">{language.t("model.tag.latest")}</TagV2>
                                </Show>
                              </MenuV2.RadioItem>
                            </TooltipV2>
                          )}
                        </For>
                      </MenuV2.RadioGroup>
                    </MenuV2.Group>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === manageKey }}
              onMouseEnter={() => {
                setStore("active", manageKey)
                setTimeout(() => searchRef?.focus())
              }}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate leading-5">{language.t("dialog.model.manage")}</span>
            </MenuV2.Item>
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelPickerState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const showProviders = useSettingsDialog("providers")

  const provider = () => {
    showProviders()
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
