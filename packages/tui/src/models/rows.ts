import { label } from "../state"
import { modelIdentity } from "./identity"
import { lastReplyModel } from "./effective"
import { orderModels } from "./order"
import type { ModelsContext, ModelTarget } from "./types"

export type Row = { ref: string; name: string; description: string }

export const ROW_LIMIT = 100

type Catalog = Awaited<ReturnType<ModelsContext["connection"]["providers"]["list"]>>

/** Every row the terms keep, in picker order. The caller cuts the list; ordering comes first so the cut drops the oldest. */
export function modelRows(ctx: ModelsContext, target: ModelTarget, catalog: Catalog, terms: string[]) {
  const reply = lastReplyModel(ctx.state, target.recipient)
  const effective = target.current || (reply ? `${reply.providerID}/${reply.id}` : "")
  return [
    ...(!target.recipient
      ? [{ ref: "", name: "Server default", description: "Let the server select an available model" }]
      : []),
    ...orderModels(catalog.models, catalog.defaults, effective).map((model) => {
      const ref = `${model.providerID}/${model.id}`
      const identity = ref === target.current && target.recipient?.model ? modelIdentity(target.recipient.model) : ref
      return {
        ref,
        name: catalog.defaults[model.providerID] === model.id ? `${model.name} · default` : model.name,
        description: [identity, model.release, model.providerName].filter(Boolean).join(" · "),
      }
    }),
  ].filter((row) => terms.every((term) => `${row.name} ${row.description}`.toLowerCase().includes(term)))
}

/** What the Current line says: the session's own model, else what its replies actually ran on. */
export function currentText(ctx: ModelsContext, target: ModelTarget) {
  if (target.recipient?.model) return modelIdentity(target.recipient.model)
  const reply = lastReplyModel(ctx.state, target.recipient)
  if (target.current || !reply) return label(target.current || "Server default", 150)
  return label(`server default (last reply used ${reply.providerID}/${reply.id})`, 200)
}
