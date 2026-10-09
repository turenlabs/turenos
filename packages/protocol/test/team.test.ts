import { describe, expect, test } from "bun:test"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { TeamGroup } from "../src/groups/team"
import { Authorization } from "../src/middleware/authorization"

const api = HttpApi.make("team-contract-test").add(TeamGroup.Group).middleware(Authorization)

describe("Team Protocol", () => {
  test("publishes stable operation names for room and teammate actions", () => {
    const document = OpenApi.fromApi(api)
    expect(document.paths["/api/team"]?.get?.operationId).toBe("v2.team.state")
    expect(document.paths["/api/team/room/{roomID}"]?.patch?.operationId).toBe("v2.team.roomEdit")
    expect(document.paths["/api/team/room/{roomID}"]?.delete?.operationId).toBe("v2.team.roomDelete")
    expect(document.paths["/api/team/room/{roomID}/archive"]?.post?.operationId).toBe("v2.team.roomArchive")
    expect(document.paths["/api/team/room/{roomID}/restore"]?.post?.operationId).toBe("v2.team.roomRestore")
    expect(document.paths["/api/team/message"]?.post?.operationId).toBe("v2.team.messagePost")
    expect(document.paths["/api/team/teammate/{teammateID}"]?.patch?.operationId).toBe("v2.team.teammateEdit")
    expect(document.paths["/api/team/task/{taskID}/cancel"]?.post?.operationId).toBe("v2.team.taskCancel")
    expect(document.paths["/api/team/room/{roomID}/factory"]?.put?.operationId).toBe("v2.team.factoryConfigure")
    expect(document.paths["/api/team/room/{roomID}/factory/run"]?.post?.operationId).toBe("v2.team.factoryRun")
    expect(document.paths["/api/team/factory-run/{runID}"]?.get?.operationId).toBe("v2.team.factoryRunGet")
    expect(document.paths["/api/team/factory-run/{runID}/cancel"]?.post?.operationId).toBe("v2.team.factoryRunCancel")
  })

  test("includes authorization failures on Team endpoints", () => {
    const document = OpenApi.fromApi(api)
    expect(document.paths["/api/team"]?.get?.responses["401"]).toBeDefined()
    expect(document.paths["/api/team/message"]?.post?.responses["401"]).toBeDefined()
    expect(document.paths["/api/team/room/{roomID}"]?.delete?.responses["401"]).toBeDefined()
    expect(document.paths["/api/team/room/{roomID}/archive"]?.post?.responses["401"]).toBeDefined()
    expect(document.paths["/api/team/room/{roomID}/factory"]?.put?.responses["401"]).toBeDefined()
  })
})
