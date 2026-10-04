import { openPicker } from "../picker"
import { label } from "../state"
import { agents } from "./agents"
import { permissions } from "./permissions"
import { providers } from "./providers"
import type { SettingsContext } from "./shared"
import { usage } from "./usage"

export function openMenu(ctx: SettingsContext) {
  const { hooks } = ctx
  if (!ctx.dialogs.navigate()) return
  openPicker(ctx.renderer, ctx.dialogs, {
    title: "Settings",
    text: `Server: ${label(ctx.connection.address, 200)}`,
    keys: "↑↓ choose · Enter open · Esc close",
    memory: ctx.memory,
    choices: [
      {
        name: "Providers",
        description: "Connect, disconnect, or remove model providers",
        run: () => providers(ctx),
      },
      {
        name: "Usage and limits",
        description: "Tokens, cost, and plan quotas for the last 7 days",
        run: () => usage(ctx),
      },
      {
        name: "Extensions",
        description: "Skills, MCP servers, and data sources",
        run: () => hooks.extensions(ctx.open),
      },
      { name: "Memories", description: "What agents remember across sessions", run: () => hooks.memories(ctx.open) },
      { name: "Agents", description: "Each agent's default model", run: () => agents(ctx) },
      { name: "Permissions", description: "Permission checks and saved rules", run: () => permissions(ctx) },
      ...(hooks.servers ? [{ name: "Servers", description: "Switch or add TurenOS servers", run: hooks.servers }] : []),
      {
        name: "Appearance",
        description: "Motion and transcript display on this computer",
        run: () => appearance(ctx),
      },
    ],
  })
}

function appearance(ctx: SettingsContext) {
  openPicker(ctx.renderer, ctx.dialogs, {
    title: "Appearance",
    text: "Only this client changes.",
    back: ctx.open,
    memory: ctx.memory,
    choices: ctx.hooks.appearance().map((choice) => ({
      ...choice,
      run: () => {
        choice.run()
        appearance(ctx)
      },
    })),
  })
}
