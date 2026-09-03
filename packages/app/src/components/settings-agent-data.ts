import type { Agent } from "@turenlabs/sdk/v2/client"
import { createMemo, createResource } from "solid-js"
import { useModels, type ModelKey } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

export type AgentModelOption = {
  providerID: string
  modelID: string
  providerName: string
  modelName: string
}

export function modelOptionValue(model: Pick<AgentModelOption, "providerID" | "modelID">) {
  return `${model.providerID}/${model.modelID}`
}

function parseModel(value: string | undefined): ModelKey | undefined {
  if (!value) return
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

export function useAgentSettings() {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const models = useModels()

  const [agents, { refetch }] = createResource(
    serverSDK,
    async (sdk) => {
      const response = await sdk.client.app.agents()
      return response.data ?? []
    },
    { initialValue: [] as Agent[] },
  )

  const availableModels = createMemo<AgentModelOption[]>(() =>
    models
      .list()
      .map((model) => ({
        providerID: model.provider.id,
        modelID: model.id,
        providerName: model.provider.name,
        modelName: model.name,
      }))
      .toSorted((a, b) => `${a.providerName}/${a.modelName}`.localeCompare(`${b.providerName}/${b.modelName}`)),
  )

  const visibleAgents = createMemo(() =>
    agents()
      .filter((agent) => !agent.hidden)
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  )

  const currentModel = (agent: Agent) => {
    return parseModel(serverSync().data.config.agent?.[agent.name]?.model)
  }

  const modelOptions = (agent: Agent) => {
    const options = [...availableModels()]
    const current = currentModel(agent)
    if (current && !options.some((option) => modelOptionValue(option) === modelOptionValue(current))) {
      options.push({
        ...current,
        providerName: current.providerID,
        modelName: current.modelID,
      })
    }
    return options
  }

  const selectedModel = (agent: Agent) => {
    const current = currentModel(agent)
    if (!current) return undefined
    return modelOptions(agent).find((option) => modelOptionValue(option) === modelOptionValue(current))
  }

  const setModel = (agent: Agent, model: AgentModelOption) => {
    const config = serverSync().data.config
    const agentConfig = config.agent?.[agent.name]

    void serverSync()
      .updateConfig({
        agent: {
          [agent.name]: {
            ...agentConfig,
            model: modelOptionValue(model),
          },
        },
      })
      .then(() => refetch())
      .catch(() => undefined)
  }

  return {
    agents: visibleAgents,
    loading: () => agents.loading,
    error: () => agents.error,
    modelOptions,
    selectedModel,
    setModel,
  }
}
