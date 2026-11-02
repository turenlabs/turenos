import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Config } from "@turenlabs/core/config"
import { ConfigAttachments } from "@turenlabs/core/config/attachments"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Image } from "@turenlabs/core/image"
import { SessionMessage } from "@turenlabs/core/session/message"
import { FileAttachment } from "@turenlabs/core/session/prompt"
import { SessionRunnerAttachment } from "@turenlabs/core/session/runner/attachment"
import { toLLMMessages } from "@turenlabs/core/session/runner/to-llm-message"
import { LLM, Model } from "@turenlabs/llm"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { Auth } from "@turenlabs/llm/route"
import { dynamicResponse } from "../../llm/test/lib/http"
import { finishChunk } from "../../llm/test/lib/openai-chunks"
import { sseEvents } from "../../llm/test/lib/sse"
import { testEffect } from "./lib/effect"

// Real fixtures, not synthetic base64 literals: `large-image.png` is a genuine 2560x1422 photo
// (copied from packages/forge/test/tool/fixtures, which V1's own tool tests use for the same
// purpose) that exceeds the real default 2000x2000 resize limit; `small-image.png` is a genuine
// small photo that doesn't. `notes.md` is a real multi-line text fixture for the inlining/range
// slicing path.
const FIXTURES = path.join(import.meta.dir, "fixtures", "attachment")
const smallImagePath = path.join(FIXTURES, "small-image.png")
const largeImagePath = path.join(FIXTURES, "large-image.png")
const notesPath = path.join(FIXTURES, "notes.md")
const notesText = fs.readFileSync(notesPath, "utf8")
const smallImageDataUrl = `data:image/png;base64,${fs.readFileSync(smallImagePath).toString("base64")}`

let configEntries: Config.Entry[] = []
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
// Real FSUtil (actual disk reads) and real Image (actual @silvia-odwyer/photon-node WASM resize) --
// no mocks. `Image.node` only depends on `Config.node`, which is overridden here to control limits.
const attachmentLayer = AppNodeBuilder.build(LayerNode.group([FSUtil.node, Image.node]), [[Config.node, config]])
const it = testEffect(attachmentLayer)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
const textOnlyModel = Model.make({
  id: "model",
  provider: "provider",
  route: OpenAIChat.route,
  compatibility: { mediaInput: false },
})

const deps = Effect.gen(function* () {
  return { fsUtil: yield* FSUtil.Service, image: yield* Image.Service } satisfies SessionRunnerAttachment.Dependencies
})

const userMessage = (files: readonly FileAttachment[]) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_attachment"),
    type: "user",
    text: "See attached",
    files,
    time: { created: DateTime.makeUnsafe(0) },
  })

const filesOf = (message: SessionMessage.Message) => (message as SessionMessage.User).files

