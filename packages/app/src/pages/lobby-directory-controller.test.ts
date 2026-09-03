import { describe, expect, test } from "bun:test"
import type { LobbyClient, LobbyRoom } from "./lobby-client"
import { createLobbyDirectoryController, type LobbyDirectoryState } from "./lobby-directory-controller"

const room: LobbyRoom = {
  id: "room_1",
  name: "Incident room",
  created_at: "2026-08-20T00:00:00Z",
  head: 1,
  members: [],
}

describe("lobby directory controller", () => {
  test("keeps rooms disabled until configured, then lists and selects the configured API", async () => {
    const states: LobbyDirectoryState[] = []
    const targets: string[] = []
    const controller = createLobbyDirectoryController({
      createClient: (baseURL) => {
        targets.push(baseURL)
        return client(async () => ({ rooms: [room], has_more: false, next_after: room.id }))
      },
      onState: (state) => states.push(state),
    })

    controller.refresh("")
    expect(states.at(-1)).toEqual({ connection: "not_configured", rooms: [] })

    controller.refresh("http://127.0.0.1:8787/")
    await tick()

    expect(targets).toEqual(["http://127.0.0.1:8787"])
    expect(states.at(-1)).toEqual({ connection: "connected", rooms: [room] })
    controller.dispose()
  })

  test("aborts obsolete configuration work and cleanup", async () => {
    const signals: AbortSignal[] = []
    const states: LobbyDirectoryState[] = []
    let resolveSecond: ((value: { rooms: LobbyRoom[]; has_more: boolean; next_after: string }) => void) | undefined
    const controller = createLobbyDirectoryController({
      createClient: (baseURL) =>
        client((_after, _limit, signal) => {
          if (signal) signals.push(signal)
          if (baseURL.endsWith("one.test")) return new Promise(() => {})
          return new Promise((resolve) => {
            resolveSecond = resolve
          })
        }),
      onState: (state) => states.push(state),
      retryDelayMs: 60_000,
    })

    controller.refresh("http://one.test")
    controller.refresh("http://two.test")
    expect(signals[0]?.aborted).toBe(true)

    resolveSecond?.({ rooms: [room], has_more: false, next_after: room.id })
    await tick()
    expect(states.at(-1)).toEqual({ connection: "connected", rooms: [room] })

    controller.dispose()
    expect(signals[1]?.aborted).toBe(true)
  })
})

function client(listRooms: LobbyClient["listRooms"]): LobbyClient {
  const unavailable = () => Promise.reject(new Error("not used"))
  return {
    listRooms,
    createRoom: unavailable,
    snapshot: unavailable,
    ledger: unavailable,
    messages: unavailable,
    stream: unavailable,
    join: unavailable,
    send: unavailable,
  } as unknown as LobbyClient
}

async function tick() {
  await Promise.resolve()
  await Promise.resolve()
}
