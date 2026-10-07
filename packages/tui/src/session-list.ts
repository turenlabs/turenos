import { ScrollBoxRenderable, TextRenderable, TextAttributes, type CliRenderer, type KeyEvent } from "@opentui/core"
import { matchesKey } from "./keys"
import type { Session } from "./server"
import { fitPath } from "./chrome"
import { label, sessionTitle, type Row } from "./state"
import { color } from "./theme"

export type SidebarRow = Row & { group?: string; groupLabel?: string; running?: boolean; needsInput?: boolean }

export function sessionRows(
  sessions: readonly Session[],
  active: Record<string, unknown>,
  needsInput: readonly string[] = [],
): SidebarRow[] {
  const groups = new Map<string, { directory: string; workspace?: string; sessions: Session[] }>()
  for (const session of sessions) {
    const { directory, workspaceID: workspace } = session.location
    const key = JSON.stringify([directory, workspace ?? null])
    if (!groups.has(key)) groups.set(key, { directory, workspace, sessions: [] })
    groups.get(key)!.sessions.push(session)
  }
  const directories = [...new Set([...groups.values()].map((group) => group.directory))]
  const parts = (directory: string) => directory.split(/[\\/]/).filter(Boolean)
  const names = new Map(
    directories.map((directory) => {
      const segments = parts(directory)
      let length = 1
      while (
        length < segments.length &&
        directories.some(
          (other) => other !== directory && parts(other).slice(-length).join("/") === segments.slice(-length).join("/"),
        )
      )
        length++
      const suffix = segments.slice(-length).join("/")
      const ambiguous = directories.some(
        (other) => other !== directory && parts(other).slice(-length).join("/") === suffix,
      )
      return [directory, ambiguous || !suffix ? directory : suffix]
    }),
  )
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...groups]
    .sort(([, a], [, b]) => compare(a.directory, b.directory) || compare(a.workspace ?? "", b.workspace ?? ""))
    .flatMap(([group, entry]) => {
      const sharedDirectory = [...groups.values()].filter((other) => other.directory === entry.directory).length > 1
      const groupLabel = label(
        `${names.get(entry.directory)}${sharedDirectory ? ` [${entry.workspace ?? "default"}]` : ""}`,
        250,
      )
      return entry.sessions
        .sort((a, b) => b.time.updated - a.time.updated || b.time.created - a.time.created || compare(a.id, b.id))
        .map((session) => ({
          id: session.id,
          name: `${needsInput.includes(session.id) ? "? " : Object.hasOwn(active, session.id) ? "* " : ""}${sessionTitle(session.title || session.id)}`,
          // Keep metadata searchable without repeating it in the visible session rows.
          description: `${Object.hasOwn(active, session.id) ? "running" : "idle"} ${session.time.archived !== undefined ? "archived" : ""} ${label(session.agent ?? "default")} ${label(session.location.directory, 250)}`,
          group,
          groupLabel,
          running: Object.hasOwn(active, session.id),
          needsInput: needsInput.includes(session.id),
        }))
    })
}

