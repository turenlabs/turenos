#!/usr/bin/env bun
// Checks a docs/ tree against the TurenOS documentation method: the section table and rules in ../SKILL.md
// plus the naming, link, anchor, orphan, index and source-path rules in ../references/practices.md.
// Exits 1 when any error is found. Read-only.
//
// usage: bun .agents/skills/turen-documentation/scripts/check.ts [docs-dir] [--coverage]
//   --coverage  also lists workspace packages that no docs page mentions (candidate blind spots)

import path from "node:path"
import { existsSync, readFileSync, statSync } from "node:fs"

type Finding = { level: "error" | "warning"; message: string }

const KEBAB_FILE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)+$/
const KEBAB_FOLDER = /^[a-z0-9]+(-[a-z0-9]+)*$/
const AGENT_FILE = /CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.claude\/rules/
const PROTOTYPE = /\.(html?|js|css|excalidraw|tldraw|drawio)$/i
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i
const MAX_LINES = 300
const LONG_PAGE_MARKER = "<!-- long-page: reference -->"
// The marker must sit near the top, where a reader deciding whether to split the page sees it.
const MARKER_LINES = 12
const LINK =
  /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)|(?:href|src)="([^"]+)"/gm
// Backticked paths from these repository roots are claims about the tree and must exist.
const REPO_PATH = /^(packages|specs|script|services|tools|mockups|docs|command-guard|patches|\.github|\.agents)\//
const STATUS = /^Status: (prototype|benchmark|adopted|abandoned), as of \d{4}-\d{2}-\d{2}\b/m
// Capitalized function words are the reliable sign of a Title Case heading; product names never need them.
const SMALL_WORDS = new Set("A An And As At By For From In Into Of On Or The To Vs With Without".split(" "))

const args = process.argv.slice(2)
const coverage = args.includes("--coverage")
const docs = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? "docs")
if (!existsSync(docs)) {
  console.error(`no docs directory at ${docs}`)
  process.exit(2)
}
const sections = await readSections()
// Annotated so type-aware lint keeps string types even where Bun's type definitions aren't installed.
const files: string[] = (await listFiles())
  .map((file) => file.split(path.sep).join("/"))
  // Names starting with "." or "_" belong to site generators and editors, not to the docs.
  .filter((file) => !file.split("/").some((part) => part.startsWith(".") || part.startsWith("_")))
  .toSorted()
const pages = new Map(
  await Promise.all(
    files.filter(isPage).map(async (file) => [file, await Bun.file(path.join(docs, file)).text()] as const),
  ),
)

const root = repositoryRoot()
const findings = [
  ...layoutFindings(),
  ...files.flatMap(fileFindings),
  ...[...pages].flatMap(([file, text]) => contentFindings(file, text)),
  ...[...pages].flatMap(([file, text]) => sourcePathFindings(file, text)),
  ...linkFindings(),
  ...catalogFindings(),
  ...folderIndexFindings(),
  ...strayDocsFindings(),
  ...inboundFindings(),
]
const errors = findings.filter((finding) => finding.level === "error")
const warnings = findings.filter((finding) => finding.level === "warning")
errors.forEach((finding) => console.log(`ERROR   ${finding.message}`))
warnings.forEach((finding) => console.log(`WARNING ${finding.message}`))
if (coverage) coverageNotes().forEach((line) => console.log(`NOTE    ${line}`))
console.log(`${pages.size} pages checked: ${errors.length} errors, ${warnings.length} warnings`)
process.exit(errors.length > 0 ? 1 : 0)

function repositoryRoot() {
  const found = Bun.spawnSync(["git", "-C", docs, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
  return found.exitCode === 0 ? found.stdout.toString().trim() : undefined
}

// Git's view of the tree (tracked plus new, unignored files), so generated output such as the ignored
// docs/icon-reference.html is never reported. Outside a repository, every file counts.
async function listFiles() {
  const listed = Bun.spawnSync(["git", "-C", docs, "ls-files", "--cached", "--others", "--exclude-standard", "."], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (listed.exitCode !== 0) return Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: docs, onlyFiles: true }))
  return listed.stdout
    .toString()
    .split("\n")
    .filter((file) => file.length > 0 && existsSync(path.join(docs, file)))
}

