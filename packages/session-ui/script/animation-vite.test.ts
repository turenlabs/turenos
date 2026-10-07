import { expect, test } from "bun:test"
import { animationRuntimePlugin, visualizationNotices } from "../animation.vite.js"

test("owned runtime bundles as an inline classic script without external imports", async () => {
  const plugin = animationRuntimePlugin()
  const watched: string[] = []
  const module = await plugin.load.call(
    { addWatchFile: (file: string) => watched.push(file) },
    "\0virtual:turen-animation-runtime",
  )
  expect(module).toStartWith("export default ")
  const source = JSON.parse(module!.slice("export default ".length, -1)) as string
  expect(() => new Function(source)).not.toThrow()
  expect(source).toContain("(()=>")
  expect(source).not.toMatch(/\bimport\s*\(/)
  expect(watched.some((file) => file.endsWith("animation-runtime.ts"))).toBe(true)
  expect(watched.some((file) => file.includes("animejs"))).toBe(true)
}, 30_000)

test("ship original notices for D3, Anime.js, and runtime dependencies", () => {
  const text = visualizationNotices()
  expect(text).toContain("d3@7.9.0 (ISC)")
  expect(text).toContain("animejs@4.5.0 (MIT)")
  expect(text).toContain("Copyright (c) 2025 Julian Garnier")
  expect(text).toContain("Copyright 2010-2023 Mike Bostock")
  expect(text).toContain("internmap@")
})
