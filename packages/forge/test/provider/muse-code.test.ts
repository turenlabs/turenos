import { expect, test } from "bun:test"
import { MuseCodeCLI } from "@turenlabs/core/provider/muse-code"
import { MuseCodeProvider } from "../../src/provider/muse-code"

test("Muse legacy catalog shares model IDs and effort levels with core", () => {
  const provider = MuseCodeProvider.info()
  expect(provider.id).toBe(MuseCodeCLI.ID)
  expect(provider.env).toEqual([])
  expect(Object.keys(provider.models)).toEqual(MuseCodeCLI.MODELS.map((model) => model.id))
  for (const item of MuseCodeCLI.MODELS) {
    const model = provider.models[item.id]!
    expect(model.api).toEqual({ id: item.apiID, npm: "muse-code-cli", url: "local://muse-code" })
    expect(Object.keys(model.variants ?? {})).toEqual([...item.efforts])
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.attachment).toBe(false)
    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  }
})

test("Muse discovery does not claim a missing executable is authenticated", async () => {
  expect(await MuseCodeCLI.probe("turen-missing-muse-executable-test")).toEqual({ status: "unavailable" })
})
