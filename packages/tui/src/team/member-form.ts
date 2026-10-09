import type { KeyEvent } from "@opentui/core"
import { teammateDraft, teammateHandle } from "@turenlabs/client/team"
import { markFocus } from "../automations/focus"
import { display } from "../messages"
import { enterAdvances } from "../dialogs/fields"
import { matchesKey } from "../keys"
import { openSection } from "../picker"
import { label } from "../state"
import { textArea } from "./fields"
import { viewOf, finite, type Teammate, type TeamContext } from "./types"

/** What the form shows and what Ctrl+L and F3 keep while a chooser is open. */
export type MemberDraft = {
  name: string
  handle: string
  role: string
  mission: string
  directory: string
  agent: string
  model: string
}

const HINT =
  "Tab or Enter next field (Mission: Enter newline) · Ctrl+S or Enter on the last field saves · F3 agent · Ctrl+L model · Esc"

/** The add form (no `mate`) or the edit form for a teammate; `back` returns to the list or menu that opened it. */
export function memberForm(
  ctx: TeamContext,
  input: { mate?: Teammate; draft?: MemberDraft; back: () => void; saved: () => void },
) {
  const view = viewOf(ctx.state)
  const room = view.room
  if (!room) return
  if (room.archived) return ctx.say("Archived rooms are read-only. Restore the room first.", true)
  const mate = input.mate
  const draft = input.draft ?? (mate ? draftOf(mate) : emptyDraft())
  const dialog = ctx.dialogs.open(
    mate ? `@${label(mate.handle, 32)} › Edit` : `# ${label(room.name, 40)} › New teammate`,
    false,
    34,
  )
  if (!dialog) return
  dialog.back = input.back
  const name = ctx.dialogs.input(dialog, "Name", draft.name)
  const handleField = mate
    ? undefined
    : ctx.dialogs.input(dialog, "Handle: letters, digits, _ and -, starting with a letter", draft.handle)
  const role = ctx.dialogs.input(dialog, "Role", draft.role, "blank: Security teammate")
  const mission = textArea(ctx, dialog, "Mission", draft.mission)
  const directory = ctx.dialogs.input(dialog, "Directory (blank: the server's default)", draft.directory)
  const agent = ctx.dialogs.input(dialog, "Agent (blank: the server's default · F3 browse)", draft.agent)
  const model = ctx.dialogs.input(
    dialog,
    "Model: provider/model (blank: the server's default · Ctrl+L browse)",
    draft.model,
  )
  ;[name, handleField, role, directory, agent, model].filter((field) => field !== undefined).forEach(markFocus)
  const read = (): MemberDraft => ({
    name: name.value,
    handle: handleField?.value ?? draft.handle,
    role: role.value,
    mission: mission.plainText,
    directory: directory.value,
    agent: agent.value,
    model: model.value,
  })
  const reopen = (next: MemberDraft) => memberForm(ctx, { ...input, draft: next })
  dialog.key = (key) => choose(ctx, key, read, reopen)
  enterAdvances(dialog)
  dialog.submit = () => submitMember(ctx, room.id, mate, read(), { name, handle: handleField, mission, model })
  dialog.afterSubmit = input.saved
  dialog.error.content = HINT
  name.focus()
}

function emptyDraft(): MemberDraft {
  return { name: "", handle: "", role: "", mission: "", directory: "", agent: "", model: "" }
}

function draftOf(mate: Teammate): MemberDraft {
  return {
    name: display(mate.name, 512),
    handle: mate.handle,
    role: display(mate.role, 512),
    mission: display(mate.mission, 100_000),
    directory: display(mate.directory, 4096),
    agent: display(mate.agent ?? "", 256),
    model: mate.model ? display(`${mate.model.providerID}/${mate.model.id}`, 512) : "",
  }
}

