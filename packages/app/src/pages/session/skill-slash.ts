import type { ExtensionItem } from "@turenlabs/sdk/v2/client"

export type SkillSlashOption = {
  id: string
  name: string
  title: string
  description: string
}

export type SkillSlashInvocation = {
  name: string
  arguments: string
}

export function visibleCustomSlashCommands<T extends { source?: "command" | "mcp" | "skill" }>(commands: T[]) {
  return commands.filter((command) => command.source !== "skill")
}

export function extensionSkillSlashOptions(items: ExtensionItem[]) {
  const seen = new Set<string>()
  return items.flatMap((item) => skillOptions(item, seen))
}

function skillOptions(item: ExtensionItem, seen: Set<string>) {
  if (!item.enabled) return []
  return item.manifest.contributions.flatMap((contribution): SkillSlashOption[] => {
    if (contribution.type !== "skill" || seen.has(contribution.id)) return []
    seen.add(contribution.id)
    return [
      {
        id: `skill.${contribution.id}`,
        name: contribution.id,
        title: contribution.name,
        description: contribution.description,
      },
    ]
  })
}

export function resolveSkillSlash(text: string, options: SkillSlashOption[]): SkillSlashInvocation | undefined {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  const option = options.find((item) => item.name === match[1])
  if (!option) return undefined
  return { name: option.name, arguments: (match[2] ?? "").trim() }
}
