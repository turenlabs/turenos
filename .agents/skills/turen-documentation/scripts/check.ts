#!/usr/bin/env bun
// Checks a docs/ tree against the TurenOS documentation method: the section table and rules in ../SKILL.md
// plus the naming, index and reachability rules in ../references/practices.md.
// It proves structure only: every link, anchor and cited path resolves and every page is indexed. Whether a page is
// true comes from reading the code. Exits 1 when any error is found. Read-only. The rules live in lib/: layout.ts
// (tree shape and indexes), content.ts (a few page conventions and source paths) and links.ts (links, anchors,
// orphans and inbound pointers).
//
// usage: bun .agents/skills/turen-documentation/scripts/check.ts [docs-dir]

import path from "node:path"
import { existsSync } from "node:fs"
import { contentFindings, sourcePathFindings } from "./lib/content"
import { loadDocs } from "./lib/docs"
import { catalogFindings, fileFindings, folderIndexFindings, layoutFindings, strayDocsFindings } from "./lib/layout"
import { inboundFindings, linkFindings } from "./lib/links"

const dir = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "docs")
if (!existsSync(dir)) {
  console.error(`no docs directory at ${dir}`)
  process.exit(2)
}
const docs = await loadDocs(dir)
const findings = [
  ...layoutFindings(docs),
  ...docs.files.flatMap(fileFindings),
  ...[...docs.pages].flatMap(([file, text]) => [
    ...contentFindings(file, text),
    ...sourcePathFindings(docs, file, text),
  ]),
  ...linkFindings(docs),
  ...catalogFindings(docs),
  ...folderIndexFindings(docs),
  ...strayDocsFindings(docs),
  ...inboundFindings(docs),
]
const errors = findings.filter((finding) => finding.level === "error")
const warnings = findings.filter((finding) => finding.level === "warning")
errors.forEach((finding) => console.log(`ERROR   ${finding.message}`))
warnings.forEach((finding) => console.log(`WARNING ${finding.message}`))
console.log(`${docs.pages.size} pages checked: ${errors.length} errors, ${warnings.length} warnings`)
process.exit(errors.length > 0 ? 1 : 0)
