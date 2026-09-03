import {
  Message,
  ToolCallPart,
  ToolOutput,
  ToolResultPart,
  type ContentPart,
  type Model,
  type ProviderMetadata,
} from "@turenlabs/llm"
import { DateTime } from "effect"
import { SessionMessage } from "../message"
import type { FileAttachment } from "../prompt"
import { isAudioVideoMime, isImageMime } from "./attachment"

// Keep an inlined attachment from dwarfing everything around it. Matches the cap
// `Prompt.TextPart.Comment` already uses for pasted/attached text (packages/schema/src/prompt.ts),
// rather than inventing a new number.
const MAX_INLINE_TEXT_CHARS = 100_000

const dataUrlPayload = (uri: string) => {
  const comma = uri.indexOf(",")
  return comma === -1 ? undefined : uri.slice(comma + 1)
}

const clip = (text: string) =>
  text.length <= MAX_INLINE_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_INLINE_TEXT_CHARS)}\n[...truncated ${text.length - MAX_INLINE_TEXT_CHARS} characters...]`

const wrapText = (file: FileAttachment, text: string): ContentPart => ({
  type: "text",
  text: `<file path="${file.name ?? file.uri}" mime="${file.mime}">\n${clip(text)}\n</file>`,
})

/**
 * Render one attachment into the content part the provider actually accepts.
 *
 * `attachment.ts`'s `materialize` runs ahead of `toLLMMessages` over the whole history and
 * resolves every attachment `uri` to a `data:` URI (materialized bytes, resized if it's an image
 * over the configured limit) or leaves it unchanged for the rare scheme neither the app nor V1
 * ever produced. This function does no I/O -- it only decides how to shape what's already there.
 *
 * Image/audio/video mimes become a media part, matching the original behavior. Everything else --
 * the common case, an @-mentioned source file -- is inlined as text instead of sent as media:
 * `ProviderShared.validateMedia` (packages/llm/src/protocols/shared.ts) whitelists only
 * image (and, per-provider, audio/video) mimes on the media channel and rejects everything else
 * with an invalid-request error, so a `text/plain` (or `application/json`, `text/markdown`, ...)
 * attachment sent as media would have failed the whole provider turn. V1 avoided this the same
 * way: a text `file:` attachment never reached its media pipeline, it was re-read as text instead.
 */
const media = (file: FileAttachment, model: Model): ContentPart => {
  // A text-only model rejects the whole request on an image part, and the attachment stays in the
  // transcript, so every later turn re-sends it and fails the same way. Say what was attached
  // instead: the turn proceeds, and the agent can see it needs another way to read the file.
  if (model.compatibility?.mediaInput === false && isImageMime(file.mime))
    return wrapText(file, `[${file.mime} attachment omitted: this model accepts text input only]`)
  if (isImageMime(file.mime) || isAudioVideoMime(file.mime))
    return {
      type: "media",
      mediaType: file.mime,
      data: file.uri,
      filename: file.name,
      metadata: file.description === undefined ? undefined : { description: file.description },
    }
  // Composer-attached files already carry the selected text client-side; prefer it over decoding
  // uri, which for that path is still the original file: reference (materialize skips reading it).
  if (file.source?.text !== undefined) return wrapText(file, file.source.text)
  if (!file.uri.startsWith("data:")) return wrapText(file, `[Attachment ${file.name ?? file.uri} could not be read]`)
  const payload = dataUrlPayload(file.uri)
  return wrapText(
    file,
    payload === undefined
      ? `[Attachment ${file.name ?? file.uri} could not be read]`
      : Buffer.from(payload, "base64").toString("utf8"),
  )
}

const toolInput = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status !== "pending") return tool.state.input
  try {
    return JSON.parse(tool.state.input) as unknown
  } catch {
    return tool.state.input
  }
}

const toolCall = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined): ContentPart =>
  ToolCallPart.make({
    id: tool.id,
    name: tool.name,
    input: toolInput(tool),
    providerExecuted: tool.provider?.executed,
    providerMetadata,
  })

const toolResult = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined) => {
  if (tool.state.status === "completed") {
    // TODO: Materialize remote and managed URIs before provider-history lowering.
    // ToolOutput.toResultValue rejects unresolved URIs rather than treating them as media bytes.
    const result =
      tool.provider?.executed === true && tool.state.result !== undefined
        ? tool.state.result
        : ToolOutput.toResultValue({ structured: tool.state.structured, content: tool.state.content })
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result,
      providerExecuted: tool.provider?.executed,
      providerMetadata,
    })
  }
  if (tool.state.status === "error") {
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result:
        tool.provider?.executed === true && tool.state.result !== undefined
          ? tool.state.result
          : { error: tool.state.error, content: tool.state.content, structured: tool.state.structured },
      resultType: "error",
      providerExecuted: tool.provider?.executed,
      providerMetadata,
    })
  }
}

const assistant = (message: SessionMessage.Assistant, model: Model) => {
  const sameModel =
    String(message.model.providerID) === String(model.provider) && String(message.model.id) === String(model.id)
  const reuseProviderMetadata = sameModel && message.error === undefined
  const content = message.content.flatMap((item): ContentPart[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }]
    if (item.type === "reasoning")
      return sameModel
        ? [
            {
              type: "reasoning",
              text: item.text,
              providerMetadata: reuseProviderMetadata ? item.providerMetadata : undefined,
            },
          ]
        : item.text.length > 0
          ? [{ type: "text", text: item.text }]
          : []
    const call = toolCall(item, reuseProviderMetadata ? item.provider?.metadata : undefined)
    if (item.provider?.executed !== true) return [call]
    const result = toolResult(
      item,
      reuseProviderMetadata ? (item.provider.resultMetadata ?? item.provider.metadata) : undefined,
    )
    return result ? [call, result] : [call]
  })
  const meaningful = content.filter((part) => {
    if (part.type === "text") return part.text !== ""
    if (part.type !== "reasoning") return true
    return part.text !== "" || (part.providerMetadata !== undefined && Object.keys(part.providerMetadata).length > 0)
  })
  const results = message.content.reduce<Message[]>((output, item) => {
    if (item.type !== "tool" || item.provider?.executed === true) return output
    const result = toolResult(
      item,
      reuseProviderMetadata ? (item.provider?.resultMetadata ?? item.provider?.metadata) : undefined,
    )
    if (result !== undefined) output.push(Message.tool(result))
    return output
  }, [])
  if (meaningful.length === 0) return results
  return [
    Message.make({ id: message.id, role: "assistant", content: meaningful, metadata: message.metadata }),
    ...results,
  ]
}

/**
 * The checkpoint as the model sees it: the anchored summary, then the carried fact ledger.
 *
 * `<durable-facts>` is emitted only when the checkpoint has a ledger, so a checkpoint written
 * before the ledger landed -- or with `compaction.ledger: false` -- lowers to byte-identical text.
 * That matters beyond compatibility: an unchanged prefix keeps the provider prompt cache of every
 * already-adopted session intact.
 *
 * Summary first, ledger second, preserved tail last. The summary is the narrative the model reads
 * to know where the work is; the ledger is reference material it looks things up in, and putting
 * a few hundred bullets ahead of the narrative would bury it. The facts are stated as
 * still-true-unless-contradicted rather than as instructions, matching the disclaimer the
 * checkpoint opens with -- they were true when recorded and have not been re-verified since.
 */
const checkpointText = (message: SessionMessage.Compaction) => {
  const facts = message.ledger ?? []
  return `<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.

