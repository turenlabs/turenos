import path from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { error, warning, type Finding } from "./findings"
import { VENDORED, type Repo } from "./repo"

// Claude Code reads CLAUDE.md, never AGENTS.md, so the root needs a CLAUDE.md that imports it. Every CLAUDE.md is a
// one-line shim: rules written only there would reach Claude Code and no other agent.
export function claudeFindings(repo: Repo): Finding[] {
  const shims = repo.instructionFiles.filter(
    (file) => path.posix.basename(file) === "CLAUDE.md" && !VENDORED.test(file),
  )
  return [
    ...(repo.texts.has("AGENTS.md") && !shims.includes("CLAUDE.md")
      ? [
          error(
            "",
            "no root CLAUDE.md: Claude Code reads CLAUDE.md, not AGENTS.md, so it loads none of these rules. Add a CLAUDE.md containing only `@AGENTS.md`",
          ),
        ]
      : []),
    ...shims.flatMap((claude) => shimFindings(repo, claude)),
  ]
}

function shimFindings(repo: Repo, claude: string): Finding[] {
  const text = readFileSync(path.join(repo.root, claude), "utf8")
  const sibling = claude === "CLAUDE.md" ? "AGENTS.md" : `${path.posix.dirname(claude)}/AGENTS.md`
  const extra = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "@AGENTS.md")
  return [
    ...(/^\s*@AGENTS\.md\s*$/m.test(text) && existsSync(path.join(repo.root, sibling))
      ? []
      : [
          error(
            "",
            `${claude} does not import a sibling AGENTS.md: Claude Code sessions in ${path.posix.dirname(claude)}/ miss those rules. Make it contain only \`@AGENTS.md\`, next to an AGENTS.md`,
          ),
        ]),
    ...(extra.length > 0
      ? [
          warning(
            "",
            `${claude} has ${extra.length} lines besides \`@AGENTS.md\`; only Claude Code reads them. Move them into ${sibling}`,
          ),
        ]
      : []),
  ]
}
