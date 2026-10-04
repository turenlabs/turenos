import type { CliRenderer, PasteEvent } from "@opentui/core"

/** The one line left on the restored terminal, so a quit is never mistaken for a crash or for lost drafts. */
export function closedLine(drafts: number) {
  return `Turen TUI closed.${drafts ? ` ${drafts} unsent draft${drafts === 1 ? "" : "s"} discarded.` : ""}\n`
}

export async function settleTerminalInput(renderer: CliRenderer, input: NodeJS.EventEmitter = process.stdin) {
  if (renderer.isDestroyed) return Promise.resolve()
  const swallow = () => true
  const swallowPaste = (event: PasteEvent) => event.preventDefault()
  renderer.prependInputHandler(swallow)
  renderer.keyInput.on("paste", swallowPaste)
  renderer.useMouse = false
  renderer.stop()
  // Keep input owned until in-flight replies settle, before native destruction
  // restores terminal modes. A noisy terminal must not prevent quitting.
  return new Promise<void>((resolve) => {
    let finished = false
    let quiet = setTimeout(finish, 150)
    const deadline = setTimeout(finish, 600)
    function received() {
      if (finished) return
      clearTimeout(quiet)
      quiet = setTimeout(finish, 150)
    }
    function finish() {
      if (finished) return
      finished = true
      clearTimeout(quiet)
      clearTimeout(deadline)
      input.off("data", received)
      renderer.off("destroy", finish)
      renderer.removeInputHandler(swallow)
      renderer.keyInput.off("paste", swallowPaste)
      resolve()
    }
    input.on("data", received)
    renderer.once("destroy", finish)
  })
}
