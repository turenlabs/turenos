import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Auth, Framing } from "../src/route"
import { LLMError, TransportReason } from "../src/schema"
import { it } from "./lib/effect"

describe("Route.with", () => {
  test("merges endpoint query and header defaults while replacing auth and id", () => {
    const auth = Auth.headers({ "x-auth": "new" })
    const route = OpenAIChat.route
      .with({
        id: "base-chat",
        endpoint: {
          baseURL: "https://api.example.test/v1",
          query: { keep: "base", base: "1" },
        },
        headers: { "x-base": "base", "x-override": "base" },
        auth: Auth.headers({ "x-auth": "old" }),
      })
      .with({
        id: "patched-chat",
        endpoint: { query: { keep: "patch", patch: "1" } },
        headers: { "x-override": "patch", "x-patch": "patch" },
        auth,
      })

    expect(route.id).toBe("patched-chat")
    expect(route.auth).toBe(auth)
    expect(route.endpoint).toMatchObject({
      baseURL: "https://api.example.test/v1",
      path: "/chat/completions",
      query: { keep: "patch", base: "1", patch: "1" },
    })
    expect(route.defaults.headers).toEqual({
      "x-base": "base",
      "x-override": "patch",
      "x-patch": "patch",
    })
    expect(route.defaults.http?.headers).toEqual({
      "x-base": "base",
      "x-override": "patch",
      "x-patch": "patch",
    })
  })
})

describe("SSE framing", () => {
  it.effect("preserves data before and after a retry directive", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder()
      const stream = Framing.sse.frame(
        Stream.fromIterable(
          ["data: before\n\n", "retry: 1000\n\n", "data: after\n\n"].map((chunk) => encoder.encode(chunk)),
        ),
      )
      expect(yield* Stream.runCollect(stream)).toEqual(["before", "after"])
      expect(yield* Stream.runCollect(stream)).toEqual(["before", "after"])
    }),
  )

  it.effect("propagates upstream LLM errors after a retry directive", () =>
    Effect.gen(function* () {
      const error = new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "lost" }) })
      const stream = Framing.sse.frame(
        Stream.concat(Stream.make(new TextEncoder().encode("retry: 1000\n\n")), Stream.fail(error)),
      )
      expect(yield* Stream.runCollect(stream).pipe(Effect.flip)).toBe(error)
    }),
  )

  it.effect("finalizes upstream on downstream cancellation", () =>
    Effect.gen(function* () {
      let finalized = false
      const bytes = Stream.concat(
        Stream.make(new TextEncoder().encode("retry: 1000\n\ndata: first\n\n")),
        Stream.never,
      ).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            finalized = true
          }),
        ),
      )
      expect(yield* Framing.sse.frame(bytes).pipe(Stream.take(1), Stream.runCollect)).toEqual(["first"])
      expect(finalized).toBe(true)
    }),
  )

  it.effect("preserves split UTF-8 and multiline data around retry directives", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(
        ": comment\nretry: 1000\n\ndata: café\ndata: next\n\nretry: 250\n\ndata: [DONE]\n\ndata: last\n\n",
      )
      const stream = Framing.sse.frame(Stream.fromIterable(Array.from(bytes, (byte) => new Uint8Array([byte]))))
      expect(yield* Stream.runCollect(stream)).toEqual(["café\nnext", "last"])
      expect(yield* Stream.runCollect(stream)).toEqual(["café\nnext", "last"])
    }),
  )
})
