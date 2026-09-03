import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@turenlabs/core/config"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { Pty } from "@turenlabs/core/pty"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTerminal } from "@turenlabs/core/session/terminal"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionTerminal.node, Pty.node, EventV2.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const terminalTest = process.platform === "win32" ? it.live.skip : it.live

describe("SessionTerminal", () => {
  terminalTest("shares one shell process and preserves environment state", () =>
    Effect.gen(function* () {
      const terminal = yield* SessionTerminal.Service
      const sessionID = SessionSchema.ID.make("ses_shared_terminal")
      const created = yield* terminal.create(sessionID)

      expect((yield* terminal.create(sessionID)).ptyID).toBe(created.ptyID)
      yield* terminal.execute({
        sessionID,
        input: "export FORGE_SHARED_TERMINAL_TEST=multiplayer\n",
        idleMs: 500,
        timeoutMs: 10_000,
      })
      const result = yield* terminal.execute({
        sessionID,
        input: "printf 'value:%s\\n' \"$FORGE_SHARED_TERMINAL_TEST\"\n",
        idleMs: 500,
        timeoutMs: 10_000,
      })

      expect(result.output).toContain("value:multiplayer")
      yield* terminal.remove(sessionID)
      expect(yield* terminal.get(sessionID)).toBeUndefined()
    }),
  )

  terminalTest("blocks agent access while sharing is disabled", () =>
    Effect.gen(function* () {
      const terminal = yield* SessionTerminal.Service
      const sessionID = SessionSchema.ID.make("ses_private_terminal")
      yield* terminal.create(sessionID)
      yield* terminal.share({ sessionID, shared: false })

      const result = yield* terminal.execute({ sessionID, input: "pwd\n" }).pipe(Effect.flip)
      expect(result._tag).toBe("SessionTerminal.NotSharedError")
    }),
  )

  terminalTest("coalesces concurrent opens onto one PTY", () =>
    Effect.gen(function* () {
      const terminal = yield* SessionTerminal.Service
      const pty = yield* Pty.Service
      const sessionID = SessionSchema.ID.make("ses_concurrent_terminal")
      const opened = yield* Effect.all([terminal.create(sessionID), terminal.create(sessionID)], {
        concurrency: "unbounded",
      })

      expect(new Set(opened.map((state) => state.ptyID)).size).toBe(1)
      expect((yield* pty.list()).length).toBe(1)
    }),
  )
})
