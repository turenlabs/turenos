export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@turenlabs/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { SessionHarness } from "@turenlabs/schema/session-harness"
import type { AgentV2 } from "../agent"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly subagentContext?: SubagentPromptContext
}

export interface SubagentPromptContext {
  readonly toolDefinitions: ReadonlyArray<ToolDefinition>
  readonly harnessSnapshot: SessionHarness.HarnessSnapshot | null
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
> = {
  readonly description: string
  readonly input: Input
  /**
   * Advertise this JSON Schema to the provider instead of deriving one from `input`.
   *
   * Only for tools whose parameters are discovered at runtime and therefore cannot be
   * expressed as an Effect Schema — today that means MCP, whose servers hand us a JSON
   * Schema document directly. `input` still decodes the call, so such tools pass
   * `Schema.Unknown` and validate against the remote contract at the far end.
   * Shipped built-ins must never set this: a derived schema and a hand-written one can
   * drift, and the derived one is the only one the decoder actually enforces.
   */
  readonly inputJsonSchema?: JsonSchema.JsonSchema
  readonly output: Output
  /**
   * Keep the tool callable but withhold its definition from the advertised catalog until a
   * session broker selects it. The tool search/load pair discovers deferred tools by name and
   * description only; a direct call by name still settles and marks the tool loaded.
   */
  readonly deferred?: boolean
  /**
   * Release a generic execution claim when the tool returns an error settlement, allowing the
   * same call identity to execute again. Use only when an error intentionally leaves a durable,
   * tool-owned operation pending and that operation reconciles the retry itself.
   */
  readonly retryableError?: boolean
  readonly structured?: Structured
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => Schema.Schema.Type<Structured>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly permission?: string
  readonly deferred: boolean
  readonly retryableError: boolean
  readonly requiresSubagentContext: boolean
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
>(config: Config<Input, Output, Structured>): Definition<Input, Structured> {
  const tool = Object.freeze({}) as Definition<Input, Structured>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    deferred: config.deferred ?? false,
    retryableError: config.retryableError ?? false,
    requiresSubagentContext: false,
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.inputJsonSchema ?? toToolInputSchema(config.input),
        outputSchema: toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(
            Effect.flatMap((output) =>
              Schema.encodeEffect(config.output)(output).pipe(
                Effect.flatMap((output) => {
                  if (!config.structured || !config.toStructuredOutput)
                    return Effect.succeed({ output, structured: output })
                  return Schema.encodeEffect(config.structured)(config.toStructuredOutput({ input, output })).pipe(
                    Effect.map((structured) => ({ output, structured })),
                  )
                }),
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Tool returned an invalid value for its output schema: ${error.message}`,
                    }),
                ),
              ),
            ),
            Effect.map(({ output, structured }) => ({
              structured,
              content:
                config.toModelOutput?.({ input, output }).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        uri: `data:${part.mime};base64,${part.data}`,
                        mime: part.mime,
                        name: part.name,
                      },
                ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
            })),
          ),
        ),
      ),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const withSubagentContext = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), requiresSubagentContext: true })
  return decorated
}

export const withDeferred = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), deferred: true })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const isDeferred = (tool: AnyTool) => runtimeOf(tool).deferred
export const retryableError = (tool: AnyTool) => runtimeOf(tool).retryableError
export const requiresSubagentContext = (tool: AnyTool) => runtimeOf(tool).requiresSubagentContext
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

type JsonObject = Record<string, unknown>

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const inlineRootReference = (input: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  if (!isRecord(input) || typeof input.$ref !== "string" || !isRecord(input.$defs)) return input
  const name = input.$ref
    .match(/^#\/\$defs\/(.+)$/)?.[1]
    ?.replaceAll("~1", "/")
    .replaceAll("~0", "~")
  const target = name ? input.$defs[name] : undefined
  if (!isRecord(target)) return input
  const { $ref: _reference, ...rest } = input
  return { ...target, ...rest }
}

// Effect renders a parameterless Struct as an untyped `object | array` union rather than an empty object schema.
const isParameterlessUnion = (input: JsonSchema.JsonSchema) => {
  const anyOf = (input as { readonly anyOf?: unknown }).anyOf
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return false
  const types = anyOf.map((member) =>
    typeof member === "object" && member !== null && Object.keys(member).length === 1
      ? (member as { readonly type?: unknown }).type
      : undefined,
  )
  return types.includes("object") && types.includes("array")
}

function toToolInputSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const input = flattenConstraints(inlineRootReference(toJsonSchema(schema)))
  if (input.type !== undefined) return input
  // Provider function arguments are always keyed objects, so make the root contract explicit for strict
  // Anthropic-compatible APIs that reject an untyped tool input schema.
  if (!isParameterlessUnion(input)) return { ...input, type: "object" }
  // A parameterless tool must restate as a plain empty object rather than keeping the union, otherwise adapters
  // disagree about what it means: Anthropic forwards the union verbatim (self-contradictory once a root type is
  // added) and Gemini cannot recognise it as an empty object at all.
  const { anyOf: _union, ...rest } = input as JsonSchema.JsonSchema & { readonly anyOf?: unknown }
  return { ...rest, type: "object", properties: {} }
}

// Keep bounds beside the type/items they constrain instead of requiring tool-schema
// consumers to combine constraint-only allOf arms with sibling array item fields.
function flattenConstraints(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const result = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (
        ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) &&
        isRecord(value)
      )
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, isRecord(item) ? flattenConstraints(item) : item]),
          ),
        ]
      if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value))
        return [key, value.map((item) => (isRecord(item) ? flattenConstraints(item) : item))]
      if (
        ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames"].includes(key) &&
        isRecord(value)
      )
        return [key, flattenConstraints(value)]
      return [key, value]
    }),
  )
  if (!Array.isArray(result.allOf)) return result
  const bounds = new Set([
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minProperties",
    "maxProperties",
    "description",
  ])
  const keys = new Set(Object.keys(result))
  const canFlatten = result.allOf.every(
    (item) =>
      isRecord(item) &&
      Object.keys(item).every((key) => {
        if (!bounds.has(key) || keys.has(key)) return false
        keys.add(key)
        return true
      }),
  )
  if (!canFlatten) return result
  const { allOf, ...rest } = result
  return Object.assign(rest, ...allOf)
}
