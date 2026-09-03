import path from "node:path"
import { buffer } from "node:stream/consumers"
import type { Hooks, PluginInput } from "@turenlabs/plugin"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"
import { Patch } from "@/patch"
import { Scanner } from "@/security/util/scanner"
import { ensureBatouBinary, resolveBatouBinary } from "@/security/batou-binary"

/**
 * Bundled plugin that runs the Batou SAST scanner inline on every agent file
 * write. It hooks the write / edit / apply_patch tools:
 *
 *  - `tool.execute.before` fires a Claude-Code-shaped PreToolUse event. A
 *    `deny` decision (RiskScore >= 0.7) throws, which aborts the tool call
 *    before the file is touched — this is the blocking mechanism.
 *  - `tool.execute.after` fires a PostToolUse event and appends Batou's
 *    advisory findings to the tool output the model sees. The clean
 *    "No security issues detected" note is skipped to avoid noise.
 *
 * Everything is best-effort. The only outcome that blocks a write is an
 * explicit `deny`; a disabled toggle, a missing binary, a spawn error, a
 * timeout, or unparseable output all fail open (the write proceeds), with a
 * single concise log per distinct failure.
 */

const HOOKED_TOOLS = new Set(["write", "edit", "apply_patch"])
const BATOU_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 1024 * 1024
/** Batou's clean-scan note; findings appends are skipped when this is all it says. */
const CLEAN_MARKER = "No security issues detected"

type HookEventName = "PreToolUse" | "PostToolUse"

interface WriteToolInput {
  file_path: string
  content: string
}

interface EditToolInput {
  file_path: string
  old_string: string
  new_string: string
}

interface HookEvent {
  session_id: string
  cwd: string
  hook_event_name: HookEventName
  tool_name: "Write" | "Edit"
  tool_input: WriteToolInput | EditToolInput
  tool_response?: { filePath: string; success: boolean }
}

interface BatouHookOutput {
  hookSpecificOutput?: {
    hookEventName?: string
    permissionDecision?: "allow" | "deny"
    permissionDecisionReason?: string
    additionalContext?: string
  }
}

/**
 * One scan's result. `exitCode` matters because the public v2.0.0 binary
 * signals a block via exit code 2 (with permissionDecision:"allow" in the JSON
 * and the block details in additionalContext); only the managed enterprise
 * build sets permissionDecision:"deny". `output` is undefined when stdout
 * could not be parsed as a hook decision.
 */
interface BatouScanResult {
  exitCode: number
  timedOut: boolean
  output?: BatouHookOutput
}

/** A single file's worth of change, ready to become Pre/Post events. */
interface FileChange {
  toolName: "Write" | "Edit"
  filePath: string
  toolInput: WriteToolInput | EditToolInput
}

export interface BatouPluginDeps {
  /** Live Storage-backed enabled check; evaluated for every hook call. */
  isEnabled?: () => Promise<boolean>
  /** Resolve/download the binary (before hook). Injectable for tests. */
  ensureBinary?: () => Promise<string | undefined>
  /** Resolve an existing binary without downloading (after hook). */
  resolveBinary?: () => Promise<string | undefined>
  /** Spawn Batou for one event. Injectable for tests. */
  spawnBatou?: (binary: string, event: HookEvent, cwd: string) => Promise<BatouScanResult>
  logger?: (message: string) => void
}

/**
 * Decompose a tool call into the file changes Batou should scan. write/edit map
 * 1:1; apply_patch is decomposed per hunk — "add" hunks become Write events
 * (full new contents scanned), "update" hunks become Edit events (the removed
 * and added lines from the parsed chunks), and pure deletes are skipped as
 * there is no new content to scan.
 */
