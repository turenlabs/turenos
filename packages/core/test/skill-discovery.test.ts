import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNodePlatform } from "@turenlabs/core/effect/app-node-platform"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Global } from "@turenlabs/core/global"
import { SkillDiscovery } from "@turenlabs/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("SkillDiscovery", () => {
  testEffect(Layer.empty).live("caches valid same-origin files and ignores unsafe index entries", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const requests: string[] = []
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request.url)
              const body = responseFor(request.url)
              return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
            }),
          ),
        )
        const layer = LayerNode.compile(SkillDiscovery.node, [
          [Global.node, Global.layerWith({ cache: path.join(tmp.path, "cache") })],
          [LayerNodePlatform.httpClient, http],
        ])
        return Effect.gen(function* () {
          const discovery = yield* SkillDiscovery.Service
          const first = yield* discovery.pull("https://skills.example.test/catalog")
          const second = yield* discovery.pull("https://skills.example.test/catalog/")

          expect(second).toEqual(first)
          expect(first).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readFile(path.join(first[0]!, "SKILL.md"), "utf8"))).toContain(
            "Safe guidance",
          )
          expect(requests.filter((url) => url.endsWith("/safe/SKILL.md"))).toHaveLength(1)
          expect(requests.some((url) => url.includes("attacker.example"))).toBe(false)
          expect(requests.some((url) => url.includes("unsafe"))).toBe(false)
          expect(
            yield* Effect.promise(() =>
              fs.stat(path.join(tmp.path, "escape.md")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }).pipe(Effect.provide(layer))
      }),
    ),
  )

  testEffect(Layer.empty).live("rejects redirects for indexes and skill files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const indexRedirect = yield* discoveryLayer(tmp.path, (request) =>
            request.url.endsWith("/index.json")
              ? new Response(null, { status: 302, headers: { location: "https://attacker.example/index.json" } })
              : new Response("unexpected", { status: 500 }),
          )
          expect(yield* indexRedirect.pull("https://skills.example.test/catalog")).toEqual([])

          const fileRedirect = yield* discoveryLayer(tmp.path, (request) =>
            request.url.endsWith("/index.json")
              ? new Response(JSON.stringify({ skills: [{ name: "safe", files: ["SKILL.md"] }] }))
              : new Response(null, { status: 302, headers: { location: "https://attacker.example/SKILL.md" } }),
          )
          expect(yield* fileRedirect.pull("https://skills.example.test/redirected")).toEqual([])
        }),
      ),
    ),
  )
})

function discoveryLayer(
  root: string,
  response: (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => Response,
) {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response(request)))),
  )
  const layer = LayerNode.compile(SkillDiscovery.node, [
    [Global.node, Global.layerWith({ cache: path.join(root, crypto.randomUUID()) })],
    [LayerNodePlatform.httpClient, http],
  ])
  return Effect.gen(function* () {
    return yield* SkillDiscovery.Service
  }).pipe(Effect.provide(layer))
}

function responseFor(url: string) {
  if (url.endsWith("/index.json")) {
    return JSON.stringify({
      skills: [
        { name: "safe", version: "1", files: ["SKILL.md", "reference.md"] },
        { name: "unsafe", version: "1", files: ["SKILL.md", "../escape.md"] },
        { name: "cross-origin", version: "1", files: ["SKILL.md", "https://attacker.example/file.md"] },
      ],
    })
  }
  if (url.endsWith("/safe/SKILL.md")) {
    return "---\nname: safe\ndescription: Safe discovery\n---\nSafe guidance"
  }
  if (url.endsWith("/safe/reference.md")) return "Reference"
  throw new Error(`Unexpected request: ${url}`)
}
