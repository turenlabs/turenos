import { TextRenderable, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { openPicker, openSection, type Choice, type Picker } from "./picker"
import { array, numeric, object, optional, string } from "./response-validation"
import { errorText, type Connection } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Provider = { id: string; name: string; connected: boolean }

/**
 * The desktop's Settings, for what a terminal client can change on the server: providers and their
 * usage, extensions, memories, agent default models, permission checks and saved rules. Every
 * section is server-global unless it says otherwise.
 */
export function createSettings(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
  hooks: {
    connectProvider: () => void
    extensions: (back: () => void) => void
    memories: (back: () => void) => void
    servers?: () => void
    appearance: () => Choice[]
  },
) {
  function directory() {
    return (
      state.snapshot?.sessions.find((item) => item.id === state.selected)?.location.directory ??
      state.snapshot?.location.directory ??
      "/"
    )
  }

  function open() {
    if (!dialogs.navigate()) return
    openPicker(renderer, dialogs, {
      title: "Settings",
      text: `Server: ${label(connection.address, 200)}`,
      keys: "↑↓ choose · Enter open · Esc close",
      choices: [
        { name: "Providers", description: "Connect, disconnect, or remove model providers", run: providers },
        { name: "Usage and limits", description: "Tokens, cost, and plan quotas for the last 7 days", run: usage },
        { name: "Extensions", description: "Skills, MCP servers, and data sources", run: () => hooks.extensions(open) },
        { name: "Memories", description: "What agents remember across sessions", run: () => hooks.memories(open) },
        { name: "Agents", description: "Each agent's default model", run: agents },
        { name: "Permissions", description: "Permission checks and saved rules", run: permissions },
        ...(hooks.servers
          ? [{ name: "Servers", description: "Switch or add TurenOS servers", run: hooks.servers }]
          : []),
        {
          name: "Appearance",
          description: "Motion and transcript display on this computer",
          run: () =>
            openPicker(renderer, dialogs, {
              title: "Appearance",
              text: "Only this client changes.",
              back: open,
              choices: hooks.appearance(),
            }),
        },
      ],
    })
  }

  /** Opens a section that loads before it can list its choices. */
  function section<T>(title: string, work: () => Promise<T>, fill: (value: T, picker: Picker) => void) {
    return openSection(renderer, dialogs, state, { title, back: open }, work, fill)
  }

  function providers() {
    const where = directory()
    return section(
      "Providers",
      () => connection.providers.list(where),
      (catalog, picker) => {
        picker.text.content = "Credentials and configuration are shared by every client of this server."
        picker.set([
          {
            name: "Connect a provider…",
            description: "API key, OAuth, or a custom OpenAI-compatible endpoint",
            run: hooks.connectProvider,
          },
          {
            name: "Refresh providers",
            description: "Re-run discovery on the server",
            run: () => change("Providers refreshed.", async () => true),
          },
          ...catalog.providers
            .toSorted((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
            .map((provider) => ({
              name: `${provider.connected ? "●" : "○"} ${label(provider.name, 60)}`,
              description: provider.connected ? `${provider.id} · connected` : provider.id,
              run: () => providerActions(provider, where),
            })),
        ])
      },
    )
  }

  function providerActions(provider: Provider, where: string) {
    const path = encodeURIComponent(provider.id)
    openPicker(renderer, dialogs, {
      title: label(provider.name, 60),
      text: provider.connected ? "Connected on this server." : "Not connected.",
      back: () => void providers(),
      choices: [
        provider.connected
          ? {
              name: "Disconnect",
              description: "Delete the stored credential; reconnecting signs in again",
              run: () =>
                confirm(`Disconnect ${provider.name}?`, "Sessions using it fail until it is reconnected.", () =>
                  change(`${provider.name} disconnected.`, () => connection.api(`/auth/${path}`, { method: "DELETE" })),
                ),
            }
          : { name: "Connect…", description: "Choose it in provider setup", run: hooks.connectProvider },
        {
          name: "Remove",
          description: "Delete its credential and configuration and hide it until set up again",
          run: () =>
            confirm(`Remove ${provider.name}?`, "Its configuration is deleted from the server.", () =>
              change(`${provider.name} removed.`, () =>
                connection.api(`/provider/${path}`, { method: "DELETE", directory: where }),
              ),
            ),
        },
      ],
    })
  }

  /** Provider changes retire the server's cached provider clients, as the desktop does. */
  async function change(done: string, request: () => Promise<unknown>) {
    if ((await request()) !== true || (await connection.api("/global/dispose", { method: "POST" })) !== true)
      throw new Error("The server did not confirm the change.")
    say(done)
  }

  function confirm(title: string, text: string, action: () => Promise<void>) {
    const dialog = dialogs.open(title, false, 14)
    if (!dialog) return
    dialog.form.add(new TextRenderable(renderer, { content: text, fg: color.warning, wrapMode: "word" }))
    dialog.submit = action
    dialog.error.content = "Ctrl+S confirm · Esc cancel"
    dialog.form.focus()
  }

  function usage() {
    return section(
      "Usage and limits",
      () => connection.api("/provider/usage", { directory: directory() }).then(object),
      (result, picker) => {
        picker.text.content = usageText(result)
        picker.text.fg = color.text
        picker.set([{ name: "Refresh", run: usage }])
      },
    )
  }

  function agents() {
    const where = directory()
    return section(
      "Agents",
      () =>
        Promise.all([
          connection.client.agents.list({ location: { directory: where } }),
          connection.providers.list(where),
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
              run: () =>
                openPicker(renderer, dialogs, {
                  title: `Default model · ${label(agent.id, 40)}`,
                  text: "Connected models on this server:",
                  back: () => void agents(),
                  choices: catalog.models.map((model) => ({
                    name: `${label(model.providerName, 30)} · ${label(model.name, 50)}`,
                    description: `${model.providerID}/${model.id}`,
                    run: () =>
                      confirm(
                        `Use ${model.name} for ${agent.id}?`,
                        "Changes this agent's default for every session.",
                        async () => {
                          await connection.api("/global/config", {
                            method: "PATCH",
                            body: { agent: { [agent.id]: { model: `${model.providerID}/${model.id}` } } },
                          })
                          say(`${agent.id} now defaults to ${model.name}.`)
                        },
                      ),
                  })),
                }),
            })),
        )
      },
    )
  }

  function permissions() {
    return section(
      "Permissions",
      () =>
        Promise.all([
          connection.api("/global/permission-checks").then(object),
          connection.client.permissions.listSaved(),
        ]),
      ([checks, saved], picker) => {
        const enforced = checks.enforced === true
        picker.text.content = `Saved rules come from "Allow always". ${saved.length ? "Enter on a rule removes it." : "None saved."}`
        picker.set([
          {
            name: `Permission checks: ${enforced ? "on" : "off"}`,
            description: enforced ? "Tools ask before acting unless a rule allows them" : "Tools act without asking",
            run: () =>
              confirm(
                `Turn permission checks ${enforced ? "off" : "on"}?`,
                enforced
                  ? "Agents on this server will run tools without asking."
                  : "Agents will ask before running tools.",
                async () => {
                  await connection.api("/global/permission-checks", { method: "PUT", body: { enforced: !enforced } })
                  say(`Permission checks ${enforced ? "off" : "on"}.`)
                },
              ),
          },
          ...saved.map((rule) => ({
            name: `${label(rule.action, 30)} · ${label(rule.resource, 80)}`,
            description: "Saved rule",
            run: () =>
              confirm("Remove this saved rule?", `${rule.action} ${rule.resource} will ask again.`, async () => {
                await connection.client.permissions.removeSaved({ id: rule.id })
                say("Saved rule removed.")
              }),
          })),
        ])
      },
    )
  }

  return { open }
}

