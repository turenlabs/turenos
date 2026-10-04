import { openPicker } from "../picker"
import { array, isRecord } from "../response-validation"
import { label } from "../state"
import { confirm, directory, section, trail, type SettingsContext } from "./shared"

export function agents(ctx: SettingsContext) {
  const where = directory(ctx)
  return section(
    ctx,
    trail("Agents"),
    () =>
      Promise.all([
        ctx.connection.client.agents.list({ location: { directory: where } }),
        ctx.connection.providers.list(where),
        defaults(ctx, where),
      ]),
    ([list, catalog, saved], picker) => {
      picker.text.content = "Enter sets the model an agent uses when a session does not choose one."
      picker.set(
        list.data
          .filter((agent) => !agent.hidden)
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .map((agent) => ({
            name: `${label(agent.id, 40)} · ${agent.mode}`,
            description: modelName(agent.model ?? saved.get(agent.id)),
            run: () => defaultModel(ctx, agent.id, catalog.models),
          })),
      )
    },
  )
}

/** The agent list of the v2 route omits a model saved in the config; the original route carries it. */
async function defaults(ctx: SettingsContext, where: string) {
  const list = await ctx.connection.api("/agent", { directory: where }).catch(() => [])
  return new Map(
    (Array.isArray(list) ? array(list, 512) : []).flatMap((item) => {
      if (!isRecord(item) || !isRecord(item.model) || typeof item.name !== "string") return []
      const model = item.model
      return typeof model.providerID === "string" && typeof model.modelID === "string"
        ? [[item.name, { providerID: model.providerID, id: model.modelID }] as const]
        : []
    }),
  )
}

function modelName(model: { providerID: string; id: string } | undefined) {
  return model ? `${model.providerID}/${model.id}` : "Server default model"
}

type CatalogModel = { providerID: string; id: string; name: string; providerName: string }

function defaultModel(ctx: SettingsContext, agentID: string, models: CatalogModel[]) {
  openPicker(ctx.renderer, ctx.dialogs, {
    title: trail("Agents", label(agentID, 40), "Default model"),
    text: "Connected models on this server:",
    back: () => void agents(ctx),
    memory: ctx.memory,
    choices: models.map((model) => ({
      name: `${label(model.providerName, 30)} · ${label(model.name, 50)}`,
      description: `${model.providerID}/${model.id}`,
      run: () =>
        confirm(
          ctx,
          `Use ${model.name} for ${agentID}?`,
          "Changes this agent's default for every session.",
          async () => {
            await ctx.connection.api("/global/config", {
              method: "PATCH",
              body: { agent: { [agentID]: { model: `${model.providerID}/${model.id}` } } },
            })
            ctx.say(`${agentID} now defaults to ${model.name}.`)
          },
          () => void agents(ctx),
        ),
    })),
  })
}
