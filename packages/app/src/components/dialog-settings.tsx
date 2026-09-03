import { Component, createSignal, startTransition } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Dialog } from "@turenlabs/ui/dialog"
import { Tabs } from "@turenlabs/ui/tabs"
import { Icon } from "@turenlabs/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsAgents } from "./settings-agents"
import { SettingsModels } from "./settings-models"
import { SettingsServers } from "./settings-servers"
import { SettingsServerProvider } from "./settings-server-context"

export const DialogSettings: Component<{ defaultValue?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")

  return (
    <SettingsServerProvider>
      <Dialog size="x-large" transition>
        <Tabs
          orientation="vertical"
          variant="settings"
          value={tab()}
          onChange={(value) => {
            if (value === "extend") {
              dialog.close()
              navigate("/extend/catalog")
              return
            }
            void startTransition(() => setTab(value))
          }}
          class="h-full settings-dialog"
        >
          <Tabs.List>
            <div class="flex flex-col justify-between h-full w-full gap-4">
              <div class="flex flex-col gap-3 w-full pt-3">
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1.5">
                    <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <Tabs.Trigger value="general">
                        <Icon name="sliders" />
                        {language.t("settings.tab.general")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="shortcuts">
                        <Icon name="keyboard" />
                        {language.t("settings.tab.shortcuts")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="agents">
                        <Icon name="subagent" />
                        {language.t("settings.agents.title")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="servers">
                        <Icon name="server" />
                        {language.t("status.popover.tab.servers")}
                      </Tabs.Trigger>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <Tabs.Trigger value="models">
                        <Icon name="models" />
                        {language.t("settings.models.title")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="extend">
                        <Icon name="plus" />
                        Extend
                      </Tabs.Trigger>
                    </div>
                  </div>
                </div>
              </div>
              <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
                <span>{language.t("app.name.desktop")}</span>
                <span class="text-11-regular">v{platform.version}</span>
              </div>
            </div>
          </Tabs.List>
          <Tabs.Content value="general" class="no-scrollbar">
            <SettingsGeneral />
          </Tabs.Content>
          <Tabs.Content value="shortcuts" class="no-scrollbar">
            <SettingsKeybinds />
          </Tabs.Content>
          <Tabs.Content value="servers" class="no-scrollbar">
            <SettingsServers />
          </Tabs.Content>
          <Tabs.Content value="models" class="no-scrollbar">
            <SettingsModels />
          </Tabs.Content>
          <Tabs.Content value="agents" class="no-scrollbar">
            <SettingsAgents />
          </Tabs.Content>
        </Tabs>
      </Dialog>
    </SettingsServerProvider>
  )
}
