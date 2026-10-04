import { openPicker } from "../picker"
import { label } from "../state"
import { confirm, directory, section, trail, type SettingsContext } from "./shared"

type Provider = { id: string; name: string; connected: boolean }

export function providers(ctx: SettingsContext) {
  const where = directory(ctx)
  return section(
    ctx,
    trail("Providers"),
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
          run: () => change(ctx, where, "Providers refreshed.", async () => true).then(() => providers(ctx)),
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
    title: trail("Providers", label(provider.name, 60)),
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
                  change(
                    ctx,
                    where,
                    `${provider.name} disconnected.`,
                    () => ctx.connection.api(`/auth/${path}`, { method: "DELETE" }),
                    (catalog) =>
                      stillConnected(catalog, provider) &&
                      `${provider.name} is still connected: the server configuration defines it, so there is no stored credential to delete. Remove it instead.`,
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
        description: "Delete its credential and configuration",
        run: () =>
          confirm(
            ctx,
            `Remove ${provider.name}?`,
            "Its configuration is deleted from the server.",
            async () => {
              await change(
                ctx,
                where,
                `${provider.name} removed.`,
                () => ctx.connection.api(`/provider/${path}`, { method: "DELETE", directory: where }),
                (catalog) =>
                  stillConnected(catalog, provider) && `The server still lists ${provider.name} as connected.`,
              )
              ctx.removed.add(provider.id)
            },
            () => void providers(ctx),
          ),
      },
    ],
  })
}

/**
 * Provider changes retire the server's cached provider clients, as the desktop does, and the list is
 * read again: a provider the server configuration defines stays connected after its credential is gone.
 */
async function change(
  ctx: SettingsContext,
  where: string,
  done: string,
  request: () => Promise<unknown>,
  failure?: (catalog: Awaited<ReturnType<SettingsContext["connection"]["providers"]["list"]>>) => string | false,
) {
  if ((await request()) !== true || (await ctx.connection.api("/global/dispose", { method: "POST" })) !== true)
    throw new Error("The server did not confirm the change.")
  const problem = failure?.(await ctx.connection.providers.list(where))
  if (problem) throw new Error(problem)
  ctx.say(done)
}

function stillConnected(catalog: { providers: Provider[] }, provider: Provider) {
  return catalog.providers.some((item) => item.id === provider.id && item.connected)
}
