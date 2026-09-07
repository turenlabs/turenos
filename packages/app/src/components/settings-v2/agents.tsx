import type { Agent } from "@turenlabs/sdk/v2/client"
import { type Component, For, Show } from "solid-js"
import { SelectV2 } from "@turenlabs/ui/v2/select-v2"
import { ModelsProvider } from "@/context/models"
import { useLanguage } from "@/context/language"
import { SettingsServerPicker, SettingsServerScope } from "../settings-server-picker"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { modelOptionValue, useAgentSettings, type AgentModelOption } from "../settings-agent-data"
import { SettingsPageHeaderV2 } from "./page-header"
import "./settings-v2.css"

export const SettingsAgentsV2: Component = () => {
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
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{title}</h3>
        <SettingsListV2>
          <For each={agents}>
            {(agent) => (
              <SettingsRowV2
                title={agent.name}
                description={agent.description ?? language.t("settings.agents.defaultModel.description")}
              >
                <div class="settings-v2-agent-model-control">
                  <span class="settings-v2-agent-model-label">{language.t("settings.agents.defaultModel.title")}</span>
                  <SelectV2<AgentModelOption>
                    class="settings-v2-agent-model-select"
                    data-action={`settings-agent-model-${agent.name}`}
                    options={data.modelOptions(agent)}
                    current={data.selectedModel(agent)}
                    disabled={data.saving()}
                    value={modelOptionValue}
                    label={(model) => `${model.providerName} / ${model.modelName}`}
                    groupBy={(model) => model.providerName}
                    placeholder={language.t("settings.agents.defaultModel.placeholder")}
                    onSelect={(model) => {
                      if (model) data.setModel(agent, model)
                    }}
                    appearance="inline"
                    aria-label={`${agent.name} ${language.t("settings.agents.defaultModel.title")}`}
                  />
                </div>
              </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>
      </div>
    </Show>
  )

  const primary = () => data.agents().filter((agent) => agent.mode !== "subagent")
  const subagents = () => data.agents().filter((agent) => agent.mode === "subagent")

  return (
    <>
      <SettingsPageHeaderV2
        class="settings-v2-agents-header"
        title={language.t("settings.agents.title")}
        description={language.t("settings.agents.description")}
        scope={language.t("settings.scope.selectedServer")}
        actions={<SettingsServerPicker />}
      />

      <div class="settings-v2-tab-body settings-v2-agents">
        <Show
          when={!data.loading()}
          fallback={
            <div class="settings-v2-agents-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={!data.error() && data.agents().length > 0}
            fallback={
              <div class="settings-v2-agents-status">
                {data.error() ? language.t("settings.agents.loadError") : language.t("settings.agents.empty")}
              </div>
            }
          >
            {renderSection(language.t("settings.agents.section.primary"), primary())}
            {renderSection(language.t("settings.agents.section.subagents"), subagents())}
          </Show>
        </Show>
      </div>
    </>
  )
}
