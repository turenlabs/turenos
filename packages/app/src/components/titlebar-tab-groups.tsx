import { MenuV2 } from "@turenlabs/ui/v2/menu-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { useSortable } from "@dnd-kit/solid/sortable"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type ParentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { tabKey, useTabs, type Tab } from "@/context/tabs"
import { TAB_GROUP_COLORS, tabGroupDragKey, type TabGroup, type TabGroupColor } from "@/context/tab-groups"

const TAB_GROUP_COLOR_VALUES: Record<TabGroupColor, string> = {
  grey: "var(--v2-grey-600)",
  blue: "var(--v2-blue-500)",
  red: "var(--v2-red-500)",
  yellow: "var(--v2-yellow-600)",
  green: "var(--v2-green-600)",
  pink: "var(--v2-pink-500)",
  purple: "var(--v2-purple-500)",
  cyan: "var(--v2-cyan-600)",
  orange: "var(--v2-orange-600)",
}

export function TitlebarTabContextMenu(
  props: ParentProps<{
    tab: Tab
    onClose: () => void
    onEditGroup: (id: string) => void
  }>,
) {
  const language = useLanguage()
  const tabs = useTabs()
  const current = createMemo(() =>
    tabs.groups.find((group) => group.tabs.some((tab) => tabKey(tab) === tabKey(props.tab))),
  )
  const available = createMemo(() => tabs.groups.filter((group) => group.id !== current()?.id))

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger as="div" class="h-full w-full">
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content class="max-h-[min(480px,calc(100vh-16px))] min-w-52 overflow-y-auto">
          <MenuV2.Item
            data-action="tab-group-new"
            onSelect={() => {
              const group = tabs.createGroup({ tab: props.tab })
              if (group) props.onEditGroup(group.id)
            }}
          >
            {language.t("tab.groups.new")}
          </MenuV2.Item>
          <Show when={available().length}>
            <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
              <MenuV2.SubTrigger>{language.t(current() ? "tab.groups.move" : "tab.groups.add")}</MenuV2.SubTrigger>
              <MenuV2.Portal>
                <MenuV2.SubContent class="max-h-[min(480px,calc(100vh-16px))] min-w-48 overflow-y-auto">
                  <For each={available()}>
                    {(group) => (
                      <MenuV2.Item
                        data-action="tab-group-assign"
                        onSelect={() => tabs.addTabToGroup(props.tab, group.id)}
                      >
                        <span
                          class="size-2.5 shrink-0 rounded-full"
                          style={{ "background-color": TAB_GROUP_COLOR_VALUES[group.color] }}
                          aria-hidden="true"
                        />
                        <span class="min-w-0 truncate">{group.name || language.t("tab.groups.unnamed")}</span>
                      </MenuV2.Item>
                    )}
                  </For>
                </MenuV2.SubContent>
              </MenuV2.Portal>
            </MenuV2.Sub>
          </Show>
          <Show when={current()}>
            <MenuV2.Separator />
            <MenuV2.Item data-action="tab-group-remove" onSelect={() => tabs.removeTabFromGroup(props.tab)}>
              {language.t("tab.groups.removeTab")}
            </MenuV2.Item>
          </Show>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={props.onClose}>{language.t("common.closeTab")}</MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}

