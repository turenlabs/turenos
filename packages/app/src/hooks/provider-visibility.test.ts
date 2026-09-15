import { describe, expect, test } from "bun:test"
import {
  isLocalProvider,
  isLocalProviderEndpoint,
  isLocalProviderID,
  isRemovedProvider,
  localProviders,
} from "./provider-visibility"

const provider = (id: string, baseURL?: string) => ({
  id,
  options: baseURL === undefined ? undefined : { baseURL },
})

describe("isLocalProvider", () => {
  test("classifies the known local provider ids", () => {
    for (const meta of localProviders) {
      expect(isLocalProvider(provider(meta.id))).toBe(true)
    }
    expect(isLocalProviderID("claude-code")).toBe(true)
    expect(isLocalProviderID("muse-code")).toBe(true)
    expect(isLocalProviderID("ollama")).toBe(true)
    expect(isLocalProviderID("llama-cpp")).toBe(true)
  })

  test("classifies local:// sentinel providers", () => {
    expect(isLocalProviderEndpoint("local://claude-code")).toBe(true)
    expect(isLocalProvider(provider("anything", "local://muse-code"))).toBe(true)
  })

  test("classifies loopback endpoints, including schemeless and IPv6", () => {
    expect(isLocalProviderEndpoint("http://127.0.0.1:11434/v1")).toBe(true)
    expect(isLocalProviderEndpoint("http://localhost:1234/v1")).toBe(true)
    expect(isLocalProviderEndpoint("http://[::1]:8080")).toBe(true)
    expect(isLocalProviderEndpoint("localhost:8080")).toBe(true)
    expect(isLocalProvider(provider("custom-local", "http://127.0.0.1:9999"))).toBe(true)
  })

  test("keeps remote providers cloud-side", () => {
    expect(isLocalProvider(provider("anthropic", "https://api.anthropic.com"))).toBe(false)
    expect(isLocalProvider(provider("ollama-cloud", "https://ollama.com/v1"))).toBe(false)
    expect(isLocalProvider(provider("openai"))).toBe(false)
    // Lookalike hostnames are not loopback.
    expect(isLocalProviderEndpoint("http://localhost.evil.com")).toBe(false)
    expect(isLocalProviderEndpoint("http://127.0.0.1.evil.com")).toBe(false)
  })

  test("tolerates missing and malformed endpoints", () => {
    expect(isLocalProviderEndpoint(undefined)).toBe(false)
    expect(isLocalProviderEndpoint(null)).toBe(false)
    expect(isLocalProviderEndpoint("")).toBe(false)
    expect(isLocalProviderEndpoint(8080)).toBe(false)
    expect(isLocalProviderEndpoint("not a url ://")).toBe(false)
    expect(isLocalProvider(provider("custom"))).toBe(false)
  })

  test("isLocalProviderID falls back to the configured endpoint", () => {
    expect(isLocalProviderID("custom-local", "http://127.0.0.1:9000")).toBe(true)
    expect(isLocalProviderID("custom-cloud", "https://api.example.com")).toBe(false)
    expect(isLocalProviderID("custom-cloud")).toBe(false)
  })
})

describe("isRemovedProvider", () => {
  test("withholds retired providers only", () => {
    expect(isRemovedProvider("opencode")).toBe(true)
    expect(isRemovedProvider("ollama")).toBe(false)
  })
})
