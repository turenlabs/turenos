import { label } from "../state"
import { choose } from "./choose"
import { custom } from "./custom"
import { show, stepBack, wait, type Flow } from "./flow"
import { prompt } from "./prompt"

/** Loads the provider catalog and lists providers, with custom setup first. */
export function load(flow: Flow) {
  flow.answers.clear()
  wait(
    flow,
    "Loading providers",
    () => flow.connection.providers.list(flow.directory),
    (catalog) => {
      const dialog = show(flow, "Connect a provider")
      if (!dialog) return
      choose(
        flow,
        dialog,
        [
          {
            name: "+ Add custom provider",
            description: "OpenAI-compatible endpoint and model",
            run: () => custom(flow, stepBack(flow, load)),
          },
          ...catalog.providers.map((provider) => ({
            name: label(provider.name, 512),
            description: `${label(provider.id, 256)}${provider.connected ? " · connected; replace credentials" : " · not connected"}`,
            run: () => authMethods(flow, provider),
          })),
        ],
        true,
      )
    },
  )
}

function authMethods(flow: Flow, provider: { id: string; name: string }) {
  wait(
    flow,
    "Loading authentication methods",
    () => flow.connection.providers.auth(flow.directory),
    (auth) => {
      const dialog = show(flow, `Connect ${label(provider.name, 80)}`)
      if (!dialog) return
      dialog.back = stepBack(flow, load)
      // Use the original advertised index, even when methods share a type.
      choose(
        flow,
        dialog,
        (auth[provider.id] ?? [{ type: "api" as const, label: "API key" }]).map((method, index) => ({
          name: label(method.label, 512),
          description: method.type === "api" ? "API key" : "OAuth · browser or headless instructions",
          run: () =>
            prompt(
              flow,
              provider.id,
              method,
              index,
              0,
              stepBack(flow, (next) => authMethods(next, provider)),
            ),
        })),
      )
      if (auth[provider.id]?.length === 0)
        dialog.error.content = "No authentication methods advertised for this provider. Esc back."
    },
  )
}
