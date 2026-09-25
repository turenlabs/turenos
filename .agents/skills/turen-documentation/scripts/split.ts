#!/usr/bin/env bun
// Splits `##` sections out of a docs page into sibling pages in the same folder, and rewrites every link to their
// anchors. Use it after move.ts has turned a long page into a folder (`page.md -> page/README.md`), so extracted
// sections keep their relative links unchanged.
//
// Each --into starts a new page: its file name, its title, and one or more `##` section headings (exact text) to move
// there, in order. A page with one section whose title equals the heading uses that heading as its `#` title and
// promotes its subsections by one level, so anchors keep their slugs. The source page keeps a short `##` stub linking
// the new page where the first moved section was.
//
// Without --apply it prints the plan. With --apply it writes the pages, then rewrites `page#anchor` links in every
// Markdown file in the repository (and same-page `#anchor` links on both sides) to point at the page that now holds
// the anchor.
//
// usage: bun .agents/skills/turen-documentation/scripts/split.ts <page.md> --into <file.md> --title "<Title>"
//          --section "<Heading>" [--section ...] [--into ...] [--apply]

import path from "node:path"
import { existsSync } from "node:fs"

type Group = { file: string; title: string; sections: string[] }

const LINK = /(\]\(\s*<?|^\s*\[[^\]]+\]:\s*<?|(?:href|src)=")([^)\s>"]+)/gm

const args = process.argv.slice(2)
const page = path.resolve(args[0] ?? "")
if (!args[0] || !existsSync(page)) {
  console.error("usage: bun split.ts <page.md> --into <file.md> --title <Title> --section <Heading> [...] [--apply]")
  process.exit(2)
}
const groups = parseGroups(args.slice(1))
const folder = path.dirname(page)
const root = git(folder, "rev-parse", "--show-toplevel") ?? folder
const blocks = splitBlocks(await Bun.file(page).text())
const moved = new Map(groups.flatMap((group) => group.sections.map((heading) => [heading, group] as const)))
const missing = [...moved.keys()].filter(
  (heading) => !blocks.some((block) => block.level === 2 && block.heading === heading),
)
if (missing.length > 0) throw new Error(`no "## " section named: ${missing.join(", ")}`)
groups.forEach((group) => {
  if (existsSync(path.join(folder, group.file))) throw new Error(`target already exists: ${group.file}`)
})

// Each `##` block owns the `###`+ blocks after it; they move together.
const owned = blocks.map((block, index) => {
  if (block.level !== 2) return undefined
  const end = blocks.findIndex((next, at) => at > index && next.level <= 2)
  return { index, end: end === -1 ? blocks.length : end }
})
const ownerOf = (index: number) =>
  owned.find((range) => range !== undefined && index >= range.index && index < range.end)
const groupOf = (index: number) => {
  const range = ownerOf(index)
  return range === undefined ? undefined : moved.get(blocks[range.index]?.heading ?? "")
}

// Anchor slug -> the file that holds it after the split.
const slugs = headingSlugs(blocks.map((block) => block.heading))
const anchorHome = new Map(
  blocks.map((block, index) => [slugs[index] ?? "", groupOf(index)?.file ?? path.basename(page)]),
)

const kept = blocks.flatMap((block, index) => {
  const group = groupOf(index)
  if (group === undefined) return [block.lines.join("\n")]
  const first = blocks.findIndex((candidate, at) => groupOf(at) === group)
  if (index !== first) return []
  return [`## ${group.title}\n\nSee [${group.title}](./${group.file}).\n`]
})
const pages = groups.map((group) => ({ group, text: renderGroup(group) }))

console.log(`split ${path.relative(root, page)} into ${groups.length} pages`)
groups.forEach((group) => console.log(`  ${group.file}: ${group.sections.join(" + ")}`))
if (!args.includes("--apply")) {
  console.log("dry run: nothing changed. Re-run with --apply.")
  process.exit(0)
}

await Bun.write(page, relink(kept.join("\n").replace(/\n{3,}/g, "\n\n"), page))
await Promise.all(
  pages.map((entry) =>
    Bun.write(path.join(folder, entry.group.file), relink(entry.text, path.join(folder, entry.group.file))),
  ),
)
const others = (git(root, "ls-files", "*.md") ?? "")
  .split("\n")
  .filter((file) => file.length > 0)
  .map((file) => path.join(root, file))
  .filter((file) => file !== page)
