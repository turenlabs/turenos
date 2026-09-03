import type { Agent } from "@turenlabs/sdk/v2/client"
import { type Component, For, Show } from "solid-js"
import { ModelsProvider } from "@/context/models"
import { useLanguage } from "@/context/language"
import { SettingsServerPicker, SettingsServerScope } from "./settings-server-picker"
import { SettingsList } from "./settings-list"
import { Select } from "@turenlabs/ui/select"
import { useAgentSettings, modelOptionValue, type AgentModelOption } from "./settings-agent-data"

export const SettingsAgents: Component = () => {
  return (
    <ModelsProvider>
      <SettingsServerScope>
        <SettingsAgentsContent />
      </SettingsServerScope>
    </ModelsProvider>
  )
}

const SettingsAgentsContent: Component = () => {
  const language = useLanguage()
  const data = useAgentSettings()

  const renderSection = (title: string, agents: Agent[]) => (
    <Show when={agents.length > 0}>
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{title}</h3>
        <SettingsList>
          <For each={agents}>
            {(agent) => (
              <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-14-medium text-text-strong">{agent.name}</span>
                  <span class="text-12-regular text-text-weak">
                    {agent.description ?? language.t("settings.agents.defaultModel.description")}
                  </span>
                </div>
                <div class="flex w-full items-center justify-end gap-2 sm:w-auto sm:shrink-0">
                  <span class="text-12-regular text-text-weak">{language.t("settings.agents.defaultModel.title")}</span>
                  <Select<AgentModelOption>
                    data-action={`settings-agent-model-${agent.name}`}
                    options={data.modelOptions(agent)}
                    current={data.selectedModel(agent)}
                    value={modelOptionValue}
                    label={(model) => `${model.providerName} / ${model.modelName}`}
                    groupBy={(model) => model.providerName}
                    placeholder={language.t("settings.agents.defaultModel.placeholder")}
                    onSelect={(model) => {
                      if (model) data.setModel(agent, model)
                    }}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    triggerStyle={{ "min-width": "220px", "max-width": "320px" }}
                  />
                </div>
              </div>
            )}
          </For>
        </SettingsList>
      </div>
    </Show>
  )

  const primary = () => data.agents().filter((agent) => agent.mode !== "subagent")
  const subagents = () => data.agents().filter((agent) => agent.mode === "subagent")

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-8">
          <div class="min-w-0">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
            <p class="text-12-regular text-text-weak mt-1">{language.t("settings.agents.description")}</p>
          </div>
          <SettingsServerPicker />
        </div>
      </div>

      <Show
        when={!data.loading()}
        fallback={
          <div class="py-12 text-center text-14-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={!data.error() && data.agents().length > 0}
          fallback={
            <div class="py-12 text-center text-14-regular text-text-weak">
              {data.error() ? language.t("settings.agents.loadError") : language.t("settings.agents.empty")}
            </div>
          }
        >
          <div class="flex flex-col gap-8 max-w-[720px]">
            {renderSection(language.t("settings.agents.section.primary"), primary())}
            {renderSection(language.t("settings.agents.section.subagents"), subagents())}
          </div>
        </Show>
      </Show>
    </div>
  )
}
