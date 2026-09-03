import { Memory } from "@turenlabs/core/memory"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { MemoryNotFoundError } from "@turenlabs/protocol/groups/memory"

export const MemoryHandler = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  handlers
    .handle("memory.wings", () => Memory.Service.use((memory) => memory.wings()))
    .handle("memory.wing", (ctx) => Memory.Service.use((memory) => memory.wing(ctx.payload)))
    .handle("memory.rooms", (ctx) => Memory.Service.use((memory) => memory.rooms(ctx.query.wingID)))
    .handle("memory.room", (ctx) =>
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          if (!(yield* memory.wings()).some((wing) => wing.id === ctx.payload.wingID))
            return yield* new MemoryNotFoundError({ message: "Memory wing not found" })
          return yield* memory.room(ctx.payload)
        }),
      ),
    )
    .handle("memory.list", (ctx) =>
      Memory.Service.use((memory) =>
        memory.list({
          wings: [ctx.query.wingID],
          ...(ctx.query.roomID ? { rooms: [ctx.query.roomID] } : {}),
        }),
      ),
    )
    .handle("memory.create", (ctx) =>
      Memory.Service.use((memory) =>
        memory
          .write({
            ...ctx.payload,
            provenance: { assertedBy: "settings", source: "human" },
          })
          .pipe(Effect.mapError(() => new MemoryNotFoundError({ message: "Memory room not found" }))),
      ),
    )
    .handle("memory.update", (ctx) =>
      Effect.gen(function* () {
        const updated = yield* (yield* Memory.Service).update({ id: ctx.params.drawerID, ...ctx.payload })
        if (!updated) return yield* new MemoryNotFoundError({ message: "Memory not found" })
        return updated
      }),
    )
    .handle("memory.remove", (ctx) =>
      Effect.gen(function* () {
        const removed = yield* (yield* Memory.Service).forget({ id: ctx.params.drawerID, wings: [ctx.query.wingID] })
        if (!removed) return yield* new MemoryNotFoundError({ message: "Memory not found" })
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
