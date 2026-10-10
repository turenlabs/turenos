import { describe, expect, test } from "bun:test"
import { ProviderURL } from "../src/provider-url"
import { SessionTitle } from "../src/session-title"
import { TurnInterruption } from "../src/turn-interruption"

describe("session title", () => {
  test("a placeholder records its kind and creation time", () => {
    const at = Date.UTC(2026, 9, 8, 1, 2, 3, 456)
    expect(SessionTitle.placeholder("new", at)).toBe("New session - 2026-10-08T01:02:03.456Z")
    expect(SessionTitle.parsePlaceholder(SessionTitle.placeholder("new", at))).toEqual({ kind: "new", at })
    expect(SessionTitle.parsePlaceholder(SessionTitle.placeholder("child", at))).toEqual({ kind: "child", at })
  })

  test("any other title is not a placeholder", () => {
    for (const title of [
      "Fix the build",
      "New session - 2026-10-08T01:02:03Z",
      "New session - 2026-10-08T01:02:03.456789Z",
      "new session - 2026-10-08T01:02:03.456Z",
      "New session - 2026-10-08T01:02:03.456Z and more",
    ])
      expect(SessionTitle.parsePlaceholder(title)).toBeUndefined()
  })

  test("a placeholder-shaped name with no real time keeps its kind", () => {
    expect(SessionTitle.parsePlaceholder("New session - 2026-13-45T00:00:00.000Z")?.at).toBeNaN()
  })
})

describe("turn interruption", () => {
  test("only the runner's turn messages read as interrupted", () => {
    expect(TurnInterruption.isTurnInterrupted(TurnInterruption.TURN)).toBe(true)
    expect(TurnInterruption.isTurnInterrupted(TurnInterruption.BEFORE_START)).toBe(true)
    expect(TurnInterruption.isTurnInterrupted(TurnInterruption.SETTLEMENT)).toBe(true)
    expect(TurnInterruption.isTurnInterrupted(TurnInterruption.TOOL)).toBe(false)
    expect(TurnInterruption.isTurnInterrupted("Provider turn interrupted: rate limited")).toBe(false)
  })
})

describe("provider URL", () => {
  test("HTTPS anywhere, HTTP only on loopback and private addresses", () => {
    for (const url of [
      "https://api.example.com/v1",
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.10/v1",
    ])
      expect(ProviderURL.qualified(url)).toBe(true)
    for (const url of [
      undefined,
      "",
      "not a url",
      "http://api.example.com",
      "http://172.15.0.1",
      "http://172.32.0.1",
      "http://8.8.8.8",
      "ftp://10.0.0.1",
      "https://user:pass@api.example.com",
      "https://api.example.com/#fragment",
    ])
      expect(ProviderURL.qualified(url)).toBe(false)
  })
})
