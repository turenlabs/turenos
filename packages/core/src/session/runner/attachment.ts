export * as SessionRunnerAttachment from "./attachment"

import { Effect } from "effect"
import { fileURLToPath } from "url"
import type { FSUtil } from "../../fs-util"
import type { Image } from "../../image"
import type { FileSystem } from "../../filesystem"
import { SessionMessage } from "../message"
import { FileAttachment } from "../prompt"

/**
 * Mime prefixes the LLM protocol layer ever accepts on the "media" content channel.
 * `ProviderShared.validateMedia` (packages/llm/src/protocols/shared.ts) whitelists image mimes for
 * every provider and audio/video for some; every other mime is rejected outright with an
 * invalid-request error before the turn is even sent. `to-llm-message.ts` uses these same
 * predicates to decide whether a materialized attachment renders as a media part or as inline text.
 */
export const isImageMime = (mime: string) => mime.toLowerCase().startsWith("image/")
export const isAudioVideoMime = (mime: string) => /^(audio|video)\//i.test(mime)

/**
 * Already-resolved services `materialize` needs. Callers (`llm.ts`) resolve these once, the same
 * way every other collaborator in that layer is resolved -- as a plain captured value, not via
 * `yield* Service` inside a closure that has to type-check against an `R = never` interface.
 */
export interface Dependencies {
  readonly fsUtil: FSUtil.Interface
  readonly image: Image.Interface
}

