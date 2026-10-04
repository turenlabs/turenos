import { openPicker } from "../picker"
import { label } from "../state"
import { confirm, directory, section, type SettingsContext } from "./shared"

type Provider = { id: string; name: string; connected: boolean }

export function providers(ctx: SettingsContext) {
  const where = directory(ctx)
  return section(
    ctx,
    "Providers",
    () => ctx.connection.providers.list(where),
    (catalog, picker) => {
      picker.text.content = "Credentials and configuration are shared by every client of this server."
      picker.set([
        {
          name: "Connect a provider…",
          description: "API key, OAuth or custom endpoint",
          run: () => ctx.hooks.connectProvider(() => void providers(ctx)),
        },
        {
          name: "Refresh providers",
          description: "Re-run discovery on the server",
          run: () => change(ctx, "Providers refreshed.", async () => true).then(() => providers(ctx)),
        },
        ...catalog.providers
          .filter((provider) => provider.connected || !ctx.removed.has(provider.id))
          .toSorted((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
          .map((provider) => ({
            name: `${provider.connected ? "●" : "○"} ${label(provider.name, 60)}`,
            description: `${provider.id} · ${provider.connected ? "connected" : "not connected"}`,
            run: () => providerActions(ctx, provider, where),
          })),
      ])
    },
  )
}

function providerActions(ctx: SettingsContext, provider: Provider, where: string) {
  const path = encodeURIComponent(provider.id)
  openPicker(ctx.renderer, ctx.dialogs, {
    title: label(provider.name, 60),
    text: provider.connected ? "Connected on this server." : "Not connected.",
    back: () => void providers(ctx),
    memory: ctx.memory,
    choices: [
      provider.connected
        ? {
            name: "Disconnect",
            description: "Delete the stored credential; reconnecting signs in again",
            run: () =>
              confirm(
                ctx,
                `Disconnect ${provider.name}?`,
                "Sessions using it fail until it is reconnected.",
                () =>
                  change(ctx, `${provider.name} disconnected.`, () =>
                    ctx.connection.api(`/auth/${path}`, { method: "DELETE" }),
                  ),
                () => void providers(ctx),
              ),
          }
        : {
            name: "Connect…",
            description: "Choose it in provider setup",
            run: () => ctx.hooks.connectProvider(() => void providers(ctx)),
          },
      {
        name: "Remove",
        description: "Delete its credential and configuration and hide it until set up again",
        run: () =>
          confirm(
            ctx,
            `Remove ${provider.name}?`,
            "Its configuration is deleted from the server.",
            async () => {
              await change(ctx, `${provider.name} removed.`, () =>
                ctx.connection.api(`/provider/${path}`, { method: "DELETE", directory: where }),
              )
              ctx.removed.add(provider.id)
            },
            () => void providers(ctx),
          ),
      },
    ],
  })
}

/** Provider changes retire the server's cached provider clients, as the desktop does. */
async function change(ctx: SettingsContext, done: string, request: () => Promise<unknown>) {
  if ((await request()) !== true || (await ctx.connection.api("/global/dispose", { method: "POST" })) !== true)
    throw new Error("The server did not confirm the change.")
  ctx.say(done)
}
