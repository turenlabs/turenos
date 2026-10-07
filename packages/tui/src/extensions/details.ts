import { StyledText, fg } from "@opentui/core"
import { display } from "../messages"
import { label } from "../state"
import { color } from "../theme"
import type { Extension } from "./types"

export function details(item: Extension) {
  const missing = item.contributions.flatMap((contribution) =>
    contribution.secrets
      .filter((secret) => secret.required && !(Object.hasOwn(item.secretsSet, secret.id) && item.secretsSet[secret.id]))
      .map((secret) => secret.label),
  )
  return new StyledText([
    fg(color.text)(`${display(item.name, 200)}\n`),
    fg(color.muted)(
      `${item.enabled ? "On" : "Off"} · ${label(item.status, 40)}${item.mutable ? "" : " · managed (read-only here)"}\n\n`,
    ),
    fg(color.text)(`${display(item.description, 4000)}\n\n`),
    ...(item.detail ? [fg(color.warning)(`${display(item.detail, 2000)}\n\n`)] : []),
    ...(missing.length
      ? [fg(color.warning)(`Needs: ${missing.map((name) => label(name, 60)).join(", ")} (s)\n\n`)]
      : []),
    fg(color.muted)("PROVIDES\n"),
    ...item.contributions.map((contribution) =>
      fg(color.text)(
        `  ${label(contribution.type, 40)} · ${label(contribution.name, 60)}${contribution.authentication && contribution.authentication !== "none" ? ` · sign-in: ${label(contribution.authentication, 40)}` : ""}\n    ${label(contribution.description, 200)}\n`,
      ),
    ),
  ])
}
