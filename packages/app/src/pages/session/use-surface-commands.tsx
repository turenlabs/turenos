import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { useSessionLayout } from "./session-layout"
import { useParams } from "@solidjs/router"

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

/**
 * Commands owned by whichever session surface is routed - the draft composer
 * (`/new-session`) or a live session.
 *
 * Both surfaces implement these ids against their own composer ref and their own
 * `useSessionLayout()` view, so the id is surface-scoped rather than global and cannot
 * be hoisted to the app shell. The router mounts exactly one surface at a time, so they
 * share a single registration slot: the incoming surface takes ownership from the
 * outgoing one instead of both registering the ids and the registry dropping one of
 * them by mount order.
 */
export const useSurfaceCommands = (input: { focusInput: () => void }) => {
  const command = useCommand()
  const language = useLanguage()
  const terminal = useTerminal()
  const params = useParams()
  const { view } = useSessionLayout()

  const opened = () => view().terminal.opened()

  const openTerminal = () => {
    terminal.requestFocus(terminal.active())
    view().terminal.open()
  }

  const openSharedTerminal = () => {
    openTerminal()
    const sessionID = params.id
    if (!sessionID) return
    void terminal.shared(sessionID, { focus: true })
  }

  const toggleTerminal = () => {
    if (!opened()) {
      openTerminal()
      return
    }
    terminal.cancelFocus()
    view().terminal.close()
  }

  // Opening an empty panel spawns the first terminal on its own, so only ask for
  // another one when the workspace already has some.
  const newTerminal = () => {
    openTerminal()
    if (terminal.all().length === 0) return
    terminal.new({ focus: true })
  }

  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))

  command.register("surface", () => [
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: () => input.focusInput(),
    }),
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => (opened() ? toggleTerminal() : params.id ? openSharedTerminal() : openTerminal()),
    }),
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      keybind: "ctrl+alt+t",
      onSelect: newTerminal,
    }),
  ])

  return { opened, toggleTerminal }
}
