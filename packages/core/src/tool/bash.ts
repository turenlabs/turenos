export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@turenlabs/llm"
import { Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Global } from "../global"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ShellSafety } from "../shell-safety"
import { ShellToolRouting } from "../shell-tool-routing"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024
/**
 * Budget beyond `timeout` after which the tool settles without waiting for the
 * process layer at all.
 *
 * `AppProcess.run`'s timeout races collection against a sleep and then *awaits*
 * the losing fiber's interruption. That interruption closes the spawn scope,
 * which signals the process group and blocks on the OS `close` notification —
 * an unbounded wait, even after `forceKillAfter` escalates to SIGKILL, because
 * `close` also requires every inherited stdio handle to be released. A child
 * that leaks a descendant holding those handles therefore suspends `run`
 * forever, and with it the tool call, its durable part, the assistant turn, and
 * every attempt to interrupt the turn (the runner's cancellation path awaits the
 * same tool fibers). A tool call owns its own terminal state, so it settles here
 * and leaves teardown to a detached fiber rather than waiting on the kernel.
 */
export const TERMINATION_GRACE_MS = 10 * 1_000

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Working directory. Defaults to the active Location; relative paths resolve from that Location. Delegated tasks must omit workdir or use "."; package-specific directory options must be included in the exact command grant instead.',
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timeout) return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command timed out before completion.`
  return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command exited with code ${output.exit}.`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = Effect.fn("BashTool.externalCommandDirectories")(function* (
  fs: FSUtil.Interface,
  command: string,
  cwd: string,
) {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token)
      .replace(/^~(?=[/\\])/, Global.Path.home)
      .replace(/^\$HOME(?=[/\\])/, Global.Path.home)
      .replace(/^\$\{HOME\}(?=[/\\])/, Global.Path.home)
      .replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = yield* fs.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(yield* fs.resolve(path.dirname(resolved)))
  }
  return [...directories]
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const assertPermission = (input: PermissionV2.AssertInput) =>
      permission.assert(input).pipe(
        Effect.catchTag("PermissionV2.BlockedError", () =>
          Effect.fail(
            new ToolFailure({
              message: `Permission denied: ${input.action}. No command was executed.${input.action === name ? ' Delegated commands must match an exact grant and run from the active workspace root (omit workdir or use "."). Ask the parent to correct the grant or assignment; do not retry the same denied call.' : ""}`,
            }),
          ),
        ),
      )

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. Use this for tests, builds, git, package managers, compilers, and other terminal programs; use glob or grep for workspace searches and edit or apply_patch for workspace mutations. High-confidence workspace searches and mutations are rejected before execution with the specialized tool to retry. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdirs and detected external command-argument paths require external_directory approval. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows. ${ShellSafety.PROCESS_SAFETY_GUIDANCE} Recursive deletion is allowed only for a narrow literal child of the working directory or temporary directory; roots, home, working-directory roots, parents, wildcards, dynamic targets, and paths with intermediate components are always blocked.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
          }),
          // The status sentence is only worth wire bytes when it says something stdout
          // does not: a failure, a timeout, or warnings. A clean exit with output is
          // implied by the result not being an error, and the sentence was re-sent for
          // every historical call on every turn.
          toModelOutput: ({ output }) => {
            const noteworthy = output.exit !== 0 || output.timeout || output.warnings?.length
            if (!output.output) return [{ type: "text", text: modelOutput(output) }]
            if (!noteworthy) return [{ type: "text", text: output.output }]
            return [
              { type: "text", text: output.output },
              { type: "text", text: modelOutput(output) },
            ]
          },
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const entries = yield* config.entries()
              const shell =
                Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                  .shell ?? defaultShell()
              const violation = yield* ShellSafety.inspect({
                command: input.command,
                cwd: target.canonical,
                shell: ShellSafety.kind(shell),
              })
              if (violation) return yield* new ToolFailure({ message: ShellSafety.blockedMessage(violation) })
              const recommendation = yield* ShellToolRouting.inspect({
                command: input.command,
                cwd: target.canonical,
                shell: ShellSafety.kind(shell),
              })
              if (recommendation)
                return yield* new ToolFailure({ message: ShellToolRouting.blockedMessage(recommendation) })
              const external = target.externalDirectory
              if (external)
                yield* assertPermission({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const externalDirectories = yield* externalCommandDirectories(fs, input.command, target.canonical)
              for (const directory of externalDirectories) {
                const resource = path.join(directory, "*").replaceAll("\\", "/")
                yield* assertPermission({
                  action: "external_directory",
                  resources: [resource],
                  save: [resource],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              }
              const warnings = externalDirectories.map(
                (directory) =>
                  `Command argument references approved external directory ${path.join(directory, "*").replaceAll("\\", "/")}.`,
              )
              yield* assertPermission({
                action: name,
                resources: [input.command],
                save: [input.command],
                metadata: { workdir: target.resource },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const command = ChildProcess.make(input.command, [], {
                cwd: target.canonical,
                shell,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              })
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const running = yield* appProcess
                .run(command, {
                  combineOutput: true,
                  timeout: Duration.millis(timeout),
                  maxOutputBytes: MAX_CAPTURE_BYTES,
                })
                .pipe(
                  Effect.catchTag("AppProcessError", (error) =>
                    isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
                  ),
                  Effect.forkDetach({ startImmediately: true }),
                )
              // Never awaited: interrupting the run can itself block on the same
              // unbounded process teardown, so both the deadline below and an
              // interrupted turn hand it off instead of waiting on it.
              const abandon = Fiber.interrupt(running).pipe(
                Effect.forkDetach({ startImmediately: true }),
                Effect.asVoid,
              )
              const settled = yield* Fiber.await(running).pipe(
                Effect.timeoutOption(Duration.millis(timeout + TERMINATION_GRACE_MS)),
                Effect.onInterrupt(() => abandon),
              )
              if (Option.isNone(settled)) {
                yield* abandon
                return yield* Effect.fail(
                  new ToolFailure({
                    message: `Command exceeded timeout of ${timeout} ms and its process did not terminate within ${TERMINATION_GRACE_MS} ms. The call was abandoned and the process may still be running: ${input.command}`,
                  }),
                )
              }
              const result = yield* settled.value
              if (!result) {
                return {
                  output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                  truncated: false,
                  timeout: true,
                  ...(warnings.length ? { warnings } : {}),
                }
              }

              const output = result.output?.toString("utf8") || "(no output)"
              const notice = result.outputTruncated
                ? "[output capture truncated at the in-memory safety limit]"
                : undefined
              return {
                exit: result.exitCode,
                output: notice ? `${output}\n\n${notice}` : output,
                truncated: result.outputTruncated === true,
                ...(warnings.length ? { warnings } : {}),
              }
            }).pipe(
              Effect.mapError((error) =>
                // A failure this tool raised deliberately already says what went
                // wrong; only opaque dependency failures collapse to the generic
                // message.
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to execute command: ${input.command}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, AppProcess.node, Config.node, PermissionV2.node],
})
