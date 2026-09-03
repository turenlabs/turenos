import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Storage } from "@turenlabs/core/storage"
import { ConfigV1 } from "@turenlabs/core/v1/config/config"
import { ConfigMcpLegacyV1 } from "@turenlabs/core/v1/config/mcp-legacy"
import { Effect } from "effect"
import { ConfigMcpLegacy } from "@/config/mcp-legacy"
import { ConfigParse } from "@/config/parse"
import { configErrorMessage } from "@/util/error"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ExtensionRuntime.node, Storage.node])))

const notion = "turenlabs/notion"
const notionEntry = {
  kind: "enable",
  name: "notion",
  extension: notion,
  detail: "https://mcp.notion.com/mcp",
} satisfies ConfigMcpLegacyV1.Enable

describe("ConfigMcpLegacy.activate", () => {
  it.effect("turns on the extension that replaced a legacy remote server", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      expect(yield* extensions.enabled(notion)).toBe(false)

      const result = yield* ConfigMcpLegacy.activate([notionEntry])

      expect(result.activated).toEqual([notion])
      expect(yield* extensions.enabled(notion)).toBe(true)
    }),
  )

  it.effect("offers each extension once, so a later opt-out is never undone", () =>
    Effect.gen(function* () {
      const extensions = yield* ExtensionRuntime.Service
      yield* ConfigMcpLegacy.activate([notionEntry])
      // The user changes their mind in Settings.
      yield* extensions.update(notion, { enabled: false }, { local: true })

      const second = yield* ConfigMcpLegacy.activate([notionEntry])

      expect(second).toEqual({ activated: [], skipped: [notion] })
      expect(yield* extensions.enabled(notion)).toBe(false)
    }),
  )

  it.effect("recreates nothing for the obsolete or unmapped servers it was handed", () =>
    Effect.gen(function* () {
      const result = yield* ConfigMcpLegacy.activate([
        { kind: "obsolete", name: "forge-security", detail: "superseded" },
        { kind: "unmapped", name: "acme", detail: "no extension provides it" },
        { kind: "disabled", name: "notion", detail: "the server was disabled" },
      ])

      expect(result).toEqual({ activated: [], skipped: [] })
      expect(yield* ExtensionRuntime.Service.use((svc) => svc.enabled(notion))).toBe(false)
    }),
  )

  it.effect("does nothing at all when the config never declared MCP servers", () =>
    Effect.gen(function* () {
      expect(yield* ConfigMcpLegacy.activate(undefined)).toEqual({ activated: [], skipped: [] })
    }),
  )
})

// The failure this whole change exists to stop surfaced to the UI as the bare string
// "ConfigInvalidError", because NamedError passes its *name* to Error and everything useful lives on
// `.data`. Whatever else changes, an invalid config has to name the file and the key.
describe("configErrorMessage", () => {
  const invalid = (data: unknown, source: string) => {
    try {
      ConfigParse.schema(ConfigV1.Info, data, source)
      throw new Error("expected the config parse to fail")
    } catch (error) {
      return error
    }
  }

  test("names the offending key and the file it came from", () => {
    const error = invalid({ model: "test/model", banana: true }, "/home/u/.config/forge/forge.jsonc")

    expect((error as Error).message).toBe("ConfigInvalidError")
    expect(configErrorMessage(error)).toBe(
      "Configuration is invalid at /home/u/.config/forge/forge.jsonc\n↳ Unrecognized key: banana",
    )
  })

  test("spells out a value that failed validation, with its path", () => {
    const message = configErrorMessage(invalid({ subagent_depth: -1 }, "/home/u/.config/forge/forge.jsonc"))

    expect(message).toContain("/home/u/.config/forge/forge.jsonc")
    expect(message).toContain("subagent_depth")
  })

  test("leaves errors that are not config errors to the generic path", () => {
    expect(configErrorMessage(new Error("EACCES: permission denied"))).toBeUndefined()
    expect(configErrorMessage("not an error")).toBeUndefined()
  })
})