export function TitlebarTabGroupHeader(props: {
  group: TabGroup
  index: () => number
  editing: boolean
  onToggle: () => void
  onEditingChange: (editing: boolean) => void
}) {
  const language = useLanguage()
  const tabs = useTabs()
  const [draft, setDraft] = createSignal("")
  const sortable = useSortable({
    get id() {
      return tabGroupDragKey(props.group.id)
    },
    get index() {
      return props.index()
    },
  })
  let input!: HTMLInputElement

  createEffect(() => {
    if (!props.editing) return
    setDraft(props.group.name)
    const frame = requestAnimationFrame(() => {
      input.focus()
      input.select()
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const commit = () => {
    tabs.updateGroup(props.group.id, { name: draft() })
    props.onEditingChange(false)
  }
  const name = () => props.group.name || language.t("tab.groups.unnamed")

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger
        ref={sortable.ref}
        as="div"
        class="h-7 shrink-0"
        classList={{ "opacity-70": sortable.isDragSource() }}
        data-titlebar-tab-group-header
        data-dragging={sortable.isDragSource()}
      >
        <Show
          when={props.editing}
          fallback={
            <button
              type="button"
              data-titlebar-tab-group-trigger
              data-action="tab-group-toggle"
              class="flex h-7 max-w-40 shrink-0 items-center gap-1.5 px-2 text-[12px] font-[560] outline-none"
              onClick={props.onToggle}
              aria-expanded={!props.group.collapsed}
              aria-label={language.t(props.group.collapsed ? "tab.groups.expand" : "tab.groups.collapse", {
                name: name(),
              })}
            >
              <span
                data-titlebar-tab-group-dot
                class="size-2 shrink-0 rounded-full bg-[var(--tab-group-color)]"
                aria-hidden="true"
              />
              <Show when={props.group.name}>
                <span data-titlebar-tab-group-name class="truncate">
                  {props.group.name}
                </span>
              </Show>
              <IconV2 data-titlebar-tab-group-chevron name="chevron-down" size="small" class="shrink-0" />
            </button>
          }
        >
          <form
            data-titlebar-tab-group-editor
            class="flex h-7 w-40 shrink-0 items-center gap-1.5 bg-v2-background-bg-layer-02 px-2 shadow-[inset_0_0_0_1px_var(--tab-group-color)]"
            onSubmit={(event) => {
              event.preventDefault()
              commit()
            }}
          >
            <span
              data-titlebar-tab-group-dot
              class="size-2 shrink-0 rounded-full bg-[var(--tab-group-color)]"
              aria-hidden="true"
            />
            <input
              ref={input}
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => {
                if (props.editing) commit()
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                props.onEditingChange(false)
              }}
              aria-label={language.t("tab.groups.name")}
              placeholder={language.t("tab.groups.unnamed")}
              class="min-w-0 flex-1 bg-transparent text-[12px] font-[530] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            />
          </form>
        </Show>
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content class="max-h-[min(480px,calc(100vh-16px))] min-w-56 overflow-y-auto">
          <MenuV2.Group>
            <MenuV2.GroupLabel>{language.t("tab.groups.color")}</MenuV2.GroupLabel>
            <MenuV2.RadioGroup value={props.group.color}>
              <For each={TAB_GROUP_COLORS}>
                {(color) => (
                  <MenuV2.RadioItem
                    value={color}
                    data-action="tab-group-color"
                    onSelect={() => tabs.updateGroup(props.group.id, { color })}
                  >
                    <span
                      class="size-2.5 rounded-full"
                      style={{ "background-color": TAB_GROUP_COLOR_VALUES[color] }}
                      aria-hidden="true"
                    />
                    {language.t(`tab.groups.color.${color}`)}
                  </MenuV2.RadioItem>
                )}
              </For>
            </MenuV2.RadioGroup>
          </MenuV2.Group>
          <MenuV2.Separator />
          <MenuV2.Item data-action="tab-group-rename" onSelect={() => props.onEditingChange(true)}>
            {language.t("tab.groups.rename")}
          </MenuV2.Item>
          <MenuV2.Item data-action="tab-group-ungroup" onSelect={() => tabs.deleteGroup(props.group.id)}>
            {language.t("tab.groups.ungroup")}
          </MenuV2.Item>
          <MenuV2.Item data-action="tab-group-close" onSelect={() => tabs.closeGroup(props.group.id)}>
            {language.t("tab.groups.close")}
          </MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}

export function tabGroupStyle(group: TabGroup) {
  return `--tab-group-color: ${TAB_GROUP_COLOR_VALUES[group.color]}`
}
