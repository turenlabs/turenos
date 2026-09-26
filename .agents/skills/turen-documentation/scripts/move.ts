#!/usr/bin/env bun
// Moves docs pages and rewrites every link the moves would break.
//
// The moves file has one `old -> new` line per move, both relative to the docs directory. A target may leave docs/
// (`old-mock/index.html -> ../mockups/old-mock.html`). Blank lines and lines starting with # are ignored.
//
// Every move is checked before anything changes: each source is a regular file, no two moves share a target (ignoring
// letter case), targets don't exist yet, and nothing lands outside the repository. Without --apply it prints the plan
// and changes nothing. With --apply it:
//   1. moves each file with `git mv` when it is tracked, so history follows it, and removes folders the moves emptied
//   2. rewrites relative links (inline, reference-style, HTML src/href) in every Markdown file under docs/, from both
//      the linking file's and the target's new locations, keeping ./ style and #anchors, and updates link labels
//      and backticked mentions that spelled out the old path
//   3. rewrites `docs/<old>` references in Markdown outside docs/ (README.md, CONTRIBUTING.md, package READMEs, ...)
// Symlinked Markdown files are never written through.
// References in code, scripts and config are listed for review, never edited. Links that were already broken are
// reported and left alone.
//
// usage: bun .agents/skills/turen-documentation/scripts/move.ts <moves-file> [--docs docs] [--apply]

import path from "node:path"
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync } from "node:fs"
import { git, listed } from "./lib/git"
import { fenced, isPage, REWRITABLE_LINK } from "./lib/markdown"

const args = process.argv.slice(2)
const docsIndex = args.indexOf("--docs")
const docs = path.resolve(docsIndex === -1 ? "docs" : (args[docsIndex + 1] ?? "docs"))
const mapFile = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--docs")
if (!mapFile) {
  console.error("usage: bun move.ts <moves-file> [--docs docs] [--apply]")
  process.exit(2)
}
const root = git(docs, "rev-parse", "--show-toplevel") ?? path.dirname(docs)
// The docs folder as the repository names it, usually "docs".
const home = path.relative(root, docs).split(path.sep).join("/")
// Match a complete relative docs/ path, not a docs/ suffix inside an area path such as tools/foo/docs/.
const INBOUND = new RegExp(
  `(?<![A-Za-z0-9_./-])((?:\\.\\.?/)*)${home.replaceAll(".", "\\.")}/([A-Za-z0-9/_.-]+(?:#[A-Za-z0-9_-]+)?)`,
  "g",
)
const moves = await readMoves(mapFile)
// A moved README.md carries its folder with it, so links to the old folder follow too.
const folders = new Map(
  [...moves]
    .filter(([from, to]) => path.basename(from) === "README.md" && path.basename(to) === "README.md")
    .map(([from, to]) => [path.dirname(from), path.dirname(to)]),
)

const docsEdits = await Promise.all(
  // Pages moving in from outside docs/ need their links rewritten for their new home too.
  [...new Set([...(await markdownUnder(docs)), ...[...moves.keys()].filter(isPage)])].map(async (file) => ({
    file,
    ...rewriteDocsPage(await Bun.file(file).text(), file),
  })),
)
const inboundEdits = await Promise.all(
  outsideMarkdown()
    .filter((file) => !moves.has(file))
    .map(async (file) => ({ file, dead: [], ...rewriteInbound(await Bun.file(file).text(), file) })),
)
const edits = [...docsEdits, ...inboundEdits].filter((edit) => edit.count > 0)
const broken = docsEdits.flatMap((edit) => edit.dead.map((target) => `${path.relative(root, edit.file)}: ${target}`))
const manual = [...moves.keys()].flatMap((from) =>
  (git(root, "grep", "--untracked", "-n", "-F", path.relative(root, from), "--", ".", ":!*.md", `:!${home}/`) ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, 160)),
)

console.log(
  `${moves.size} moves, ${edits.reduce((sum, edit) => sum + edit.count, 0)} links rewritten in ${edits.length} files`,
)
moves.forEach((to, from) => console.log(`  move ${path.relative(root, from)} -> ${path.relative(root, to)}`))
edits.forEach((edit) => console.log(`  edit ${path.relative(root, edit.file)} (${edit.count} links)`))
if (broken.length > 0)
  console.log(["already broken before the move (left alone):", ...broken.map((line) => `  ${line}`)].join("\n"))
if (manual.length > 0)
  console.log(["references outside Markdown to update by hand:", ...manual.map((line) => `  ${line}`)].join("\n"))
