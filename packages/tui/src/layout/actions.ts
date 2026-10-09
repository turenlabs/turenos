import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { color } from "../theme"

/** Entries only some tabs use, found by id so the dashboard can click them: `4 Team` back from a task session, and the room's two keys. */
const EXTRA = { "action-team": "4 Team", "action-room": "d Room", "action-new-room": "a New room" }

/** Builds the composer prompt and the secondary action row under the transcript. */
export function createActions(renderer: CliRenderer, main: BoxRenderable) {
  const actions = new BoxRenderable(renderer, {
    height: 2,
    flexShrink: 0,
    flexDirection: "column",
    paddingX: 2,
    backgroundColor: color.panel,
    border: ["left"],
    borderColor: color.accent,
    marginTop: 1,
  })
  main.add(actions)
  const composer = new TextRenderable(renderer, {
    content: " Send a message…  f",
    fg: color.muted,
    bg: color.panel,
    height: 1,
    width: "100%",
    flexShrink: 0,
    minWidth: 1,
    truncate: true,
    wrapMode: "none",
  })
  actions.add(composer)
  return { actions, composer, ...createSecondaryActions(renderer, actions) }
}

function createSecondaryActions(renderer: CliRenderer, actions: BoxRenderable) {
  const secondaryActions = new BoxRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    gap: 2,
  })
  actions.add(secondaryActions)
  // First, so the width limit clips lower-value entries before it hides the way to stop a turn.
  const stop = new TextRenderable(renderer, { content: "x Stop", visible: false, fg: color.warning, flexShrink: 0 })
  secondaryActions.add(stop)
  const history = new TextRenderable(renderer, { content: "h History", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(history)
  const information = new TextRenderable(renderer, { content: "i Details", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(information)
  const changes = new TextRenderable(renderer, { content: "d Changes", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(changes)
  const files = new TextRenderable(renderer, { content: "e Files", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(files)
  const tasks = new TextRenderable(renderer, { content: "t Tasks", visible: false, fg: color.accent, flexShrink: 0 })
  secondaryActions.add(tasks)
  const queued = new TextRenderable(renderer, { content: "u Queued", visible: false, fg: color.accent, flexShrink: 0 })
  secondaryActions.add(queued)
  const harness = new TextRenderable(renderer, { content: "H Harness", fg: color.muted, flexShrink: 0 })
  secondaryActions.add(harness)
  const meter = new TextRenderable(renderer, { content: "", visible: false, fg: color.muted, flexShrink: 0 })
  secondaryActions.add(meter)
  for (const [id, content] of Object.entries(EXTRA)) {
    secondaryActions.add(new TextRenderable(renderer, { id, content, visible: false, fg: color.muted, flexShrink: 0 }))
  }
  return { stop, history, information, changes, files, tasks, queued, harness, meter }
}

/** The nodes of `EXTRA` in a built action box. */
export function extraActions(actions: BoxRenderable) {
  const node = (id: keyof typeof EXTRA) => {
    const found = actions.findDescendantById(id)
    if (!(found instanceof TextRenderable)) throw new Error(`Missing action entry ${id}`)
    return found
  }
  return { team: node("action-team"), room: node("action-room"), newRoom: node("action-new-room") }
}
