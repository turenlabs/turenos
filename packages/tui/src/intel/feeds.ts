import type { CliRenderer } from "@opentui/core"
import type { Dialogs } from "../dialogs"
import { openSection } from "../picker"
import { errorText, type Connection } from "../server"
import { label, type DashboardState } from "../state"

export type IntelContext = {
  renderer: CliRenderer
  state: DashboardState
  connection: Connection
  dialogs: Dialogs
  say: (message: string, error?: boolean) => void
}

/** The feed list: Enter turns a feed on or off. `back` reopens the Intel panel. */
export function feeds(ctx: IntelContext, back: () => void) {
  const intel = ctx.connection.client["server.intel"]
  ctx.dialogs.close(false)
  return openSection(
    ctx.renderer,
    ctx.dialogs,
    ctx.state,
    { title: "Intel feeds", back },
    intel.feeds,
    (list, picker) => {
      picker.text.content = "Enter turns a feed on or off. Feeds are polled on the server every six hours."
      picker.set(
        list.map((feed) => ({
          name: `${feed.enabled ? "●" : "○"} ${label(feed.name, 60)} · ${feed.kind}`,
          description: label(feed.url, 120),
          run: async () => {
            try {
              await intel.feedUpdate({ feedID: feed.id, enabled: !feed.enabled })
              ctx.say(`${feed.name} ${feed.enabled ? "off" : "on"}.`)
            } catch (error) {
              ctx.say(errorText(error), true)
            }
            await feeds(ctx, back)
          },
        })),
      )
    },
  )
}
