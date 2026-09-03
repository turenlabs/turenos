import { describe, expect, test } from "bun:test"
import {
  createLobbyClient,
  loadLobbyDirectory,
  loadLobbyRoom,
  LobbyConfigurationError,
  LobbyDisabledError,
  LobbyNetworkError,
  LobbyProtocolError,
  lobbyRequestBaseURL,
  normalizeLobbyAPIURL,
  type LobbyClient,
  type LobbyEvent,
  type LobbyMessage,
  type LobbyPresenceSnapshot,
  type LobbyRoom,
} from "./lobby-client"

const room: LobbyRoom = {
  id: "room_1",
  name: "Incident room",
  created_at: "2026-08-20T00:00:00Z",
  head: 2,
  members: [{ id: "forge-user", type: "human", name: "TurenOS user", joined_at: "2026-08-20T00:00:00Z" }],
}

const message: LobbyMessage = {
  id: "message_1",
  room_id: room.id,
  sequence: 4,
  actor_id: "forge-user",
  actor_type: "human",
  text: "The findings are ready.",
  base_revision: 3,
  created_at: "2026-08-20T00:00:00Z",
}

const presence: LobbyPresenceSnapshot = {
  room_id: room.id,
  version: 1,
  members: [
    {
      member_id: "forge-user",
      member_type: "human",
      state: "online",
      typing: true,
      updated_at: "2026-08-20T00:00:00Z",
      expires_at: "2026-08-20T00:00:35Z",
    },
  ],
}

describe("TurenOS lobby API URL", () => {
  test("normalizes a root HTTP(S) URL and rejects non-base URLs", () => {
    expect(normalizeLobbyAPIURL(" http://127.0.0.1:8787/ ")).toBe("http://127.0.0.1:8787")
    expect(normalizeLobbyAPIURL("https://lobby.example.test/")).toBe("https://lobby.example.test")
    expect(normalizeLobbyAPIURL(" ")).toBe("")

    for (const value of [
      "ftp://lobby.example.test",
      "http:///rooms",
      "https://user:secret@lobby.example.test",
      "https://lobby.example.test/rooms",
      "https://lobby.example.test?limit=100",
      "https://lobby.example.test#rooms",
    ]) {
      expect(() => normalizeLobbyAPIURL(value)).toThrow(LobbyConfigurationError)
    }
  })

  test("does not make requests when the integration is disabled", async () => {
    const client = createLobbyClient({
      baseURL: "",
      fetch: (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch,
    })
    const error = await client.listRooms("", 100).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LobbyDisabledError)
  })

  test("uses the Vite proxy only for the supported local development origins", () => {
    expect(lobbyRequestBaseURL("http://127.0.0.1:8787", true)).toBe("/turen-lobby")
    expect(lobbyRequestBaseURL("http://localhost:8787", true)).toBe("/turen-lobby")
    expect(lobbyRequestBaseURL("http://127.0.0.1:8080", true)).toBe("http://127.0.0.1:8080")
    expect(lobbyRequestBaseURL("https://lobby.example.test", true)).toBe("https://lobby.example.test")
    expect(lobbyRequestBaseURL("http://127.0.0.1:8787", false)).toBe("http://127.0.0.1:8787")
  })
})