export function fileChangesFor(tool: string, args: any, cwd: string): FileChange[] {
  if (tool === "write") {
    const filePath = typeof args?.filePath === "string" ? args.filePath : args?.path
    if (typeof filePath !== "string") return []
    return [
      {
        toolName: "Write",
        filePath,
        toolInput: { file_path: filePath, content: typeof args.content === "string" ? args.content : "" },
      },
    ]
  }

  if (tool === "edit") {
    const filePath = typeof args?.filePath === "string" ? args.filePath : args?.path
    if (typeof filePath !== "string") return []
    return [
      {
        toolName: "Edit",
        filePath,
        toolInput: {
          file_path: filePath,
          old_string: typeof args.oldString === "string" ? args.oldString : "",
          new_string: typeof args.newString === "string" ? args.newString : "",
        },
      },
    ]
  }

  if (tool === "apply_patch") {
    if (typeof args?.patchText !== "string") return []
    let hunks: Patch.Hunk[]
    try {
      hunks = Patch.parsePatch(args.patchText).hunks
    } catch {
      return []
    }
    const changes: FileChange[] = []
    for (const hunk of hunks) {
      const filePath = path.resolve(cwd, hunk.path)
      if (hunk.type === "add") {
        changes.push({ toolName: "Write", filePath, toolInput: { file_path: filePath, content: hunk.contents } })
      } else if (hunk.type === "update") {
        const oldString = hunk.chunks.flatMap((chunk) => chunk.old_lines).join("\n")
        const newString = hunk.chunks.flatMap((chunk) => chunk.new_lines).join("\n")
        if (newString.length === 0) continue // move-only / no added content
        changes.push({
          toolName: "Edit",
          filePath,
          toolInput: { file_path: filePath, old_string: oldString, new_string: newString },
        })
      }
      // "delete": nothing new to scan.
    }
    return changes
  }

  return []
}

function toEvent(
  change: FileChange,
  hookEventName: HookEventName,
  base: { sessionId: string; cwd: string },
): HookEvent {
  return {
    session_id: base.sessionId,
    cwd: base.cwd,
    hook_event_name: hookEventName,
    tool_name: change.toolName,
    tool_input: change.toolInput,
    ...(hookEventName === "PostToolUse" ? { tool_response: { filePath: change.filePath, success: true } } : {}),
  }
}

/**
 * Default spawn: pipe the event JSON on stdin, then return the exit code plus
 * the parsed stdout decision. Both are needed: the public binary blocks via
 * exit code 2 while keeping permissionDecision:"allow" in the JSON.
 */
