import { describe, expect, test } from "bun:test"
import {
  assistantPublicText,
  createLobbyAgentController,
  lobbyAgentHandle,
  lobbyAgentReplyDepth,
  lobbyAgentStorageKey,
  recoverLobbyAgentMappings,
  lobbyMessageMentions,
  type LobbyAgentMapping,
  type LobbyAgentSessionRuntime,
} from "./lobby-agent-controller"
import { LobbyRequestError, type LobbyClient, type LobbyMessage, type LobbyRoom } from "./lobby-client"
import type { LobbyDiagnosticFields, LobbyDiagnosticLevel } from "./lobby-diagnostics"

const room: LobbyRoom = {
  id: "room_1",
  name: "Incident room",
  created_at: "2026-08-20T00:00:00Z",
  head: 2,
  members: [],
}

const human = { id: "human_1", type: "human" as const, name: "Analyst" }
const message = (sequence: number, actorType: LobbyMessage["actor_type"] = "human"): LobbyMessage => ({
  id: `event_${sequence}`,
  room_id: room.id,
  sequence,
  actor_id: actorType === "agent" ? "another-agent" : human.id,
  actor_type: actorType,
  text: `message ${sequence}`,
  base_revision: sequence - 1,
  created_at: "2026-08-20T00:00:00Z",
})

