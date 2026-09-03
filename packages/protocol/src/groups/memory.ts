import { Memory } from "@turenlabs/schema/memory"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export class MemoryNotFoundError extends Schema.TaggedErrorClass<MemoryNotFoundError>()(
  "MemoryNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const MemoryGroup = HttpApiGroup.make("server.memory")
  .add(
    HttpApiEndpoint.get("memory.wings", "/api/memory/wing", { success: Schema.Array(Memory.Wing) }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.memory.wings", summary: "List memory wings" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("memory.wing", "/api/memory/wing", {
      payload: Memory.WingInput,
      success: Memory.Wing,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.wing", summary: "Create or update a memory wing" })),
  )
  .add(
    HttpApiEndpoint.get("memory.rooms", "/api/memory/room", {
      query: Schema.Struct({ wingID: Memory.WingID }),
      success: Schema.Array(Memory.Room),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.rooms", summary: "List memory rooms" })),
  )
  .add(
    HttpApiEndpoint.post("memory.room", "/api/memory/room", {
      payload: Memory.RoomInput,
      success: Memory.Room,
      error: MemoryNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.room", summary: "Create or update a memory room" })),
  )
  .add(
    HttpApiEndpoint.get("memory.list", "/api/memory", {
      query: Schema.Struct({ wingID: Memory.WingID, roomID: Schema.optional(Memory.RoomID) }),
      success: Schema.Array(Memory.Drawer),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.list", summary: "List memories" })),
  )
  .add(
    HttpApiEndpoint.post("memory.create", "/api/memory", {
      payload: Memory.DrawerInput,
      success: Memory.Drawer,
      error: MemoryNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.create", summary: "Create a memory" })),
  )
  .add(
    HttpApiEndpoint.patch("memory.update", "/api/memory/:drawerID", {
      params: { drawerID: Memory.DrawerID },
      payload: Memory.DrawerUpdate,
      success: Memory.Drawer,
      error: MemoryNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.update", summary: "Update a memory" })),
  )
  .add(
    HttpApiEndpoint.delete("memory.remove", "/api/memory/:drawerID", {
      params: { drawerID: Memory.DrawerID },
      query: Schema.Struct({ wingID: Memory.WingID }),
      success: HttpApiSchema.NoContent,
      error: MemoryNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.memory.remove", summary: "Delete a memory" })),
  )
  .annotateMerge(OpenApi.annotations({ title: "memory", description: "Durable cross-session memory management." }))
