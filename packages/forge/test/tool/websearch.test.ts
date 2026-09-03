import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseResponse } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, webSearchModelName, webSearchProviderLabel } from "../../src/tool/websearch"

import { it } from "../lib/effect"
import { ProviderV2 } from "@turenlabs/core/provider"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    const enabled = { exa: true, parallel: true }
    expect(selectWebSearchProvider(SESSION_ID, enabled)).toBe(selectWebSearchProvider(SESSION_ID, enabled))
  })

  test("routes only to enabled Extension providers", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: false })).toBeUndefined()
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})