describe("lobby room agent", () => {
  test("uses storage keys accepted by the desktop persistence bridge", () => {
    const key = lobbyAgentStorageKey("http://localhost:8787/", "room:one")
    expect(key).not.toContain("\0")
    expect(key).toContain("lobby:")
  })

  test("recovers a lost local roster from internal sessions and public members", () => {
    const recovered = recoverLobbyAgentMappings(
      {
        ...room,
        head: 11,
        members: [
          { ...human, joined_at: "2026-08-25T00:00:00Z" },
          {
            id: "forge-agent-luna-1234",
            type: "agent",
            name: "@luna",
            joined_at: "2026-08-25T00:00:00Z",
          },
        ],
      },
      [
        { ...message(6, "agent"), actor_id: "forge-agent-luna-1234" },
        { ...message(10, "agent"), actor_id: "forge-agent-luna-1234" },
        message(11),
      ],
      [
        {
          id: "ses_lobby_luna1234_deadbeef",
          location: { directory: "/repo" },
          model: { providerID: "provider", id: "model" },
        },
      ],
      "http://127.0.0.1:8787",
    )

    expect(recovered).toMatchObject([
      {
        instanceID: "luna-1234",
        agentMemberID: "forge-agent-luna-1234",
        sessionID: "ses_lobby_luna1234_deadbeef",
        lastHandledSequence: 10,
      },
    ])
  })

  test("recovered Room 67 mapping processes the first post-restart human message", async () => {
    const recovered = recoverLobbyAgentMappings(
      {
        ...room,
        head: 11,
        members: [
          { ...human, joined_at: "2026-08-25T00:00:00Z" },
          {
            id: "forge-agent-luna-1234",
            type: "agent",
            name: "@luna",
            joined_at: "2026-08-25T00:00:00Z",
          },
        ],
      },
      [{ ...message(10, "agent"), actor_id: "forge-agent-luna-1234" }, message(11)],
      [
        {
          id: "ses_lobby_luna1234_deadbeef",
          location: { directory: "/repo" },
          model: { providerID: "provider", id: "model" },
        },
      ],
      "http://127.0.0.1:8787",
    )
    const fixture = harness({ mapping: recovered[0] })
    await fixture.controller.adopt(human)
    fixture.controller.messages([{ ...message(11), text: "just built it" }], { ...room, head: 11 })
    await settle()

    expect(fixture.prompts[0]?.prompt).toContain('"sequence": 11')
  })

  test("starts one distinct room member and one V2 session without replaying old messages", async () => {
    const fixture = harness()
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(4), message(5)])
    await settle()

    expect(fixture.joins.map((member) => member.type)).toEqual(["human", "agent"])
    expect(fixture.joins[0]?.id).toBe(human.id)
    expect(fixture.joins[1]?.id).not.toBe(human.id)
    expect(fixture.joins[1]?.name).toBe(`@${fixture.mapping?.agentHandle}`)
    expect(fixture.ensures).toHaveLength(1)
    expect(fixture.ensures[0]?.capabilityProfile).toBe("workspace")
    expect(fixture.prompts.map((item) => item.prompt)).toEqual([expect.stringContaining('"sequence": 5')])
    expect(fixture.sends).toHaveLength(1)
    expect(fixture.sends[0]).toMatchObject({ actor_type: "agent", reply_to: "event_5" })
  })

  test("emits correlated phases without logging room text", async () => {
    const diagnostics: Array<{ event: string; fields?: LobbyDiagnosticFields }> = []
    const fixture = harness({ diagnostic: (event, fields) => diagnostics.push({ event, fields }) })
    await fixture.controller.start(startInput())
    fixture.controller.messages([{ ...message(5), text: "SECRET_ROOM_TEXT" }], room)
    await settle()
    await settle()

    expect(diagnostics.map((entry) => entry.event)).toContain("agent.turn.reserved")
    expect(diagnostics.map((entry) => entry.event)).toContain("agent.runtime.completed")
    expect(diagnostics.map((entry) => entry.event)).toContain("agent.publish.completed")
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET_ROOM_TEXT")
  })

  test("serializes human turns and ignores own or other agent chatter", async () => {
    const first = deferred<string>()
    const fixture = harness({ responses: [first.promise, Promise.resolve("second response")] })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5), message(6, "agent"), message(7)])
    await settle()

    expect(fixture.prompts).toHaveLength(1)
    first.resolve("first response")
    await settle()
    await settle()

    expect(fixture.prompts).toHaveLength(2)
    expect(fixture.sends.map((item) => item.reply_to)).toEqual(["event_5", "event_7"])
  })

  test("two room agents independently answer one human message without triggering each other", async () => {
    const first = harness()
    const second = harness()
    await Promise.all([
      first.controller.start(startInput("instance_1")),
      second.controller.start(startInput("instance_2")),
    ])

    first.controller.messages([message(5)])
    second.controller.messages([message(5)])
    await settle()
    await settle()

    expect(first.prompts).toHaveLength(1)
    expect(second.prompts).toHaveLength(1)
    expect(first.mapping?.agentMemberID).not.toBe(second.mapping?.agentMemberID)
    expect(first.sends[0]?.idempotency_key).not.toBe(second.sends[0]?.idempotency_key)
    first.controller.messages([message(6, "agent")])
    second.controller.messages([message(6, "agent")])
    await settle()
    expect(first.prompts).toHaveLength(1)
    expect(second.prompts).toHaveLength(1)
  })

  test("keeps private agent sessions distinct while sharing the same room-context tool contract", async () => {
    const first = harness()
    const second = harness()
    await Promise.all([
      first.controller.start(startInput("instance_1")),
      second.controller.start(startInput("instance_2")),
    ])
    const sharedRoom = {
      ...room,
      members: [
        { ...human, joined_at: "2026-08-25T00:00:00Z" },
        {
          id: first.mapping!.agentMemberID,
          type: "agent" as const,
          name: first.mapping!.agentName,
          joined_at: "2026-08-25T00:00:00Z",
        },
        {
          id: second.mapping!.agentMemberID,
          type: "agent" as const,
          name: second.mapping!.agentName,
          joined_at: "2026-08-25T00:00:00Z",
        },
      ],
    }
    first.controller.messages([message(5)], sharedRoom)
    second.controller.messages([message(5)], sharedRoom)
    await settle()
    await settle()

    const firstEnvelope = promptEnvelope(first.prompts[0]!.prompt)
    const secondEnvelope = promptEnvelope(second.prompts[0]!.prompt)
    expect(first.mapping?.sessionID).not.toBe(second.mapping?.sessionID)
    expect(first.prompts[0]!.sessionID).toBe(first.mapping!.sessionID)
    expect(second.prompts[0]!.sessionID).toBe(second.mapping!.sessionID)
    expect(firstEnvelope.context_boundary.shared_room_context).toContain("lobby_room_context")
    expect(secondEnvelope.context_boundary.shared_room_context).toContain("lobby_room_context")
    expect(first.prompts[0]!.prompt).not.toContain('"public_room"')
    expect(first.prompts[0]!.prompt).not.toContain(second.mapping!.sessionID)
    expect(second.prompts[0]!.prompt).not.toContain(first.mapping!.sessionID)
    expect(firstEnvelope.context_boundary.private_agent_context).toContain("private")
  })

  test("serializes provider turns across room agents", async () => {
    const firstResponse = deferred<string>()
    const first = harness({ responses: [firstResponse.promise] })
    const second = harness({ responses: [Promise.resolve("second")] })
    await Promise.all([
      first.controller.start(startInput("instance_1")),
      second.controller.start(startInput("instance_2")),
    ])
    first.controller.messages([message(5)])
    second.controller.messages([message(5)])
    await settle()

    expect(first.prompts).toHaveLength(1)
    expect(second.prompts).toHaveLength(0)
    firstResponse.resolve("first")
    await settle()
    await settle()
    expect(second.prompts).toHaveLength(1)
  })

  test("routes mentioned messages only to the addressed public handle", async () => {
    const luna = harness()
    const atlas = harness()
    await Promise.all([
      luna.controller.start({ ...startInput("luna"), agentName: "Luna", agentHandle: "luna" }),
      atlas.controller.start({ ...startInput("atlas"), agentName: "Atlas", agentHandle: "atlas" }),
    ])

    const addressed = { ...message(5), text: "@luna investigate this" }
    luna.controller.messages([addressed])
    atlas.controller.messages([addressed])
    await settle()

    expect(luna.prompts).toHaveLength(1)
    expect(atlas.prompts).toHaveLength(0)
    expect(luna.prompts[0]?.prompt).toContain('"addressed_agent": "@luna"')
  })

  test("directs the model to query fresh shared context instead of injecting room history", async () => {
    const fixture = harness()
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)], { ...room, members: [{ ...human, joined_at: "2026-08-20T00:00:00Z" }] })
    await settle()

    expect(fixture.prompts[0]?.prompt).toContain("call lobby_room_context")
    expect(fixture.prompts[0]?.prompt).not.toContain('"public_room"')
    expect(fixture.prompts[0]?.prompt).not.toContain('"name": "Incident room"')
    expect(fixture.prompts[0]?.prompt).not.toContain('"name": "Analyst"')
    expect(fixture.prompts[0]?.prompt).toContain('"text": "message 5"')
  })

  test("allows explicitly mentioned agent-to-agent chat but bounds reply chains", async () => {
    const luna = harness()
    await luna.controller.start({ ...startInput("luna"), agentName: "Luna", agentHandle: "luna" })
    const first = { ...message(5), text: "@luna start" }
    const second = { ...message(6, "agent"), id: "event_6", text: "@luna continue", reply_to: first.id }
    const third = { ...message(7, "agent"), id: "event_7", text: "@luna continue", reply_to: second.id }
    const fourth = { ...message(8, "agent"), id: "event_8", text: "@luna stop", reply_to: third.id }
    const fifth = { ...message(9, "agent"), id: "event_9", text: "@luna stop", reply_to: fourth.id }
    luna.controller.messages([first, second, third, fourth, fifth], room)
    await settle()

    expect(luna.prompts).toHaveLength(4)
    expect(lobbyAgentReplyDepth(fourth, [first, second, third, fourth])).toBe(2)
  })

  test("normalizes public handles and parses bounded mentions", () => {
    expect(lobbyAgentHandle("  Incident Résponder #1 ")).toBe("incident-responder-1")
    expect(lobbyMessageMentions("hi @Luna, ask @atlas-now! email@test.invalid")).toEqual(["luna", "atlas-now"])
  })

  test("reuses stable prompt and response keys after remount", async () => {
    const first = harness({ errors: [new Error("provider unavailable")] })
    await first.controller.start(startInput())
    first.controller.messages([message(5)])
    await settle()
    const pending = first.mapping?.pending
    first.controller.dispose()

    const second = harness({ mapping: first.mapping })
    await second.controller.start(startInput())
    await settle()

    expect(second.prompts[0]).toMatchObject({ promptID: pending?.promptID })
    expect(second.sends[0]?.idempotency_key).toBe(pending!.responseKey)
    second.controller.messages([message(5)])
    await settle()
    expect(second.prompts).toHaveLength(1)
  })

  test("adopts an active mapping and handles missed human messages after its cursor", async () => {
    const initial = harness()
    await initial.controller.start(startInput())
    initial.controller.dispose()

    const remounted = harness({ mapping: initial.mapping, head: 8 })
    await remounted.controller.adopt(human)
    remounted.controller.messages([message(5), message(8)])
    await settle()

    expect(remounted.ensures).toHaveLength(1)
    expect(remounted.prompts.map((item) => item.prompt)).toEqual([
      expect.stringContaining('"sequence": 5'),
      expect.stringContaining('"sequence": 8'),
    ])
  })

  test("retries revision conflict with the same response idempotency key", async () => {
    const fixture = harness({ conflicts: 1 })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await settle()

    expect(fixture.sends).toHaveLength(2)
    expect(new Set(fixture.sends.map((item) => item.idempotency_key)).size).toBe(1)
  })

  test("stop interrupts work and fences a late completion", async () => {
    const response = deferred<string>()
    const fixture = harness({ responses: [response.promise] })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await settle()
    await fixture.controller.stop()
    response.resolve("too late")
    await settle()

    expect(fixture.interrupts).toHaveLength(1)
    expect(fixture.sends).toHaveLength(0)
    expect(fixture.mapping?.status).toBe("stopped")
  })

  test("stop during startup interrupts a session created after the abort", async () => {
    const ensure = deferred<void>()
    const fixture = harness({ ensure: ensure.promise })
    const starting = fixture.controller.start(startInput())
    await settle()
    const stopping = fixture.controller.stop()
    ensure.resolve()
    await Promise.all([starting, stopping])

    expect(fixture.mapping?.status).toBe("stopped")
    expect(fixture.interrupts).toContain(fixture.mapping!.sessionID)
  })

  test("restarts a stopped mapping without replacing its member or session identity", async () => {
    const initial = harness()
    await initial.controller.start({ ...startInput(), agentName: "Luna", agentHandle: "luna" })
    await initial.controller.stop()
    const stopped = initial.mapping!

    await initial.controller.start({ ...startInput(), agentName: "Changed", agentHandle: "changed" })

    expect(initial.mapping).toMatchObject({
      status: "ready",
      agentMemberID: stopped.agentMemberID,
      sessionID: stopped.sessionID,
      agentHandle: "luna",
    })
  })

  test("kill signal stops work and a remount stays stopped", async () => {
    const response = deferred<string>()
    const listeners = new Set<() => void>()
    let generation = 0
    const fixture = harness({
      responses: [response.promise],
      subscribeKill: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      killGeneration: () => generation,
    })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await settle()
    generation += 1
    listeners.forEach((listener) => listener())
    response.resolve("too late")
    await settle()

    expect(fixture.sends).toHaveLength(0)
    expect(fixture.mapping?.status).toBe("stopped")

    const remounted = harness({ mapping: fixture.mapping, killGeneration: () => generation })
    await settle()
    expect(remounted.mapping?.status).toBe("stopped")
  })

  test("observes a persisted stop written by another controller before public publication", async () => {
    const response = deferred<string>()
    const fixture = harness({ responses: [response.promise] })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await settle()
    fixture.replaceMapping({ ...fixture.mapping!, status: "stopped" })
    response.resolve("too late")
    await settle()

    expect(fixture.sends).toHaveLength(0)
  })

  test("does not publish an old response after another controller stops and restarts", async () => {
    const response = deferred<string>()
    const fixture = harness({ responses: [response.promise] })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await settle()
    fixture.replaceMapping({ ...fixture.mapping!, status: "stopped", stopRevision: 1 })
    fixture.replaceMapping({ ...fixture.mapping!, status: "ready" })
    response.resolve("too late")
    await settle()

    expect(fixture.sends).toHaveLength(0)
  })

  test("turns a stuck local server wait into a retryable error", async () => {
    const fixture = harness({ hang: true, responseTimeoutMs: 5 })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(fixture.mapping?.status).toBe("error")
    expect(fixture.mapping?.error).toContain("timed out")
    expect(fixture.interrupts).toHaveLength(1)
    expect(fixture.sends).toHaveLength(0)
  })

  test("detaching the UI lets an admitted turn finish and publish", async () => {
    const response = deferred<string>()
    const fixture = harness({ responses: [response.promise] })
    await fixture.controller.start(startInput())
    fixture.controller.messages([message(5)])
    await settle()
    fixture.controller.dispose()
    response.resolve("public after navigation")
    await settle()

    expect(fixture.sends).toHaveLength(1)
    expect(fixture.mapping?.status).toBe("ready")
  })

  test("publishes only completed assistant text", () => {
    expect(
      assistantPublicText({
        id: "msg_assistant",
        type: "assistant",
        agent: "lobby",
        model: { providerID: "provider", id: "model" },
        time: { created: 1, completed: 2 },
        content: [
          { id: "reasoning", type: "reasoning", text: "private reasoning" },
          { id: "text", type: "text", text: "public response" },
        ],
      }),
    ).toBe("public response")
  })
})

