import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { color } from "../theme"

/** Builds the composer prompt and the secondary action row under the transcript. */
export function createActions(renderer: CliRenderer, main: BoxRenderable) {
  const actions = new BoxRenderable(renderer, {
    height: 3,
    flexShrink: 0,
    flexDirection: "column",
    paddingX: 2,
    backgroundColor: color.panel,
    border: ["left"],
    borderColor: color.focus,
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
  return { history, information, changes, files, tasks, queued, harness, meter }
}
