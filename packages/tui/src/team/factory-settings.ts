import { SelectRenderable, TextRenderable } from "@opentui/core"
import { factoryConfigProblem, parseFactoryParameters, selectFactoryTeammate } from "@turenlabs/client/team"
import { markFocus } from "../automations/focus"
import { matchesKey } from "../keys"
import { display } from "../messages"
import { label, type ModalState } from "../state"
import { color } from "../theme"
import type { TeamOperations } from "./actions"
import { textArea } from "./fields"
import { applyRoom, panelNote } from "./selection"
import { finite, viewOf, type Room, type Teammate, type TeamContext } from "./types"

const HINT = "Tab next field · Space toggles a teammate · Ctrl+S save (does not start work) · Esc back"

/** The factory's setup form. Saving never starts a run; Ctrl+R in the panel does. */
export function openSettings(ctx: TeamContext, ops: TeamOperations, room: Room, back: () => void) {
  const mates = viewOf(ctx.state).teammates
  if (!mates.length) return ctx.say("Add teammates first: M opens the room's teammates.", true)
  const dialog = ctx.dialogs.open(`Factory › # ${label(room.name, 40)} › Settings`, false, 40)
  if (!dialog) return
  dialog.back = back
  dialog.afterSubmit = back
  const fields = settingsFields(ctx, dialog, room, mates)
  dialog.submit = () => saveSettings(ctx, room, mates, fields)
  dialog.error.content = HINT
  fields.outcome.focus()
}

type Fields = ReturnType<typeof settingsFields>

function settingsFields(ctx: TeamContext, dialog: ModalState, room: Room, mates: readonly Teammate[]) {
  const config = room.factory?.config
  const outcome = textArea(
    ctx,
    dialog,
    "Outcome (required, up to 4000 characters)",
    display(config?.outcome ?? "", 4000),
  )
  const parameters = textArea(
    ctx,
    dialog,
    "Parameters (a JSON object)",
    JSON.stringify(config?.parameters ?? {}, null, 2),
    3,
  )
  const problem = new TextRenderable(ctx.renderer, { content: "", fg: color.error })
  dialog.form.add(problem)
  parameters.onContentChange = () => (problem.content = parametersProblem(parameters.plainText) ?? "")
  const constraints = textArea(
    ctx,
    dialog,
    "Constraints (optional, up to 8000 characters)",
    display(config?.constraints ?? "", 8000),
    3,
  )
  const acceptance = textArea(
    ctx,
    dialog,
    "Acceptance criteria (required, up to 4000 characters)",
    display(config?.acceptanceCriteria ?? "", 4000),
    3,
  )
  const directory = ctx.dialogs.input(
    dialog,
    "Working directory on the server (required)",
    display(config?.directory ?? mates[0]!.directory, 4096),
  )
  markFocus(directory)
  return { outcome, parameters, constraints, acceptance, directory, team: teamPickers(ctx, dialog, mates, config) }
}

async function saveSettings(ctx: TeamContext, room: Room, mates: readonly Teammate[], fields: Fields) {
  if (!ctx.state.connected) throw new Error("Reconnect before saving the factory.")
  const next = {
    outcome: fields.outcome.plainText.trim(),
    parameters: parseFactoryParameters(fields.parameters.plainText.trim() || "{}"),
    constraints: fields.constraints.plainText.trim(),
    acceptanceCriteria: fields.acceptance.plainText.trim(),
    directory: fields.directory.value.trim(),
    coordinatorTeammateID: fields.team.coordinator(),
    teammateIDs: fields.team.selected(),
  }
  const refusal = factoryConfigProblem(next, mates)
  if (refusal) throw new Error(refusal)
  applyRoom(ctx, finite(await ctx.connection.client.team.factoryConfigure({ roomID: room.id, ...next })))
  panelNote(ctx, "Factory saved. Saving does not start work: Ctrl+R starts a run.")
}

function parametersProblem(text: string) {
  try {
    parseFactoryParameters(text.trim() || "{}")
  } catch (error) {
    return error instanceof Error ? error.message : "Parameters must be a JSON object"
  }
}

/**
 * Two lists: the room's teammates (Space marks up to ten) and the coordinator, chosen among the marked.
 * Both hold the teammates as they were when the form opened.
 */
function teamPickers(
  ctx: TeamContext,
  dialog: ModalState,
  mates: readonly Teammate[],
  config: NonNullable<Room["factory"]>["config"] | undefined,
) {
  let ids = (config?.teammateIDs ?? []).filter((id) => mates.some((mate) => mate.id === id))
  let coordinator = config?.coordinatorTeammateID ?? ""
  const team = list(ctx, Math.min(5, mates.length))
  const lead = list(ctx, Math.min(5, Math.max(1, mates.length)))
  const paint = () => {
    team.options = mates.map((mate) => ({
      name: `${ids.includes(mate.id) ? "[x]" : "[ ]"} @${label(mate.handle, 32)}  ${label(mate.name, 40)} · ${label(mate.role, 40)}`,
      description: "",
    }))
    const chosen = mates.filter((mate) => ids.includes(mate.id))
    lead.options = chosen.length
      ? chosen.map((mate) => ({
          name: `${mate.id === coordinator ? "(•)" : "( )"} @${label(mate.handle, 32)}`,
          description: "",
        }))
      : [{ name: "Mark teammates above first", description: "" }]
  }
  dialog.form.add(new TextRenderable(ctx.renderer, { content: "Teammates (Space marks, at most 10)", fg: color.muted }))
  dialog.form.add(team)
  dialog.form.add(
    new TextRenderable(ctx.renderer, { content: "Coordinator (Space chooses, among the marked)", fg: color.muted }),
  )
  dialog.form.add(lead)
  ;[team, lead].forEach((field) => {
    ctx.dialogs.track(dialog, field)
    markFocus(field)
  })
  team.onKeyDown = (key) => {
    if (!matchesKey(key, "space")) return
    key.preventDefault()
    const mate = mates[team.getSelectedIndex()]
    if (!mate) return
    try {
      ids = selectFactoryTeammate(ids, mate.id, !ids.includes(mate.id))
    } catch (error) {
      dialog.error.content = `! ${error instanceof Error ? error.message : "Select at most 10 teammates"}\n${HINT}`
      return
    }
    if (!ids.includes(coordinator)) coordinator = ids[0] ?? ""
    const at = team.getSelectedIndex()
    paint()
    team.setSelectedIndex(at)
  }
  lead.onKeyDown = (key) => {
    if (!matchesKey(key, "space")) return
    key.preventDefault()
    coordinator = mates.filter((mate) => ids.includes(mate.id))[lead.getSelectedIndex()]?.id ?? coordinator
    const at = lead.getSelectedIndex()
    paint()
    lead.setSelectedIndex(at)
  }
  paint()
  return { selected: () => ids, coordinator: () => coordinator }
}

function list(ctx: TeamContext, height: number) {
  return new SelectRenderable(ctx.renderer, {
    height,
    options: [],
    showDescription: false,
    backgroundColor: color.bg,
    textColor: color.text,
    selectedBackgroundColor: color.selected,
    selectedTextColor: color.accent,
  })
}
