// Rules about links: every link and anchor inside docs/ resolves, every page is reachable from docs/README.md, and
// every pointer into docs/ from Markdown elsewhere in the repository resolves.

import path from "node:path"
import { existsSync, readFileSync, statSync } from "node:fs"
import type { Docs } from "./docs"
import { error, warning, type Finding } from "./findings"
import { listed } from "./git"
import { anchors, isPage, linkTargets, stripCode } from "./markdown"

export function linkFindings(docs: Docs): Finding[] {
  const resolved = [...docs.pages].flatMap(([file, text]) =>
    [...new Set(linkTargets(stripCode(text)))].map((target) => ({ file, result: resolveLink(docs, file, target) })),
  )
  const edges = new Map(
    [...docs.pages.keys()].map((file) => [
      file,
      resolved.filter((link) => link.file === file && link.result.page).map((link) => link.result.page ?? ""),
    ]),
  )
  const reachable = walk("README.md", edges)
  return [
    ...resolved.flatMap((link) => (link.result.finding ? [link.result.finding] : [])),
    ...(docs.pages.has("README.md")
      ? [...docs.pages.keys()]
          .filter((file) => !reachable.has(file))
          .map((file) => warning(`orphan page, not reachable from docs/README.md: ${file}`))
      : []),
  ]
}

// Markdown outside docs/ (READMEs, AGENTS.md, CONTRIBUTING.md, skills) points into it. A page renamed without move.ts
// breaks those pointers silently, so resolve every one. A Markdown link resolves relative to its file, as GitHub does;
// a bare or backticked mention may also name a path from the repository root.
export function inboundFindings(docs: Docs): Finding[] {
  const root = docs.root
  const home = docs.home
  if (root === undefined || home === undefined) return []
  // .forge/ holds runtime config and translation glossaries, not documentation.
  const sources = listed(root, "*.md").filter(
    (file) => !file.startsWith(`${home}/`) && !/(^|\/)(vendor|node_modules)\/|^\.forge\//.test(file),
  )
  const pattern = new RegExp(`(?<![\\w./-])((?:\\.\\.?/)*)${home}/([A-Za-z0-9_./-]*[A-Za-z0-9_/-])(#[a-z0-9_-]+)?`, "g")
  return sources.flatMap((source) =>
    // Fenced blocks hold examples, not pointers; inline code stays, since AGENTS.md cites paths that way.
    stripCode(readFileSync(path.join(root, source), "utf8"), true)
      .split("\n")
      .flatMap((line, number) =>
        [...line.matchAll(pattern)].flatMap((match) => {
          const prefix = match[1] ?? ""
          const rest = match[2] ?? ""
          const anchor = (match[3] ?? "").slice(1)
          const linked = /\]\(\s*<?$/.test(line.slice(0, match.index))
          const fromFile = path.resolve(root, path.dirname(source), `${prefix}${home}`, rest)
          const fromRoot = path.resolve(root, home, rest)
          const target = existsSync(fromFile)
            ? fromFile
            : !linked && prefix === "" && existsSync(fromRoot)
              ? fromRoot
              : undefined
          const where = `${source}:${number + 1}`
          if (target === undefined)
            return [
              error(
                `${where}: points to ${prefix}${home}/${rest}, which does not exist${linked ? " relative to this file" : ""}`,
              ),
            ]
          const page = statSync(target).isDirectory() ? path.join(target, "README.md") : target
          if (anchor && isPage(page) && existsSync(page) && !anchors(readFileSync(page, "utf8")).has(anchor)) {
            return [error(`${where}: points to ${home}/${rest}#${anchor}, which has no such heading`)]
          }
          return []
        }),
      ),
  )
}

// Resolves one link from a page, returning the docs page it reaches (for the reachability walk) and any finding.
function resolveLink(docs: Docs, file: string, target: string): { page?: string; finding?: Finding } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return {}
  if (target.startsWith("/")) return { finding: warning(`${file}: site-root link can't be checked offline: ${target}`) }
  const hash = target.indexOf("#")
  const linkPath = decode(hash === -1 ? target : target.slice(0, hash))
  if (linkPath === undefined) return { finding: error(`${file}: malformed percent-encoding in link: ${target}`) }
  const anchor = hash === -1 ? "" : target.slice(hash + 1).toLowerCase()
  const absolute = linkPath
    ? path.resolve(path.dirname(path.join(docs.dir, file)), linkPath)
    : path.join(docs.dir, file)
  if (!existsSync(absolute)) return { finding: error(`${file}: broken link: ${target}`) }
  const readmeOfFolder = path.join(absolute, "README.md")
  const destination = statSync(absolute).isDirectory() && existsSync(readmeOfFolder) ? readmeOfFolder : absolute
  if (!isPage(destination)) return {}
  const page = path.relative(docs.dir, destination).split(path.sep).join("/")
  const inside = page.startsWith("..") ? undefined : page
  if (anchor && !anchors(docs.pages.get(page) ?? readFileSync(destination, "utf8")).has(anchor)) {
    return { page: inside, finding: error(`${file}: broken anchor: ${target}`) }
  }
  return { page: inside }
}

function decode(link: string) {
  // decodeURIComponent throws on a stray %, which would otherwise abort the whole run.
  try {
    return decodeURIComponent(link)
  } catch {
    return undefined
  }
}

function walk(start: string, edges: Map<string, string[]>) {
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    ;(edges.get(queue.shift() ?? "") ?? [])
      .filter((next) => !seen.has(next))
      .forEach((next) => {
        seen.add(next)
        queue.push(next)
      })
  }
  return seen
}
