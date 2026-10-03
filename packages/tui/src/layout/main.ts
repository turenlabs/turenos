import { BoxRenderable, type CliRenderer } from "@opentui/core"
import { createActions } from "./actions"
import { createHistoryActions, createSessionHeader, createTranscript } from "./transcript"

/** Builds the main pane and adds it to `body`; the sidebar is added after it. */
export function createMain(renderer: CliRenderer, body: BoxRenderable) {
  const main = new BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 1,
    flexDirection: "column",
    // Keep transcript text off the pane edge; the composer box below is
    // inset further by its own border and padding.
    paddingLeft: 1,
  })
  body.add(main)
  return {
    main,
    ...createSessionHeader(renderer, main),
    ...createHistoryActions(renderer, main),
    ...createTranscript(renderer, main),
    ...createActions(renderer, main),
  }
}
