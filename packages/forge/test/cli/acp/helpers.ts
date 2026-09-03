import { expect } from "bun:test"
import type { InitializeResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import type { CliFixture } from "../../lib/cli-process"
import { createAcpClient as createJsonRpcAcpClient, expectOk, type AcpClient } from "./acp-test-client"

export function createAcpClient(input: Pick<CliFixture, "opencode">, env?: Record<string, string>) {
  return Effect.gen(function* () {
    return createJsonRpcAcpClient(yield* input.opencode.acp(env ? { env } : undefined))
  })
}

export function initialize(acp: AcpClient) {
  return Effect.gen(function* () {
    return expectOk(
      yield* acp.request<InitializeResponse>("initialize", {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "terminal-auth": true } },
        clientInfo: { name: "opencode-local-acp", version: "0.1.0" },
      }),
    )
  })
}

export function expectErrorCode(error: unknown, code: number) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    expect(error).toEqual({ code })
    return
  }
  expect(error.code).toBe(code)
}
