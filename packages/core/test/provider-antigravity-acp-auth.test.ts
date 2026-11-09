import { describe, expect } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { AntigravityAcpAuth } from "../src/provider/antigravity-acp-auth"
import { it } from "./lib/effect"

const url =
  "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F&state=native-state&code_challenge=native-challenge"
const fake = (body: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "turen-acp-auth-test-"))
      const executable = path.join(directory, "agy_acp_server.par")
      const capture = path.join(directory, "capture.json")
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          `import {writeFileSync} from "node:fs"`,
          `import {createInterface} from "node:readline"`,
          `const received=[]`,
          `const save=()=>writeFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,cwd:process.cwd(),received}))`,
          `save()`,
          `const send=(message)=>process.stdout.write(JSON.stringify(message)+"\\n")`,
          `const rl=createInterface({input:process.stdin})`,
          body,
        ].join("\n"),
      )
      chmodSync(executable, 0o755)
      return { executable, capture }
    }),
    (child) => Effect.sync(() => rmSync(path.dirname(child.executable), { recursive: true, force: true })),
  )

const standard = (options?: { wait?: boolean; fail?: boolean; missingMethod?: boolean; url?: string }) => `
rl.on("line", (line)=>{
  const message=JSON.parse(line)
  received.push(message)
  save()
  if(message.method==="initialize") return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,authMethods:${options?.missingMethod ? "[]" : '[{id:"oauth-personal",name:"Google"}]'}}})
  if(message.method==="authenticate") {
    process.stderr.write("Benign documentation warning: https://example.com/help\\n")
    process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.goo")
    process.stderr.write(${JSON.stringify((options?.url ?? url).replace("https://accounts.goo", ""))}+"\\n")
    if(${Boolean(options?.wait)}) return
    return send({jsonrpc:"2.0",id:message.id,${options?.fail ? 'error:{code:-32000,message:"private-token-diagnostic"}' : "result:{}"}})
  }
  if(message.method==="session/new") return send({jsonrpc:"2.0",id:message.id,result:{sessionId:"verified-session"}})
})
`

const cleanup = (capture: string) => {
  const value = JSON.parse(readFileSync(capture, "utf8")) as {
    pid: number
    cwd: string
    received: { method: string; params: Record<string, unknown> }[]
  }
  expect(() => process.kill(value.pid, 0)).toThrow()
  expect(existsSync(value.cwd)).toBe(false)
  return value
}

describe("Antigravity ACP native authentication", () => {
  it.live("keeps the runtime alive through Google authentication, verifies a session, and cleans up", () =>
    Effect.gen(function* () {
      const child = yield* fake(standard())
      const seen: string[] = []
      yield* AntigravityAcpAuth.authenticate({
        executable: child.executable,
        onWaiting: (value) => seen.push(value),
      }).pipe(Effect.scoped, Effect.timeout("10 seconds"))
      expect(seen).toEqual([url])
      const captured = cleanup(child.capture)
      expect(captured.received.map((message) => message.method)).toEqual(["initialize", "authenticate", "session/new"])
      expect(captured.received[1].params).toEqual({ methodId: "oauth-personal" })
      expect(captured.received[2].params.mcpServers).toEqual([])
    }),
  )

  it.live("cancels a pending browser flow and removes its process and private directory", () =>
    Effect.gen(function* () {
      const child = yield* fake(standard({ wait: true }))
      const waiting = yield* Deferred.make<void>()
      const fiber = yield* AntigravityAcpAuth.authenticate({
        executable: child.executable,
        onWaiting: () => {
          Deferred.doneUnsafe(waiting, Effect.void)
        },
      }).pipe(Effect.scoped, Effect.forkChild)
      yield* Deferred.await(waiting).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(fiber)
      cleanup(child.capture)
    }),
  )

  for (const [name, body] of [
    ["missing Google authentication method", standard({ missingMethod: true })],
    ["native authentication failure", standard({ fail: true })],
    ["malformed JSON", 'rl.on("line",()=>process.stdout.write("{broken\\n"))'],
    ["oversized stdout", 'rl.on("line",()=>process.stdout.write("x".repeat(256*1024+1)))'],
  ]) {
    it.live(`returns safe errors for ${name}`, () =>
      Effect.gen(function* () {
        const child = yield* fake(body!)
        const result = yield* AntigravityAcpAuth.authenticate({
          executable: child.executable,
          onWaiting: () => {},
        }).pipe(Effect.scoped, Effect.exit, Effect.timeout("5 seconds"))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).not.toContain("private-token-diagnostic")
        cleanup(child.capture)
      }),
    )
  }

  it.effect("allows only Google OAuth with an HTTP loopback callback", () =>
    Effect.sync(() => {
      expect(AntigravityAcpAuth.authorizationUrl(`Open: ${url}`)).toBe(url)
      for (const value of [
        url.replace("https://accounts.google.com", "http://accounts.google.com"),
        url.replace("accounts.google.com", "accounts.google.com.evil.test"),
        url.replace("accounts.google.com", "evil.test@accounts.google.com"),
        url.replace("http%3A%2F%2F127.0.0.1", "https%3A%2F%2F127.0.0.1"),
        url.replace("127.0.0.1", "evil.test"),
        url.replace("/o/oauth2/v2/auth", "/unrelated"),
        url + "&redirect_uri=https%3A%2F%2Fevil.test%2F",
        url + "&padding=" + "a".repeat(8192),
      ])
        expect(() => AntigravityAcpAuth.authorizationUrl(`Open: ${value}`)).toThrow()
      expect(AntigravityAcpAuth.authorizationUrl("No browser URL yet")).toBeUndefined()
    }),
  )

  it.effect("bounds the initial handshake", () =>
    Effect.gen(function* () {
      const child = yield* fake("setInterval(()=>{},1000)")
      const fiber = yield* AntigravityAcpAuth.authenticate({ executable: child.executable, onWaiting: () => {} }).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.forkChild,
      )
      yield* TestClock.adjust("60 seconds")
      const result = yield* Fiber.join(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("60 seconds")
    }),
  )

  it.effect("bounds browser authentication and cleans up after its deadline", () =>
    Effect.gen(function* () {
      const child = yield* fake(standard({ wait: true }))
      const waiting = yield* Deferred.make<void>()
      const fiber = yield* AntigravityAcpAuth.authenticate({
        executable: child.executable,
        onWaiting: () => {
          Deferred.doneUnsafe(waiting, Effect.void)
        },
      }).pipe(Effect.scoped, Effect.exit, Effect.forkChild)
      yield* Deferred.await(waiting)
      yield* TestClock.adjust("5 minutes")
      const result = yield* Fiber.join(fiber)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Google sign-in timed out")
      cleanup(child.capture)
    }),
  )
})
