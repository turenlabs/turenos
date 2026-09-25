#!/usr/bin/env bun
// Audits the repository's AGENTS.md files, the instructions coding agents load while developing TurenOS.
// Checks what a script can prove: load budget per directory chain, references from ancestors, size, stray @mentions,
// backticked paths and package scripts that don't resolve, broken links, lines repeated across files, lines naming the
// upstream OpenCode product, and the CLAUDE.md shims Claude Code needs to read AGENTS.md at all. Symbols, invariants and
// gotchas still need a human read.
// Exits 1 when any error is found. Read-only.
//
// usage: bun .agents/skills/turen-context/scripts/check.ts [repo-root]

import path from "node:path"
import { existsSync, readFileSync } from "node:fs"

type Level = "error" | "warning" | "note"
type Finding = { level: Level; file: string; message: string }

// Codex stops adding instruction files once the root-to-directory chain reaches this many bytes (its default).
const CODEX_BUDGET = 32 * 1024
const LINE_GUIDANCE = 200
const VENDORED = /(^|\/)(vendor|node_modules|dist|build|third[-_]party)\//
const FILE_EXTS = new Set(
  "md mdx ts tsx js jsx mjs cjs json jsonc yaml yml toml py go rs java kt rb php cs sh sql lock txt html css scss env ini cfg conf xml gradle mod sum swift c h cc cpp hpp vue svelte proto".split(
    " ",
  ),
)
const BARE_FILES = new Set(["Makefile", "Dockerfile", "justfile", "Justfile", "Procfile", "Gemfile", "Brewfile"])
const SPECIFIER_EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".rs", "/index.ts", "/index.js"]
const BUILTINS = new Set(
  "add build create exec init install i link outdated patch pm publish remove rm run test unlink update upgrade x audit info why repl".split(
    " ",
  ),
)

const root =
  git(path.resolve(process.argv[2] ?? "."), "rev-parse", "--show-toplevel") ?? path.resolve(process.argv[2] ?? ".")
const tracked = (git(root, "ls-files", "--cached", "--others", "--exclude-standard") ?? "")
  .split("\n")
  .filter((file) => file.length > 0)
const instructionFiles = tracked.filter((file) => /(^|\/)(AGENTS|AGENTS\.override|CLAUDE)\.md$/.test(file))
const graded = instructionFiles.filter((file) => path.posix.basename(file) === "AGENTS.md" && !VENDORED.test(file))
const vendored = instructionFiles.filter((file) => VENDORED.test(file))
const texts = new Map(graded.map((file) => [file, readFileSync(path.join(root, file), "utf8")]))
const scripts = packageScripts()

const findings = [...graded.flatMap(fileFindings), ...duplicateFindings(), ...claudeFindings()]

console.log(`# AGENTS.md audit: ${graded.length} files under ${root}`)
if (vendored.length > 0) {
  console.log(`Vendored instruction files (not graded; they load for agents working in those folders):`)
  vendored.forEach((file) => console.log(`  ${file} (${chainBytes(file)} B chain)`))
}
graded.forEach((file) => {
  const own = findings.filter((finding) => finding.file === file)
  const text = texts.get(file) ?? ""
  console.log(
    `\n## ${file}: ${text.split("\n").length} lines, ${Buffer.byteLength(text)} B, chain ${chainBytes(file)} B`,
  )
  if (own.length === 0)
    console.log("- no mechanical findings; still verify symbols, invariants and gotchas by reading the code")
  own.forEach((finding) => console.log(`- ${finding.level.toUpperCase()}: ${finding.message}`))
})
const crossFile = findings.filter((finding) => finding.file === "")
if (crossFile.length > 0) {
  console.log("\n## Across files")
  crossFile.forEach((finding) => console.log(`- ${finding.level.toUpperCase()}: ${finding.message}`))
}
const count = (level: Level) => findings.filter((finding) => finding.level === level).length
console.log(`\n${count("error")} errors, ${count("warning")} warnings, ${count("note")} notes`)
process.exit(count("error") > 0 ? 1 : 0)

