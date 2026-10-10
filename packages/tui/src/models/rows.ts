import {
  cleanModelName,
  compareProviders,
  latestModels,
  matchesModelSearch,
  modelKey,
  modelVisible,
  withoutDeprecated,
} from "@turenlabs/client/models"
import { label } from "../state"
import { modelIdentity } from "./identity"
import { lastReplyModel } from "./effective"
import type { ModelRef, ModelsContext, ModelTarget } from "./types"

export type Row = {
  ref: string
  name: string
  description: string
  /** The model a choice records as recent; absent on the Server default and toggle rows. */
  model?: ModelRef
  toggle?: true
}

export const ROW_LIMIT = 100
export const TOGGLE_REF = "*show-all*"

type Catalog = Awaited<ReturnType<ModelsContext["connection"]["providers"]["list"]>>
type Entry = Catalog["models"][number] & { ref: string; latest: boolean }

const SERVER_DEFAULT = { ref: "", name: "Server default", description: "Let the server select an available model" }

/**
 * The picker rows under the desktop app's rules: a Recent group, then one group per provider in popular-first order,
 * models alphabetical. Older releases stay hidden behind the final toggle row; the current model and recents always
 * show.
 * `total` counts the rows before the cap; the toggle row is never cut.
 */
export function modelRows(ctx: ModelsContext, target: ModelTarget, catalog: Catalog, search: string) {
  const reply = lastReplyModel(ctx.state, target.recipient)
  const effective = target.current || (reply ? `${reply.providerID}/${reply.id}` : "")
  const entries = listed(catalog)
  const latest = latestModels(
    entries.map((item) => ({
      id: item.id,
      providerID: item.providerID,
      family: item.family,
      release_date: item.release,
    })),
    Date.now(),
  )
  const recents = ctx.memory.recent
  const matched = entries.filter((item) => matchesModelSearch(search, [item.name, item.id, item.providerName]))
  // Recents are hidden while searching: a hit then sits in its provider group.
  const recent = search.trim() ? [] : recents.flatMap((ref) => matched.filter((item) => same(item, ref)))
  const hidden = new Set(
    matched.filter(
      (item) =>
        item.ref !== effective &&
        !recents.some((ref) => same(item, ref)) &&
        !modelVisible({ id: item.id, providerID: item.providerID, release_date: item.release }, latest),
    ),
  )
  const grouped = matched
    .filter((item) => !recent.includes(item) && (ctx.memory.showAll || !hidden.has(item)))
    .toSorted(compareEntries)
  const rows = [
    ...(!target.recipient && matchesModelSearch(search, [SERVER_DEFAULT.name, SERVER_DEFAULT.description])
      ? [SERVER_DEFAULT]
      : []),
    ...recent.map((item) => modelRow(item, target, `Recent · ${item.providerName}`)),
    ...grouped.map((item) => modelRow(item, target, item.providerName)),
  ]
  return {
    rows: [...rows.slice(0, ROW_LIMIT), ...(hidden.size ? [toggleRow(ctx.memory.showAll, hidden.size)] : [])],
    total: rows.length,
  }
}

/** What the Current line says: the session's own model, else what its replies actually ran on. */
export function currentText(ctx: ModelsContext, target: ModelTarget) {
  if (target.recipient?.model) return modelIdentity(target.recipient.model)
  const reply = lastReplyModel(ctx.state, target.recipient)
  if (target.current || !reply) return label(target.current || "Server default", 150)
  return label(`server default (last reply used ${reply.providerID}/${reply.id})`, 200)
}

function listed(catalog: Catalog): Entry[] {
  const byKey = Object.fromEntries(catalog.models.map((item) => [modelKey(item), item]))
  return Object.values(withoutDeprecated(byKey)).map((item) => ({
    ...item,
    ...cleanModelName(item.name),
    ref: `${item.providerID}/${item.id}`,
  }))
}

const same = (item: Entry, ref: ModelRef) => item.providerID === ref.providerID && item.id === ref.modelID

function compareEntries(a: Entry, b: Entry) {
  return (
    compareProviders({ id: a.providerID, name: a.providerName }, { id: b.providerID, name: b.providerName }) ||
    a.providerID.localeCompare(b.providerID) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  )
}

function modelRow(item: Entry, target: ModelTarget, group: string): Row {
  const identity =
    item.ref === target.current && target.recipient?.model ? modelIdentity(target.recipient.model) : item.ref
  return {
    ref: item.ref,
    name: item.name,
    description: [identity, item.latest ? "latest" : undefined, item.release, group].filter(Boolean).join(" · "),
    model: { providerID: item.providerID, modelID: item.id },
  }
}

function toggleRow(showAll: boolean, hidden: number): Row {
  return {
    ref: TOGGLE_REF,
    name: showAll ? "Show fewer models" : `Show all models (${hidden} hidden)`,
    description: showAll ? "Hide releases older than the latest" : "Older releases are hidden",
    toggle: true,
  }
}
