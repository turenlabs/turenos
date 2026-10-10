// Package-script commands (`bun run generate`) must be defined by the package they run from.

import path from "node:path"
import { error, warning, type Finding } from "./findings"
import { codeSpans } from "./markdown"
import { hasFileExt } from "./paths"
import { ancestorDirs, type Repo } from "./repo"

const BUILTINS = new Set(
  "add build create exec init install i link outdated patch pm publish remove rm run test unlink update upgrade x audit info why repl".split(
    " ",
  ),
)

type Command = { tool: string; name: string; cwd?: string; mentioned: string[] }

// A paragraph is the context for a command: "Run it in `packages/x`" often sits on the line before it.
export function commandFindings(repo: Repo, file: string, text: string): Finding[] {
  return commands(text.split(/\n\s*\n/)).flatMap((command) => commandFinding(repo, file, command))
}

function commandFinding(repo: Repo, file: string, command: Command): Finding[] {
  const start = command.cwd ?? path.posix.dirname(file)
  const nearest = [start, ...ancestorDirs(start)].find((dir) => repo.scripts.has(dir))
  if (nearest !== undefined && repo.scripts.get(nearest)?.has(command.name)) return []
  // "run `bun run generate` from `packages/client`": a package named in the same paragraph is where it runs.
  if (command.mentioned.some((dir) => repo.scripts.get(dir)?.has(command.name))) return []
  const defined = [...repo.scripts].filter((entry) => entry[1].has(command.name)).map((entry) => entry[0])
  const label = `\`${command.tool} run ${command.name}\``
  if (defined.length === 0)
    return [error(file, `${label}: no package.json in the repo defines a \`${command.name}\` script`)]
  return [
    warning(
      file,
      `${label}: not defined in ${nearest ?? "."}/package.json; defined in ${defined
        .slice(0, 3)
        .map((dir) => `${dir}/package.json`)
        .join(", ")}. Say which package to run it from`,
    ),
  ]
}

// Package-script invocations per paragraph, with any `--cwd` and the backticked folders the paragraph mentions.
function commands(paragraphs: string[]): Command[] {
  return paragraphs.flatMap((snippet) =>
    [
      ...snippet.matchAll(
        /\b(npm|pnpm|yarn|bun)\s+((?:--cwd[= ]\S+\s+)?)(run\s+)?((?:--cwd[= ]\S+\s+)?)([A-Za-z0-9][\w:.-]*)/g,
      ),
    ].flatMap((match) => {
      const tool = match[1] ?? ""
      const name = match[5] ?? ""
      const explicit = match[3] !== undefined
      const cwd = (match[2] || match[4] || "").replace(/^--cwd[= ]/, "").trim() || undefined
      if (name === "run" || (!explicit && (BUILTINS.has(name) || tool === "npm"))) return []
      const mentioned = codeSpans(snippet)
        .map((span) => span.replace(/^\.\//, "").replace(/\/+$/, ""))
        .flatMap((span) => (hasFileExt(span) ? [span, path.posix.dirname(span)] : [span]))
      return [{ tool, name, cwd: cwd?.replace(/^\.\//, "").replace(/\/$/, ""), mentioned }]
    }),
  )
}