if (!args.includes("--apply")) {
  console.log("dry run: nothing changed. Re-run with --apply.")
  process.exit(0)
}

moves.forEach((to, from) => {
  mkdirSync(path.dirname(to), { recursive: true })
  const tracked = git(root, "ls-files", "--error-unmatch", from) !== undefined
  if (!tracked) {
    renameSync(from, to)
    return
  }
  // Never fall back to a plain rename: it would overwrite whatever made git refuse.
  if (git(root, "mv", from, to) === undefined)
    throw new Error(`git mv ${from} ${to} failed; nothing after it was applied`)
})
moves.forEach((_, from) => removeEmptyParents(path.dirname(from)))
// Edits were computed against each page's old location; a moved page is written where it now lives.
await Promise.all(edits.map((edit) => Bun.write(moves.get(edit.file) ?? edit.file, edit.text)))
console.log("applied. Next: run check.ts and fix what it reports.")

// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
async function readMoves(file: string): Promise<Map<string, string>> {
  const lines = (await Bun.file(file).text()).split("\n").map((line) => line.trim())
  const entries = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.length > 0 && !entry.line.startsWith("#"))
  const realRoot = realpathSync(root)
  const pairs = entries.map((entry) => {
    const where = `${file}:${entry.number}`
    const sides = entry.line.split("->").map((side) => side.trim().replaceAll("`", ""))
    if (sides.length !== 2 || !sides[0] || !sides[1]) throw new Error(`${where}: expected "old -> new"`)
    const from = path.resolve(docs, sides[0])
    const to = path.resolve(docs, sides[1])
    if (!existsSync(from) || !lstatSync(from).isFile()) {
      throw new Error(`${where}: ${from} is not a file; move a folder's pages one by one, README.md included`)
    }
    // A case-only rename on a case-insensitive filesystem finds the source itself at the target.
    const renamingCase = existsSync(to) && statSync(to).ino === statSync(from).ino && to !== from
    if (existsSync(to) && !renamingCase) throw new Error(`${where}: target already exists: ${to}`)
    // The nearest existing folder, resolved through symlinks, is where the new file really lands.
    const landing = nearestExisting(path.dirname(to))
    if (!statSync(landing).isDirectory()) throw new Error(`${where}: ${landing} is a file, so ${to} can't be created`)
    ;[realpathSync(path.dirname(from)), realpathSync(landing)].forEach((folder) => {
      if (folder !== realRoot && !folder.startsWith(realRoot + path.sep)) {
        throw new Error(`${where}: ${folder} is outside the repository ${realRoot}`)
      }
    })
    return [from, to] as const
  })
  const repeated = (values: string[]) => values.find((value, index) => values.indexOf(value) !== index)
  const source = repeated(pairs.map((pair) => pair[0]))
  if (source) throw new Error(`${file}: ${source} is listed twice`)
  // Compared without case, since macOS would put both moves on the same file.
  const target = repeated(pairs.map((pair) => pair[1].toLowerCase()))
  if (target) throw new Error(`${file}: two moves target ${target}`)
  return new Map(pairs)
}

function nearestExisting(folder: string): string {
  return existsSync(folder) || path.dirname(folder) === folder ? folder : nearestExisting(path.dirname(folder))
}

function rewriteDocsPage(text: string, file: string) {
  const home = path.dirname(moves.get(file) ?? file)
  const dead: string[] = []
  const renamed = new Map<string, string>()
  const counter = { links: 0 }
  const linked = outsideCode(
    text,
    (chunk) =>
      chunk.replace(REWRITABLE_LINK, (whole, prefix: string, target: string) => {
        if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole
        const hash = target.indexOf("#")
        const linkPath = decode(hash === -1 ? target : target.slice(0, hash))
        const anchor = hash === -1 ? "" : target.slice(hash)
        if (linkPath === undefined) {
          dead.push(target)
          return whole
        }
        const from = path.resolve(path.dirname(file), linkPath)
        if (!existsSync(from)) {
          dead.push(target)
          return whole
        }
        const to = moves.get(from) ?? folders.get(from) ?? from
        const relative = path.relative(home, to).split(path.sep).join("/")
        // TurenOS writes every same- or child-folder link as ./path.
        const styled = encode(relative === "" ? "./" : relative.startsWith("../") ? relative : `./${relative}`)
        const rewritten = (linkPath.endsWith("/") && !styled.endsWith("/") ? `${styled}/` : styled) + anchor
        if (rewritten === target) return whole
        renamed.set(target, rewritten)
        counter.links += 1
        return prefix + rewritten
      }),
    false,
  )
  // A label that spelled out the old target, as in [`../x.md`](../x.md), follows the link.
  const relabeled = [...renamed].reduce(
    (current, [from, to]) => current.replaceAll(`[\`${from}\`](${to})`, `[\`${to}\`](${to})`),
    linked,
  )
  // Backticked repo paths of moved files, as in [`docs/memory.md`](...), name the new location. Fenced examples stay.
  const mentions = [...moves].map(
    ([from, to]) => [`\`${path.relative(root, from)}\``, `\`${path.relative(root, to)}\``] as const,
  )
  const mentionCount = { value: 0 }
  const mentioned = outsideCode(
    relabeled,
    (chunk) =>
      mentions.reduce((current, [from, to]) => {
        mentionCount.value += current.split(from).length - 1
        return current.replaceAll(from, to)
      }, chunk),
    true,
  )
  return { text: mentioned, count: counter.links + mentionCount.value, dead }
}