async function readSections() {
  const skill = await Bun.file(path.join(import.meta.dir, "..", "SKILL.md")).text()
  const table = skill.match(/^## The `docs\/` sections$([\s\S]*?)(?=^## )/m)?.[1] ?? ""
  const rows = [...table.matchAll(/^\|\s*`([a-z0-9-]+)\/`\s*\|([^|]*)\|/gm)]
  if (rows.length === 0) throw new Error("could not read the section table from SKILL.md")
  // "yes: `README.md`" lists required pages; anything else means the section is optional.
  return new Map(
    rows.map((row) => {
      const required = row[2] ?? ""
      const pages = required.trim().startsWith("yes")
        ? [...required.matchAll(/`([^`]+)`/g)].map((page) => page[1] ?? "")
        : []
      return [row[1] ?? "", pages] as const
    }),
  )
}

function layoutFindings(): Finding[] {
  const present = [...new Set(files.filter((file) => file.includes("/")).map((file) => file.split("/")[0] ?? ""))]
  const atRoot = files.filter((file) => !file.includes("/"))
  const folders = [...new Set(files.flatMap((file) => ancestors(file)))]
  const index = pages.get("README.md") ?? ""
  return [
    ...(atRoot.includes("README.md") ? [] : [error("docs/README.md is missing: it is the entry point and index")]),
    ...atRoot
      .filter((file) => file !== "README.md")
      .map((file) => error(`file at the docs root, move it into a section: ${file}`)),
    ...present
      .filter((folder) => !sections.has(folder))
      .map((folder) => error(`${folder}/ is not a docs section (allowed: ${[...sections.keys()].join(", ")})`)),
    ...[...sections].flatMap(([name, required]) => [
      ...(required.length > 0 && !present.includes(name) ? [error(`required section missing: ${name}/`)] : []),
      ...required
        .filter((page) => present.includes(name) && !files.includes(`${name}/${page}`))
        .map((page) => error(`required page missing: ${name}/${page}`)),
      ...(present.includes(name) && name !== "assets" && !files.includes(`${name}/README.md`)
        ? [error(`section without README.md: ${name}/`)]
        : []),
      ...(present.includes(name) && name !== "assets" && !linksTo(index, `${name}/`)
        ? [warning(`docs/README.md does not link ${name}/`)]
        : []),
    ]),
    ...folders
      .filter((folder) => !KEBAB_FOLDER.test(path.posix.basename(folder)))
      .map((folder) => error(`folder name is not kebab-case: ${folder}`)),
    ...folders
      .filter((folder) => folder.includes("/") && pagesIn(folder) > 1 && !files.includes(`${folder}/README.md`))
      .map((folder) => warning(`${folder}/ has ${pagesIn(folder)} pages and no README.md`)),
  ]
}

function fileFindings(file: string): Finding[] {
  const name = path.posix.basename(file)
  const section = file.includes("/") ? file.split("/")[0] : undefined
  return [
    ...(name === "README.md" || KEBAB_FILE.test(name) ? [] : [error(`file name is not kebab-case: ${file}`)]),
    ...(/-v?\d+(\.\d+)+\.[a-z]+$/.test(name)
      ? [warning(`version number in file name, say "as of <version>" in the page instead: ${file}`)]
      : []),
    ...(section !== "assets" && PROTOTYPE.test(name)
      ? [
          error(
            `prototype or diagram source outside assets/: ${file} (prototypes go in mockups/, diagram sources in docs/assets/)`,
          ),
        ]
      : []),
    ...(section !== undefined && section !== "assets" && IMAGE.test(name)
      ? [warning(`image outside assets/: ${file}`)]
      : []),
    ...(section === "assets" && isPage(file) ? [error(`documentation page inside assets/: ${file}`)] : []),
    ...(file.split("/").length > 3 ? [warning(`nested deeper than docs/<section>/<folder>/<page>: ${file}`)] : []),
  ]
}

function contentFindings(file: string, text: string): Finding[] {
  const prose = stripCode(text)
  const parts = file.split("/")
  const readme = parts.at(-1) === "README.md"
  // A system's main page is systems/<name>.md or systems/<name>/README.md.
  const systemPage = parts[0] === "systems" && ((parts.length === 2 && !readme) || (parts.length === 3 && readme))
  const bare = [...new Set(targets(prose))].filter((target) => isRelative(target) && !/^\.\.?\//.test(target))
  return [
    ...prose.split("\n").flatMap((line, number) => {
      const match = line.match(AGENT_FILE)
      return match ? [error(`${file}:${number + 1}: references an agent instruction file (${match[0]})`)] : []
    }),
    ...(bare.length > 0 ? [warning(`${file}: write relative links as ./ or ../: ${bare.slice(0, 3).join(", ")}`)] : []),
    ...[...prose.matchAll(/^## ((?:known|current) limits)\s*$/gim)].map((match) =>
      warning(`${file}: rename "## ${match[1]}" to "## Limits"`),
    ),
    ...(systemPage && !/^## Source( map)?\s*$/m.test(prose)
      ? [warning(`${file}: system page has no "## Source" section citing its implementation`)]
      : []),
    // Past MAX_LINES a page gets a review: one topic stays (reference pages opt out with the marker), several split.
    ...(text.split("\n").length > MAX_LINES &&
    !text.split("\n").slice(0, MARKER_LINES).join("\n").includes(LONG_PAGE_MARKER)
      ? [
          warning(
            `${file}: ${text.split("\n").length} lines. If it covers several topics, split it along its ## sections (move.ts, then split.ts); if it is one reference topic, add ${LONG_PAGE_MARKER} in its first ${MARKER_LINES} lines`,
          ),
        ]
      : []),
    ...(parts[0] === "experimental" && !readme && !STATUS.test(text.split("\n").slice(0, 12).join("\n"))
      ? [warning(`${file}: no "Status: <prototype|benchmark|adopted|abandoned>, as of YYYY-MM-DD" line near the top`)]
      : []),
    ...[...prose.matchAll(/^#{1,4}\s+(.+?)\s*#*\s*$/gm)]
      .filter((match) => titleCase(match[1] ?? ""))
      .map((match) => warning(`${file}: heading "${match[1]}" is Title Case; use sentence case`)),
    ...linkTextFindings(file, stripCode(text, true)),
  ]
}

// "Create An Automation" and "Existing Plaintext Migration" are Title Case; "Claude Code tool routing" and
// "MCP credentials" are not. Code spans and tokens that don't start with a letter are ignored.
function titleCase(heading: string) {
  const words = heading
    .replace(/`[^`]*`/g, "")
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word))
  if (words.slice(1).some((word) => SMALL_WORDS.has(word))) return true
  return words.length >= 3 && words.every((word) => /^[A-Z]/.test(word))
}

// After a page moves into a folder, links keep text such as `secure-storage.md` while the target becomes
// secure-storage/README.md. Link text that names a Markdown file must name the file it points to.
function linkTextFindings(file: string, prose: string): Finding[] {
  return [...prose.matchAll(/\[`?([\w./-]+\.mdx?)`?\]\(([^)\s#]+)(#[^)]*)?\)/g)].flatMap((match) => {
    const named = (match[1] ?? "").split("/")
    const target = (match[2] ?? "").split("/")
    // A README is named by its folder, so `quality-gate/README.md` must point into quality-gate/.
    const folderDiffers =
      named.at(-1) === "README.md" && named.length > 1 && target.length > 1 && named.at(-2) !== target.at(-2)
    return named.at(-1) === target.at(-1) && !folderDiffers
      ? []
      : [warning(`${file}: link text \`${match[1]}\` does not match its target ${match[2]}`)]
  })
}