function startInput(instanceID = "instance_1") {
  return {
    instanceID,
    lobbyBaseURL: "http://127.0.0.1:8787",
    roomID: room.id,
    roomHead: room.head,
    directory: "/repo",
    model: { providerID: "provider", id: "model" },
    human,
  }
}

function harness(
  options: {
    mapping?: LobbyAgentMapping
    responses?: Promise<string>[]
    errors?: Error[]
    conflicts?: number
    subscribeKill?: (listener: () => void) => VoidFunction
    killGeneration?: () => number
    head?: number
    ensure?: Promise<void>
    hang?: boolean
    responseTimeoutMs?: number
    diagnostic?(event: string, fields?: LobbyDiagnosticFields, level?: LobbyDiagnosticLevel): void
  } = {},
) {
  const joins: Array<{ id: string; type: string; name: string }> = []
  const ensures: Array<Parameters<LobbyAgentSessionRuntime["ensure"]>[0]> = []
  const prompts: Array<{ sessionID: string; directory: string; promptID: string; prompt: string }> = []
  const sends: Array<{
    actor_id: string
    actor_type: "human" | "agent" | "system"
    text: string
    reply_to?: string
    base_revision: number
    idempotency_key: string
  }> = []
  const interrupts: string[] = []
  let mapping = options.mapping
  let head = options.head ?? mapping?.lastHandledSequence ?? room.head
  let conflict = options.conflicts ?? 0
  let id = 0
  const responses = [...(options.responses ?? [])]
  const errors = [...(options.errors ?? [])]
  const client = {
    join: async (_roomID: string, member: Parameters<LobbyClient["join"]>[1]) => {
      joins.push(member)
      head += 1
      return { ...room, head }
    },
    snapshot: async () => ({ ...room, head }),
    send: async (_roomID: string, input: Parameters<LobbyClient["send"]>[1]) => {
      sends.push(input)
      if (conflict > 0) {
        conflict -= 1
        head += 1
        throw new LobbyRequestError(409, "revision_conflict", "refresh")
      }
      head += 1
      return {
        id: `agent_${head}`,
        room_id: room.id,
        sequence: head,
        actor_id: input.actor_id,
        actor_type: input.actor_type,
        text: input.text,
        reply_to: input.reply_to,
        base_revision: input.base_revision,
        created_at: "2026-08-20T00:00:00Z",
      }
    },
  } as unknown as LobbyClient
  const runtime: LobbyAgentSessionRuntime = {
    ensure: async (input) => {
      ensures.push(input)
      await options.ensure
    },
    respond: async (input) => {
      prompts.push(input)
      if (options.hang)
        return await new Promise<string>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })
        })

      const error = errors.shift()
      if (error) throw error
      return responses.shift() ?? Promise.resolve("public response")
    },
    interrupt: async (sessionID) => void interrupts.push(sessionID),
  }
  const controller = createLobbyAgentController({
    client,
    runtime,
    load: () => mapping,
    save: (next) => void (mapping = structuredClone(next)),
    onState: (next) => void (mapping = next ? structuredClone(next) : undefined),
    subscribeKill: options.subscribeKill,
    killGeneration: options.killGeneration,
    responseTimeoutMs: options.responseTimeoutMs,
    diagnostic: options.diagnostic,
    id: () => String(++id).padStart(4, "0"),
  })
  return {
    controller,
    joins,
    ensures,
    prompts,
    sends,
    interrupts,
    get mapping() {
      return mapping
    },
    replaceMapping(next: LobbyAgentMapping) {
      mapping = next
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function promptEnvelope(prompt: string) {
  return JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
    context_boundary: { private_agent_context: string; shared_room_context: string }
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
