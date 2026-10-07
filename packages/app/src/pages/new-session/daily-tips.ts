import type { TranslationKey } from "@/context/language"

export type Tip = {
  id: string
  title: TranslationKey
  body: TranslationKey
  automatic: boolean
  // Command whose live keybind is shown beside the tip, so rebound or unbound shortcuts are
  // never advertised from static copy.
  command?: string
}

export const tips: readonly Tip[] = [
  { id: "context", title: "tips.context.title", body: "tips.context.body", automatic: true },
  {
    id: "commands",
    title: "tips.commands.title",
    body: "tips.commands.body",
    automatic: true,
    command: "command.palette",
  },
  { id: "undo", title: "tips.undo.title", body: "tips.undo.body", automatic: true },
  { id: "attach", title: "tips.attach.title", body: "tips.attach.body", automatic: true, command: "file.attach" },
  { id: "worktree", title: "tips.worktree.title", body: "tips.worktree.body", automatic: true },
  { id: "shell", title: "tips.shell.title", body: "tips.shell.body", automatic: true, command: "prompt.mode.shell" },
  { id: "history", title: "tips.history.title", body: "tips.history.body", automatic: true },
  { id: "model", title: "tips.model.title", body: "tips.model.body", automatic: true, command: "model.choose" },
  {
    id: "effort",
    title: "tips.effort.title",
    body: "tips.effort.body",
    automatic: true,
    command: "model.variant.cycle",
  },
  { id: "handoff", title: "tips.handoff.title", body: "tips.handoff.body", automatic: true },
  {
    id: "terminal",
    title: "tips.terminal.title",
    body: "tips.terminal.body",
    automatic: true,
    command: "terminal.toggle",
  },
  { id: "review", title: "tips.review.title", body: "tips.review.body", automatic: true, command: "review.toggle" },
  { id: "swarm", title: "tips.swarm.title", body: "tips.swarm.body", automatic: true },
  { id: "compact", title: "tips.compact.title", body: "tips.compact.body", automatic: true },
  { id: "extensions", title: "tips.extensions.title", body: "tips.extensions.body", automatic: true },
  { id: "providers", title: "tips.providers.title", body: "tips.providers.body", automatic: false },
]

const automatic = tips.filter((tip) => tip.automatic)

export function localDay(date: Date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-")
}

export function dailyTip(date: Date) {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
  return automatic[day % automatic.length]
}
