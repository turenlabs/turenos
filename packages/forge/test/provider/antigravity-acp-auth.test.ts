import { describe, expect } from "bun:test"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Config } from "@turenlabs/core/config"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AntigravityAcpAuth } from "../../src/provider/antigravity-acp-auth"
import { InstanceStore } from "../../src/project/instance-store"
import { provideTmpdirInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([AntigravityAcpAuth.node, CrossSpawnSpawner.node])))
const config = (executable: string) =>
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({
            providers: { "antigravity-acp": { request: { body: { executable } } } },
          }),
        }),
      ]),
  })

const fake = (complete = false) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const executable = path.join(directory, "agy_acp_server.par")
    const capture = path.join(directory, "capture.json")
    yield* Effect.promise(() =>
      Bun.write(
        executable,
        [
          `#!${process.execPath}`,
          `import {writeFileSync} from "node:fs"`,
          `import {createInterface} from "node:readline"`,
          `writeFileSync(${JSON.stringify(capture)},JSON.stringify({pid:process.pid,cwd:process.cwd()}))`,
          `const send=(message)=>process.stdout.write(JSON.stringify(message)+"\\n")`,
          `createInterface({input:process.stdin}).on("line",line=>{`,
          `const message=JSON.parse(line)`,
          `if(message.method==="initialize") send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,authMethods:[{id:"oauth-personal"}]}})`,
          `if(message.method==="authenticate") process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F&state=native-state\\n")`,
          `if(message.method==="authenticate" && ${complete}) send({jsonrpc:"2.0",id:message.id,result:{}})`,
          `if(message.method==="session/new") send({jsonrpc:"2.0",id:message.id,result:{sessionId:"verified-session"}})`,
          `})`,
        ].join("\n"),
      ),
    )
    yield* Effect.sync(() => chmodSync(executable, 0o755))
    return { executable, capture }
  })

const cleanup = (capture: string) => {
  const captured = JSON.parse(readFileSync(capture, "utf8")) as { pid: number; cwd: string }
  expect(() => process.kill(captured.pid, 0)).toThrow()
  expect(existsSync(captured.cwd)).toBe(false)
}

describe("Antigravity ACP authentication lifecycle", () => {
  it.instance("joins concurrent starts, rejects stale IDs, and cancels", () =>
    Effect.gen(function* () {
      const child = yield* fake()
      const service = yield* AntigravityAcpAuth.Service
      const attempts = yield* Effect.all(
        [
          service.authorize().pipe(Effect.provideService(Config.Service, config(child.executable))),
          service.authorize().pipe(Effect.provideService(Config.Service, config(child.executable))),
        ],
        { concurrency: "unbounded" },
      )
      expect(attempts[0].id).toBe(attempts[1].id)
      expect(attempts[0].status).toBe("starting")
      const waiting = yield* pollWithTimeout(
        service.status(attempts[0].id).pipe(Effect.map((state) => (state.status === "waiting" ? state : undefined))),
        "ACP did not reach browser authentication",
      )
      expect(waiting.url).toStartWith("https://accounts.google.com/")
      const otherDirectory = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      expect(
        Exit.isFailure(
          yield* store.provide({ directory: otherDirectory }, service.status(waiting.id)).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* service.cancel("stale-id").pipe(Effect.exit))).toBe(true)
      expect((yield* service.status(waiting.id)).status).toBe("waiting")
      const cancelled = yield* service.cancel(waiting.id).pipe(Effect.timeout("5 seconds"))
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.url).toBeUndefined()
      cleanup(child.capture)
    }),
  )

  it.instance("cancels an attempt immediately while the runtime is starting", () =>
    Effect.gen(function* () {
      const child = yield* fake()
      const service = yield* AntigravityAcpAuth.Service
      const started = yield* service.authorize().pipe(Effect.provideService(Config.Service, config(child.executable)))
      expect(started.status).toBe("starting")
      const cancelled = yield* service.cancel(started.id).pipe(Effect.timeout("5 seconds"))
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.url).toBeUndefined()
      if (existsSync(child.capture)) cleanup(child.capture)
    }),
  )

  it.instance("disposes a pending runtime with its owning instance", () =>
    Effect.gen(function* () {
      const child = yield* fake()
      const service = yield* AntigravityAcpAuth.Service
      const instance = yield* TestInstance
      const store = yield* InstanceStore.Service
      const started = yield* service.authorize().pipe(Effect.provideService(Config.Service, config(child.executable)))
      yield* pollWithTimeout(
        service.status(started.id).pipe(Effect.map((state) => (state.status === "waiting" ? state : undefined))),
        "ACP did not start",
      )
      yield* store.disposeDirectory(instance.directory).pipe(Effect.timeout("5 seconds"))
      cleanup(child.capture)
    }),
  )

  it.instance("returns a safe error for a missing configured runtime", () =>
    Effect.gen(function* () {
      const service = yield* AntigravityAcpAuth.Service
      const started = yield* service
        .authorize()
        .pipe(Effect.provideService(Config.Service, config("/missing/turen-acp-runtime")))
      expect(started.status).toBe("error")
      expect(started.message).toContain("was not found")
      expect(started.url).toBeUndefined()
      expect(Exit.isFailure(yield* service.status("not-current").pipe(Effect.exit))).toBe(true)
    }),
  )

  it.instance("marks a verified native login authenticated and forgets its browser URL", () =>
    Effect.gen(function* () {
      const child = yield* fake(true)
      const service = yield* AntigravityAcpAuth.Service
      const started = yield* service.authorize().pipe(Effect.provideService(Config.Service, config(child.executable)))
      const authenticated = yield* pollWithTimeout(
        service.status(started.id).pipe(Effect.map((state) => (state.status === "authenticated" ? state : undefined))),
        "ACP did not finish authentication",
      )
      expect(authenticated.url).toBeUndefined()
      expect(authenticated.message).toBeUndefined()
      expect((yield* service.cancel(authenticated.id)).status).toBe("authenticated")
      cleanup(child.capture)
    }),
  )
  it.effect("spaces launches by three seconds without extending the delay or accumulating a lockout", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const child = yield* fake()
        const service = yield* AntigravityAcpAuth.Service
        const missing = yield* service
          .authorize()
          .pipe(Effect.provideService(Config.Service, config("/missing/turen-acp-runtime")))
        expect(missing.status).toBe("error")
        // Missing installations do not start a cooldown; more than five real retries remain possible.
        for (const _ of [1, 2, 3, 4, 5, 6, 7]) {
          const started = yield* service
            .authorize()
            .pipe(Effect.provideService(Config.Service, config(child.executable)))
          expect(started.status).toBe("starting")
          const joined = yield* service
            .authorize()
            .pipe(Effect.provideService(Config.Service, config(child.executable)))
          expect(joined.id).toBe(started.id)
          yield* service.cancel(started.id)
          const limited = yield* service
            .authorize()
            .pipe(Effect.provideService(Config.Service, config(child.executable)))
          expect(limited.status).toBe("error")
          expect(limited.message).toContain("wait 3s")
          expect(limited.url).toBeUndefined()
          yield* TestClock.adjust("2999 millis")
          const remaining = yield* service
            .authorize()
            .pipe(Effect.provideService(Config.Service, config(child.executable)))
          expect(remaining.status).toBe("error")
          expect(remaining.message).toContain("wait 1s")
          yield* TestClock.adjust("1 millis")
        }
      }),
    ),
  )
})