/** Cuts a row to `width` columns with an ellipsis at its end; OpenTUI's own truncation elides the middle. */
function fit(text: string, width: number) {
  return width > 0 && text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

export class SessionListRenderable extends ScrollBoxRenderable {
  private items: { name: string; description?: string; group?: string; groupLabel?: string; running?: boolean }[] = []
  private lines: TextRenderable[] = []
  private headings: { node: TextRenderable; text: string }[] = []
  private selected = 0
  private reveal = false

  constructor(private renderer: CliRenderer) {
    super(renderer, {
      flexGrow: 1,
      width: "100%",
      minHeight: 1,
      backgroundColor: color.panel,
      scrollX: false,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
    })
    // Rows are fitted to the viewport (which excludes the scrollbar column), so they are fitted again when it changes.
    this.viewport.on("resize", () => this.paint())
  }

  get options() {
    return this.items
  }
  set options(items: typeof this.items) {
    if (JSON.stringify(items) === JSON.stringify(this.items)) return
    this.items = items
    for (const child of this.getChildren()) child.destroyRecursively()
    this.lines = []
    this.headings = []
    let previous: string | undefined
    for (const [index, item] of items.entries()) {
      if (item.group !== undefined && item.group !== previous) {
        const heading = new TextRenderable(this.renderer, {
          content: item.groupLabel ?? item.group,
          fg: color.muted,
          attributes: TextAttributes.BOLD,
          height: 1,
          flexShrink: 0,
          wrapMode: "none",
          onMouseDown: (event) => {
            event.preventDefault()
            event.stopPropagation()
          },
        })
        this.headings.push({ node: heading, text: item.groupLabel ?? item.group })
        this.add(heading)
      }
      previous = item.group
      const line = new TextRenderable(this.renderer, {
        content: `  ${item.name}`,
        fg: color.text,
        height: 1,
        flexShrink: 0,
        width: "100%",
        wrapMode: "none",
        onMouseDown: (event) => {
          if (event.button !== 0) return
          // Do not let renderer autofocus override focus restored by a rejected navigation.
          event.preventDefault()
          event.stopPropagation()
          this.focus()
          this.setSelectedIndex(index)
        },
      })
      this.lines.push(line)
      this.add(line)
    }
    this.setSelectedIndex(this.selected, false)
  }

  getSelectedIndex() {
    return this.selected
  }

  /** Rewrites every row for the current selection and width: prefix and marker count toward the width. */
  private paint() {
    const width = this.viewport.width
    for (const [i, line] of this.lines.entries()) {
      const active = this.items[i]!.running === true
      line.content = fit(`${i === this.selected ? "> " : "  "}${this.items[i]!.name}`, width)
      line.bg = i === this.selected ? color.selected : color.panel
      // A running session is a clear active line, not just a marker glyph.
      line.fg = i === this.selected ? color.text : active ? color.accent : color.text
      line.attributes = i === this.selected ? TextAttributes.BOLD : TextAttributes.NONE
    }
    for (const heading of this.headings)
      heading.node.content =
        width > 0 && heading.text.startsWith("/") ? fitPath(heading.text, width) : fit(heading.text, width)
  }

  setSelectedIndex(index: number, notify = true) {
    const previous = this.selected
    this.selected = Math.max(0, Math.min(index, this.items.length - 1))
    this.paint()
    const line = this.lines[this.selected]
    // Passive refreshes must not move the viewport back to an unchanged selection.
    if (line && (notify || previous !== this.selected)) {
      this.reveal = true
      this.scrollChildIntoView(line.id)
    }
    if (notify && previous !== this.selected && line) this.emit("selectionChanged", this.selected)
  }

  moveUp(steps = 1) {
    this.setSelectedIndex(this.selected < steps ? this.items.length - 1 : this.selected - steps)
  }
  moveDown(steps = 1) {
    this.setSelectedIndex(this.selected + steps >= this.items.length ? 0 : this.selected + steps)
  }
  selectCurrent() {
    if (this.items.length) this.emit("itemSelected", this.selected)
  }

  protected override onUpdate(deltaTime: number) {
    super.onUpdate(deltaTime)
    if (!this.reveal || !this.viewport.height || this.scrollHeight < this.getChildren().length) return
    this.reveal = false
    const row = this.getChildren().indexOf(this.lines[this.selected]!)
    if (row < this.scrollTop) this.scrollTo(row)
    else if (row >= this.scrollTop + this.viewport.height) this.scrollTo(row - this.viewport.height + 1)
  }

  override handleKeyPress(key: KeyEvent) {
    if (matchesKey(key, "up") || matchesKey(key, "k")) this.moveUp()
    else if (matchesKey(key, "down") || matchesKey(key, "j")) this.moveDown()
    else if (matchesKey(key, "up", { shift: true })) this.moveUp(5)
    else if (matchesKey(key, "down", { shift: true })) this.moveDown(5)
    else if (matchesKey(key, "home")) this.setSelectedIndex(0)
    else if (matchesKey(key, "end")) this.setSelectedIndex(this.items.length - 1)
    else if (matchesKey(key, "enter")) this.selectCurrent()
    else return false
    return true
  }
}
