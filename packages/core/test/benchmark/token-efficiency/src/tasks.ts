import { readFileSync } from "node:fs"
import path from "node:path"
import type { Task, Verifier } from "./types.ts"

/**
 * Every expected answer below is pinned to a literal in `fixture/`. If you edit
 * the fixture you must edit these too — the whole benchmark is worthless if a
 * verifier can pass for the wrong reason.
 */

/** Passes when the answer text contains `needle` as a standalone token. */
function containsToken(needle: string): Verifier {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(needle)}([^A-Za-z0-9_]|$)`)
  return (ctx) => {
    const pass = pattern.test(ctx.text)
    return { pass, detail: pass ? `found ${needle}` : `expected ${needle} in answer, got: ${truncate(ctx.text)}` }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function truncate(value: string, max = 220) {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/**
 * Passes when every `required` path is mentioned and no `forbidden` path is.
 * Matching is on basename so `src/tenant.ts`, `./src/tenant.ts` and an absolute
 * path all count — we are scoring whether the model found the right files, not
 * whether it formatted paths our way.
 */
function mentionsFiles(required: string[], forbidden: string[]): Verifier {
  return (ctx) => {
    const text = ctx.text
    const missing = required.filter((file) => !text.includes(file))
    const leaked = forbidden.filter((file) => text.includes(file))
    if (missing.length === 0 && leaked.length === 0) return { pass: true, detail: `found all ${required.length} files` }
    const problems: string[] = []
    if (missing.length) problems.push(`missing ${missing.join(", ")}`)
    if (leaked.length) problems.push(`wrongly included ${leaked.join(", ")}`)
    return { pass: false, detail: `${problems.join("; ")} — answer: ${truncate(text)}` }
  }
}

export const TASKS: Task[] = [
  {
    id: "trivial",
    label: "Trivial single-file question",
    measures: "fixed overhead — the floor a harness pays before doing any real work",
    needsWrite: false,
    turns: [
      {
        prompt:
          "In src/config.ts, what is the numeric value of the exported constant MAX_RETRY_ATTEMPTS? Reply with only the number.",
        verify: containsToken("4271"),
      },
    ],
  },
  {
    id: "search",
    label: "Multi-file symbol search",
    measures: "tool-output cost — how expensively a harness reads a repo",
    needsWrite: false,
    turns: [
      {
        prompt:
          "List every file under src/ that references the identifier normalizeTenantId, including the file that defines it. " +
          "Reply with only the repo-relative file paths, one per line, and nothing else.",
        verify: mentionsFiles(
          ["src/tenant.ts", "src/auth.ts", "src/store.ts"],
          ["src/metrics.ts", "src/config.ts", "src/index.ts"],
        ),
      },
    ],
  },
  {
    id: "edit",
    label: "Small edit, verified on disk",
    measures: "write-path cost — read/modify/write round-trip",
    needsWrite: true,
    turns: [
      {
        prompt:
          "In src/config.ts, change the exported constant REQUEST_TIMEOUT_MS from its current value to 9500. " +
          "Change nothing else in the file or the repository.",
        // Verified against the workspace on disk, not against what the model
        // claims it did.
        verify: (ctx) => {
          let source: string
          try {
            source = readFileSync(path.join(ctx.workspace, "src", "config.ts"), "utf8")
          } catch (err) {
            return { pass: false, detail: `could not read src/config.ts: ${String(err)}` }
          }
          const applied = /export const REQUEST_TIMEOUT_MS(?:\s*:\s*number)?\s*=\s*9500\b/.test(source)
          const collateral = !/export const MAX_RETRY_ATTEMPTS(?:\s*:\s*number)?\s*=\s*4271\b/.test(source)
          if (!applied) return { pass: false, detail: "REQUEST_TIMEOUT_MS was not set to 9500 on disk" }
          if (collateral) return { pass: false, detail: "edit applied but MAX_RETRY_ATTEMPTS was collaterally changed" }
          return { pass: true, detail: "REQUEST_TIMEOUT_MS = 9500 on disk, no collateral damage" }
        },
      },
    ],
  },
  {
    id: "conversation",
    label: "5-turn conversation",
    measures: "context growth per turn — how fast history compounds",
    needsWrite: false,
    turns: [
      {
        prompt:
          "In src/config.ts, what is the numeric value of the exported constant MAX_RETRY_ATTEMPTS? Reply with only the number.",
        verify: containsToken("4271"),
      },
      {
        prompt: "In that same file, what is the numeric value of REQUEST_TIMEOUT_MS? Reply with only the number.",
        verify: containsToken("3000"),
      },
      {
        prompt: "Which file defines the function normalizeTenantId? Reply with only the repo-relative path.",
        verify: containsToken("src/tenant.ts"),
      },
      {
        prompt: "What is the name of the exported class in src/store.ts? Reply with only the class name.",
        verify: containsToken("TenantStore"),
      },
      {
        prompt: "According to README.md, what is this project's codename? Reply with only the codename.",
        verify: containsToken("Bramblewick"),
      },
    ],
  },
]

export function taskById(id: string): Task | undefined {
  return TASKS.find((task) => task.id === id)
}
