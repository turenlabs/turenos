import { BoxRenderable, type CliRenderer } from "@opentui/core"
import { createActions } from "./actions"
import { createHistoryActions, createSessionHeader, createTranscript } from "./transcript"

/** Builds the main pane and adds it to `body`; the sidebar is added after it. `still` is true for reduced motion. */
export function createMain(renderer: CliRenderer, body: BoxRenderable, still: () => boolean) {
  const main = new BoxRenderable(renderer, {
    flexGrow: 1,
    minWidth: 1,
    flexDirection: "column",
    // Keep transcript text off the pane edge; the composer box below is
    // inset further by its own border and padding.
    paddingLeft: 1,
  })
  body.add(main)
  const header = createSessionHeader(renderer, main)
  const history = createHistoryActions(renderer, main)
  const transcript = createTranscript(renderer, main, still)
  // "Working (12s · Esc Esc to stop)" sits where new output and the reply editor are, not above the transcript.
  main.add(header.activity)
  return { main, ...header, ...history, ...transcript, ...createActions(renderer, main) }
}