function usageText(result: Record<string, unknown>) {
  const providers = array(result.providers, 512).map((value) => {
    const item = object(value)
    const tokens = object(item.tokens)
    const total = ["input", "output", "reasoning"].reduce((sum, key) => sum + numeric(tokens[key]), 0)
    return `${label(string(item.providerID, 256), 40)}: ${numeric(item.turns)} turns · ${Math.round(total / 1000)}k tokens · $${numeric(item.cost).toFixed(2)}`
  })
  const quotas = array(result.quotas, 512).flatMap((value) => {
    const quota = object(value)
    optional(quota.detail, string)
    optional(quota.plan, string)
    return [
      `${label(string(quota.providerID, 256), 40)}${quota.plan ? ` (${label(quota.plan as string, 40)})` : ""}: ${label(string(quota.status, 32))}${quota.detail ? ` · ${label(quota.detail as string, 200)}` : ""}`,
      ...array(quota.windows, 32).map((value) => {
        const window = object(value)
        const reset = typeof window.resetAt === "number" ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ""
        return `  ${label(string(window.label, 100), 40)}: ${Math.round(numeric(window.usedPercent))}% used${reset}`
      }),
    ]
  })
  return [
    "LAST 7 DAYS",
    ...(providers.length ? providers : ["No usage recorded."]),
    "",
    "PLAN QUOTAS",
    ...(quotas.length ? quotas : ["No provider reports quotas."]),
  ].join("\n")
}