describe("local lobby client", () => {
  test("uses URL-encoded routes and typed room endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = createLobbyClient({
      baseURL: "http://127.0.0.1:8787/",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        if (url.endsWith("/rooms?limit=100")) return json({ rooms: [room], has_more: false, next_after: room.id })
        if (url.endsWith("/rooms")) return json(room, 201)
        if (url.includes("/presence")) return json(presence)
        if (url.includes("/members")) return json(room)
        if (url.includes("/ledger")) return json({ room, events: [], has_more: false, next_after: 2 })
        if (url.includes("/messages?") && init?.method !== "POST")
          return json({ room, messages: [message], has_more: false, next_after: 4 })
        if (url.includes("/messages")) return json(message, 201)
        return json(room)
      }) as typeof fetch,
    })

    expect(await client.listRooms("", 100)).toEqual({ rooms: [room], has_more: false, next_after: room.id })
    await client.createRoom("Incident room")
    await client.snapshot("room/slash")
    await client.updateRoom(room.id, {
      actor_id: "forge-user",
      actor_type: "human",
      name: "Renamed",
      base_revision: 2,
      idempotency_key: "rename-key",
    })
    await client.deleteRoom(room.id, {
      actor_id: "forge-user",
      actor_type: "human",
      base_revision: 2,
      idempotency_key: "delete-key",
    })
    expect((await client.ledger(room.id, 2, 100)).items).toEqual([])
    expect((await client.messages(room.id, 2, 100)).items).toEqual([message])
    await client.join(room.id, { id: "forge-user", type: "human", name: "TurenOS user" })
    await client.leave(room.id, "forge-user", {
      actor_id: "forge-user",
      actor_type: "human",
      base_revision: 2,
      idempotency_key: "leave-key",
    })
    await client.presence(room.id)
    await client.setPresence(room.id, {
      actor_id: "forge-user",
      actor_type: "human",
      state: "online",
      typing: true,
    })
    await client.send(room.id, {
      actor_id: "forge-user",
      actor_type: "human",
      text: message.text,
      reply_to: "message_0",
      base_revision: 2,
      idempotency_key: "message-key",
    })

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8787/rooms?limit=100",
      "http://127.0.0.1:8787/rooms",
      "http://127.0.0.1:8787/rooms/room%2Fslash",
      "http://127.0.0.1:8787/rooms/room_1",
      "http://127.0.0.1:8787/rooms/room_1",
      "http://127.0.0.1:8787/rooms/room_1/ledger?after=2&limit=100",
      "http://127.0.0.1:8787/rooms/room_1/messages?after=2&limit=100",
      "http://127.0.0.1:8787/rooms/room_1/members",
      "http://127.0.0.1:8787/rooms/room_1/members/forge-user",
      "http://127.0.0.1:8787/rooms/room_1/presence",
      "http://127.0.0.1:8787/rooms/room_1/presence",
      "http://127.0.0.1:8787/rooms/room_1/messages",
    ])
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      actor_id: "forge-user",
      actor_type: "human",
      text: "The findings are ready.",
      reply_to: "message_0",
      base_revision: 2,
      idempotency_key: "message-key",
    })
  })

  test("distinguishes a network failure from malformed successful data", async () => {
    const offline = createLobbyClient({
      baseURL: "http://127.0.0.1:8787",
      fetch: (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch,
    })
    const offlineError = await offline.listRooms("", 100).catch((cause: unknown) => cause)
    expect(offlineError).toBeInstanceOf(LobbyNetworkError)

    const malformed = createLobbyClient({
      baseURL: "http://127.0.0.1:8787",
      fetch: (async () =>
        json({ rooms: [{ id: "room_1" }], has_more: false, next_after: "room_1" })) as unknown as typeof fetch,
    })
    const malformedError = await malformed.listRooms("", 100).catch((cause: unknown) => cause)
    expect(malformedError).toBeInstanceOf(LobbyProtocolError)
  })

  test("streams durable room and ephemeral presence events without mixing cursors", async () => {
    const calls: string[] = []
    const client = createLobbyClient({
      baseURL: "http://127.0.0.1:8787",
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": connected\n\n"))
              controller.enqueue(
                new TextEncoder().encode(`id: 4\nevent: chat.message\ndata: ${JSON.stringify(message)}\n\n`),
              )
              controller.enqueue(
                new TextEncoder().encode(`event: presence.snapshot\ndata: ${JSON.stringify(presence)}\n\n`),
              )
              controller.enqueue(
                new TextEncoder().encode(
                  `id: 5\nevent: room.updated\ndata: ${JSON.stringify({ sequence: 5, room: { ...room, name: "Renamed", head: 5 } })}\n\n`,
                ),
              )
              controller.enqueue(new TextEncoder().encode(`id: 6\nevent: ledger.cursor\ndata: {"sequence":6}\n\n`))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }) as typeof fetch,
    })
    const streamed: LobbyMessage[] = []
    const presenceEvents: LobbyPresenceSnapshot[] = []
    const rooms: LobbyRoom[] = []
    const cursors: number[] = []

    let opened = false
    await client.stream(room.id, 3, {
      open: () => (opened = true),
      message: (next) => streamed.push(next),
      presence: (next) => presenceEvents.push(next),
      room: (next) => rooms.push(next.room),
      cursor: (next) => cursors.push(next),
    })

    expect(calls).toEqual(["http://127.0.0.1:8787/rooms/room_1/stream?after=3"])
    expect(opened).toBe(true)
    expect(streamed).toEqual([message])
    expect(presenceEvents).toEqual([presence])
    expect(rooms).toEqual([{ ...room, name: "Renamed", head: 5 }])
    expect(cursors).toEqual([6])
  })

  test("loads every directory page, including an empty page that advances", async () => {
    const cursors: string[] = []
    const secondRoom = { ...room, id: "room_2", name: "Second room" }
    const client: Pick<LobbyClient, "listRooms"> = {
      listRooms: async (after) => {
        cursors.push(after)
        if (!after) return { rooms: [], has_more: true, next_after: "room_1" }
        return { rooms: [secondRoom], has_more: false, next_after: "room_2" }
      },
    }

    expect(await loadLobbyDirectory(client)).toEqual([secondRoom])
    expect(cursors).toEqual(["", "room_1"])
  })

  test("loads a selected room across an empty projected message page", async () => {
    const messageAfter: number[] = []
    const client: Pick<LobbyClient, "snapshot" | "ledger" | "messages"> = {
      snapshot: async () => room,
      ledger: async () => ({ room, items: [] as LobbyEvent[], has_more: false, next_after: 2 }),
      messages: async (_roomID, after) => {
        messageAfter.push(after)
        if (after === 0) return { room, items: [], has_more: true, next_after: 3 }
        return { room: { ...room, head: 4 }, items: [message], has_more: false, next_after: 4 }
      },
    }

    const history = await loadLobbyRoom(client, room.id)

    expect(messageAfter).toEqual([0, 3])
    expect(history.messages).toEqual([message])
    expect(history.messagesAfter).toBe(4)
    expect(history.room.head).toBe(4)
  })
})

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}
