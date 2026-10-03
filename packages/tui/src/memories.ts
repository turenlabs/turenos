import { StyledText, fg, type CliRenderer } from "@opentui/core"
import type { MemoriesListOutput } from "@turenlabs/client"
import type { Dialogs } from "./dialogs"
import { matchesKey } from "./keys"
import { display } from "./messages"
import { openPanel } from "./panel"
import { openSection } from "./picker"
import { errorText, type Connection } from "./server"
import { label, type DashboardState } from "./state"
import { color } from "./theme"

type Memory = MemoriesListOutput[number]
type Place = { wingID: string; roomID?: string; name: string }

const KINDS = ["note", "fact", "decision", "observation"] as const

/**
 * The desktop's memory manager: durable notes agents recall across sessions, grouped into wings
 * (a project or a person) and rooms (a topic). Add, edit, and delete are yours; agents write too.
 */
export function createMemories(
  renderer: CliRenderer,
  state: DashboardState,
  connection: Connection,
  dialogs: Dialogs,
  say: (message: string, error?: boolean) => void,
) {
  const memories = connection.client.memories

  function open(back?: () => void) {
    if (!dialogs.navigate()) return
    return openSection(renderer, dialogs, state, { title: "Memories", back }, memories.wings, (wings, picker) => {
      picker.text.content = "Wings group memories by project or person."
      picker.set([
        ...wings.map((wing) => ({
          name: label(wing.name, 60),
          description: `${wing.kind} · ${label(wing.key, 80)}`,
          run: () => rooms({ wingID: wing.id, name: wing.name }, () => void open(back)),
        })),
        {
          name: "+ New personal wing",
          description: "For notes that are about you rather than one project",
          run: async () => {
            const wing = await memories.wing({ kind: "person", key: "personal", name: "Personal" })
            await memories.room({ wingID: wing.id, slug: "general", name: "General" })
            await open(back)
          },
        },
      ])
    })
  }

  function rooms(wing: Place, back: () => void) {
    return openSection(
      renderer,
      dialogs,
      state,
      { title: label(wing.name, 60), back },
      () => memories.rooms({ wingID: wing.wingID }),
      (list, picker) => {
        picker.text.content = "Rooms are topics within the wing."
        picker.set([
          { name: "All rooms", run: () => browse(wing, () => void rooms(wing, back)) },
          ...list.map((room) => ({
            name: label(room.name, 60),
            description: room.slug,
            run: () =>
              browse({ ...wing, roomID: room.id, name: `${wing.name} · ${room.name}` }, () => void rooms(wing, back)),
          })),
        ])
      },
    )
  }

  function browse(place: Place, back: () => void) {
    const panel = openPanel(renderer, dialogs, `Memories · ${label(place.name, 60)}`)
    if (!panel) return
    panel.dialog.back = back
    let items: Memory[] = []
    let armed = ""
    const keys = "↑↓ choose · a add · E edit · Ctrl+D delete · Ctrl+R refresh · Esc back"

    async function load() {
      try {
        const list = await memories.list({ wingID: place.wingID, roomID: place.roomID })
        if (state.modal !== panel!.dialog) return
        items = list
          .filter((item) => !item.supersededBy)
          .toSorted((a, b) => Number(b.timeUpdated) - Number(a.timeUpdated))
        panel!.heading.content = `${items.length} memor${items.length === 1 ? "y" : "ies"}`
        panel!.list.options = items.map((item) => ({
          name: `[${item.kind}] ${label(item.title, 60)}`,
          description: "",
        }))
        panel!.dialog.error.content = keys
        describe()
      } catch (error) {
        if (state.modal === panel!.dialog) panel!.show(`Memories unavailable: ${errorText(error)}`)
      }
    }

    function describe() {
      armed = ""
      const item = items[panel!.list.getSelectedIndex()]
      if (!item)
        return panel!.show(
          place.roomID ? "No memories here yet. a adds one." : "No memories yet. Open a room to add one.",
        )
      const anchor = [item.anchor.path, item.anchor.symbol].filter(Boolean).join(" · ")
      panel!.show(
        new StyledText([
          fg(color.text)(`${display(item.title, 500)}\n`),
          fg(color.muted)(
            `${item.kind} · by ${label(item.provenance.assertedBy, 40)} (${item.provenance.source})${anchor ? ` · ${label(anchor, 200)}` : ""}\n\n`,
          ),
          fg(color.text)(display(item.body, 48000)),
        ]),
      )
    }

    function remove() {
      const item = items[panel!.list.getSelectedIndex()]
      if (!item) return
      if (armed !== item.id) {
        armed = item.id
        panel!.dialog.error.content = `Ctrl+D again deletes "${label(item.title, 40)}".\n${keys}`
        return
      }
      void memories.remove({ drawerID: item.id, wingID: item.wingID }).then(
        () => load(),
        (error: unknown) => (panel!.dialog.error.content = `! ${errorText(error)}\n${keys}`),
      )
    }

    panel.list.on("selectionChanged", describe)
    panel.dialog.key = (key) => {
      const item = items[panel.list.getSelectedIndex()]
      const action = matchesKey(key, "r", { ctrl: true })
        ? load
        : matchesKey(key, "d", { ctrl: true })
          ? remove
          : key.sequence === "a" && place.roomID
            ? () => edit(place, undefined, back)
            : key.sequence === "E" && item
              ? () => edit(place, item, back)
              : undefined
      if (!action) return false
      void action()
      return true
    }
    void load()
  }

  function edit(place: Place, item: Memory | undefined, back: () => void) {
    dialogs.close(false)
    const dialog = dialogs.open(item ? "Edit memory" : "New memory", false, 30)
    if (!dialog) return
    const kind = dialogs.input(dialog, `Kind: ${KINDS.join(", ")}`, item?.kind ?? "note")
    const title = dialogs.input(dialog, "Title", item?.title ?? "")
    const body = dialogs.prompt(dialog, "Body (Shift+Enter adds a line)", item?.body ?? "")
    dialog.submit = async () => {
      const value = kind.value.trim() as (typeof KINDS)[number]
      if (!KINDS.includes(value)) throw new Error(`Kind must be one of: ${KINDS.join(", ")}.`)
      if (!title.value.trim() || !body.plainText.trim()) throw new Error("Enter a title and a body.")
      const fields = { kind: value, title: title.value.trim(), body: body.plainText }
      // Updates name the version they edited, so another client's newer edit is never overwritten.
      if (item)
        await memories.update({
          drawerID: item.id,
          expectedTimeUpdated: item.timeUpdated,
          wingID: item.wingID,
          roomID: item.roomID,
          ...fields,
        })
      else await memories.create({ wingID: place.wingID, roomID: place.roomID!, ...fields })
      say(item ? "Memory saved." : "Memory added.")
    }
    dialog.afterSubmit = () => browse(place, back)
    dialog.back = () => browse(place, back)
    dialog.error.content = "Tab next field · Ctrl+S save · Esc cancel"
    title.focus()
  }

  return { open }
}