function fileFindings(file: string): Finding[] {
  const text = texts.get(file) ?? ""
  const prose = stripFences(text)
  const lines = text.split("\n").length
  const chain = chainBytes(file)
  const unreferenced =
    file !== "AGENTS.md" &&
    !ancestors(file).some((parent) => {
      const parentText = texts.get(parent) ?? ""
      return parentText.includes(file) || parentText.includes(path.posix.relative(path.posix.dirname(parent), file))
    })
  return [
    ...(chain > CODEX_BUDGET
      ? [
          error(
            file,
            `chain is ${chain} B, over Codex's ${CODEX_BUDGET} B budget: Codex stops adding instruction files there, so this file loads partly or not at all. Slim it, split it deeper, or move repo-wide lines to the root`,
          ),
        ]
      : chain > CODEX_BUDGET * 0.8
        ? [
            warning(
              file,
              `chain is ${chain} B, ${Math.round((chain / CODEX_BUDGET) * 100)}% of Codex's ${CODEX_BUDGET} B budget`,
            ),
          ]
        : []),
    ...(lines > LINE_GUIDANCE ? [warning(file, `${lines} lines, over the ${LINE_GUIDANCE}-line guidance`)] : []),
    ...(unreferenced
      ? [
          warning(
            file,
            `no ancestor AGENTS.md mentions \`${file}\`; Codex sessions started above this folder never load it, so add a "follow \`${file}\` when working in ${path.posix.dirname(file)}/" line to its parent`,
          ),
        ]
      : []),
    ...[...new Set(bareMentions(prose))].map((mention) =>
      warning(file, `bare \`@${mention}\` outside code: Claude Code treats it as a file import; wrap it in backticks`),
    ),
    ...[...new Set(codeSpans(prose))].flatMap((token) => pathFinding(file, token)),
    // A paragraph is the context for a command: "Run it in `packages/x`" often sits on the line before it.
    ...commands(text.split(/\n\s*\n/)).flatMap((command) => commandFinding(file, command)),
    ...[...new Set([...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? ""))]
      .filter((target) => target !== "" && !/^([a-z][a-z0-9+.-]*:|#)/i.test(target))
      .filter((target) => !existsSync(path.resolve(root, path.posix.dirname(file), target.split("#")[0] ?? "")))
      .map((target) => error(file, `broken link: ${target}`)),
    ...emphasisFindings(file, prose),
    ...upstreamFindings(file, prose),
  ]
}

// Lines inherited from OpenCode name commands, APIs and hosts that TurenOS never shipped (`opencode dev web`,
// `opencode.tools.register`). TurenOS spells its own identifiers `forge` or TurenOS, so any OpenCode name needs checking.
function upstreamFindings(file: string, prose: string): Finding[] {
  return prose
    .split("\n")
    .flatMap((line, number) =>
      /\bopencode\b/i.test(line)
        ? [
            warning(
              file,
              `line ${number + 1} names OpenCode, the upstream product; confirm the command, API or path exists in TurenOS or remove the line`,
            ),
          ]
        : [],
    )
}

function pathFinding(file: string, raw: string): Finding[] {
  const token =
    raw
      .replace(/:\d+(:\d+)?$/, "")
      .split("#")[0]
      ?.replace(/[.,;]+$/, "") ?? ""
  if (!looksLikePath(token) || token.startsWith("/") || token.startsWith("~")) return []
  if (/(^|[/._-])(foo|bar|baz|example|my|your)([/._-]|$)/i.test(token)) return []
  const clean = token.replace(/\/+$/, "")
  const stripped = clean.replace(/^(\.\.?\/)+/, "")
  const folder = path.posix.dirname(file)
  // Nested files name paths relative to their own area, so any folder from this file up to the root is a valid base.
  const bases = [folder, ...ancestorDirs(folder)].map((dir) => path.join(root, dir))
  if (clean.includes("*")) {
    const glob = new Bun.Glob(`{,**/}${stripped}`)
    return tracked.some((candidate) => glob.match(candidate))
      ? []
      : [note(file, `glob \`${token}\` matches no tracked files`)]
  }
  if (bases.some((base) => SPECIFIER_EXTS.some((ext) => existsSync(path.join(base, clean + ext))))) return []
  const hits = SPECIFIER_EXTS.map((ext) => suffixHits(stripped + ext)).find((found) => found.length > 0) ?? []
  if (hits.length > 0 && !clean.includes("/")) return []
  // Inside a nested file's own subtree, one match is unambiguous for an agent working there.
  const inScope = folder !== "." && hits.length === 1 && hits.every((hit) => hit.startsWith(`${folder}/`))
  if (inScope) return []
  if (hits.length > 0) {
    return [
      warning(
        file,
        `\`${token}\` is not relative to this file or the root; it exists at ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? " ..." : ""}. Name the package so the path is unambiguous`,
      ),
    ]
  }
  const first = stripped.split("/")[0] ?? ""
  // A missing path is only a confident finding when it names a file, is explicitly relative, or starts in an existing
  // folder beside this file. Otherwise it may be an MCP method, route, package or range such as `patches/0001-0004`.
  const strong = hasFileExt(clean) || clean !== stripped || existsSync(path.join(root, folder, first))
  return strong
    ? [error(file, `\`${token}\` does not exist`)]
    : [note(file, `\`${token}\` is not a path in this repo (a package, route, repo slug or placeholder?)`)]
}

function commandFinding(
  file: string,
  command: { tool: string; name: string; cwd?: string; mentioned: string[] },
): Finding[] {
  const start = command.cwd ?? path.posix.dirname(file)
  const nearest = [start, ...ancestorDirs(start)].find((dir) => scripts.has(dir))
  if (nearest !== undefined && scripts.get(nearest)?.has(command.name)) return []
  // "run `bun run generate` from `packages/client`": a package named in the same paragraph is where it runs.
  if (command.mentioned.some((dir) => scripts.get(dir)?.has(command.name))) return []
  const defined = [...scripts].filter((entry) => entry[1].has(command.name)).map((entry) => entry[0])
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

function emphasisFindings(file: string, prose: string): Finding[] {
  const words = [...prose.matchAll(/\b(IMPORTANT|MUST|NEVER|ALWAYS|CRITICAL|REQUIRED)\b/g)].length
  return words >= 6 ? [note(file, `${words} all-caps emphasis words; when everything is emphasized, nothing is`)] : []
}

function duplicateFindings(): Finding[] {
  const seen = new Map<string, Set<string>>()
  graded.forEach((file) =>
    stripFences(texts.get(file) ?? "")
      .split("\n")
      .map((line) =>
        line
          .replace(/^[\s>*#-]+/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((line) => line.length >= 40)
      .forEach((line) => seen.set(line, new Set([...(seen.get(line) ?? []), file]))),
  )
  return [...seen]
    .filter((entry) => entry[1].size > 1)
    .map((entry) =>
      warning(
        "",
        `repeated in ${[...entry[1]].join(", ")}: "${entry[0].slice(0, 90)}". Keep it in the deepest file where it is true`,
      ),
    )
}

// Claude Code reads CLAUDE.md, never AGENTS.md, so the root needs a CLAUDE.md that imports it. Every CLAUDE.md is a
// one-line shim: rules written only there would reach Claude Code and no other agent.
function claudeFindings(): Finding[] {
  const shims = instructionFiles.filter((file) => path.posix.basename(file) === "CLAUDE.md" && !VENDORED.test(file))
  return [
    ...(texts.has("AGENTS.md") && !shims.includes("CLAUDE.md")
      ? [
          error(
            "",
            "no root CLAUDE.md: Claude Code reads CLAUDE.md, not AGENTS.md, so it loads none of these rules. Add a CLAUDE.md containing only `@AGENTS.md`",
          ),
        ]
      : []),
    ...shims.flatMap((claude) => {
      const text = readFileSync(path.join(root, claude), "utf8")
      const sibling = claude === "CLAUDE.md" ? "AGENTS.md" : `${path.posix.dirname(claude)}/AGENTS.md`
      const extra = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line !== "@AGENTS.md")
      return [
        ...(/^\s*@AGENTS\.md\s*$/m.test(text) && existsSync(path.join(root, sibling))
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
    }),
  ]
}

function chainBytes(file: string) {
  return [path.posix.dirname(file), ...ancestorDirs(path.posix.dirname(file))]
    .map((dir) => {
      const override = dir === "." ? "AGENTS.override.md" : `${dir}/AGENTS.override.md`
      const regular = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`
      const chosen = [override, regular].find((candidate) => existsSync(path.join(root, candidate)))
      return chosen === undefined ? 0 : Buffer.byteLength(readFileSync(path.join(root, chosen)))
    })
    .reduce((sum, bytes) => sum + bytes, 0)
}

function ancestors(file: string) {
  return ancestorDirs(path.posix.dirname(file))
    .map((dir) => (dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`))
    .filter((candidate) => texts.has(candidate))
}

// Folders above dir, nearest first, ending with the repository root ".".
function ancestorDirs(dir: string) {
  const parts = dir === "." ? [] : dir.split("/")
  return parts.map((_, index) => parts.slice(0, parts.length - 1 - index).join("/") || ".")
}

function packageScripts() {
  const manifests = tracked.filter((file) => path.posix.basename(file) === "package.json" && !VENDORED.test(file))
  return new Map(
    manifests.map((file) => {
      const parsed: unknown = JSON.parse(readFileSync(path.join(root, file), "utf8"))
      const found = typeof parsed === "object" && parsed !== null && "scripts" in parsed ? parsed.scripts : undefined
      const names = typeof found === "object" && found !== null ? Object.keys(found) : []
      return [path.posix.dirname(file), new Set(names)] as const
    }),
  )
}

// Package-script invocations per paragraph, with any `--cwd` and the backticked folders the paragraph mentions.
function commands(lines: string[]) {
  return lines.flatMap((snippet) =>
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

function suffixHits(suffix: string) {
  const needle = `/${suffix}/`
  return [
    ...new Set(
      tracked.flatMap((file) => {
        const padded = `/${file}/`
        const at = padded.indexOf(needle)
        return at === -1 ? [] : [padded.slice(1, at + needle.length - 1)]
      }),
    ),
  ]
}

function looksLikePath(token: string) {
  if (token === "" || /[\s<>{}$()|;=,"'\\]|:\/\/|::/.test(token) || /^[-@$]/.test(token)) return false
  if (token.includes("/")) return /^[~./\w*-]+$/.test(token) && !/^\d/.test(token)
  return hasFileExt(token)
}

function hasFileExt(token: string) {
  const name = token.replace(/\/+$/, "").split("/").at(-1) ?? ""
  return BARE_FILES.has(name) || (name.includes(".") && FILE_EXTS.has(name.split(".").at(-1) ?? ""))
}

function bareMentions(prose: string) {
  const outsideSpans = prose.replace(/`[^`\n]*`/g, "")
  return [...outsideSpans.matchAll(/(?:^|(?<=[\s(]))@([~./\w][\w./~-]*\w)/gm)].map((match) => match[1] ?? "")
}

function codeSpans(prose: string) {
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "")
}

function stripFences(text: string) {
  const lines = text.split("\n")
  return lines.map((line, index) => (insideFence(lines, index) ? "" : line)).join("\n")
}

// A line is inside a fence when an odd number of fence markers precede it (the markers themselves count as inside).
function insideFence(lines: string[], index: number) {
  const markers = lines.slice(0, index + 1).filter((line) => /^\s*(```|~~~)/.test(line)).length
  return markers % 2 === 1 || /^\s*(```|~~~)/.test(lines[index] ?? "")
}

// Typed explicitly so type-aware lint keeps string types where Bun's type definitions aren't installed.
function git(cwd: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

function error(file: string, message: string): Finding {
  return { level: "error", file, message }
}

function warning(file: string, message: string): Finding {
  return { level: "warning", file, message }
}

function note(file: string, message: string): Finding {
  return { level: "note", file, message }
}
