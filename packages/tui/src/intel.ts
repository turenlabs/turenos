import { StyledText, fg, type CliRenderer } from "@opentui/core"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { openPanel } from "./panel"
import { openSection } from "./picker"
import { array, numeric, object, optional, string } from "./response-validation"
import { errorText, type Connection } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Mode = "advisories" | "kev" | "news"
type Item = { title: string; meta: string; body: string; tone: string }

const TITLES: Record<Mode, string> = { advisories: "Advisories", kev: "Known exploited (KEV)", news: "News" }
const SEVERITY: Record<string, string> = {
  critical: color.error,
  high: color.error,
  medium: color.warning,
  low: color.muted,
  info: color.muted,
}
const PAGE = 50

/**
 * The desktop Home's threat intelligence: advisories, CISA's known-exploited list, and security
 * news that the server polls from its feeds. m switches lists, [ and ] page, f manages feeds.
 */
export function createIntel(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  const intel = connection.client["server.intel"]

  function open() {
    if (!dialogs.navigate()) return
    const panel = openPanel(renderer, dialogs, "Intel")
    if (!panel) return
    let mode: Mode = "advisories"
    let page = 1
    let items: Item[] = []
    let request = 0
    const keys = "↑↓ choose · m list · [ ] page · f feeds · p poll now · Ctrl+R refresh · Esc close"

    async function load() {
      const version = ++request
      panel!.heading.content = `${TITLES[mode]} · loading…`
      try {
        const result = await fetch(mode, page)
        if (version !== request || state.modal !== panel!.dialog) return
        items = result.items
        const pages = Math.max(1, Math.ceil(result.total / PAGE))
        panel!.heading.content = `${TITLES[mode]} · page ${page} of ${pages} · ${result.total} items`
        panel!.list.options = items.map((item) => ({ name: label(item.title, 80), description: "" }))
        panel!.list.setSelectedIndex(0)
        panel!.dialog.error.content = keys
        describe()
      } catch (error) {
        if (version !== request || state.modal !== panel!.dialog) return
        items = []
        panel!.list.options = []
        panel!.show(`${TITLES[mode]} unavailable: ${errorText(error)}`)
      }
    }

    function describe() {
      const item = items[panel!.list.getSelectedIndex()]
      if (!item) return panel!.show("Nothing here yet. p polls the feeds now.")
      panel!.show(
        new StyledText([
          fg(color.text)(`${display(item.title, 1000)}\n`),
          fg(item.tone)(`${item.meta}\n\n`),
          fg(color.text)(item.body),
        ]),
      )
    }

    async function poll() {
      panel!.dialog.error.content = `Polling feeds…\n${keys}`
      try {
        const result = await intel.poll()
        const failed = result.feeds.filter((feed) => feed.lastOk === false).length
        panel!.dialog.error.content = `${failed ? `${failed} feed(s) failed.` : "Feeds updated."}\n${keys}`
        await load()
      } catch (error) {
        panel!.dialog.error.content = `! ${errorText(error)}\n${keys}`
      }
    }

    function turn(step: number) {
      page = Math.max(1, page + step)
      return load()
    }

    panel.list.on("selectionChanged", describe)
    panel.dialog.key = (key) => {
      const action = matchesKey(key, "r", { ctrl: true })
        ? load
        : key.sequence === "m"
          ? () => {
              mode = mode === "advisories" ? "kev" : mode === "kev" ? "news" : "advisories"
              page = 1
              return load()
            }
          : key.sequence === "]"
            ? () => turn(1)
            : key.sequence === "["
              ? () => turn(-1)
              : key.sequence === "p"
                ? poll
                : key.sequence === "f"
                  ? feeds
                  : undefined
      if (!action) return false
      void action()
      return true
    }
    void load()
  }

  function feeds() {
    dialogs.close(false)
    return openSection(renderer, dialogs, state, { title: "Intel feeds", back: open }, intel.feeds, (list, picker) => {
      picker.text.content = "Enter turns a feed on or off. Feeds are polled on the server every six hours."
      picker.set(
        list.map((feed) => ({
          name: `${feed.enabled ? "●" : "○"} ${label(feed.name, 60)} · ${feed.kind}`,
          description: label(feed.url, 120),
          run: async () => {
            try {
              await intel.feedUpdate({ feedID: feed.id, enabled: !feed.enabled })
              say(`${feed.name} ${feed.enabled ? "off" : "on"}.`)
            } catch (error) {
              say(errorText(error), true)
            }
            await feeds()
          },
        })),
      )
    })
  }

  async function fetch(mode: Mode, page: number): Promise<{ items: Item[]; total: number }> {
    if (mode === "advisories") {
      const result = await intel.advisories({ page, pageSize: PAGE, sort: "publishedAt", order: "desc" })
      return {
        total: numeric(result.total),
        items: array(result.items, 1000).map((value) => {
          const item = object(value)
          optional(item.summary, string)
          optional(item.url, string)
          const severity = string(item.severity, 16)
          return {
            title: `${severity.toUpperCase()} ${string(item.title, 2000)}`,
            meta: `${string(item.id, 256)} · ${string(item.source, 256)} · ${date(item.publishedAt)}${typeof item.cvss === "number" ? ` · CVSS ${item.cvss}` : ""}`,
            body: `${display((item.summary as string | undefined) ?? "", 8000)}${item.url ? `\n\n${label(item.url as string, 500)}` : ""}`,
            tone: SEVERITY[severity] ?? color.muted,
          }
        }),
      }
    }
    if (mode === "kev") {
      const result = await intel.kev({ page, pageSize: PAGE, sort: "dateAdded", order: "desc" })
      return {
        total: numeric(result.total),
        items: array(result.items, 1000).map((value) => {
          const item = object(value)
          optional(item.url, string)
          return {
            title: `${string(item.cveID, 64)} ${string(item.name, 2000)}`,
            meta: `${string(item.vendor, 256)} ${string(item.product, 256)} · added ${date(item.dateAdded)}${typeof item.dueDate === "number" ? ` · remediate by ${date(item.dueDate)}` : ""}`,
            body: item.url ? label(item.url as string, 500) : "",
            tone: color.error,
          }
        }),
      }
    }
    const result = await intel.news({ page, pageSize: PAGE, sort: "publishedAt", order: "desc" })
    return {
      total: numeric(result.total),
      items: array(result.items, 1000).map((value) => {
        const item = object(value)
        optional(item.summary, string)
        return {
          title: string(item.title, 2000),
          meta: `${string(item.source, 256)} · ${date(item.publishedAt)}`,
          body: `${display((item.summary as string | undefined) ?? "", 8000)}\n\n${label(string(item.url, 2000), 500)}`,
          tone: color.muted,
        }
      }),
    }
  }

  return { open }
}

function date(value: unknown) {
  return new Date(numeric(value)).toLocaleDateString()
}
