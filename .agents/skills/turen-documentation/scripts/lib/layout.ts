// Rules about the shape of the tree: sections, file and folder names, where files may live, and the indexes that must
// link every page.

import path from "node:path"
import type { Docs } from "./docs"
import { error, warning, type Finding } from "./findings"
import { listed } from "./git"
import { isPage, linksTo } from "./markdown"

const KEBAB_FILE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)+$/
const KEBAB_FOLDER = /^[a-z0-9]+(-[a-z0-9]+)*$/
const PROTOTYPE = /\.(html?|js|css|excalidraw|tldraw|drawio)$/i
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i

export function layoutFindings(docs: Docs): Finding[] {
  const present = [...new Set(docs.files.filter((file) => file.includes("/")).map((file) => file.split("/")[0] ?? ""))]
  const atRoot = docs.files.filter((file) => !file.includes("/"))
  const folders = [...new Set(docs.files.flatMap(ancestors))]
  const index = docs.pages.get("README.md") ?? ""
  return [
    ...(atRoot.includes("README.md") ? [] : [error("docs/README.md is missing: it is the entry point and index")]),
    ...atRoot
      .filter((file) => file !== "README.md")
      .map((file) => error(`file at the docs root, move it into a section: ${file}`)),
    ...present
      .filter((folder) => !docs.sections.has(folder))
      .map((folder) => error(`${folder}/ is not a docs section (allowed: ${[...docs.sections.keys()].join(", ")})`)),
    ...[...docs.sections].flatMap(([name, required]) => [
      ...(required.length > 0 && !present.includes(name) ? [error(`required section missing: ${name}/`)] : []),
      ...required
        .filter((page) => present.includes(name) && !docs.files.includes(`${name}/${page}`))
        .map((page) => error(`required page missing: ${name}/${page}`)),
      ...(present.includes(name) && name !== "assets" && !docs.files.includes(`${name}/README.md`)
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
      .filter(
        (folder) => folder.includes("/") && pagesIn(docs, folder) > 1 && !docs.files.includes(`${folder}/README.md`),
      )
      .map((folder) => warning(`${folder}/ has ${pagesIn(docs, folder)} pages and no README.md`)),
  ]
}

export function fileFindings(file: string): Finding[] {
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

// A folder's README.md is its main page and must link every sibling page and subfolder, or they are only reachable
// through deep links. The systems catalog is covered by catalogFindings.
export function folderIndexFindings(docs: Docs): Finding[] {
  const readmes = docs.files.filter(
    (file) => file.endsWith("README.md") && file !== "README.md" && file !== "systems/README.md",
  )
  return readmes.flatMap((readme) => {
    const folder = path.posix.dirname(readme)
    const text = docs.pages.get(readme) ?? ""
    const children = [
      ...new Set(
        docs.files
          .filter((file) => file.startsWith(`${folder}/`) && file !== readme)
          .map((file) => file.slice(folder.length + 1).split("/")[0] ?? "")
          .filter(
            (entry) => isPage(entry) || (!entry.includes(".") && docs.files.includes(`${folder}/${entry}/README.md`)),
          ),
      ),
    ]
    return children
      .filter((entry) => !linksTo(text, entry.endsWith(".md") ? entry : `${entry}/`))
      .map((entry) => warning(`${readme} does not link ${entry}`))
  })
}

export function catalogFindings(docs: Docs): Finding[] {
  const catalog = docs.pages.get("systems/README.md")
  if (catalog === undefined) return []
  const entries = [
    ...new Set(
      docs.files
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

// Documentation is centralized: a `docs/` folder anywhere else in the repository is a second tree. Vendored upstream
// code keeps its own docs.
export function strayDocsFindings(docs: Docs): Finding[] {
  const root = docs.root
  const home = docs.home
  if (root === undefined || home === undefined) return []
  const stray = listed(root, "*/docs/*").filter(
    (file) => !file.startsWith(`${home}/`) && !/(^|\/)(vendor|node_modules)\//.test(file),
  )
  return [...new Set(stray.map((file) => file.slice(0, file.indexOf("/docs/") + "/docs/".length)))].map((folder) =>
    warning(`documentation outside docs/: ${folder} (move its pages into ${home}/ with move.ts)`),
  )
}

function ancestors(file: string) {
  const parts = file.split("/").slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"))
}

function pagesIn(docs: Docs, folder: string) {
  return docs.files.filter(
    (file) => path.posix.dirname(file) === folder && isPage(file) && !file.endsWith("/README.md"),
  ).length
}
