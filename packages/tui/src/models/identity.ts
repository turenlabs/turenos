import { label } from "../state"
import type { Session } from "../server"

export function modelIdentity(model: NonNullable<Session["model"]>) {
  return label(`${model.providerID}/${model.id} (variant: ${model.variant ?? "default"})`, 2048)
}
