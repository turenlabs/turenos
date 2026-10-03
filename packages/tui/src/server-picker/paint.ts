import { TextAttributes, TextRenderable } from "@opentui/core"
import { display } from "../messages"
import { serverLabel, type Target } from "../servers"
import { label } from "../state"
import { color } from "../theme"
import type { Picker, Tone, View } from "./types"

export function say(picker: Picker, text: string, tone: Tone = "muted") {
  if (!picker.view) return
  picker.view.status.content = display(text, 1000)
  picker.view.status.fg = color[tone]
}

export function paint(picker: Picker) {
  const view = picker.view
  if (!view) return
  const current = picker.hooks.current()
  view.logo.visible = picker.renderer.height >= 30
  view.heading.content = current
    ? `Connected to ${label(serverLabel(current.target), 80)}${current.connected ? "" : " (disconnected)"} · choose a server`
    : "Choose a TurenOS server"
  view.list.visible = picker.mode === "list" || picker.mode === "connecting"
  view.fields.visible = picker.mode === "add" || picker.mode === "password"
  view.rows.forEach((row) => row.destroyRecursively())
  const offsets: number[] = []
  view.rows = entryRows(picker, current?.target.id, offsets)
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
function entryRows(picker: Picker, currentID: Target["id"] | undefined, offsets: number[]) {
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
    const active = currentID === entry.target.id
    const chosen = index === picker.selected
    const row = new TextRenderable(renderer, {
      content: `${chosen ? "›" : " "} ${active ? "●" : "○"} ${label(entry.target.name, 64).padEnd(width)}  ${label(entry.detail, 200)}${active ? "  · current" : ""}`,
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

function scrollToSelected(picker: Picker, view: View, top: number) {
  if (top <= view.list.scrollTop) view.list.scrollTo(Math.max(0, top - 1))
  if (top >= view.list.scrollTop + view.list.viewport.height) view.list.scrollTo(top - view.list.viewport.height + 1)
}

function keyHint(picker: Picker, hasCurrent: boolean) {
  if (picker.mode === "connecting") return "Esc cancel"
  if (picker.mode === "add") return "Tab next field · Enter save · Esc cancel"
  if (picker.mode === "password") return "Enter connect · Ctrl+U clear · Esc cancel"
  return `↑↓ choose · Enter connect · a add · d remove · r rescan${hasCurrent ? " · Esc back" : ""} · q quit`
}
