#!/usr/bin/env bun
// Moves docs pages and rewrites every link the moves would break.
//
// The moves file has one `old -> new` line per move, both relative to the docs directory. A target may leave docs/
// (`old-mock/index.html -> ../mockups/old-mock.html`). Blank lines and lines starting with # are ignored.
//
// Without --apply it prints the plan and changes nothing. With --apply it:
//   1. rewrites relative links (inline, reference-style, HTML src/href) in every Markdown file under docs/, from both
//      the linking file's and the target's new locations, keeping ./ style and #anchors, and updates link labels
//      and backticked mentions that spelled out the old path
//   2. rewrites `docs/<old>` references in Markdown outside docs/ (README.md, CONTRIBUTING.md, package READMEs, ...)
//   3. moves each file with `git mv` when it is tracked, so history follows it
// References in code, scripts and config are listed for review, never edited. Links that were already broken are
// reported and left alone.
//
// usage: bun .agents/skills/turen-documentation/scripts/move.ts <moves-file> [--docs docs] [--apply]

import path from "node:path"
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs"

const LINK = /(\]\(\s*<?|^\s*\[[^\]]+\]:\s*<?|(?:href|src)=")([^)\s>"]+)/gm
const INBOUND = /(?<![A-Za-z0-9_.-])((?:\.\.\/)*)docs\/([A-Za-z0-9/_.-]+(?:#[A-Za-z0-9_-]+)?)/g

const args = process.argv.slice(2)
const docsIndex = args.indexOf("--docs")
const docs = path.resolve(docsIndex === -1 ? "docs" : (args[docsIndex + 1] ?? "docs"))
const mapFile = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--docs")
if (!mapFile) {
  console.error("usage: bun move.ts <moves-file> [--docs docs] [--apply]")
  process.exit(2)
}
const root = git(docs, "rev-parse", "--show-toplevel") ?? path.dirname(docs)
const moves = await readMoves(mapFile)
// A moved README.md carries its folder with it, so links to the old folder follow too.
const folders = new Map(
  [...moves]
    .filter(([from, to]) => path.basename(from) === "README.md" && path.basename(to) === "README.md")
    .map(([from, to]) => [path.dirname(from), path.dirname(to)]),
)

const docsEdits = await Promise.all(
  (await markdownUnder(docs)).map(async (file) => ({ file, ...rewriteDocsPage(await Bun.file(file).text(), file) })),
)
const inboundEdits = await Promise.all(
  outsideMarkdown().map(async (file) => ({ file, dead: [], ...rewriteInbound(await Bun.file(file).text(), file) })),
)
const edits = [...docsEdits, ...inboundEdits].filter((edit) => edit.count > 0)
const broken = docsEdits.flatMap((edit) => edit.dead.map((target) => `${path.relative(root, edit.file)}: ${target}`))
const manual = [...moves.keys()].flatMap((from) =>
  (git(root, "grep", "-n", "-F", path.relative(root, from), "--", ".", ":!*.md", ":!docs/") ?? "")
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

await Promise.all(edits.map((edit) => Bun.write(edit.file, edit.text)))
moves.forEach((to, from) => {
  mkdirSync(path.dirname(to), { recursive: true })
  const tracked = git(root, "ls-files", "--error-unmatch", from) !== undefined
  if (tracked && git(root, "mv", from, to) !== undefined) return
  renameSync(from, to)
})
removeEmptyFolders(docs)
console.log("applied. Next: run check.ts and fix what it reports.")

async function readMoves(file: string) {
  const lines = (await Bun.file(file).text()).split("\n").map((line) => line.trim())
  const entries = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.length > 0 && !entry.line.startsWith("#"))
  const invalid = entries.find((entry) => !entry.line.includes("->"))
  if (invalid) throw new Error(`${file}:${invalid.number}: expected "old -> new"`)
  const pairs = entries.map((entry) => {
    const sides = entry.line.split("->").map((side) => path.resolve(docs, side.trim().replaceAll("`", "")))
    const from = sides[0] ?? ""
    const to = sides[1] ?? ""
    if (!existsSync(from)) throw new Error(`${file}:${entry.number}: no such file: ${from}`)
    if (existsSync(to)) throw new Error(`${file}:${entry.number}: target already exists: ${to}`)
    return [from, to] as const
  })
  return new Map(pairs)
}

function rewriteDocsPage(text: string, file: string) {
  const home = path.dirname(moves.get(file) ?? file)
  const dead: string[] = []
  const renamed = new Map<string, string>()
  const counter = { links: 0 }
  const linked = outsideCode(
    text,
    (chunk) =>
      chunk.replace(LINK, (whole, prefix: string, target: string) => {
        if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole
        const hash = target.indexOf("#")
        const linkPath = hash === -1 ? target : target.slice(0, hash)
        const anchor = hash === -1 ? "" : target.slice(hash)
        const from = path.resolve(path.dirname(file), linkPath)
        if (!existsSync(from)) {
          dead.push(target)
          return whole
        }
        const to = moves.get(from) ?? folders.get(from) ?? from
        const relative = path.relative(home, to).split(path.sep).join("/")
        // TurenOS writes every same- or child-folder link as ./path.
        const styled = relative === "" ? "./" : relative.startsWith("../") ? relative : `./${relative}`
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
  // Backticked repo paths of moved files, as in [`docs/memory.md`](...), name the new location.
  const mentions = [...moves].map(
    ([from, to]) => [`\`${path.relative(root, from)}\``, `\`${path.relative(root, to)}\``] as const,
  )
  const mentioned = mentions.reduce((current, [from, to]) => current.replaceAll(from, to), relabeled)
  const mentionCount = mentions.reduce((sum, [from]) => sum + relabeled.split(from).length - 1, 0)
  return { text: mentioned, count: counter.links + mentionCount, dead }
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
        const relativeToFile = path.resolve(path.dirname(file), `${prefix}docs`, linkPath)
        const relativeToRoot = path.resolve(root, "docs", linkPath)
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
  const result = lines.reduce<{ out: string[]; prose: string[]; fence?: string }>(
    (state, line) => {
      const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]
      if (marker && state.fence === undefined) {
        return {
          out: [...state.out, spans(state.prose.join(""), transform, keepSpans), line],
          prose: [],
          fence: marker,
        }
      }
      if (marker && state.fence !== undefined && marker[0] === state.fence[0]) {
        return { out: [...state.out, line], prose: [], fence: undefined }
      }
      if (state.fence !== undefined) return { ...state, out: [...state.out, line] }
      return { ...state, prose: [...state.prose, line] }
    },
    { out: [], prose: [] },
  )
  return [...result.out, spans(result.prose.join(""), transform, keepSpans)].join("")
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
  return found.filter((file) => !file.split(path.sep).includes("node_modules")).map((file) => path.join(folder, file))
}

function outsideMarkdown() {
  const listed = git(root, "ls-files", "*.md")
  if (listed === undefined) return []
  return listed
    .split("\n")
    .filter((file) => file.length > 0 && !file.includes("node_modules/") && !file.includes("/vendor/"))
    .map((file) => path.join(root, file))
    .filter((file) => !file.startsWith(docs + path.sep) && existsSync(file))
}

function removeEmptyFolders(folder: string) {
  readdirSync(folder)
    .map((entry) => path.join(folder, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .forEach(removeEmptyFolders)
  if (folder !== docs && readdirSync(folder).length === 0) rmdirSync(folder)
}

function git(cwd: string, ...command: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...command], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}