describe("SessionRunnerAttachment.materialize", () => {
  it.effect("passes through a small, already-materialized data: image unresized", () =>
    Effect.gen(function* () {
      configEntries = []
      const file = FileAttachment.make({ uri: smallImageDataUrl, mime: "image/png", name: "small-image.png" })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      expect(resultFile?.uri).toBe(smallImageDataUrl)
      expect(resultFile?.mime).toBe("image/png")
    }),
  )

  it.effect("reads a file: image off disk and resizes it below the real 2000x2000 default limit", () =>
    Effect.gen(function* () {
      configEntries = []
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const uri = pathToFileURL(largeImagePath).toString()
      const file = FileAttachment.make({ uri, mime: "image/png", name: "large-image.png" })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      expect(resultFile?.uri.startsWith("data:")).toBe(true)
      const base64 = resultFile!.uri.slice(resultFile!.uri.indexOf(",") + 1)
      const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))
      // The source fixture is a real photo -- verify the *real* Photon resizer actually ran,
      // against the real default limits, not a mock.
      expect(decoded.get_width()).toBeLessThanOrEqual(2000)
      expect(decoded.get_height()).toBeLessThanOrEqual(2000)
      decoded.free()

      const rendered = toLLMMessages([materialized!], model)
      const media = rendered[0]?.content.find((part) => part.type === "media")
      expect(media).toBeDefined()
      expect((media as { mediaType: string }).mediaType).toBe(resultFile!.mime)
    }),
  )

  it.effect("keeps images off the wire for a model that accepts text input only", () =>
    Effect.gen(function* () {
      configEntries = []
      const file = FileAttachment.make({
        uri: pathToFileURL(largeImagePath).toString(),
        mime: "image/png",
        name: "screenshot.png",
      })
      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])

      // Sending it fails the whole request upstream, and because the attachment stays in the
      // transcript every retry fails identically, so the Session never recovers on its own.
      const rendered = toLLMMessages([materialized!], textOnlyModel)
      expect(rendered[0]?.content.find((part) => part.type === "media")).toBeUndefined()
      // The note replaces the image part, after the message body the user typed.
      const note = rendered[0]?.content.findLast((part) => part.type === "text") as { text: string }
      expect(note.text).toContain("screenshot.png")
      expect(note.text).toContain("text input only")

      // The same attachment still reaches a model that accepts images.
      expect(
        toLLMMessages([materialized!], model)
          .find(() => true)
          ?.content.some((p) => p.type === "media"),
      ).toBe(true)
    }),
  )

  it.effect("strips stored images for an OpenAI-compatible model whose catalog is silent on modalities", () =>
    Effect.gen(function* () {
      // The live Console Go failure: deepseek-v4-flash on opencode-go carries no image modality in
      // its catalog, so the resolver sets mediaInput:false and a poisoned transcript -- images
      // already stored from a vision-model turn -- lowers to text notes instead of re-sending
      // `image_url` parts the text-only upstream rejects.
      configEntries = []
      const file = FileAttachment.make({
        uri: pathToFileURL(largeImagePath).toString(),
        mime: "image/png",
        name: "screenshot.png",
      })
      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const opencodeGo = Model.make({
        id: "deepseek-v4-flash",
        provider: "opencode-go",
        route: OpenAIChat.route,
        compatibility: { mediaInput: false },
      })

      const rendered = toLLMMessages([materialized!], opencodeGo)
      expect(rendered[0]?.content.some((part) => part.type === "media")).toBe(false)
      expect(rendered[0]?.content.findLast((part) => part.type === "text")).toMatchObject({
        text: expect.stringContaining("text input only"),
      })
    }),
  )

  it.effect("degrades an image to a text note when no resized candidate fits the configured limit", () =>
    Effect.gen(function* () {
      // Mirrors how V1's own image.test.ts forces SizeError deterministically: an impossible byte
      // budget, not a synthetic corrupt image.
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({ image: new ConfigAttachments.Image({ max_base64_bytes: 1 }) }),
          }),
        }),
      ]
      const file = FileAttachment.make({ uri: smallImageDataUrl, mime: "image/png", name: "small-image.png" })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      expect(resultFile?.mime).toBe("text/plain")
      const note = Buffer.from(resultFile!.uri.slice(resultFile!.uri.indexOf(",") + 1), "base64").toString("utf8")
      expect(note).toContain("could not be processed as an image and was omitted")

      const rendered = toLLMMessages([materialized!], model)
      expect(rendered[0]?.content).toContainEqual({
        type: "text",
        text: `<file path="small-image.png" mime="text/plain">\n${note}\n</file>`,
      })
    }),
  )

  it.effect("passes an unresizable image through unchanged when the resizer is unavailable", () =>
    Effect.gen(function* () {
      configEntries = []
      const file = FileAttachment.make({ uri: smallImageDataUrl, mime: "image/png", name: "small-image.png" })
      const fsUtil = yield* FSUtil.Service
      const unavailable: SessionRunnerAttachment.Dependencies = {
        fsUtil,
        image: Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
      }

      const [materialized] = yield* SessionRunnerAttachment.materialize(unavailable, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      expect(resultFile?.uri).toBe(smallImageDataUrl)
      expect(resultFile?.mime).toBe("image/png")
    }),
  )

  it.effect("reads a file: text attachment off disk and inlines it instead of sending it as media", () =>
    Effect.gen(function* () {
      configEntries = []
      const uri = pathToFileURL(notesPath).toString()
      const file = FileAttachment.make({ uri, mime: "text/markdown", name: "notes.md" })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const rendered = toLLMMessages([materialized!], model)
      expect(rendered[0]?.content).toContainEqual({
        type: "text",
        text: `<file path="notes.md" mime="text/markdown">\n${notesText}\n</file>`,
      })
      // Never sent on the media channel: every provider's ProviderShared.validateMedia rejects a
      // text/markdown mime outright, which is exactly the bug this change fixes.
      expect(rendered[0]?.content.some((part) => part.type === "media")).toBe(false)
    }),
  )

  it.effect("reads the file behind a composer mention rather than its source token", () =>
    Effect.gen(function* () {
      configEntries = []
      const file = FileAttachment.make({
        uri: pathToFileURL(notesPath).toString(),
        mime: "text/markdown",
        name: "notes.md",
        source: { text: "@notes.md", start: 0, end: 9 },
      })
      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      expect(toLLMMessages([materialized!], model)[0]?.content).toContainEqual({
        type: "text",
        text: `<file path="notes.md" mime="text/markdown">\n${notesText}\n</file>`,
      })
    }),
  )

  it.effect("sends mentioned file contents through the OpenAI Chat HTTP transport", () =>
    Effect.gen(function* () {
      configEntries = []
      const file = FileAttachment.make({
        uri: pathToFileURL(notesPath).toString(),
        mime: "text/markdown",
        name: "notes.md",
        source: { text: "@notes.md", start: 0, end: 9 },
      })
      const wireModel = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://provider.test/v1/" }, auth: Auth.bearer("fixture") })
        .model({ id: "fixture-model" })
      const bodies: string[] = []
      const transport = dynamicResponse((input) =>
        Effect.sync(() => {
          bodies.push(input.text)
          return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
        }),
      )
      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      yield* LLM.stream(LLM.request({ model: wireModel, messages: toLLMMessages([materialized!], wireModel) })).pipe(
        Stream.runCollect,
        Effect.provide(transport),
      )
      expect(bodies).toHaveLength(1)
      const body = JSON.parse(bodies[0]!) as { messages: { role: string; content: string }[] }
      expect(body.messages).toEqual([
        { role: "user", content: `See attached<file path="notes.md" mime="text/markdown">\n${notesText}\n</file>` },
      ])
    }),
  )

  it.effect("slices a file: text attachment to the requested line range", () =>
    Effect.gen(function* () {
      configEntries = []
      const uri = `${pathToFileURL(notesPath).toString()}?start=3&end=4`
      const file = FileAttachment.make({
        uri,
        mime: "text/markdown",
        name: "notes.md",
        source: { text: "@notes.md#3-4", start: 0, end: 13 },
      })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const rendered = toLLMMessages([materialized!], model)
      expect(rendered[0]?.content).toContainEqual({
        type: "text",
        text: `<file path="notes.md" mime="text/markdown">\nLine 3: charlie\nLine 4: delta\n</file>`,
      })
    }),
  )

  it.effect("reports a missing mentioned file rather than treating its source token as content", () =>
    Effect.gen(function* () {
      configEntries = []
      const uri = pathToFileURL(path.join(FIXTURES, "does-not-exist.md")).toString()
      const file = FileAttachment.make({
        uri,
        mime: "text/plain",
        name: "selection.md",
        source: { start: 0, end: 13, text: "@selection.md" },
      })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      const rendered = toLLMMessages([materialized!], model)
      expect(resultFile?.mime).toBe("text/plain")
      expect(rendered[0]?.content.findLast((part) => part.type === "text")).toMatchObject({
        text: expect.stringContaining("Could not read attachment selection.md"),
      })
    }),
  )

  it.effect("uses data URI content and preserves cleared-media notes", () =>
    Effect.gen(function* () {
      const files = [
        FileAttachment.make({
          uri: `data:text/plain;base64,${Buffer.from("inline evidence").toString("base64")}`,
          mime: "text/plain",
          name: "inline.txt",
          source: { text: "@inline.txt", start: 0, end: 11 },
        }),
        FileAttachment.make({
          uri: "cleared:old.png",
          mime: "text/plain",
          name: "old.png",
          source: { text: "image omitted", start: 0, end: 0 },
        }),
      ]
      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage(files)])
      const content = toLLMMessages([materialized!], model)[0]?.content
      expect(content).toContainEqual({
        type: "text",
        text: '<file path="inline.txt" mime="text/plain">\ninline evidence\n</file>',
      })
      expect(content).toContainEqual({
        type: "text",
        text: '<file path="old.png" mime="text/plain">\nimage omitted\n</file>',
      })
    }),
  )

  it.effect("degrades a deleted or moved file: attachment to a note instead of failing the turn", () =>
    Effect.gen(function* () {
      configEntries = []
      const uri = pathToFileURL(path.join(FIXTURES, "gone-missing.md")).toString()
      const file = FileAttachment.make({ uri, mime: "text/markdown", name: "gone.md" })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      expect(resultFile?.mime).toBe("text/plain")
      const note = Buffer.from(resultFile!.uri.slice(resultFile!.uri.indexOf(",") + 1), "base64").toString("utf8")
      expect(note).toContain("Could not read attachment")
      // The whole message translation still succeeds -- a dead attachment degrades in place rather
      // than failing the provider turn (and, since this re-runs every turn against durable history,
      // every future turn of the session).
      expect(() => toLLMMessages([materialized!], model)).not.toThrow()
    }),
  )

  it.effect("leaves an unhandled scheme (e.g. a bare http(s) URL) unchanged, matching V1", () =>
    Effect.gen(function* () {
      configEntries = []
      const file = FileAttachment.make({
        uri: "https://example.com/image.png",
        mime: "image/png",
        name: "remote.png",
      })

      const [materialized] = yield* SessionRunnerAttachment.materialize(yield* deps, [userMessage([file])])
      const resultFile = filesOf(materialized!)?.[0]
      expect(resultFile).toEqual(file)
    }),
  )
})
