export * as TeamGroup from "./team"

import { Schema } from "effect"
import { Team } from "@turenlabs/schema/team"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "../errors"

const errors = [InvalidRequestError, ConflictError] as const

export const Group = HttpApiGroup.make("server.team")
  .add(
    HttpApiEndpoint.get("team.state", "/api/team", {
      query: {
        roomID: Schema.optional(Schema.String),
        after: Schema.optional(Schema.NumberFromString),
        before: Schema.optional(Schema.NumberFromString),
        limit: Schema.optional(Schema.NumberFromString),
      },
      success: Team.State,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.state", summary: "Read Team room" })),
  )
  .add(
    HttpApiEndpoint.post("team.roomCreate", "/api/team/room", {
      payload: Schema.Struct({ name: Schema.String, topic: Schema.optional(Schema.String) }),
      success: Team.Room,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.roomCreate", summary: "Create Team room" })),
  )
  .add(
    HttpApiEndpoint.patch("team.roomEdit", "/api/team/room/:roomID", {
      params: { roomID: Schema.String },
      payload: Team.EditRoom,
      success: Team.Room,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.roomEdit", summary: "Edit Team room" })),
  )
  .add(
    HttpApiEndpoint.post("team.roomArchive", "/api/team/room/:roomID/archive", {
      params: { roomID: Schema.String },
      success: Team.Room,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.roomArchive", summary: "Archive Team room" })),
  )
  .add(
    HttpApiEndpoint.post("team.roomRestore", "/api/team/room/:roomID/restore", {
      params: { roomID: Schema.String },
      success: Team.Room,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.roomRestore", summary: "Restore Team room" })),
  )
  .add(
    HttpApiEndpoint.delete("team.roomDelete", "/api/team/room/:roomID", {
      params: { roomID: Schema.String },
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.roomDelete", summary: "Delete Team room" })),
  )
  .add(
    HttpApiEndpoint.post("team.teammateCreate", "/api/team/teammate", {
      payload: Team.CreateTeammate,
      success: Team.Teammate,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.teammateCreate", summary: "Create teammate" })),
  )
  .add(
    HttpApiEndpoint.patch("team.teammateEdit", "/api/team/teammate/:teammateID", {
      params: { teammateID: Schema.String },
      payload: Team.EditTeammate,
      success: Team.Teammate,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.teammateEdit", summary: "Edit teammate" })),
  )
  .add(
    HttpApiEndpoint.post("team.teammateStop", "/api/team/teammate/:teammateID/stop", {
      params: { teammateID: Schema.String },
      success: HttpApiSchema.NoContent,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.teammateStop", summary: "Stop teammate work" })),
  )
  .add(
    HttpApiEndpoint.post("team.messagePost", "/api/team/message", {
      payload: Team.PostMessage,
      success: Team.Posted,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.messagePost", summary: "Post Team room message" })),
  )
  .add(
    HttpApiEndpoint.post("team.dutyAttach", "/api/team/teammate/:teammateID/duty", {
      params: { teammateID: Schema.String },
      payload: Schema.Struct({ loopID: Schema.String }),
      success: Team.Duty,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.dutyAttach", summary: "Assign teammate duty" })),
  )
  .add(
    HttpApiEndpoint.post("team.taskCancel", "/api/team/task/:taskID/cancel", {
      params: { taskID: Schema.String },
      success: Team.Task,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.taskCancel", summary: "Cancel teammate task" })),
  )
  .add(
    HttpApiEndpoint.put("team.factoryConfigure", "/api/team/room/:roomID/factory", {
      params: { roomID: Schema.String },
      payload: Team.FactoryConfig,
      success: Team.Room,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.team.factoryConfigure", summary: "Configure Team factory" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("team.factoryRun", "/api/team/room/:roomID/factory/run", {
      params: { roomID: Schema.String },
      payload: Schema.Struct({
        id: Schema.String,
        request: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(4_000)))),
      }),
      success: Team.FactoryRun,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.factoryRun", summary: "Start Team factory run" })),
  )
  .add(
    HttpApiEndpoint.get("team.factoryRunGet", "/api/team/factory-run/:runID", {
      params: { runID: Schema.String },
      success: Team.FactoryRun,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.team.factoryRunGet", summary: "Get Team factory run" })),
  )
  .add(
    HttpApiEndpoint.post("team.factoryRunCancel", "/api/team/factory-run/:runID/cancel", {
      params: { runID: Schema.String },
      success: Team.FactoryRun,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.team.factoryRunCancel", summary: "Cancel Team factory run" }),
    ),
  )
