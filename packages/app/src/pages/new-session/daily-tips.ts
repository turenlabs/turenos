import type { TranslationKey } from "@/context/language"

type Tip = {
  id: string
  title: TranslationKey
  body: TranslationKey
  automatic: boolean
}

export const tips = [
  { id: "context", title: "tips.context.title", body: "tips.context.body", automatic: true },
  { id: "commands", title: "tips.commands.title", body: "tips.commands.body", automatic: true },
  { id: "extensions", title: "tips.extensions.title", body: "tips.extensions.body", automatic: true },
  { id: "worktree", title: "tips.worktree.title", body: "tips.worktree.body", automatic: true },
  { id: "model", title: "tips.model.title", body: "tips.model.body", automatic: true },
  { id: "providers", title: "tips.providers.title", body: "tips.providers.body", automatic: false },
] as const satisfies readonly Tip[]

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