// Backticked repository paths ("see `packages/core/src/memory/index.ts`") are claims about the tree. Links are checked
// by linkFindings; this catches the inline mentions a rename leaves behind. Placeholders and globs are skipped.
function sourcePathFindings(file: string, text: string): Finding[] {
  if (root === undefined) return []
  return stripCode(text, true)
    .split("\n")
    .flatMap((line, number) =>
      [...line.matchAll(/`([^`\s]+)`/g)].flatMap((match) => {
        const token = (match[1] ?? "")
          .replace(/[),.;:]+$/, "")
          .replace(/#.*$/, "")
          .replace(/:\d+(-\d+)?$/, "")
        if (!REPO_PATH.test(token) || /[<>*{}$]|\.\.\./.test(token)) return []
        return existsSync(path.join(root, token))
          ? []
          : [error(`${file}:${number + 1}: \`${token}\` does not exist in the repository`)]
      }),
    )
}

// A folder's README.md is its main page and must link every sibling page and subfolder, or they are only reachable
// through deep links. The systems catalog is covered by catalogFindings.
function folderIndexFindings(): Finding[] {
  const readmes = files.filter(
    (file) => file.endsWith("README.md") && file !== "README.md" && file !== "systems/README.md",
  )
  return readmes.flatMap((readme) => {
    const folder = path.posix.dirname(readme)
    const text = pages.get(readme) ?? ""
    const children = [
      ...new Set(
        files
          .filter((file) => file.startsWith(`${folder}/`) && file !== readme)
          .map((file) => file.slice(folder.length + 1).split("/")[0] ?? "")
          .filter((entry) => isPage(entry) || (!entry.includes(".") && files.includes(`${folder}/${entry}/README.md`))),
      ),
    ]
    return children
      .filter((entry) => !linksTo(text, entry.endsWith(".md") ? entry : `${entry}/`))
      .map((entry) => warning(`${readme} does not link ${entry}`))
  })
}

