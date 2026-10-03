import { openPicker } from "../picker"
import { label } from "../state"
import { confirm, directory, section, type SettingsContext } from "./shared"

export function agents(ctx: SettingsContext) {
  const where = directory(ctx)
  return section(
    ctx,
    "Agents",
    () =>
      Promise.all([
        ctx.connection.client.agents.list({ location: { directory: where } }),
        ctx.connection.providers.list(where),
      ]),
    ([list, catalog], picker) => {
      picker.text.content = "Enter sets the model an agent uses when a session does not choose one."
      picker.set(
        list.data
          .filter((agent) => !agent.hidden)
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .map((agent) => ({
            name: `${label(agent.id, 40)} · ${agent.mode}`,
            description: agent.model ? `${agent.model.providerID}/${agent.model.id}` : "Server default model",
            run: () => defaultModel(ctx, agent.id, catalog.models),
          })),
      )
    },
  )
}

type CatalogModel = { providerID: string; id: string; name: string; providerName: string }

function defaultModel(ctx: SettingsContext, agentID: string, models: CatalogModel[]) {
  openPicker(ctx.renderer, ctx.dialogs, {
    title: `Default model · ${label(agentID, 40)}`,
    text: "Connected models on this server:",
    back: () => void agents(ctx),
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
        ),
    })),
  })
}
