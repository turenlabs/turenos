import { TextAttributes, TextRenderable } from "@opentui/core"
import { fitHints } from "../changes/heading"
import { display } from "../messages"
import { serverLabel, type Entry, type Target } from "../servers"
import { label } from "../state"
import { color } from "../theme"
import { fitDetail } from "./detail"
import type { Picker, Tone, View } from "./types"

export function say(picker: Picker, text: string, tone: Tone = "muted") {
  if (!picker.view) return
  picker.view.status.content = display(text, 1000)
  picker.view.status.fg = color[tone]
}

const formHeading: Partial<Record<Picker["mode"], string>> = {
  add: "Add a server by its address",
  password: "This server needs a password",
}

export function paint(picker: Picker) {
  const view = picker.view
  if (!view) return
  const current = picker.hooks.current()
  view.logo.visible = picker.renderer.height >= 30
  // A form has its own line; the picker's "Connected to … · choose a server" belongs to the list.
  view.heading.content =
    formHeading[picker.mode] ??
    (current
      ? `Connected to ${label(serverLabel(current.target), 80)}${current.connected ? "" : " (disconnected)"} · choose a server`
      : "Choose a TurenOS server")
  const root = picker.back ? "Settings › Servers" : "Servers"
  view.frame.title =
    picker.mode === "add" ? ` ${root} › Add server ` : picker.mode === "password" ? ` ${root} › Password ` : ` ${root} `
  view.list.visible = picker.mode === "list" || picker.mode === "connecting"
  view.fields.visible = picker.mode === "add" || picker.mode === "password"
  view.rows.forEach((row) => row.destroyRecursively())
  const offsets: number[] = []
  view.rows = entryRows(picker, current?.target, offsets)
  if (!picker.entries.length)
    view.rows.push(
      new TextRenderable(picker.renderer, {
        content: "No TurenOS server found. Open the TurenOS app, or press a to add a server.",
        fg: color.muted,
        wrapMode: "word",
      }),
    )
  view.rows.forEach((row) => view.list.add(row))
  scrollToSelected(picker, view, offsets[picker.selected] ?? 0)
  view.keys.content = keyHint(picker, !!current)
}

/** Group headings and one row per entry; fills `offsets` with each entry's screen line. */
function entryRows(picker: Picker, current: Target | undefined, offsets: number[]) {
  const { entries, renderer } = picker
  const width = Math.min(30, Math.max(10, ...entries.map((entry) => label(entry.target.name, 64).length)))
  // Screen line of each entry, counting group headings and the gap above all but the first.
  let line = 0
  return entries.flatMap((entry, index) => {
    const heading =
      entries[index - 1]?.group !== entry.group
        ? [
            new TextRenderable(renderer, {
              content: entry.group.toUpperCase(),
              fg: color.muted,
              attributes: TextAttributes.BOLD,
              marginTop: index ? 1 : 0,
              height: 1,
              flexShrink: 0,
            }),
          ]
        : []
    const active = isCurrent(current, entry)
    const chosen = index === picker.selected
    const name = label(entry.target.name, 64)
    // The row's prefix, name column, gap and current marker come off the frame's inner width, with a column for the scrollbar.
    const detail = fitDetail(
      name,
      entry.detail,
      Math.min(100, renderer.width - 2) - 7 - 4 - Math.max(width, name.length) - 2 - (active ? 11 : 0) - 1,
    )
    const row = new TextRenderable(renderer, {
      content: `${chosen ? "▶" : " "} ${active ? "●" : "○"} ${name.padEnd(width)}${detail ? `  ${detail}` : ""}${active ? "  · current" : ""}`,
      fg: active ? color.accent : color.text,
      bg: chosen ? color.selected : undefined,
      height: 1,
      width: "100%",
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
      onMouseDown: (event) => {
        if (event.button !== 0 || picker.mode !== "list") return
        event.preventDefault()
        picker.selected = index
        picker.choose()
      },
    })
    if (heading.length) line += index ? 2 : 1
    offsets.push(line++)
    return [...heading, row]
  })
}

/** A discovered local server is the current one when it is the endpoint a URL connection opened. */
export function isCurrent(current: Target | undefined, entry: Entry) {
  return (
    current?.id === entry.target.id || (current?.kind === "url" && entry.url !== undefined && entry.url === current.url)
  )
}

function scrollToSelected(picker: Picker, view: View, top: number) {
  if (top <= view.list.scrollTop) view.list.scrollTo(Math.max(0, top - 1))
  if (top >= view.list.scrollTop + view.list.viewport.height) view.list.scrollTo(top - view.list.viewport.height + 1)
}

function keyHint(picker: Picker, hasCurrent: boolean) {
  if (picker.mode === "connecting") return "Esc cancel"
  if (picker.mode === "add") return "Tab next field · Enter / Ctrl+S save · Esc back"
  if (picker.mode === "password") return "Enter connect · Ctrl+U clear · Esc back"
  // Hints wrap only between entries, so a key never lands on one line and its word on the next.
  return fitHints(
    Math.min(100, picker.renderer.width - 2) - 6,
    ["↑↓ choose", "a add", "d remove", "r rescan"],
    ["Enter connect", ...(hasCurrent ? ["Esc back"] : []), "q quit"],
  )
}