// Workspace packages and top-level code areas that no page names. Each is a candidate blind spot to review, not an
// error: some packages are documented by their own README on purpose.
function coverageNotes() {
  if (root === undefined) return []
  const corpus = [...pages.values()].join("\n")
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  const declared =
    typeof manifest === "object" && manifest !== null && "workspaces" in manifest ? manifest.workspaces : undefined
  // `workspaces` is either a list of globs or an object whose `packages` holds them.
  const globs = (
    Array.isArray(declared)
      ? declared
      : typeof declared === "object" && declared !== null && "packages" in declared && Array.isArray(declared.packages)
        ? declared.packages
        : []
  ).filter((glob): glob is string => typeof glob === "string")
  const areas = [
    ...new Set(
      globs.flatMap((glob) =>
        [...new Bun.Glob(`${glob.replace(/\/+$/, "")}/package.json`).scanSync({ cwd: root })].map((file) =>
          path.posix.dirname(file.split(path.sep).join("/")),
        ),
      ),
    ),
  ].filter((area) => !area.endsWith("-wasm") && !area.includes("node_modules/"))
  return areas
    .toSorted((left, right) => left.localeCompare(right))
    .filter((area) => {
      const name = path.posix.basename(area)
      return !corpus.includes(`${area}/`) && !corpus.includes(`${area}\``) && !corpus.includes(`@turenlabs/${name}`)
    })
    .map((area) => `no docs page mentions ${area}`)
}

function linkFindings(): Finding[] {
  const resolved = [...pages].flatMap(([file, text]) =>
    [...new Set(targets(stripCode(text)))].map((target) => ({ file, target, result: resolveLink(file, target) })),
  )
  const edges = new Map(
    [...pages.keys()].map((file) => [
      file,
      resolved.filter((link) => link.file === file && link.result.page).map((link) => link.result.page ?? ""),
    ]),
  )
  const reachable = walk("README.md", edges)
  return [
    ...resolved.flatMap((link) => (link.result.finding ? [link.result.finding] : [])),
    ...(pages.has("README.md")
      ? [...pages.keys()]
          .filter((file) => !reachable.has(file))
          .map((file) => warning(`orphan page, not reachable from docs/README.md: ${file}`))
      : []),
  ]
}

