export * as ComplexityRatchetPlugin from "./complexity-ratchet"

import { diffLines } from "diff"
import { Effect } from "effect"
import { Patch } from "../patch"
import { ApplyPatchTool } from "../tool/apply-patch"
import { EditTool } from "../tool/edit"
import type { ToolInterceptor } from "../tool/interceptor"
import { WriteTool } from "../tool/write"
import { define } from "./define"

export const threshold = 8
const maximumChangeCharacters = 32_000

export interface Change {
  readonly path: string
  readonly before: string
  readonly after: string
  readonly copies?: number
  readonly stateOnly?: boolean
}

export interface Features {
  readonly added: number
  readonly removed: number
  readonly branchesAdded: number
  readonly branchesRemoved: number
  readonly duplicateAdditions: number
  readonly emptyBodies: number
  readonly placeholders: number
  readonly longestAddition: number
}

export interface Assessment {
  readonly score: number
  readonly features: Features
  readonly reasons: ReadonlyArray<"placeholder" | "empty" | "duplication" | "branching">
}

const branch = /\b(?:if|elif|else|switch|case|catch|except|for|foreach|while|match|when|guard|rescue)\b|&&|\|\|/
const placeholder =
  /^\s*(?:raise\s+(?:NotImplementedError|NotImplementedException)\b|(?:todo|unimplemented)!\s*\(|(?:throw\s+new\s+\w*Error|panic!)\s*\(\s*["'`]not implemented)/i
const placeholderOperation =
  /^\s*(?:raise\s+(?:NotImplementedError|NotImplementedException)\b|(?:todo|unimplemented)!\s*\(|(?:throw\s+new\s+\w*Error|panic!)\s*\()/i
const ignored =
  /(?:^|\/)(?:vendor|vendors|generated|gen|dist|build|coverage|fixtures?|snapshots?|migrations?)(?:\/|$)|(?:\.min\.[^.]+|\.(?:lock|md|mdx|json|jsonc|ya?ml|toml|csv|txt|svg|map))$/i

export function assess(change: Change): Assessment {
  if (ignored.test(change.path)) return { score: 0, features: emptyFeatures(), reasons: [] }
  if (change.before.length + change.after.length > maximumChangeCharacters)
    return { score: 0, features: emptyFeatures(), reasons: [] }
  const changed = diffLines(change.before, change.after)
  const additions = changed.filter((item) => item.added).flatMap((item) => lines(item.value))
  const removals = changed.filter((item) => item.removed).flatMap((item) => lines(item.value))
  const additionCode = sanitize(additions.join("\n"))
  const removalCode = sanitize(removals.join("\n"))
  const meaningfulAdditions = additions.map(normalize).filter((line) => line.length >= 12 && !syntaxOnly(line))
  const meaningfulRemovals = removals.map(normalize).filter((line) => line.length >= 12 && !syntaxOnly(line))
  const frequencies = new Map<string, number>()
  for (const line of meaningfulAdditions) frequencies.set(line, (frequencies.get(line) ?? 0) + 1)
  const copies = Math.max(1, Math.min(1_000, change.copies ?? 1))
  const features = {
    added: additions.filter(nonBlank).length * copies,
    removed: removals.filter(nonBlank).length * copies,
    branchesAdded: additionCode.filter((line) => branch.test(line)).length * copies,
    branchesRemoved: removalCode.filter((line) => branch.test(line)).length * copies,
    // Each meaningful removed line licenses one added line: a modification
    // (rename, signature change) replayed across N sites replaces as much as it
    // adds and creates no new duplication, while stamping new logic over bare
    // markers removes nothing meaningful and still counts in full.
    duplicateAdditions: Math.max(
      0,
      Array.from(frequencies.values()).reduce((total, count) => total + Math.max(0, count * copies - 1), 0) -
        meaningfulRemovals.length * copies,
    ),
    emptyBodies: emptyBodyCount(additionCode.join("\n")) * copies,
    placeholders:
      additions.filter(
        (line, index) =>
          placeholder.test(line) &&
          placeholderOperation.test(additionCode[index] ?? "") &&
          !additionCode.slice(Math.max(0, index - 3), index).some((candidate) => /@abstractmethod\b/.test(candidate)),
      ).length * copies,
    longestAddition: changed.reduce(
      (longest, item) => (item.added ? Math.max(longest, lines(item.value).filter(nonBlank).length) : longest),
      0,
    ),
  }
  return score(features, change.stateOnly)
}

export function makeObserver() {
  return (event: ToolInterceptor.AfterEvent) => {
    if (event.denied || event.result.type === "error") return
    const warnings = changes(event).flatMap((change) => {
      const current = assess(change)
      return current.score < threshold ? [] : [current.reasons[0] ?? "branching"]
    })
    if (warnings.length === 0) return
    event.notes.push(message(warnings[0] ?? "branching"))
  }
}

export const Plugin = define({
  id: "complexity-ratchet",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.tool.execute.after(makeObserver())
  }),
})

function score(features: Features, stateOnly = false): Assessment {
  const branchGrowth = Math.max(0, features.branchesAdded - features.branchesRemoved)
  const netGrowth = Math.max(0, features.added - features.removed)
  const points =
    (features.placeholders > 0 ? 8 : 0) +
    Math.min(9, features.emptyBodies * 3) +
    (stateOnly ? 0 : features.duplicateAdditions >= 8 ? 8 : 0) +
    (stateOnly || netGrowth < 40 ? 0 : 2) +
    (stateOnly || features.longestAddition < 40 ? 0 : 2) +
    (stateOnly || branchGrowth < 6 ? 0 : 3) +
    (stateOnly || branchGrowth < 10 ? 0 : 3) +
    (stateOnly || features.added < 8 || branchGrowth < 4 || features.branchesAdded / features.added < 0.15 ? 0 : 2)
  return {
    score: points,
    features,
    reasons: [
      ...(features.placeholders > 0 ? (["placeholder"] as const) : []),
      ...(features.emptyBodies >= 3 ? (["empty"] as const) : []),
      ...(features.duplicateAdditions >= 8 ? (["duplication"] as const) : []),
      ...(points > 0 ? (["branching"] as const) : []),
    ],
  }
}

function changes(event: ToolInterceptor.AfterEvent): ReadonlyArray<Change> {
  if (!record(event.input)) return []
  if (
    event.tool === EditTool.name &&
    typeof event.input.path === "string" &&
    typeof event.input.oldString === "string" &&
    typeof event.input.newString === "string"
  )
    return [
      {
        path: event.input.path,
        before: event.input.oldString,
        after: event.input.newString,
        copies: editReplacements(event),
      },
    ]
  if (
    event.tool === WriteTool.name &&
    typeof event.input.path === "string" &&
    typeof event.input.content === "string" &&
    event.result.type === "text" &&
    typeof event.result.value === "string" &&
    /^(?:Created|Wrote) file successfully:/.test(event.result.value)
  )
    return [
      {
        path: event.input.path,
        before: "",
        after: event.input.content,
        stateOnly: event.result.value.startsWith("Wrote file successfully:"),
      },
    ]
  if (event.tool !== ApplyPatchTool.name || typeof event.input.patchText !== "string") return []
  if (event.input.patchText.length > maximumChangeCharacters) return []
  return patchChanges(event.input.patchText)
}

function patchChanges(value: string): ReadonlyArray<Change> {
  try {
    return Patch.parse(value).flatMap((hunk) => {
      if (hunk.type === "add") return [{ path: hunk.path, before: "", after: hunk.contents }]
      if (hunk.type === "delete") return []
      return hunk.chunks.map((chunk) => ({
        path: hunk.path,
        before: chunk.oldLines.join("\n"),
        after: chunk.newLines.join("\n"),
      }))
    })
  } catch {
    return []
  }
}

function emptyFeatures(): Features {
  return {
    added: 0,
    removed: 0,
    branchesAdded: 0,
    branchesRemoved: 0,
    duplicateAdditions: 0,
    emptyBodies: 0,
    placeholders: 0,
    longestAddition: 0,
  }
}

function emptyBodyCount(value: string) {
  const braces = Array.from(value.matchAll(/([^{}\n]+)\{\s*\}/g)).filter((match) => {
    const header = match[1]?.trim() ?? ""
    if (/^(?:if|else|for|while|switch|catch|try|do)\b/.test(header)) return false
    return /\b(?:function|func)\b|\w+\s*\([^;{}]*\)\s*$/.test(header)
  }).length
  return braces + Array.from(value.matchAll(/\bdef\s+\w+\s*\([^)]*\)\s*:\s*\n\s*pass\b/g)).length
}

function normalize(value: string) {
  return value
    .trim()
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '"$"')
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
}

function syntaxOnly(value: string) {
  return /^[{}()[\],;:.]+$/.test(value)
}

function lines(value: string) {
  const result = value.replaceAll("\r\n", "\n").split("\n")
  if (result.at(-1) === "") result.pop()
  return result
}

// This is intentionally only a lexical noise filter, not a language parser. It preserves line
// structure while blanking common string and comment forms so prose cannot look like control flow.
function sanitize(value: string) {
  const output: string[] = []
  let line = ""
  let quote: "'" | '"' | "`" | undefined
  let triple = false
  let blockComment = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const current = value[index] ?? ""
    const next = value[index + 1] ?? ""
    const third = value[index + 2] ?? ""
    if (current === "\n") {
      output.push(line)
      line = ""
      if (quote !== "`" && !triple) quote = undefined
      escaped = false
      continue
    }
    if (blockComment) {
      line += " "
      if (current === "*" && next === "/") {
        line += " "
        index++
        blockComment = false
      }
      continue
    }
    if (quote) {
      line += " "
      if (triple && current === quote && next === quote && third === quote) {
        line += "  "
        index += 2
        quote = undefined
        triple = false
        continue
      }
      if (!triple && !escaped && current === quote) quote = undefined
      escaped = !escaped && current === "\\"
      if (current !== "\\") escaped = false
      continue
    }
    if (current === "/" && next === "*") {
      line += "  "
      index++
      blockComment = true
      continue
    }
    if ((current === "/" && next === "/") || current === "#") {
      line += " ".repeat(value.indexOf("\n", index) === -1 ? value.length - index : value.indexOf("\n", index) - index)
      index = value.indexOf("\n", index) === -1 ? value.length : value.indexOf("\n", index) - 1
      continue
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current
      triple = current !== "`" && next === current && third === current
      line += triple ? "   " : " "
      if (triple) index += 2
      continue
    }
    line += current
  }
  output.push(line)
  return output
}

function nonBlank(value: string) {
  return value.trim().length > 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function editReplacements(event: ToolInterceptor.AfterEvent) {
  if (!record(event.input) || event.input.replaceAll !== true) return 1
  if (event.result.type !== "text" || typeof event.result.value !== "string") return 1
  const count = event.result.value.match(/^Replacements:\s*(\d+)$/m)?.[1]
  return count === undefined ? 1 : Number(count)
}

function message(reason: Assessment["reasons"][number]) {
  if (reason === "placeholder") return "Quality ratchet: complete or remove the new placeholder implementation."
  if (reason === "empty") return "Quality ratchet: complete or remove the new empty implementations."
  if (reason === "duplication") return "Quality ratchet: this change adds substantial duplicated code; simplify it."
  return "Quality ratchet: this change concentrates branching in one path; simplify it before extending it."
}