const updated = await Promise.all(
  others.map(async (file) => {
    const text = await Bun.file(file).text()
    const next = relink(text, file)
    if (next === text) return undefined
    await Bun.write(file, next)
    return path.relative(root, file)
  }),
)
const touched = updated.filter((file) => file !== undefined)
console.log(
  `applied. Rewrote anchor links in ${touched.length} other files${touched.length > 0 ? `: ${touched.join(", ")}` : ""}`,
)

function renderGroup(group: Group) {
  const members = blocks.filter((_, index) => groupOf(index) === group)
  const single = group.sections.length === 1 && group.sections[0] === group.title
  if (!single)
    return `# ${group.title}\n\n${members.map((block) => block.lines.join("\n")).join("\n")}`.trimEnd() + "\n"
  // One section titled like its heading: it becomes the page title and its subsections move up a level.
  const body = members
    .map((block, at) =>
      at === 0
        ? block.lines.slice(1).join("\n")
        : [`${"#".repeat(block.level - 1)} ${block.heading}`, ...block.lines.slice(1)].join("\n"),
    )
    .join("\n")
  return `# ${group.title}\n${body}`.trimEnd() + "\n"
}

// Points links at whichever file holds their anchor now: `page#a` from elsewhere, and `#a` within the split pages.
function relink(text: string, file: string) {
  const self = path.resolve(file)
  return text.replace(LINK, (whole, prefix: string, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole
    const hash = target.indexOf("#")
    if (hash === -1) return whole
    const linkPath = target.slice(0, hash)
    const anchor = target.slice(hash + 1)
    const destination = linkPath === "" ? self : path.resolve(path.dirname(file), linkPath)
    const splitFiles = [page, ...groups.map((group) => path.join(folder, group.file))]
    if (!splitFiles.includes(destination)) return whole
    const home = anchorHome.get(anchor.toLowerCase())
    if (home === undefined) return whole
    const holder = path.join(folder, home)
    if (holder === destination) return whole
    const relative = path.relative(path.dirname(file), holder).split(path.sep).join("/")
    return `${prefix}${relative.startsWith("../") ? relative : `./${relative}`}#${anchor}`
  })
}

function splitBlocks(text: string) {
  const lines = text.split("\n")
  const fenced = lines.map(
    (_, index) => lines.slice(0, index).filter((line) => /^\s*(```|~~~)/.test(line)).length % 2 === 1,
  )
  const starts = lines
    .map((line, index) => ({ match: /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line), index }))
    .filter((entry) => entry.match !== null && !fenced[entry.index])
  return [
    { heading: "", level: 0, lines: lines.slice(0, starts[0]?.index ?? lines.length) },
    ...starts.map((entry, at) => ({
      heading: entry.match?.[2] ?? "",
      level: entry.match?.[1]?.length ?? 0,
      lines: lines.slice(entry.index, starts[at + 1]?.index ?? lines.length),
    })),
  ].filter((block) => block.level > 0 || block.lines.some((line) => line.trim() !== ""))
}

// GitHub heading slugs, with -1, -2 suffixes for repeated headings.
function headingSlugs(headings: string[]) {
  const counts = new Map<string, number>()
  return headings.map((heading) => {
    const slug = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replaceAll("`", "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replaceAll(" ", "-")
    const seen = counts.get(slug) ?? 0
    counts.set(slug, seen + 1)
    return seen === 0 ? slug : `${slug}-${seen}`
  })
}

function parseGroups(rest: string[]): Group[] {
  const flags = rest.filter((arg) => arg !== "--apply")
  return flags.reduce<Group[]>((found, arg, index) => {
    const value = flags[index + 1] ?? ""
    if (arg === "--into") return [...found, { file: value, title: "", sections: [] }]
    const last = found.at(-1)
    if (last === undefined) return found
    if (arg === "--title") return [...found.slice(0, -1), { ...last, title: value }]
    if (arg === "--section") return [...found.slice(0, -1), { ...last, sections: [...last.sections, value] }]
    return found
  }, [])
}

// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
function git(cwd: string, ...command: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...command], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}
