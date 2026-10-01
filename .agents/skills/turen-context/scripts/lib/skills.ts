import path from "node:path"
import { readFileSync } from "node:fs"
import { error, warning, type Finding } from "./findings"
import type { Repo } from "./repo"

// Frontmatter rules from the Agent Skills specification (https://agentskills.io/specification).
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"])

// Repository skills live in `.agents/skills/<name>/SKILL.md`. Codex and OpenCode find them there and read their
// frontmatter; Claude Code never looks there, so it reaches a skill only through a pointer in the root AGENTS.md.
export function skillFindings(repo: Repo): Finding[] {
  return repo.tracked
    .filter((file) => /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(file))
    .flatMap((file) => [
      ...frontmatterFindings(file, readFileSync(path.join(repo.root, file), "utf8")),
      ...(repo.texts.get("AGENTS.md")?.includes(file)
        ? []
        : [error("", `${file} is not named in the root AGENTS.md, so Claude Code never finds it. Add a pointer line`)]),
    ])
}

function frontmatterFindings(file: string, text: string): Finding[] {
  const lines = text.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (lines[0]?.trim() !== "---" || end === -1) return [error("", `${file} has no frontmatter between --- lines`)]
  const block = lines.slice(1, end).join("\n")
  const parsed = parseYaml(block)
  if ("problem" in parsed) {
    // Codex, OpenCode and TurenOS retry with such a value quoted; strict parsers, like the reference validator, don't.
    const key = /^([\w-]+):\s+[^'"|>\s].*:\s/m.exec(block)?.[1]
    const hint = key === undefined ? "" : `; its \`${key}\` value contains an unquoted ": ", so quote it or reword it`
    return [error("", `${file} frontmatter is not valid YAML (${parsed.problem})${hint}`)]
  }
  if (typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data))
    return [error("", `${file} frontmatter is not a mapping of fields`)]
  const fields = new Map(Object.entries(parsed.data))
  const folder = path.posix.basename(path.posix.dirname(file))
  const name = fields.get("name")
  const description = fields.get("description")
  return [
    ...(typeof name === "string" && NAME.test(name) && name.length <= 64
      ? []
      : [error("", `${file} \`name\` must be 1-64 lowercase letters, digits and single hyphens`)]),
    ...(name === folder ? [] : [error("", `${file} \`name\` must match its folder, \`${folder}\``)]),
    ...(typeof description === "string" && description.trim().length > 0
      ? []
      : [error("", `${file} has no \`description\`; agents use it to decide when to load the skill`)]),
    ...(typeof description === "string" && description.length > 1024
      ? [error("", `${file} \`description\` is ${description.length} characters; the limit is 1024`)]
      : []),
    ...[...fields.keys()]
      .filter((key) => !FIELDS.has(key))
      .map((key) => warning("", `${file} frontmatter field \`${key}\` is not in the Agent Skills specification`)),
  ]
}

function parseYaml(block: string): { data: unknown } | { problem: string } {
  try {
    const data: unknown = Bun.YAML.parse(block)
    return { data }
  } catch (cause) {
    return { problem: cause instanceof Error ? cause.message : String(cause) }
  }
}
