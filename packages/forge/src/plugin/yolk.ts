import { tool, type Hooks, type PluginInput } from "@turenlabs/plugin"
import {
  createYolkRuntime,
  formatSemanticDiff,
  hasYolkChanges,
  type BuildIndexOptions,
  type CodeIndex,
} from "@turenlabs/core/yolk"
import { errorMessage } from "@/util/error"

const HOOKED_TOOLS = new Set(["write", "edit", "apply_patch"])

function changedPaths(input: unknown) {
  if (!input || typeof input !== "object") return []
  const value = input as Record<string, unknown>
  const paths = typeof value.path === "string" ? [value.path] : []
  if (typeof value.patchText !== "string") return paths
  return [
    ...paths,
    ...[...value.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!),
  ]
}

export const YOLK_ID = "yolk"

export interface YolkPluginDeps {
  isEnabled: () => Promise<boolean>
  build?: (root: string, options?: BuildIndexOptions) => Promise<CodeIndex>
  logger?: (message: string) => void
}

export async function YolkPlugin(input: Pick<PluginInput, "directory">, deps: YolkPluginDeps): Promise<Hooks> {
  if (!(await deps.isEnabled())) return {}

  const runtime = createYolkRuntime(input.directory || process.cwd(), deps.build)
  const log = deps.logger ?? ((message: string) => process.stderr.write(`[yolk] ${message}\n`))

  const callKey = (input: { sessionID: string; callID: string }) => `${input.sessionID}:${input.callID}`

  return {
    event: async ({ event }) => {
      if (event.type !== "file.watcher.updated") return
      runtime.invalidate([event.properties.file])
    },
    tool: {
      inspect_change: tool({
        description:
          "Inspect static impact for a named function or method, or discover indexed symbols by passing a source path. Yolk does not observe Solid/React tracking or store reads inside callees. Use path-first discovery when the exact symbol is unknown; never create probe files. Unknown or partial confidence is not a diagnosis.",
        args: {
          symbol: tool.schema
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Function or method symbol; omit it and pass path to discover valid symbols"),
          path: tool.schema
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Source path used to discover or narrow symbols, relative to the workspace root"),
          symbols: tool.schema
            .array(tool.schema.string().trim().min(1))
            .optional()
            .describe("Exact function or method symbols to inspect together using one index"),
          paths: tool.schema
            .array(tool.schema.string().trim().min(1))
            .optional()
            .describe("Source paths to discover together or use as inspection context"),
        },
        async execute(args, context) {
          if (!args.symbol && !args.path && !args.symbols?.length && !args.paths?.length) {
            throw new Error("Pass symbol, path, symbols, or paths")
          }
          const report = await runtime.inspect(args, context.abort)
          const impact = "target" in report
          return {
            title: impact
              ? `Change impact: ${report.target}`
              : "mode" in report
                ? "Yolk batch impact"
                : "Yolk symbol discovery",
            output: JSON.stringify(report, null, 2),
            metadata: impact
              ? { target: report.target, reviewScope: report.suggested_review_scope }
              : "mode" in report
                ? { targets: report.impacts.map((item) => item.target) }
                : { suggestions: report.symbols.map((item) => item.symbol) },
          }
        },
      }),
    },
    "tool.execute.before": async (hookInput) => {
      if (!HOOKED_TOOLS.has(hookInput.tool)) return
      try {
        await runtime.before(callKey(hookInput))
      } catch (error) {
        runtime.discard(callKey(hookInput))
        log(`pre-edit semantic snapshot failed: ${errorMessage(error)}`)
      }
    },
    "tool.execute.after": async (hookInput, hookOutput) => {
      if (!HOOKED_TOOLS.has(hookInput.tool)) return
      try {
        runtime.invalidate(changedPaths(hookInput.args))
        const report = await runtime.after(callKey(hookInput))
        if (!report || !hasYolkChanges(report)) return
        hookOutput.output = `${hookOutput.output}\n\n${formatSemanticDiff(report)}`
        hookOutput.metadata = { ...hookOutput.metadata, yolk: report }
      } catch (error) {
        log(`post-edit semantic check failed: ${errorMessage(error)}`)
      }
    },
    "tool.execute.error": async (hookInput, hookOutput) => {
      if (!HOOKED_TOOLS.has(hookInput.tool)) return
      try {
        runtime.invalidate(changedPaths(hookInput.args))
        const report = await runtime.after(callKey(hookInput))
        if (!report || !hasYolkChanges(report)) return
        hookOutput.message = `${hookOutput.message}\n\n${formatSemanticDiff(report)}`
      } catch (error) {
        log(`failed-tool semantic check failed: ${errorMessage(error)}`)
      }
    },
    dispose: runtime.dispose,
  }
}
