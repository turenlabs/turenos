export * as AntigravityAcpAuth from "./antigravity-acp-auth"

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Option, Schema } from "effect"
import { AntigravityAcpBridge } from "../session/runner/antigravity-acp-bridge"

const LINE_LIMIT = 256 * 1024
const OUTPUT_LIMIT = 2 * 1024 * 1024

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AntigravityAcpAuthError", {
  message: Schema.String,
}) {}

const failure = () =>
  new AuthError({ message: "Antigravity ACP sign-in failed. Check the installed runtime and try again." })
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Only the official runtime's Google OAuth URL may reach the client browser. */
export function authorizationUrl(text: string): string | undefined {
  const value = text.match(/https?:\/\/[^\s"'<>]+/)?.[0]
  if (!value) return
  if (value.length > 8192 || !URL.canParse(value)) throw failure()
  const url = new URL(value)
  const redirect = url.searchParams.get("redirect_uri")
  if (
    url.protocol !== "https:" ||
    url.hostname !== "accounts.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/o/oauth2/v2/auth" && url.pathname !== "/o/oauth2/auth") ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    !redirect ||
    !URL.canParse(redirect)
  )
    throw new AuthError({
      message: "Antigravity ACP returned an unsupported sign-in link. Update the official runtime and try again.",
    })
  const callback = new URL(redirect)
  if (
    callback.protocol !== "http:" ||
    callback.username ||
    callback.password ||
    !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname)
  )
    throw new AuthError({
      message: "Antigravity ACP returned an unsupported sign-in callback. Update the official runtime and try again.",
    })
  return url.href
}

/** The runtime handles OAuth and persists credentials; this client receives only its browser URL. */
export const authenticate = Effect.fn("AntigravityAcpAuth.authenticate")(function* (input: {
  readonly executable: string
  readonly onWaiting: (url: string) => void
}) {
  const initialized = yield* Deferred.make<void, AuthError>()
  const authenticated = yield* Deferred.make<void, AuthError>()
  const verified = yield* Deferred.make<void, AuthError>()
  const directory = yield* Effect.acquireRelease(
    Effect.try({ try: () => mkdtempSync(join(tmpdir(), "turen-acp-login-")), catch: failure }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  yield* Effect.sync(() => {
    mkdirSync(join(directory, "config"))
    mkdirSync(join(directory, "data"))
  })
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const proc = spawn(input.executable, AntigravityAcpBridge.args(), {
        cwd: directory,
        env: AntigravityAcpBridge.environment(directory),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      })
      let pending = 1
      let completed = false
      let output = 0
      const buffers = { stdout: "", stderr: "" }
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
      const fail = (cause: AuthError = failure()) => {
        if (completed) return
        completed = true
        Deferred.doneUnsafe(initialized, Effect.fail(cause))
        Deferred.doneUnsafe(authenticated, Effect.fail(cause))
        Deferred.doneUnsafe(verified, Effect.fail(cause))
      }
      const send = (id: number, method: string, params: Record<string, unknown>) => {
        if (!proc.stdin.destroyed && proc.stdin.writable)
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      }
      const line = (stream: "stdout" | "stderr", text: string) => {
        if (completed || !text.trim() || text.trim() === "Opening in existing browser session.") return
        try {
          // Diagnostics may contain the URL, but none of their other content is returned or logged.
          if (stream === "stderr" || text.startsWith("Open the following link to authenticate")) {
            if (!text.startsWith("Open the following link to authenticate")) return
            const url = authorizationUrl(text)
            if (!url) return fail()
            input.onWaiting(url)
            return
          }
          const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
          const message = Option.isSome(decoded) ? record(decoded.value) : undefined
          if (!message || message.jsonrpc !== "2.0") return fail()
          // No client callbacks are needed for authentication or session verification.
          if (typeof message.method === "string") {
            if (message.id !== undefined) fail()
            return
          }
          if (message.id !== pending || message.error !== undefined) return fail()
          const result = record(message.result)
          if (!result) return fail()
          if (pending === 1) {
            if (
              result.protocolVersion !== 1 ||
              !Array.isArray(result.authMethods) ||
              !result.authMethods.some((method) => {
                const option = record(method)
                return option?.id === "oauth-personal" && (option.type === undefined || option.type === "agent")
              })
            ) {
              return fail(
                new AuthError({
                  message:
                    "The installed Antigravity ACP runtime does not support Google sign-in. Update the official runtime and try again.",
                }),
              )
            }
            pending = 2
            Deferred.doneUnsafe(initialized, Effect.void)
            send(2, "authenticate", { methodId: "oauth-personal" })
            return
          }
          if (pending === 2) {
            pending = 3
            Deferred.doneUnsafe(authenticated, Effect.void)
            send(3, "session/new", { cwd: directory, mcpServers: [] })
            return
          }
          if (typeof result.sessionId !== "string" || !result.sessionId.trim()) return fail()
          completed = true
          Deferred.doneUnsafe(verified, Effect.void)
        } catch (cause) {
          fail(cause instanceof AuthError ? cause : failure())
        }
      }
      const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (completed) return
        output += chunk.byteLength
        if (output > OUTPUT_LIMIT)
          return fail(
            new AuthError({
              message: "Antigravity ACP sign-in exceeded its output limit. Update the runtime and try again.",
            }),
          )
        buffers[stream] += decoders[stream].decode(chunk, { stream: true })
        let newline = buffers[stream].indexOf("\n")
        while (newline >= 0) {
          if (Buffer.byteLength(buffers[stream].slice(0, newline)) > LINE_LIMIT) return fail()
          line(stream, buffers[stream].slice(0, newline).replace(/\r$/, ""))
          buffers[stream] = buffers[stream].slice(newline + 1)
          newline = buffers[stream].indexOf("\n")
        }
        if (Buffer.byteLength(buffers[stream]) > LINE_LIMIT) fail()
      }
      proc.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk))
      proc.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk))
      proc.stdout.on("error", () => fail())
      proc.stderr.on("error", () => fail())
      proc.stdin.on("error", () => fail())
      proc.on("error", () => fail())
      const exit = new Promise<void>((resolve) =>
        proc.once("close", () => {
          resolve()
          fail()
        }),
      )
      send(1, "initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "turenos", title: "TurenOS", version: "1.0.0" },
      })
      return { proc, exit }
    }),
    (child) =>
      Effect.promise(async () => {
        if (!child.proc.stdin.destroyed) child.proc.stdin.end()
        const signal = (value: NodeJS.Signals) => {
          if (!child.proc.pid) return
          try {
            if (process.platform === "win32") child.proc.kill(value)
            else process.kill(-child.proc.pid, value)
          } catch {
            /* process group already exited */
          }
        }
        signal("SIGTERM")
        const timeout = setTimeout(() => signal("SIGKILL"), 2_000)
        await Promise.race([child.exit, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())])
        clearTimeout(timeout)
        signal("SIGKILL")
      }),
  )
  yield* Deferred.await(initialized).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(new AuthError({ message: "Antigravity ACP did not initialize within 60 seconds. Try again." })),
    }),
  )
  yield* Deferred.await(authenticated).pipe(
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () => Effect.fail(new AuthError({ message: "Google sign-in timed out. Start sign-in again." })),
    }),
  )
  yield* Deferred.await(verified).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(new AuthError({ message: "Antigravity ACP could not verify the completed sign-in. Try again." })),
    }),
  )
})