/** Ctrl+L browses models and F3 agents; the form closes meanwhile and comes back with the choice. */
function choose(ctx: TeamContext, key: KeyEvent, read: () => MemberDraft, reopen: (draft: MemberDraft) => void) {
  const modelKey = matchesKey(key, "l", { ctrl: true })
  if (!modelKey && !matchesKey(key, "f3")) return false
  const draft = read()
  ctx.dialogs.close(false)
  if (modelKey)
    ctx.pickModel({
      directory: draft.directory.trim() || ctx.state.snapshot?.location.directory || "/",
      current: draft.model,
      note: "For the teammate. Choosing sends nothing; save the teammate to apply it.",
      choose: (model) => reopen({ ...draft, model }),
      cancel: () => reopen(draft),
    })
  else void pickAgent(ctx, draft, reopen)
  return true
}

function pickAgent(ctx: TeamContext, draft: MemberDraft, reopen: (draft: MemberDraft) => void) {
  const directory = draft.directory.trim() || ctx.state.snapshot?.location.directory || "/"
  return openSection(
    ctx.renderer,
    ctx.dialogs,
    ctx.state,
    { title: "Choose agent", back: () => reopen(draft), verb: "choose" },
    () => ctx.connection.agents(directory),
    (agents, picker) => {
      picker.text.content = `Agents for ${label(directory, 100)}.`
      picker.set([
        { name: "Server default", description: "Leaves the agent unset", run: () => reopen({ ...draft, agent: "" }) },
        ...agents.map((agent) => ({
          name: label(agent.id, 100),
          description: label(agent.description ?? "", 200),
          run: () => reopen({ ...draft, agent: agent.id }),
        })),
      ])
    },
  )
}

/** Throws a refusal and puts the cursor in the field it names. */
function refuse(field: { focus: () => void } | undefined, message: string): never {
  field?.focus()
  throw new Error(message)
}

async function submitMember(
  ctx: TeamContext,
  roomID: string,
  mate: Teammate | undefined,
  draft: MemberDraft,
  at: Record<"name" | "handle" | "mission" | "model", { focus: () => void } | undefined>,
) {
  if (!ctx.state.connected) throw new Error("Reconnect before saving the teammate.")
  const fields = teammateDraft({ ...draft, mission: draft.mission.trim() })
  if (!fields.name) refuse(at.name, "Enter a name.")
  // The server keeps handles lowercase; mentions ignore case.
  const handleText = fields.handle.toLowerCase()
  if (!mate && !teammateHandle.test(handleText))
    refuse(at.handle, "The handle needs letters, digits, _ or -, starts with a letter and has at most 32 characters.")
  if (!fields.mission) refuse(at.mission, "Enter a mission.")
  const model = parseModel(draft.model, at.model)
  const directory = draft.directory.trim()
  const agent = draft.agent.trim()
  const client = ctx.connection.client.team
  const result = mate
    ? await client.teammateEdit({
        teammateID: mate.id,
        name: fields.name,
        role: fields.role,
        mission: fields.mission,
        directory: directory || mate.directory,
        ...(agent ? { agent } : mate.agent ? { resetAgent: true } : {}),
        ...(model ? { model } : mate.model ? { resetModel: true } : {}),
      })
    : await client.teammateCreate({
        roomID,
        ...fields,
        handle: handleText,
        ...(directory ? { directory } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      })
  const teammate = finite(result)
  const view = viewOf(ctx.state)
  if (view.room?.id === roomID)
    view.teammates = view.teammates.some((item) => item.id === teammate.id)
      ? view.teammates.map((item) => (item.id === teammate.id ? teammate : item))
      : [...view.teammates, teammate]
  ctx.say(mate ? `Saved @${label(teammate.handle, 32)}.` : `Added @${label(teammate.handle, 32)}.`)
}

function parseModel(text: string, field: { focus: () => void } | undefined) {
  const value = text.trim()
  if (!value) return undefined
  const separator = value.indexOf("/")
  if (separator < 1 || separator === value.length - 1)
    refuse(field, "Enter the model as provider/model, or leave it blank.")
  return { providerID: value.slice(0, separator), id: value.slice(separator + 1) }
}