async function spawnBatouDefault(binary: string, event: HookEvent, cwd: string): Promise<BatouScanResult> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, BATOU_TIMEOUT_MS)
  try {
    // batou:ignore command_exec -- `binary` is the fixed, trusted "batou" tool resolved via PATH (or our own cache dir), identical to every Scanner.run "tools" integration; spawned argv-only with no shell, so PATH resolution of a known command name is not injection.
    const child = Process.spawn([binary], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      abort: controller.signal,
    })

    // Swallow EPIPE if the scanner exits before reading its stdin.
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify(event))

    // Await the process exit AND the full stdout stream: `exited` alone can
    // resolve before piped stdout is drained, which would drop the decision.
    // stderr is drained too so a chatty scanner never blocks on backpressure.
    const [exitCode, stdoutBuf] = await Promise.all([
      child.exited,
      child.stdout ? buffer(child.stdout) : Promise.resolve(Buffer.alloc(0)),
      child.stderr ? buffer(child.stderr).catch(() => Buffer.alloc(0)) : Promise.resolve(Buffer.alloc(0)),
    ])
    const stdout = Buffer.from(stdoutBuf).subarray(0, MAX_OUTPUT_BYTES).toString("utf8")
    return { exitCode, timedOut, output: Scanner.parseJsonOutput<BatouHookOutput>(stdout) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a scan is a block. Two shapes are honored:
 *  - managed/enterprise build: permissionDecision:"deny" in the JSON;
 *  - public v2.0.0 build: exit code 2 with a parseable hook decision (its JSON
 *    keeps permissionDecision:"allow" and puts the block in additionalContext).
 * Exit code 2 with unparseable output can't be told apart from a crash, so it
 * is NOT a block (the caller fails open).
 */
function isBlock(result: BatouScanResult): boolean {
  const hs = result.output?.hookSpecificOutput
  if (hs?.permissionDecision === "deny") return true
  return result.exitCode === 2 && hs !== undefined
}

/** Model-actionable block reason: the explicit reason, else Batou's full additionalContext. */
function blockReason(result: BatouScanResult): string {
  const hs = result.output?.hookSpecificOutput
  const reason = hs?.permissionDecisionReason?.trim()
  if (reason) return reason
  const context = hs?.additionalContext?.trim()
  if (context) return context
  return "a high-risk security issue was detected"
}

function makeLogger(custom?: (message: string) => void): (message: string) => void {
  if (custom) return custom
  const seen = new Set<string>()
  return (message: string) => {
    if (seen.has(message)) return
    seen.add(message)
    process.stderr.write(`[batou] ${message}\n`)
  }
}

export function BatouPlugin(input: PluginInput, deps?: BatouPluginDeps): Hooks
export function BatouPlugin(input: Pick<PluginInput, "directory">, deps?: BatouPluginDeps): Hooks
export function BatouPlugin(input: Pick<PluginInput, "directory">, deps: BatouPluginDeps = {}): Hooks {
  const log = makeLogger(deps.logger)
  const ensure = deps.ensureBinary ?? (() => ensureBatouBinary({ logger: log }))
  const resolve = deps.resolveBinary ?? (() => resolveBatouBinary())
  const spawn = deps.spawnBatou ?? spawnBatouDefault
  const cwd = input.directory || process.cwd()
  const scans = new Map<string, Map<string, BatouScanResult>>()

  function cache(callID: string, filePath: string, result: BatouScanResult) {
    const current = scans.get(callID) ?? new Map<string, BatouScanResult>()
    current.set(filePath, result)
    scans.set(callID, current)
    if (scans.size > 100) scans.delete(scans.keys().next().value!)
  }

  async function isEnabled(): Promise<boolean> {
    return (await deps.isEnabled?.()) ?? false
  }

  return {
    "tool.execute.before": async (hookInput, hookOutput) => {
      if (!HOOKED_TOOLS.has(hookInput.tool)) return

      // Compute the block verdict without ever throwing on failure; only a real
      // block decision becomes a thrown (blocking) error below. Everything else
      // — including exit-2-with-unparseable-output, other nonzero exits, and
      // timeouts — fails open so a scanner quirk never wedges the agent.
      const verdict = await (async () => {
        try {
          if (!(await isEnabled())) return undefined
          const binary = await ensure()
          if (!binary) return undefined
          const changes = fileChangesFor(hookInput.tool, hookOutput.args, cwd)
          for (const change of changes) {
            const result = await spawn(
              binary,
              toEvent(change, "PreToolUse", { sessionId: hookInput.sessionID, cwd }),
              cwd,
            )
            cache(hookInput.callID, change.filePath, result)
            if (result.timedOut) {
              log(`pre-write scan timed out for ${change.filePath}, allowing write`)
              continue
            }
            if (isBlock(result)) {
              return { filePath: change.filePath, tool: hookInput.tool, reason: blockReason(result) }
            }
            // Exit 2 with no parseable decision: can't tell a block from a crash.
            if (result.exitCode === 2 && result.output?.hookSpecificOutput === undefined) {
              log(`pre-write scan exited 2 with unparseable output for ${change.filePath}, allowing write`)
            }
          }
          return undefined
        } catch (error) {
          log(`pre-write scan failed, allowing write: ${errorMessage(error)}`)
          return undefined
        }
      })()

      if (verdict) {
        scans.delete(hookInput.callID)
        throw new Error(
          `Batou blocked this ${verdict.tool} of ${verdict.filePath}: ${verdict.reason} ` +
            `Do not resubmit the same content — fix the flagged security issue first, then retry the write.`,
        )
      }
    },

    "tool.execute.after": async (hookInput, hookOutput) => {
      if (!HOOKED_TOOLS.has(hookInput.tool)) return
      try {
        if (!(await isEnabled())) {
          scans.delete(hookInput.callID)
          return
        }
        const changes = fileChangesFor(hookInput.tool, hookInput.args, cwd)
        const cached = scans.get(hookInput.callID)
        const missing = changes.some((change) => !cached?.has(change.filePath))
        const binary = missing ? await resolve() : undefined
        if (missing && !binary) return
        const notes: string[] = []
        for (const change of changes) {
          const result =
            cached?.get(change.filePath) ??
            (await spawn(binary!, toEvent(change, "PostToolUse", { sessionId: hookInput.sessionID, cwd }), cwd))
          // PostToolUse is advisory (the write already happened): surface any
          // findings from the parsed JSON regardless of exit code.
          const context = result.output?.hookSpecificOutput?.additionalContext?.trim()
          // Only surface real findings; the clean note is pure noise for the model.
          if (context && !context.includes(CLEAN_MARKER)) notes.push(context)
        }
        if (notes.length) {
          hookOutput.output = `${hookOutput.output}\n\n${notes.join("\n\n")}`
        }
      } catch (error) {
        log(`post-write scan failed: ${errorMessage(error)}`)
      } finally {
        scans.delete(hookInput.callID)
      }
    },
  }
}
