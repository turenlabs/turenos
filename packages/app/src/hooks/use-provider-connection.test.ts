import { describe, expect, test } from "bun:test"
import { shouldClearAuthOnDisconnect, shouldReauthenticateOnReconnect } from "./use-provider-connection"

describe("provider connection", () => {
  test("clears OpenAI auth on disconnect so Connect cannot reuse the ChatGPT session", () => {
    expect(shouldClearAuthOnDisconnect("openai")).toBe(true)
    expect(shouldClearAuthOnDisconnect("xai")).toBe(false)
    expect(shouldClearAuthOnDisconnect("anthropic")).toBe(false)
  })

  test("opens a fresh auth flow when reconnecting OpenAI or xAI", () => {
    expect(shouldReauthenticateOnReconnect("openai")).toBe(true)
    expect(shouldReauthenticateOnReconnect("xai")).toBe(true)
    expect(shouldReauthenticateOnReconnect("anthropic")).toBe(false)
  })
})