const dataUrlPayload = (uri: string) => {
  const comma = uri.indexOf(",")
  return comma === -1 ? undefined : uri.slice(comma + 1)
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const inlineText = (file: FileAttachment, text: string, mime: string = file.mime): FileAttachment =>
  FileAttachment.make({
    uri: `data:${mime};base64,${Buffer.from(text, "utf8").toString("base64")}`,
    mime,
    name: file.name,
    description: file.description,
    source: file.source,
  })

const note = (file: FileAttachment, text: string) => inlineText(file, text, "text/plain")

/**
 * `file:` URLs carry the line range of a context mention as a `?start=&end=` query
 * (see `packages/app/src/components/prompt-input/build-request-parts.ts`'s `fileQuery`). Slice it
 * here, at materialization time, so the renderer never has to look past the `data:` URI it gets.
 */
const sliceRange = (text: string, params: URLSearchParams) => {
  const start = Number(params.get("start"))
  if (!Number.isFinite(start) || start < 1) return text
  const end = Number(params.get("end"))
  const from = Math.trunc(start)
  const to = Number.isFinite(end) && end >= from ? Math.trunc(end) : from
  return text
    .split("\n")
    .slice(from - 1, to)
    .join("\n")
}

const readAttachmentFile = Effect.fn("SessionRunnerAttachment.readAttachmentFile")(function* (
  fsUtil: FSUtil.Interface,
  uri: string,
) {
  const url = new URL(uri)
  const bytes = yield* fsUtil.readFile(fileURLToPath(url))
  return { base64: Buffer.from(bytes).toString("base64"), searchParams: url.searchParams }
})

/**
 * Resize an already-materialized base64 image payload against the same limits V1 used (provider
 * input caps and token cost -- see `packages/core/src/image/photon.ts`). Non-image media (audio,
 * video) and non-media attachments are returned unchanged; V1's `Image.normalize` is image-only too.
 */
const resizeIfImage = Effect.fn("SessionRunnerAttachment.resizeIfImage")(function* (
  image: Image.Interface,
  file: FileAttachment,
  base64: string,
) {
  if (!isImageMime(file.mime)) return { content: base64, mime: file.mime }
  const content: FileSystem.Content & { readonly encoding: "base64" } = {
    uri: file.uri,
    name: file.name,
    content: base64,
    encoding: "base64",
    mime: file.mime,
  }
  return yield* image.normalize(file.uri, content).pipe(
    Effect.map((result) => ({ content: result.content, mime: result.mime })),
    Effect.catchTags({
      // No WASM resizer in this runtime: best effort, send the original bytes -- matches V1, which
      // catches exactly this tag in both `prompt.ts` and `processor.ts` and passes the attachment
      // through unresized rather than failing the turn.
      "Image.ResizerUnavailableError": () => Effect.succeed({ content: base64, mime: file.mime }),
      "Image.DecodeError": () => Effect.succeed(undefined),
      "Image.SizeError": () => Effect.succeed(undefined),
    }),
  )
})

const finishMedia = Effect.fn("SessionRunnerAttachment.finishMedia")(function* (
  image: Image.Interface,
  file: FileAttachment,
  base64: string,
) {
  const resized = yield* resizeIfImage(image, file, base64)
  if (resized === undefined)
    return note(file, `Attachment ${file.name ?? file.uri} could not be processed as an image and was omitted.`)
  return FileAttachment.make({ ...file, uri: `data:${resized.mime};base64,${resized.content}`, mime: resized.mime })
})

/**
 * Resolve one prompt attachment's `uri` into something `to-llm-message.ts` can render without any
 * further I/O: a `data:` URI holding materialized (and, for images, size-limited) base64 bytes, or
 * an unchanged URI for schemes the app never actually produces (V1 never handled bare http(s) URLs
 * either -- see the `file:`/`data:` scheme survey this change is based on).
 *
 * Text-like attachments (mime outside image/audio/video -- the common case: @-mentioned source
 * files) are also decoded down to a `data:text/...;base64,` URI here rather than left as `file:`,
 * because that is the one shape the renderer treats uniformly. This mirrors V1's `resolvePart`,
 * which never let a text file reach its media pipeline at all.
 */
const materializeOne = Effect.fn("SessionRunnerAttachment.materializeOne")(function* (
  deps: Dependencies,
  file: FileAttachment,
) {
  const isMedia = isImageMime(file.mime) || isAudioVideoMime(file.mime)

  // The composer's "attach file" flow already captured the selected text client-side
  // (`Prompt.FileAttachment.source.text`); nothing to read, and the renderer prefers it anyway.
  if (!isMedia && file.source?.text !== undefined) return file

  if (file.uri.startsWith("data:")) {
    if (!isMedia) return file // renderer decodes the data: URI directly; no resize applies
    const payload = dataUrlPayload(file.uri)
    return payload === undefined ? file : yield* finishMedia(deps.image, file, payload)
  }

  if (!file.uri.startsWith("file:")) return file // unhandled scheme; pass through unchanged

  // A file that was moved or deleted after being attached must degrade to a note rather than fail
  // the whole turn: unlike V1 (which materializes once, at admission), this runs on every turn
  // against the same durable history, so a hard failure here would permanently break every future
  // turn of the session, not just the one that first noticed.
  return yield* readAttachmentFile(deps.fsUtil, file.uri).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed(note(file, `Could not read attachment ${file.name ?? file.uri}: ${errorMessage(error)}`)),
      onSuccess: (value) =>
        isMedia
          ? finishMedia(deps.image, file, value.base64)
          : Effect.succeed(
              inlineText(file, sliceRange(Buffer.from(value.base64, "base64").toString("utf8"), value.searchParams)),
            ),
    }),
  )
})

/**
 * Materialize every user-turn attachment across projected V2 Session history into content
 * `to-llm-message.ts` can lower without further I/O. Runs ahead of `toLLMMessages`, which stays a
 * pure, synchronous translation over already-resolved messages.
 */
export const materialize = Effect.fn("SessionRunnerAttachment.materialize")(function* (
  deps: Dependencies,
  messages: readonly SessionMessage.Message[],
) {
  return yield* Effect.forEach(messages, (message) => {
    if (message.type !== "user" || message.files === undefined || message.files.length === 0)
      return Effect.succeed(message)
    return Effect.forEach(message.files, (file) => materializeOne(deps, file)).pipe(
      Effect.map((files) => ({ ...message, files })),
    )
  })
})
