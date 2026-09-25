#!/usr/bin/env bun
// Checks a docs/ tree against the TurenOS documentation method: the section table and rules in ../SKILL.md
// plus the naming, link, anchor, orphan, index and source-path rules in ../references/practices.md.
// Exits 1 when any error is found. Read-only. The rules live in lib/: layout.ts (tree shape and indexes), content.ts
// (page conventions and source paths), links.ts (links, anchors, orphans, inbound pointers) and coverage.ts.
//
// usage: bun .agents/skills/turen-documentation/scripts/check.ts [docs-dir] [--coverage]
//   --coverage  also lists workspace packages that no docs page mentions (candidate blind spots)

import path from "node:path"
import { existsSync } from "node:fs"
import { contentFindings, sourcePathFindings } from "./lib/content"
import { coverageNotes } from "./lib/coverage"
import { loadDocs } from "./lib/docs"
import { catalogFindings, fileFindings, folderIndexFindings, layoutFindings, strayDocsFindings } from "./lib/layout"
import { inboundFindings, linkFindings } from "./lib/links"

const args = process.argv.slice(2)
const dir = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? "docs")
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
if (args.includes("--coverage")) coverageNotes(docs).forEach((line) => console.log(`NOTE    ${line}`))
console.log(`${docs.pages.size} pages checked: ${errors.length} errors, ${warnings.length} warnings`)
process.exit(errors.length > 0 ? 1 : 0)