// Documentation is centralized: a `docs/` folder anywhere else in the repository is a second tree. Vendored upstream
// code keeps its own docs.
function strayDocsFindings(): Finding[] {
  if (root === undefined) return []
  const tracked = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "*/docs/*"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const home = path.relative(root, docs).split(path.sep).join("/")
  const stray: string[] = tracked.stdout
    .toString()
    .split("\n")
    .filter((file) => file.length > 0 && !file.startsWith(`${home}/`) && !/(^|\/)(vendor|node_modules)\//.test(file))
  return [...new Set(stray.map((file) => file.slice(0, file.indexOf("/docs/") + "/docs/".length)))].map((folder) =>
    warning(`documentation outside docs/: ${folder} (move its pages into ${home}/ with move.ts)`),
  )
}

// Markdown outside docs/ (READMEs, AGENTS.md, CONTRIBUTING.md, skills) points into it. A page renamed without move.ts
// breaks those pointers silently, so resolve every one. A Markdown link resolves relative to its file, as GitHub does;
// a bare or backticked mention may also name a path from the repository root.
function inboundFindings(): Finding[] {
  if (root === undefined) return []
  const home = path.relative(root, docs).split(path.sep).join("/")
  const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const sources: string[] = listed.stdout
    .toString()
    .split("\n")
    // .forge/ holds runtime config and translation glossaries, not documentation.
    .filter(
      (file) =>
        file.length > 0 && !file.startsWith(`${home}/`) && !/(^|\/)(vendor|node_modules)\/|^\.forge\//.test(file),
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

function catalogFindings(): Finding[] {
  const catalog = pages.get("systems/README.md")
  if (catalog === undefined) return []
  const entries = [
    ...new Set(
      files
        .filter((file) => file.startsWith("systems/") && file !== "systems/README.md")
        .map((file) => file.split("/")[1] ?? "")
        .filter((entry) => entry.endsWith(".md") || !entry.includes(".")),
    ),
  ]
  return entries
    .filter((entry) => !linksTo(catalog, entry))
    .map((entry) =>
      warning(
        `systems/${entry}${entry.endsWith(".md") ? "" : "/"} is not linked from the systems catalog (systems/README.md)`,
      ),
    )
}

function resolveLink(file: string, target: string): { page?: string; finding?: Finding } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return {}
  if (target.startsWith("/")) return { finding: warning(`${file}: site-root link can't be checked offline: ${target}`) }
  const hash = target.indexOf("#")
  const linkPath = decode(hash === -1 ? target : target.slice(0, hash))
  if (linkPath === undefined) return { finding: error(`${file}: malformed percent-encoding in link: ${target}`) }
  const anchor = hash === -1 ? "" : target.slice(hash + 1).toLowerCase()
  const absolute = linkPath ? path.resolve(path.dirname(path.join(docs, file)), linkPath) : path.join(docs, file)
  if (!existsSync(absolute)) return { finding: error(`${file}: broken link: ${target}`) }
  const readmeOfFolder = path.join(absolute, "README.md")
  const destination = statSync(absolute).isDirectory() && existsSync(readmeOfFolder) ? readmeOfFolder : absolute
  if (!isPage(destination)) return {}
  const page = path.relative(docs, destination).split(path.sep).join("/")
  const inside = !page.startsWith("..")
  if (anchor && !anchors(pages.get(page) ?? readFileSync(destination, "utf8")).has(anchor)) {
    return { page: inside ? page : undefined, finding: error(`${file}: broken anchor: ${target}`) }
  }
  return { page: inside ? page : undefined }
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

function targets(prose: string) {
  return [...prose.matchAll(LINK)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((target) => target !== undefined)
}

// GitHub heading slugs, with -1, -2 suffixes for repeated headings, plus explicit id/name anchors.
function anchors(text: string) {
  const counts = new Map<string, number>()
  // Inline code stays: GitHub keeps its text in the slug, so "### `Tool.make`" is #toolmake.
  const slugs = [...stripCode(text, true).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => {
    const slug = (match[1] ?? "")
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
  const explicit = [...text.matchAll(/<[^>]+\b(?:id|name)="([^"]+)"/g)].map((match) => (match[1] ?? "").toLowerCase())
  return new Set([...slugs, ...explicit])
}

// Blanks fenced blocks and inline code so examples aren't checked as links or references.
function stripCode(text: string, keepSpans = false) {
  const lines = text.split("\n")
  const fences = lines.map((line) => /^\s*(```+|~~~+)/.exec(line)?.[1])
  const inside = fences.reduce<{ open?: string; flags: boolean[] }>(
    (state, fence) => {
      if (fence && state.open === undefined) return { open: fence, flags: [...state.flags, true] }
      if (fence && state.open !== undefined && fence[0] === state.open[0])
        return { open: undefined, flags: [...state.flags, true] }
      return { open: state.open, flags: [...state.flags, state.open !== undefined] }
    },
    { flags: [] },
  ).flags
  return lines
    .map((line, index) => (inside[index] ? "" : keepSpans ? line : line.replace(/`[^`\n]*`/g, "``")))
    .join("\n")
}

function linksTo(text: string, target: string) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const suffix = target.endsWith("/") ? "(README\\.md)?" : "([/#][^)\\s]*)?"
  return new RegExp(`\\]\\((\\./)?${escaped}${suffix}\\)`).test(text)
}

function ancestors(file: string) {
  const parts = file.split("/").slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"))
}

function pagesIn(folder: string) {
  return files.filter((file) => path.posix.dirname(file) === folder && isPage(file) && !file.endsWith("/README.md"))
    .length
}

function isPage(file: string) {
  return /\.mdx?$/.test(file)
}

function isRelative(target: string) {
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)
}

function error(message: string): Finding {
  return { level: "error", message }
}

function warning(message: string): Finding {
  return { level: "warning", message }
}
