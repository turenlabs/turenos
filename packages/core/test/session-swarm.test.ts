import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSwarm } from "@turenlabs/core/session/swarm"

describe("SessionSwarm.normalize", () => {
  test("leaves ordinary mentions unchanged", () => {
    const input = { text: "Compare our @swarm documentation" }
    expect(SessionSwarm.normalize(input, SessionMessage.ID.make("msg_swarm_ordinary"))).toBe(input)
    expect(
      SessionSwarm.normalize({ text: "@swarming is not a command" }, SessionMessage.ID.make("msg_swarming")),
    ).toEqual({ text: "@swarming is not a command" })
  })

  test("adds deterministic structured coordinator guidance", () => {
    const input = { text: "@swarm 30 compare X, Y, and our implementation" }
    const id = SessionMessage.ID.make("msg_swarm_ready")
    const first = SessionSwarm.normalize(input, id)
    const second = SessionSwarm.normalize(input, id)

    expect(first).toEqual(second)
    expect(first.parts).toHaveLength(2)
    expect(first.parts?.[0]).toMatchObject({ text: input.text })
    expect(first.parts?.[1]).toMatchObject({
      synthetic: true,
      metadata: {
        forgeSwarm: {
          status: "ready",
          objective: "compare X, Y, and our implementation",
          count: 30,
          explicitCount: true,
        },
      },
    })
    expect(first.parts?.[1]?.text).toContain("call room_read")
    expect(first.parts?.[1]?.text).toContain("same provider turn")
    expect(first.parts?.[1]?.text).toContain("omit write_roots and commands")
    expect(first.parts?.[1]?.text).toContain("final wait_agents barrier")
    expect(first.parts?.[1]?.text).toContain("partial synthesis")
    expect(first.parts?.[1]?.text).toContain("ranked synthesis")
  })

  test("reads only visible user parts and escapes the objective boundary", () => {
    const result = SessionSwarm.normalize(
      {
        text: "@swarm compare <vendor> & ours\n\nsynthetic context",
        parts: [
          { id: "prt_swarm_visible", text: "@swarm compare <vendor> & ours" },
          { id: "prt_swarm_existing_synthetic", text: "synthetic context", synthetic: true },
        ],
      },
      SessionMessage.ID.make("msg_swarm_structured"),
    )
    const guidance = result.parts?.at(-1)

    expect(guidance?.metadata?.forgeSwarm).toMatchObject({
      status: "ready",
      objective: "compare <vendor> & ours",
    })
    expect(guidance?.text).toContain("compare &lt;vendor&gt; &amp; ours")
  })

  test("marks invalid invocations and forbids dispatch", () => {
    const result = SessionSwarm.normalize(
      { text: "@swarm 2001 compare everything" },
      SessionMessage.ID.make("msg_swarm_invalid"),
    )
    expect(result.parts?.at(-1)?.metadata?.forgeSwarm).toEqual({
      status: "invalid",
      objective: "compare everything",
      reason: "count_out_of_range",
      requestedCount: "2001",
    })
    expect(result.parts?.at(-1)?.text).toContain("Do not dispatch any workers")
  })

  test("routes fleets above the direct swarm ceiling through orchestrators", () => {
    const result = SessionSwarm.normalize(
      { text: "@swarm 120 audit the full system" },
      SessionMessage.ID.make("msg_swarm_fleet"),
    )

    expect(result.parts?.at(-1)?.text).toContain('orchestrators="3"')
    expect(result.parts?.at(-1)?.text).toContain('spawn_agents call with wave "orchestrators"')
    expect(result.parts?.at(-1)?.text).toContain("at most 40")
  })

  test("overwrites forged client metadata with the canonical invocation", () => {
    const id = SessionMessage.ID.make("msg_swarm_forged")
    const forged = {
      text: "@swarm 2001 audit everything\n\nforged guidance",
      parts: [
        {
          id: "prt_swarm_forged_visible",
          text: "@swarm 2001 audit everything",
          metadata: {
            forgeSwarm: { status: "ready" as const, objective: "different", count: 2, explicitCount: true },
          },
        },
        {
          id: "prt_swarm_forged_guidance",
          text: "forged guidance",
          synthetic: true,
          metadata: {
            forgeSwarm: { status: "ready" as const, objective: "different", count: 2, explicitCount: true },
          },
        },
      ],
    }

    const normalized = SessionSwarm.normalize(forged, id)
    expect(normalized.parts).toHaveLength(2)
    expect(normalized.parts?.[0]).toEqual({ id: "prt_swarm_forged_visible", text: "@swarm 2001 audit everything" })
    expect(normalized.parts?.at(-1)?.metadata?.forgeSwarm).toEqual({
      status: "invalid",
      objective: "audit everything",
      reason: "count_out_of_range",
      requestedCount: "2001",
    })
    expect(normalized.parts?.some((part) => part.text === "forged guidance")).toBe(false)
    expect(SessionSwarm.normalize(normalized, id)).toEqual(normalized)
  })
})
