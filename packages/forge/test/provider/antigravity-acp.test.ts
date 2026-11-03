import { expect, test } from "bun:test"
import { AntigravityAcpCLI } from "@turenlabs/core/provider/antigravity-acp"
import { AntigravityAcpProvider } from "../../src/provider/antigravity-acp"

test("Antigravity ACP legacy catalog shares Gemini model IDs and effort levels with core", () => {
  const provider = AntigravityAcpProvider.info()
  expect(provider.id).toBe(AntigravityAcpCLI.ID)
  expect(provider.env).toEqual([])
  expect(Object.keys(provider.models)).toEqual(AntigravityAcpCLI.MODELS.map((model) => model.id))
  for (const item of AntigravityAcpCLI.MODELS) {
    const model = provider.models[item.id]!
    expect(model.api).toEqual({ id: item.apiID, npm: "antigravity-acp", url: "local://antigravity-acp" })
    expect(Object.keys(model.variants ?? {})).toEqual([...item.efforts])
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.attachment).toBe(false)
    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  }
})

test("Antigravity ACP discovery does not claim a missing executable is installed", async () => {
  expect(await AntigravityAcpCLI.probe("turen-missing-agy-acp-executable-test", { PATH: "" })).toEqual({
    status: "unavailable",
  })
})
