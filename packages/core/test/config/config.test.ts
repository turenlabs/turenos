import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Config } from "@turenlabs/core/config"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ConfigMigrateV1 } from "@turenlabs/core/v1/config/migrate"
import { ConfigV1 } from "@turenlabs/core/v1/config/config"
import { Global } from "@turenlabs/core/global"
import { Location } from "@turenlabs/core/location"
import { Policy } from "@turenlabs/core/policy"
import { Project } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
      ),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
}

describe("Config", () => {
  it.effect("returns the latest defined scalar from priority-ordered documents", () =>
    Effect.sync(() => {
      const entries = [
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5" }) }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
        new Config.Document({ type: "document", info: new Config.Info({}) }),
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5.5" }) }),
      ]

      expect(Config.latest(entries, "model")).toBe("openrouter/openai/gpt-5.5")
      expect(Config.latest(entries, "default_agent")).toBeUndefined()
    }),
  )

  it.effect("decodes embedded reflection cadence settings", () =>
    Effect.sync(() => {
      expect(
        Config.decodeDocument('{"reflection":{"enabled":true,"every_sessions":7}}')?.info.reflection,
      ).toMatchObject({ enabled: true, every_sessions: 7 })
      expect(Config.decodeDocument('{"reflection":{"every_sessions":0}}')?.info.reflection).toBeUndefined()
    }),
  )

  it.effect("decodes ordered local and remote skill sources", () =>
    Effect.sync(() => {
      expect(
        Config.decodeDocument(
          '{"skills":["./team-skills","~/shared-skills","https://example.com/.well-known/skills/"]}',
        )?.info.skills,
      ).toEqual(["./team-skills", "~/shared-skills", "https://example.com/.well-known/skills/"])
    }),
  )

  it.effect("detects v1 configuration from any v1-only top-level key", () =>
    Effect.sync(() => {
      expect(ConfigMigrateV1.isV1({ snapshot: false })).toBe(true)
      expect(ConfigMigrateV1.isV1({ snapshot: false, agents: {} })).toBe(true)
      expect(ConfigMigrateV1.isV1({ reference: {} })).toBe(false)
      expect(ConfigMigrateV1.isV1({ shell: "/bin/zsh", model: "anthropic/claude" })).toBe(false)
      expect(ConfigMigrateV1.isV1({ references: {} })).toBe(false)
    }),
  )

  it.effect("keeps legacy provider-only configuration visible to the v2 catalog", () =>
    Effect.sync(() => {
      const info = Config.decodeDocument(
        JSON.stringify({
          $schema: "https://github.com/turenlabs/forge/config.json",
          provider: {
            "local-qwen": {
              name: "Local Qwen",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://localhost:11434/v1" },
              models: { qwen: { name: "Qwen" } },
            },
          },
        }),
      )?.info

      expect(info?.providers?.["local-qwen"]).toMatchObject({
        name: "Local Qwen",
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "http://localhost:11434/v1",
        },
        models: { qwen: { name: "Qwen" } },
      })
    }),
  )

  // Every detection key must survive migration or be recorded as retired. A key
  // that is neither is dropped silently, and because detection is per-document
  // it takes the rest of the file with it.
  it.effect("carries every v1 detection key through migration or records why it was retired", () =>
    Effect.sync(() => {
      const samples: Record<string, unknown> = {
        logLevel: "DEBUG",
        server: { port: 4096 },
        command: { deploy: { template: "Ship it" } },
        snapshot: false,
        small_model: "anthropic/claude-haiku",
        mode: { build: {} },
        agent: { reviewer: { prompt: "Review." } },
        permission: { bash: "ask" },
        tools: { bash: true },
        attachment: { image: { max_width: 1200 } },
        layout: "stretch",
        plugin: ["./plugin.ts"],
      }

      expect(Object.keys(ConfigMigrateV1.retired).filter((key) => !ConfigMigrateV1.keys.has(key))).toEqual([])
      expect([...ConfigMigrateV1.keys].filter((key) => !(key in samples))).toEqual([])

      for (const key of ConfigMigrateV1.keys) {
        const migrated = ConfigMigrateV1.migrate({ [key]: samples[key] } as typeof ConfigV1.Info.Type)
        const carried = Object.values(migrated).some((value) => value !== undefined)
        const reason = ConfigMigrateV1.retired[key]
        // A retired key must genuinely produce nothing, so the list cannot drift
        // into excusing a key the migration was supposed to carry.
        if (reason) expect({ key, carried, reason }).toEqual({ key, carried: false, reason })
        else expect({ key, carried }).toEqual({ key, carried: true })
      }
    }),
  )

  it.effect("drops Extension-owned and retired transport controls while decoding and migrating", () =>
    Effect.sync(() => {
      const extensionOwned = {
        provider: { openai: { apiKey: "secret" } },
        providers: { openai: { apiKey: "secret" } },
        mcp: { server: { command: ["node", "server.js"] } },
        enabled_providers: ["openai"],
        disabled_providers: ["anthropic"],
      }
      const decoded = Config.decodeDocument(
        JSON.stringify({
          ...extensionOwned,
          agents: {
            reviewer: {
              system: "Review carefully.",
              options: { retries: 2 },
              temperature: 0.2,
              top_p: 0.9,
            },
          },
        }),
      )?.info
      const migrated = Config.decodeDocument(
        JSON.stringify({
          ...extensionOwned,
          snapshot: false,
          agent: {
            reviewer: {
              prompt: "Review carefully.",
              options: { retries: 2 },
              temperature: 0.2,
              top_p: 0.9,
            },
          },
        }),
      )?.info

      for (const info of [decoded, migrated]) {
        expect(info).toBeInstanceOf(Config.Info)
        for (const key of ["provider", "mcp", "enabled_providers", "disabled_providers"]) {
          expect(info).not.toHaveProperty(key)
        }
        expect(info?.agents?.reviewer?.system).toBe("Review carefully.")
        expect(info?.agents?.reviewer).not.toHaveProperty("options")
        expect(info?.agents?.reviewer).not.toHaveProperty("temperature")
        expect(info?.agents?.reviewer).not.toHaveProperty("top_p")
      }

      // `providers` is v2's own spelling of provider configuration (specs/v2/config.md:201), so a
      // v2 document keeps it; only the v1 `provider` block and the legacy allow/deny lists lower away.
      // The second document is classified v1, and the v1 migration has no v2 `providers` to carry.
      expect(decoded?.providers).toBeDefined()
      expect(migrated?.providers).toBeDefined()
    }),
  )

  // `compaction` is written by both versions, so it can never be a discriminator. v1's block is
  // recognised by its own key names instead, and lowered in place — `auto` and `prune` are spelled
  // identically in both, so classifying by shape is not an option either: a v2 file carrying
  // `tail_turns` would be decoded against the v1 schema and lose every v2-only block.
  it.effect("lowers v1 compaction knobs without classifying the document as v1", () =>
    Effect.sync(() => {
      expect(ConfigMigrateV1.keys.has("compaction")).toBe(false)
      expect(ConfigMigrateV1.isV1({ agents: {}, compaction: { tail_turns: 5 } })).toBe(false)

      expect(
        ConfigMigrateV1.compactionAliases({
          auto: true,
          prune: true,
          tail_turns: 5,
          preserve_recent_tokens: 16000,
          reserved: 30000,
        }),
      ).toMatchObject({ auto: true, prune: true, keep: { tokens: 16000, turns: 5 }, buffer: 30000 })

      // Only the v1 name is ambiguous about intent, so an authored v2 key wins.
      expect(
        ConfigMigrateV1.compactionAliases({
          keep: { tokens: 1000, turns: 3 },
          buffer: 1,
          tail_turns: 9,
          preserve_recent_tokens: 9,
          reserved: 9,
        }),
      ).toMatchObject({ keep: { tokens: 1000, turns: 3 }, buffer: 1 })

      expect(ConfigMigrateV1.compactionAliases({ auto: false, keep: { turns: 4 } })).toBeUndefined()
      expect(ConfigMigrateV1.compactionAliases(undefined)).toBeUndefined()
    }),
  )

  // `ConfigCompaction` carries no range check because `Config.loadFile` drops any document it
  // cannot decode. Forwarding an unchecked v1 alias into a v2 key would put that range back and
  // delete the rest of the user's config on a typo, so a malformed alias stays behind.
  it.effect("never lowers a compaction value that would fail to decode", () =>
    Effect.sync(() => {
      for (const value of [-5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "lots", null, {}]) {
        expect({ value, lowered: ConfigMigrateV1.compactionAliases({ tail_turns: value }) }).toEqual({
          value,
          lowered: undefined,
        })
      }
      // A malformed `keep` is left exactly as authored rather than replaced, so a document that
      // fails to decode today cannot start loading with settings the user never wrote.
      expect(ConfigMigrateV1.compactionAliases({ keep: "recent", tail_turns: 5 })).toBeUndefined()
    }),
  )

  it.effect("migrates arbitrary v1 configuration into valid v2 configuration", () =>
    Effect.sync(() => {
      FastCheck.assert(
        FastCheck.property(Schema.toArbitrary(ConfigV1.Info), (info) => {
          Schema.decodeUnknownSync(Config.Info)(ConfigMigrateV1.migrate(info), { errors: "all" })
        }),
        { numRuns: 100 },
      )
    }),
  )

  it.effect("migrates v1 command configuration", () =>
    Effect.sync(() => {
      expect(
        ConfigMigrateV1.migrate({
          command: {
            review: {
              template: "Review changes",
              description: "Review code",
              agent: "reviewer",
              model: "anthropic/claude",
              variant: "high",
              subtask: true,
            },
          },
        }).commands,
      ).toEqual({
        review: {
          template: "Review changes",
          description: "Review code",
          agent: "reviewer",
          model: "anthropic/claude",
          variant: "high",
          subtask: true,
        },
      })
    }),
  )

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()

          expect(entries).toEqual([
            new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("loads opencode JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "forge.json"), JSON.stringify({ $schema: "base", shell: "/bin/zsh" })),
              fs.writeFile(
                path.join(tmp.path, "forge.jsonc"),
                `{
                  // Later files are loaded after earlier files.
                  "$schema": "last",
                  "username": "test-user",
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(2)
            expect(documents.map((document) => document.type)).toEqual(["document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "last"])
            expect(documents[0]).toBeInstanceOf(Config.Document)
            expect(documents[0]?.path).toBe(path.join(tmp.path, "forge.json"))
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[1]?.info.username).toBe("test-user")

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "forge.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  // The reported downgrade, end to end through the real loader: `auto` and `prune` are spelled
  // the same in both versions, so before this the dangerous half of a v1 block survived and every
  // preservation knob fell back to a default — a user who asked to keep 5 turns and 16k tokens
  // got 2 turns and 8k with pruning still on.
  it.live("loads v1 compaction knobs from a document that is otherwise v2", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "forge.json"),
              JSON.stringify({
                agents: { reviewer: { description: "Review changes" } },
                compaction: {
                  auto: true,
                  prune: true,
                  tail_turns: 5,
                  preserve_recent_tokens: 16000,
                  reserved: 30000,
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.compaction).toMatchObject({
              auto: true,
              prune: true,
              keep: { tokens: 16000, turns: 5 },
              buffer: 30000,
            })
            // Lowering must not classify the file as v1, which would drop every v2-only block.
            expect(Object.keys(documents[0]?.info.agents ?? {})).toEqual(["reviewer"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("does not load legacy config.json files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "legacy" })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "forge.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.experimental?.policies?.[0]).toEqual({
              effect: "deny",
              action: "provider.use",
              resource: "openai",
            })
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "forge.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                autoupdate: "notify",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5",
                    variant: "high",
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "warning",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                subagents: { max_concurrent: 6 },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                },
                lsp: { typescript: { disabled: true } },
                attachments: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                retention: { archivedSessionDays: 45, toolOutputDays: 0 },
                compaction: {
                  auto: true,
                  prune: false,
                  keep: { tokens: 2000 },
                  buffer: 10000,
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toBe("anthropic/claude")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.autoupdate).toBe("notify")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toBe("openrouter/openai/gpt-5")
            expect(reviewer?.variant).toBe("high")
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("warning")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.subagents).toEqual({ max_concurrent: 6 })
            // `subagents` must not be a v1 discriminator: a file carrying it has
            // to keep decoding as v2, with every other v2 block intact.
            expect(ConfigMigrateV1.isV1({ subagents: { max_concurrent: 6 } })).toBe(false)
            // `0` is the explicit "never" and has to survive the round trip as `0`, not be
            // dropped as falsy -- dropping it would silently restore the default window.
            expect(documents[0]?.info.retention).toEqual({ archivedSessionDays: 45, toolOutputDays: 0 })
            expect(ConfigMigrateV1.isV1({ retention: { toolOutputDays: 7 } })).toBe(false)
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
            })
            expect(documents[0]?.info.attachments).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              prune: false,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates v1 configuration when a v1-only key is present", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "forge.json"),
              JSON.stringify({
                shell: "/bin/zsh",
                default_agent: "reviewer",
                snapshot: false,
                permission: {
                  bash: "ask",
                  edit: { "*.md": "allow", "*": "deny" },
                  question: "deny",
                },
                agent: {
                  reviewer: {
                    prompt: "Review changes.",
                    disable: true,
                    permission: { read: "allow" },
                  },
                },
                attachment: { image: { auto_resize: false, max_width: 1200 } },
                compaction: { auto: true, tail_turns: 3, preserve_recent_tokens: 2000, reserved: 10000 },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info).toBeInstanceOf(Config.Info)
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "edit", resource: "*.md", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
              { action: "question", resource: "*", effect: "deny" },
            ])
            expect(documents[0]?.info.agents?.reviewer).toMatchObject({
              system: "Review changes.",
              disabled: true,
              permissions: [{ action: "read", resource: "*", effect: "allow" }],
            })
            expect(documents[0]?.info.attachments).toEqual({ image: { auto_resize: false, max_width: 1200 } })
            // `tail_turns` is the v1 spelling of `keep.turns`. It had no target in `migrate`, so
            // the one knob v2 added for whole-turn preservation was unreachable from any v1 file.
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              prune: undefined,
              keep: { tokens: 2000, turns: 3 },
              buffer: 10000,
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores an invalid file while loading valid config values", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "forge.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "forge.jsonc"), "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads policy statements in reverse config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(
              path.join(global, "forge.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
              }),
            )
            await fs.writeFile(
              path.join(tmp.path, "forge.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "allow", action: "provider.use", resource: "openai" }] },
              }),
            )
          })

          return yield* Effect.gen(function* () {
            const policy = yield* Policy.Service

            expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
          }).pipe(Effect.provide(testLayer(tmp.path, global)))
        })
      }),
    ),
  )

  it.live("loads global, ancestor, and .forge configuration up to the project boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".forge"), { recursive: true })
            await fs.mkdir(path.join(directory, ".forge"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "forge.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "forge.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "forge.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "forge.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "forge.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".forge", "forge.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(path.join(directory, ".forge", "forge.jsonc"), JSON.stringify({ $schema: "directory-dot" })),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const documents = entries.filter((entry) => entry.type === "document")

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".forge")),
              AbsolutePath.make(path.join(directory, ".forge")),
            ])
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              "global",
              AbsolutePath.make(global),
              "root",
              "parent",
              "directory",
              "root-dot",
              AbsolutePath.make(path.join(root, ".forge")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".forge")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )
})
