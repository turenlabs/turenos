import { describe, expect, test } from "bun:test"
import type { ForgeClient, QuestionRequest, Session } from "@turenlabs/sdk/v2/client"
import { createForgeClient } from "@turenlabs/sdk/v2/client"
import { createServerSession } from "@/context/server-session"
import { permissionFromV2 } from "@/context/permission-request"
import { sessionPermissionRequest, sessionQuestionRequest } from "../src/pages/session/composer/session-request-tree"
import {
  hydratePendingTaskLineage,
  hydrateTaskRequests,
  loadTaskRequests,
  taskRequests,
} from "../src/pages/team/model"

const info = (id: string, parentID?: string): Session => ({
  id,
  parentID,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  time: { created: 1, updated: 1 },
})
const question = (sessionID: string): QuestionRequest => ({ id: `que-${sessionID}`, sessionID, questions: [] })
const permission = (sessionID: string) =>
  permissionFromV2({
    id: `per-${sessionID}`,
    sessionID,
    action: "read",
    resources: ["file"],
    save: [],
  })
const setup = (wait: Promise<void> = Promise.resolve()) => {
  const sessions = [info("root"), info("child", "root"), info("grandchild", "child"), info("other")]
  return createServerSession({
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        await wait
        return { data: sessions.find((item) => item.id === sessionID) }
      },
    },
  } as unknown as ForgeClient)
}

describe("Team pending request hydration", () => {
  test("fetches pending lists once per stored task Location, not the server default", async () => {
    const requests: URL[] = []
    const client = createForgeClient({
      baseUrl: "http://localhost:4096",
      directory: "/server-cwd",
      fetch: (async (request: Request) => {
        const url = new URL(request.url)
        requests.push(url)
        if (url.pathname.startsWith("/api/session/"))
          return Response.json({ data: { location: { directory: "/task-repo", workspaceID: "wrk_task" } } })
        if (url.pathname === "/api/question/request" || url.pathname === "/api/permission/request") {
          const scoped =
            url.searchParams.get("location[directory]") === "/task-repo" &&
            url.searchParams.get("location[workspace]") === "wrk_task"
          return Response.json({
            data: scoped
              ? url.pathname === "/api/question/request"
                ? [question("grandchild")]
                : [
                    {
                      id: "per-child",
                      sessionID: "child",
                      action: "read",
                      resources: ["file"],
                      save: [],
                    },
                  ]
              : [],
          })
        }
        return Response.json(
          info(
            url.pathname.split("/").at(-1)!,
            {
              child: "root",
              grandchild: "child",
            }[url.pathname.split("/").at(-1)!],
          ),
        )
      }) as typeof fetch,
    })
    const store = createServerSession(client)
    await loadTaskRequests(["root", "root-sibling"], store, client)
    const pendingCalls = requests.filter((url) => url.pathname.endsWith("/request"))
    expect(pendingCalls).toHaveLength(2)
    expect(
      pendingCalls.map((url) => [
        url.searchParams.get("location[directory]"),
        url.searchParams.get("location[workspace]"),
      ]),
    ).toEqual([
      ["/task-repo", "wrk_task"],
      ["/task-repo", "wrk_task"],
    ])
    expect(taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).get("root")).toEqual({
      kind: "question",
      sessionID: "grandchild",
    })
    expect(store.data.permission.child).toEqual([permission("child")])
  })

  test("loads missing ancestors for a live grandchild ask after empty hydration", async () => {
    const store = setup()
    await hydrateTaskRequests(["root"], store, { question: [], permission: [] })
    expect(store.get("root")).toBeUndefined()
    expect(store.get("child")).toBeUndefined()
    store.apply({ type: "question.v2.asked", properties: question("grandchild") })
    await store.resolve("grandchild")
    expect(store.get("child")).toBeUndefined()
    expect(taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).size).toBe(0)
    await hydratePendingTaskLineage(store)
    expect(store.get("child")?.parentID).toBe("root")
    expect(taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).get("root")).toEqual({
      kind: "question",
      sessionID: "grandchild",
    })
  })

  test("loads descendants without Directory bootstrap and links to the request dock", async () => {
    const store = setup()
    await hydrateTaskRequests(["root"], store, {
      question: [question("grandchild"), question("other")],
      permission: [permission("child"), permission("other")],
    })
    expect(store.get("child")?.parentID).toBe("root")
    expect(store.get("grandchild")?.parentID).toBe("child")
    expect(store.data.question.other).toBeUndefined()
    expect(store.data.permission.other).toBeUndefined()
    const waiting = taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).get("root")
    expect(waiting).toEqual({ kind: "question", sessionID: "grandchild" })
    expect(
      sessionQuestionRequest(
        Object.values(store.data.info).filter((item): item is Session => !!item),
        store.data.question,
        waiting?.sessionID,
      ),
    ).toEqual(question("grandchild"))
    store.apply({ type: "question.v2.replied", properties: { sessionID: "grandchild", requestID: "que-grandchild" } })
    const next = taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).get("root")
    expect(next).toEqual({ kind: "permission", sessionID: "child" })
    expect(
      sessionPermissionRequest(
        Object.values(store.data.info).filter((item): item is Session => !!item),
        store.data.permission,
        next?.sessionID,
      ),
    ).toEqual(permission("child"))
  })

  for (const type of ["question.v2.replied", "question.v2.rejected", "permission.v2.replied"] as const) {
    test(`${type} before metadata completion defeats a stale pending snapshot`, async () => {
      const delayed = Promise.withResolvers<void>()
      const store = setup(delayed.promise)
      const loaded = hydrateTaskRequests(["root"], store, {
        question: [question("grandchild")],
        permission: [permission("child")],
      })
      const kind = type.startsWith("question") ? "question" : "permission"
      const id = kind === "question" ? "grandchild" : "child"
      store.apply({
        type,
        properties: { sessionID: id, requestID: `${kind === "question" ? "que" : "per"}-${id}`, reply: "reject" },
      })
      expect(store.data[kind][id]).toEqual([])
      delayed.resolve()
      await loaded
      expect(store.data[kind][id]).toEqual([])
      expect(taskRequests(["root"], store.data, (id) => store.get(id)?.parentID).get("root")?.kind).toBe(
        kind === "question" ? "permission" : "question",
      )
    })
  }
})
