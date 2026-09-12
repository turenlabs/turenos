import { type Component, createEffect, createMemo, createSignal, For, Show, startTransition } from "solid-js"
import { Dialog } from "@turenlabs/ui/v2/dialog-v2"
import { TabsV2 } from "@turenlabs/ui/v2/tabs-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { IconButtonV2 } from "@turenlabs/ui/v2/icon-button-v2"
import { Icon } from "@turenlabs/ui/icon"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsAgentsV2 } from "./agents"
import { SettingsModelsV2 } from "./models"
import { SettingsProvidersV2 } from "./providers"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsIntelV2 } from "./intel"
import { SettingsZooV2 } from "./zoo"
import { SettingsServerProvider } from "../settings-server-context"

type SettingsNavigationItem = {
  value: string
  icon: Parameters<typeof Icon>[0]["name"]
  label: string
  keywords: string
}

const navigationItem = (
  value: string,
  icon: SettingsNavigationItem["icon"],
  label: string,
  keywords: string,
): SettingsNavigationItem => ({ value, icon, label, keywords })

const DEVELOPER_SETTINGS_ENABLED = import.meta.env.VITE_FORGE_CHANNEL === "dev"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(
    props.defaultValue === "mcp-runtime"
      ? "server-settings"
      : props.defaultValue === "developer" && !DEVELOPER_SETTINGS_ENABLED
        ? "general"
        : (props.defaultValue ?? "general"),
  )
  const [filter, setFilter] = createSignal("")
  const navigation = createMemo(() => {
    language.locale()
    return [
      {
        title: language.t("settings.section.personal"),
        items: [
          navigationItem(
            "general",
            "sliders",
            language.t("settings.tab.appInterface"),
            "language appearance theme fonts layout feed display updates zoom",
          ),
          navigationItem(
            "notifications",
            "status",
            language.t("settings.tab.notifications"),
            "notifications sounds agent permission error",
          ),
          navigationItem(
            "shortcuts",
            "keyboard",
            language.t("settings.tab.shortcuts"),
            "keyboard keybindings commands",
          ),
          navigationItem("zoo", "cat", "Zoo", "zoo pets critters sprites feed snack play minigame"),
        ],
      },
      {
        title: language.t("settings.section.aiAgents"),
        items: [
          navigationItem("agents", "subagent", language.t("settings.agents.title"), "agents subagents default model"),
          navigationItem("models", "models", language.t("settings.models.title"), "models visibility picker providers"),
          navigationItem(
            "providers",
            "providers",
            language.t("settings.providers.title"),
            "providers credentials api oauth custom models",
          ),
          navigationItem(
            "capabilities",
            "brain",
            language.t("settings.capabilities.title"),
            "memory semantic retrieval potion",
          ),
        ],
      },
      {
        title: language.t("settings.section.infrastructure"),
        items: [
          navigationItem(
            "servers",
            "server",
            language.t("settings.connections.title"),
            "connections servers wsl url username password",
          ),
          navigationItem(
            "server-settings",
            "shield",
            language.t("settings.serverSettings.title"),
            "server shell permissions runtime mcp storage retention docker",
          ),
          navigationItem("intel", "shield", "Threat intelligence", "intel manage feeds security advisories local rss"),
        ],
      },
      {
        title: language.t("settings.section.advanced"),
        items: [
          navigationItem(
            "experimental",
            "code",
            language.t("settings.experimental.title"),
            "experimental automations workflows scheduled yolk harness intelligence autonomy reviewer",
          ),
          ...(DEVELOPER_SETTINGS_ENABLED
            ? [
                navigationItem(
                  "developer",
                  "code-lines",
                  language.t("settings.developer.title"),
                  "developer lobby catalog diagnostics profiler interface",
                ),
              ]
            : []),
        ],
      },
    ]
  })
  const matchedNavigation = createMemo(() => {
    const query = filter().trim().toLocaleLowerCase()
    if (!query) return navigation()
    return navigation()
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(query)),
      }))
      .filter((section) => section.items.length > 0)
  })
  const matches = (item: SettingsNavigationItem) => {
    const query = filter().trim().toLocaleLowerCase()
    return !query || `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(query)
  }

  createEffect(() => {
    if (!filter()) return
    const items = matchedNavigation().flatMap((section) => section.items)
    if (items.length === 0 || items.some((item) => item.value === tab())) return
    setTab(items[0].value)
  })

  return (
    <SettingsServerProvider>
      <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
        <TabsV2
          orientation="vertical"
          variant="settings"
          value={tab()}
          onChange={(value) => {
            void startTransition(() => setTab(value))
          }}
          class="settings-v2"
        >
          <IconButtonV2
            class="settings-v2-close"
            icon="close"
            variant="ghost"
            aria-label={language.t("common.close")}
            onClick={() => dialog.close()}
          />
          <TabsV2.List>
            <div class="settings-v2-nav-shell">
              <div class="settings-v2-nav-search">
                <TextInputV2
                  type="search"
                  appearance="base"
                  value={filter()}
                  onInput={(event) => setFilter(event.currentTarget.value)}
                  placeholder={language.t("settings.search.placeholder")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  aria-label={language.t("settings.search.placeholder")}
                />
              </div>
              <div class="settings-v2-nav-sections">
                <For each={navigation()}>
                  {(section) => (
                    <div
                      class="flex flex-col gap-1.5"
                      classList={{ hidden: !section.items.some((item) => matches(item)) }}
                    >
                      <TabsV2.SectionTitle>{section.title}</TabsV2.SectionTitle>
                      <div class="flex flex-col gap-1.5 w-full">
                        <For each={section.items}>
                          {(item) => (
                            <TabsV2.Trigger
                              value={item.value}
                              disabled={!matches(item)}
                              classList={{ hidden: !matches(item) }}
                            >
                              <Icon name={item.icon} />
                              {item.label}
                            </TabsV2.Trigger>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
                <Show when={filter() && matchedNavigation().length === 0}>
                  <p class="settings-v2-nav-empty">{language.t("settings.search.empty")}</p>
                </Show>
              </div>
              <div class="settings-v2-nav-footer">
                <span>{language.t("app.name.desktop")}</span>
                <span>v{platform.version}</span>
              </div>
            </div>
          </TabsV2.List>
          <TabsV2.Content value="general" class="settings-v2-panel">
            <SettingsGeneralV2 sessionID={props.sessionID} page="app" />
          </TabsV2.Content>
          <TabsV2.Content value="notifications" class="settings-v2-panel">
            <SettingsGeneralV2 sessionID={props.sessionID} page="notifications" />
          </TabsV2.Content>
          <TabsV2.Content value="shortcuts" class="settings-v2-panel">
            <SettingsKeybinds v2 />
          </TabsV2.Content>
          <TabsV2.Content value="zoo" class="settings-v2-panel">
            <SettingsZooV2 />
          </TabsV2.Content>
          <TabsV2.Content value="servers" class="settings-v2-panel">
            <SettingsServersV2 />
          </TabsV2.Content>
          <TabsV2.Content value="intel" class="settings-v2-panel">
            <SettingsIntelV2 />
          </TabsV2.Content>
          <TabsV2.Content value="models" class="settings-v2-panel">
            <SettingsModelsV2 />
          </TabsV2.Content>
          <TabsV2.Content value="agents" class="settings-v2-panel">
            <SettingsAgentsV2 />
          </TabsV2.Content>
          <TabsV2.Content value="providers" class="settings-v2-panel">
            <SettingsProvidersV2 />
          </TabsV2.Content>
          <TabsV2.Content value="capabilities" class="settings-v2-panel">
            <SettingsGeneralV2 sessionID={props.sessionID} page="capabilities" />
          </TabsV2.Content>
          <TabsV2.Content value="experimental" class="settings-v2-panel">
            <SettingsGeneralV2 sessionID={props.sessionID} page="experimental" />
          </TabsV2.Content>
          <TabsV2.Content value="server-settings" class="settings-v2-panel">
            <SettingsGeneralV2 sessionID={props.sessionID} page="server" />
          </TabsV2.Content>
          <Show when={DEVELOPER_SETTINGS_ENABLED}>
            <TabsV2.Content value="developer" class="settings-v2-panel">
              <SettingsGeneralV2 sessionID={props.sessionID} page="developer" />
            </TabsV2.Content>
          </Show>
        </TabsV2>
      </Dialog>
    </SettingsServerProvider>
  )
}
