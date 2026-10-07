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
  /** Selected row per picker title, kept while a toggle reopens the list. */
  memory: Map<string, number>
  say: (message: string, error?: boolean) => void
}

/** The feed list: Enter turns a feed on or off. `back` reopens the Intel panel. */
const KINDS: Record<string, string> = {
  kev: "known exploited list",
  nvd: "NVD vulnerabilities",
  epss: "EPSS scores",
  github: "GitHub advisories",
  rss: "news feed",
}

/** The feed's kind in words, then its address cut to the dialog's width with an ellipsis. */
function describe(ctx: IntelContext, feed: { kind: string; url: string }) {
  const kind = Object.hasOwn(KINDS, feed.kind) ? KINDS[feed.kind]! : label(feed.kind, 32)
  return `${kind} · ${label(feed.url, Math.max(16, Math.min(70, ctx.renderer.width - 4) - 8 - kind.length - 3))}`
}

export function feeds(ctx: IntelContext, back: () => void, note = "") {
  const intel = ctx.connection.client["server.intel"]
  ctx.dialogs.close(false)
  return openSection(
    ctx.renderer,
    ctx.dialogs,
    ctx.state,
    { title: "Intel › Feeds", back, memory: ctx.memory, keys: "↑↓ choose · Enter toggle · Esc back" },
    intel.feeds,
    (list, picker) => {
      picker.text.content = `${note ? `${label(note, 300)}\n` : ""}Enter turns a feed on or off. Feeds are polled on the server every six hours.`
      picker.set(
        list.map((feed) => ({
          name: `${feed.enabled ? "●" : "○"} ${label(feed.name, 60)} · ${feed.enabled ? "on" : "off"}`,
          description: describe(ctx, feed),
          run: async () => {
            const result = await intel.feedUpdate({ feedID: feed.id, enabled: !feed.enabled }).then(
              () => `${label(feed.name, 60)} turned ${feed.enabled ? "off" : "on"}.`,
              (error: unknown) => `! ${errorText(error)}`,
            )
            ctx.say(result, result.startsWith("!"))
            // Whatever the user opened while the request ran stays open, with its draft.
            if (ctx.state.modal) return
            await feeds(ctx, back, result)
          },
        })),
      )
    },
  )
}
