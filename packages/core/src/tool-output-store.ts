export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import { SecretOutput } from "./secret-output"
import type { ToolOutput } from "@turenlabs/llm"
import { ToolResultStore } from "./tool-result-store"
import { BoundedJson } from "./util/bounded-json"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
  /** The caller's operation snapshot; a fresh one is acquired when omitted. */
  readonly protection?: SecretOutput.Snapshot
  readonly retain?: boolean
  readonly tool?: string
  readonly assistantMessageID?: string
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  /** Persist one binary artifact in the managed retention directory. */
  readonly writeBytes: (content: Uint8Array) => Effect.Effect<string, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (let end = input.length; end > 0; ) {
    const low = input.charCodeAt(end - 1)
    const high = end > 1 ? input.charCodeAt(end - 2) : 0
    const start = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? end - 2 : end - 1
    const char = input.slice(start, end)
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.push(char)
    bytes += size
    end = start
  }
  return content.reverse().join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

/**
 * Head/tail preview of `text` with `marker` naming what was dropped from the middle.
 *
 * Exported because retention reduces already-stored payloads to the same shape the publish path
 * produces. Two different truncation forms in one transcript would be two things for a reader to
 * learn, and only one of them would be tested.
 */
export const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const secretOutput = yield* SecretOutput.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const results = yield* ToolResultStore.Service
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      if (Option.isNone(config)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (content: string) {
      const file = path.join(directory, `tool_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeFileString(file, content, { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    const writeBytes = Effect.fn("ToolOutputStore.writeBytes")(function* (content: Uint8Array) {
      const file = path.join(directory, `tool_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeFile(file, content, { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const protection =
        input.protection ??
        (yield* secretOutput
          .snapshot()
          .pipe(
            Effect.mapError(
              () => new StorageError({ operation: "encode", cause: new Error("Secret output protection unavailable") }),
            ),
          ))
      const capture = input.retain
        ? yield* Effect.try({
            try: () => {
              const encoded = BoundedJson.encode(input.output.structured, ToolResultStore.MAX_BYTES)
              return encoded === undefined
                ? { rejected: input.output.structured !== undefined }
                : { encoded, value: JSON.parse(encoded) as Schema.Json }
            },
            catch: () => true,
          }).pipe(Effect.catch(() => Effect.succeed({ rejected: true })))
        : undefined
      const rejected = capture && "rejected" in capture && capture.rejected
      // Rejected source structure is omitted, never passed to a recursive redactor or serializer.
      // Every value that remains is protected before either retained store writes any bytes.
      const base = yield* Effect.try({
        try: () =>
          input.retain
            ? {
                structured: protection.json(
                  rejected
                    ? {
                        retentionUnavailable: "Structured capture exceeded JSON limits or used an unsupported value.",
                        truncated: true,
                      }
                    : capture && "value" in capture
                      ? capture.value
                      : undefined,
                ),
                content: input.output.content.map((item) =>
                  item.type === "file" && item.name !== undefined
                    ? { ...item, name: protection.text(item.name) }
                    : item,
                ),
              }
            : input.output,
        catch: () =>
          new StorageError({ operation: "encode", cause: new Error("Secret output protection unavailable") }),
      })
      const media = base.content.filter((item) => item.type === "file")
      const text = base.content.filter((item) => item.type === "text")
      const values =
        base.content.length === 0
          ? [
              yield* Effect.try({
                try: () => JSON.stringify(base.structured, null, 2) ?? String(base.structured),
                catch: (cause) => new StorageError({ operation: "encode", cause }),
              }),
            ]
          : text.map((item) => item.text)
      // Joining separately safe text blocks can reconstruct a credential. Protect
      // the exact bytes retained and previewed, not only each incoming block.
      const parts = yield* Effect.try({
        try: () => protection.parts(values),
        catch: () =>
          new StorageError({ operation: "encode", cause: new Error("Secret output protection unavailable") }),
      })
      const contextual = parts.join("")
      const changed = !parts.every((part, index) => part === values[index])
      const protectedText = new Map(text.map((item, index) => [item, parts[index]]))
      const protectedOutput: ToolOutput = !changed
        ? base
        : {
            structured: base.structured,
            content:
              text.length === 0
                ? [{ type: "text", text: contextual }]
                : base.content.flatMap((item): ToolOutput["content"][number][] => {
                    if (item.type !== "text") return [item]
                    const part = protectedText.get(item) ?? ""
                    return part === "" && item.text !== "" ? [] : [{ type: "text", text: part }]
                  }),
          }
      const oversized =
        lineCount(contextual) > outputLimits.maxLines || Buffer.byteLength(contextual, "utf-8") > outputLimits.maxBytes
      const structured =
        input.retain && !rejected
          ? yield* Effect.try({
              try: () => BoundedJson.encode(base.structured, ToolResultStore.MAX_BYTES),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
      const partial =
        rejected ||
        (typeof base.structured === "object" &&
          base.structured !== null &&
          "truncated" in base.structured &&
          base.structured.truncated === true)
      const retained =
        input.retain &&
        (oversized || partial || (structured !== undefined && Buffer.byteLength(structured) > outputLimits.maxBytes))
          ? yield* results
              .put({
                sessionID: input.sessionID,
                toolCallID: input.toolCallID,
                tool: input.tool ?? "unknown",
                ...(input.assistantMessageID === undefined ? {} : { assistantMessageID: input.assistantMessageID }),
                text: contextual,
                ...(structured === undefined ? {} : { structured: JSON.parse(structured) as Schema.Json }),
                captureTruncated: partial,
              })
              .pipe(
                Effect.match({
                  onSuccess: (reference) => ({ reference }),
                  onFailure: (error) => ({ unavailable: error.message }),
                }),
              )
          : undefined
      // Retention is advisory after a tool has executed. A quota or capture failure must not
      // turn a successful mutation into an indeterminate execution or invite a source retry.
      const reference = retained && "reference" in retained ? retained.reference : undefined
      const hint = reference
        ? `Captured result ${reference.id}; use result_read for exact pages, result_search for matching passages, or result_compute for exhaustive calculations. Expires ${new Date(reference.expiresAt).toISOString()}.${reference.captureTruncated ? " Capture is partial; source truncation or retention limits omitted data." : ""}`
        : retained && "unavailable" in retained
          ? `Retained capture unavailable: ${retained.unavailable} The source tool already completed; do not repeat a mutation to recover its output.`
          : undefined
      const output = hint
        ? {
            structured: reference ? ToolResultStore.withReference(base.structured, reference) : base.structured,
            // Keep structured-only results visible through ToolOutput.toResultValue.
            content: protectedOutput.content.length
              ? [...protectedOutput.content, { type: "text" as const, text: `\n\n[${hint}]` }]
              : [],
          }
        : protectedOutput
      if (
        !oversized &&
        (!hint ||
          (lineCount(contextual + hint) <= outputLimits.maxLines &&
            Buffer.byteLength(contextual + hint) + 4 <= outputLimits.maxBytes))
      )
        return { output, outputPaths: [] }

      const outputPath = yield* write(contextual)
      const marker = hint
        ? `... output excerpted. ${hint} ...`
        : `... output truncated; full content saved to ${outputPath} ...`

      return {
        output: {
          structured: output.structured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...media,
          ],
        },
        outputPaths: [outputPath],
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      yield* results.cleanup()
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, writeBytes, cleanup })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Config.node, SecretOutput.node, ToolResultStore.node],
})

export const nodeWithoutConfig = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, SecretOutput.node, ToolResultStore.node],
})

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node, SecretOutput.node, ToolResultStore.node],
})
