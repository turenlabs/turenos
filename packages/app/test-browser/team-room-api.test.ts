import { describe, expect, test } from "bun:test"
import { ForgeClient } from "../../sdk/js/src/v2/gen/sdk.gen"
import { createClient } from "@turenlabs/sdk/v2/gen/client"
import { teamApi } from "../src/pages/team/api"

describe("Team room API", () => {
  test("uses generated edit, archive, restore, and NoContent delete contracts", async () => {
    const requests: Request[] = []
    const room = { id: "room-a", name: "Review", topic: "Checks", head: 0, archived: false }
    const api = teamApi(
      new ForgeClient({
        client: createClient({
          baseUrl: "http://team.test",
          fetch: Object.assign(
            async (input: Parameters<typeof fetch>[0]) => {
              const request = new Request(input)
              requests.push(request)
              return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(room)
            },
            { preconnect() {} },
          ),
        }),
      }),
    )
    expect(await api.roomEdit({ roomID: room.id, edit: { name: "Review", topic: "Checks" } })).toEqual(room)
    expect(await api.roomArchive({ roomID: room.id })).toEqual(room)
    expect(await api.roomRestore({ roomID: room.id })).toEqual(room)
    expect(await api.roomDelete({ roomID: room.id })).toBeUndefined()
    expect(requests.map((request) => request.method)).toEqual(["PATCH", "POST", "POST", "DELETE"])
    expect(await requests[0]!.json()).toEqual({ name: "Review", topic: "Checks" })
    expect(new URL(requests[1]!.url).pathname).toContain("archive")
    expect(new URL(requests[2]!.url).pathname).toContain("restore")
  })

  test("exposes SDK conflicts for room mutations including NoContent delete", async () => {
    const api = teamApi(
      new ForgeClient({
        client: createClient({
          baseUrl: "http://team.test",
          fetch: Object.assign(async () => Response.json({ message: "Room has active work" }, { status: 409 }), {
            preconnect() {},
          }),
        }),
      }),
    )
    await expect(api.roomArchive({ roomID: "room-a" })).rejects.toThrow("Room has active work")
    await expect(api.roomDelete({ roomID: "room-a" })).rejects.toThrow("Room has active work")
  })
})