function rewriteInbound(text: string, file: string) {
  const counter = { count: 0 }
  const updated = outsideCode(
    text,
    (chunk) =>
      chunk.replace(INBOUND, (whole, prefix: string, rest: string) => {
        const hash = rest.indexOf("#")
        const linkPath = hash === -1 ? rest : rest.slice(0, hash)
        const anchor = hash === -1 ? "" : rest.slice(hash)
        const relativeToFile = path.resolve(path.dirname(file), `${prefix}${home}`, linkPath)
        const relativeToRoot = path.resolve(root, home, linkPath)
        const base = moves.has(relativeToFile)
          ? path.dirname(file)
          : prefix === "" && moves.has(relativeToRoot)
            ? root
            : undefined
        if (base === undefined) return whole
        counter.count += 1
        const from = base === root ? relativeToRoot : relativeToFile
        return (
          path
            .relative(base, moves.get(from) ?? from)
            .split(path.sep)
            .join("/") + anchor
        )
      }),
    true,
  )
  return { text: updated, count: counter.count }
}

// Applies transform outside fenced code blocks, and outside inline code unless keepSpans is set.
function outsideCode(text: string, transform: (chunk: string) => string, keepSpans: boolean) {
  const lines = text.split(/(?<=\n)/)
  const inside = fenced(lines)
  // Consecutive prose lines are transformed together, so a link that wraps across lines still matches.
  const result = lines.reduce<{ out: string[]; prose: string }>(
    (state, line, index) =>
      inside[index]
        ? { out: [...state.out, spans(state.prose, transform, keepSpans), line], prose: "" }
        : { out: state.out, prose: state.prose + line },
    { out: [], prose: "" },
  )
  return [...result.out, spans(result.prose, transform, keepSpans)].join("")
}

function spans(chunk: string, transform: (chunk: string) => string, keepSpans: boolean) {
  if (keepSpans) return transform(chunk)
  return chunk
    .split(/(`[^`\n]*`)/)
    .map((part) => (part.startsWith("`") ? part : transform(part)))
    .join("")
}

async function markdownUnder(folder: string) {
  const found = await Array.fromAsync(new Bun.Glob("**/*.{md,mdx}").scan({ cwd: folder, onlyFiles: true }))
  return found
    .filter((file) => !file.split(path.sep).includes("node_modules"))
    .map((file) => path.join(folder, file))
    .filter((file) => lstatSync(file).isFile())
}

function outsideMarkdown() {
  // Tracked and new, unignored files, so pages added in the same change are rewritten too.
  return listed(root, "*.md")
    .filter((file) => !file.includes("node_modules/") && !file.includes("/vendor/"))
    .map((file) => path.join(root, file))
    .filter((file) => !file.startsWith(docs + path.sep) && lstatSync(file).isFile())
}

// Removes the folder a moved file left behind, and its parents, while they are empty and inside docs/. Folders that
// were already empty elsewhere, and symlinks, are left alone.
function removeEmptyParents(folder: string) {
  if (!folder.startsWith(docs + path.sep) || !existsSync(folder) || !lstatSync(folder).isDirectory()) return
  if (readdirSync(folder).length > 0) return
  rmdirSync(folder)
  removeEmptyParents(path.dirname(folder))
}

function decode(link: string) {
  // decodeURIComponent throws on a stray %; such a link is reported as already broken.
  try {
    return decodeURIComponent(link)
  } catch {
    return undefined
  }
}

// Escapes the characters a Markdown link target can't hold bare.
function encode(link: string) {
  return link.replace(/[\s()<>%]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
}
