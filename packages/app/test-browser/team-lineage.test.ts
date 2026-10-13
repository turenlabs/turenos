import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createForgeClient } from "@turenlabs/sdk/v2/client"
import { createServerSession } from "../src/context/server-session"
import { hydratePendingTaskLineage, hydrateTaskRequests, taskRequests } from "../src/pages/team/model"

test("live pending requests reactively load ancestors after empty hydration", async () => {
  const client = createForgeClient({
    baseUrl: "http://localhost:4096",
    fetch: (async (request: Request) => {
      const id = new URL(request.url).pathname.split("/").at(-1)!
      return Response.json({
        id,
        parentID: { grandchild: "child", child: "root" }[id],
        slug: id,
        projectID: "project",
        directory: "/task-repo",
        title: id,
        version: "1",
        time: { created: 1, updated: 1 },
      })
    }) as typeof fetch,
  })
  const store = createServerSession(client)
  await hydrateTaskRequests(["root"], store, { question: [], permission: [] })
  const loaded = Promise.withResolvers<void>()
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      void hydratePendingTaskLineage(store)
    })
    createEffect(() => {
      if (taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).has("root")) loaded.resolve()
    })
    return dispose
  })
  await Bun.sleep(0)
  expect(store.get("root")).toBeUndefined()
  expect(store.get("child")).toBeUndefined()
  store.apply({ type: "question.v2.asked", properties: { id: "que-live", sessionID: "grandchild", questions: [] } })
  await loaded.promise
  dispose()
  expect(store.get("child")?.parentID).toBe("root")
  expect(taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).get("root")).toEqual({
    kind: "question",
    sessionID: "grandchild",
  })
})