<summary>
${message.summary}
</summary>
${
  facts.length === 0
    ? ""
    : `
<durable-facts>
Facts carried forward verbatim from every earlier part of this conversation, oldest first. They were recorded when they were still visible and have not been rewritten. Treat each as still true unless the summary or a later message contradicts it.
${facts.join("\n")}
</durable-facts>
`
}
<recent-context>
${message.recent}
</recent-context>
</conversation-checkpoint>`
}

const legacySystem = (message: SessionMessage.Message) => {
  const forge = message.metadata?.forge
  if (typeof forge !== "object" || forge === null) return
  const legacy = (forge as Record<string, unknown>).legacy
  if (typeof legacy !== "object" || legacy === null) return
  const system = (legacy as Record<string, unknown>).system
  return typeof system === "string" && system.length > 0 ? system : undefined
}

function toLLMMessage(message: SessionMessage.Message, model: Model): Message[] {
  switch (message.type) {
    case "agent-switched":
    case "model-switched":
      return []
    case "user": {
      const system = legacySystem(message)
      // Structured parts are the authoritative model view when present. Aggregate text remains
      // durable for old readers but must never reintroduce ignored text.
      const content = [
        ...(message.parts === undefined
          ? message.text.length > 0
            ? [{ type: "text" as const, text: message.text }]
            : []
          : message.parts
              .filter((part) => !part.ignored && part.text.length > 0)
              .map((part) => ({ type: "text" as const, text: part.text }))),
        ...(message.files ?? []).map((file) => media(file, model)),
      ]
      return [
        ...(system ? [Message.system(system)] : []),
        ...(content.length === 0
          ? []
          : [
              Message.make({
                id: message.id,
                role: "user",
                content,
                metadata: {
                  ...message.metadata,
                  ...(message.agents?.length ? { agents: message.agents } : {}),
                },
              }),
            ]),
      ]
    }
    case "synthetic": {
      const system = legacySystem(message)
      return [
        ...(system ? [Message.system(system)] : []),
        Message.make({ id: message.id, role: "user", content: message.text, metadata: message.metadata }),
      ]
    }
    case "system":
      return [Message.system(message.text)]
    case "shell":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `Shell command: ${message.command}\n\n${message.output}`,
          metadata: message.metadata,
        }),
      ]
    case "assistant":
      return assistant(message, model)
    case "compaction":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: checkpointText(message),
          metadata: message.metadata,
        }),
      ]
  }
}

/**
 * A request that ends on a checkpoint is the post-compaction continuation turn:
 * the checkpoint itself disclaims being an instruction ("historical context,
 * not new instructions"), so without an explicit directive the model's most
 * obedient move is to stop and ask what to do next. Any later request has real
 * messages after the checkpoint and never carries this.
 */
const CONTINUE_AFTER_CHECKPOINT = `The checkpoint above ends mid-task. Resume immediately: act on the most recent [User] instruction and the summary's next move without asking for confirmation. If the summary lists Durable Memories and the memory_write tool is available, persist the ones not already stored first — compaction has condensed the history they came from. Ask the user only if you are genuinely blocked on input only they can provide.`
const CONTINUE_AFTER_MANUAL_CHECKPOINT = `Act on the most recent user instruction. If the checkpoint lists Durable Memories and the memory_write tool is available, persist the ones not already stored first. Do not ask the user to repeat context that is already present in the checkpoint.`

/** Translate projected V2 Session history into canonical @turenlabs/llm context. */
export const toLLMMessages = (messages: readonly SessionMessage.Message[], model: Model) => {
  const lowered = messages.flatMap((message) => toLLMMessage(message, model))
  const checkpointIndex = messages.findLastIndex((message) => message.type === "compaction")
  if (checkpointIndex === -1) return lowered
  const checkpoint = messages[checkpointIndex]
  if (checkpoint?.type !== "compaction") return lowered
  const continued = messages
    .slice(checkpointIndex + 1)
    .some(
      (message) =>
        message.type === "assistant" &&
        DateTime.toEpochMillis(message.time.created) > DateTime.toEpochMillis(checkpoint.time.created),
    )
  if (continued) return lowered
  return [
    ...lowered,
    Message.make({
      role: "user",
      content: checkpoint.reason === "auto" ? CONTINUE_AFTER_CHECKPOINT : CONTINUE_AFTER_MANUAL_CHECKPOINT,
      metadata: { forge: { internalContext: "compaction" } },
    }),
  ]
}
