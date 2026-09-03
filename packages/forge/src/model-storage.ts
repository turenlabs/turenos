import { Storage } from "@turenlabs/core/storage"
import { Effect, Option, Schema } from "effect"
import { isRecord } from "@/util/record"

export const scope = Storage.Scope.make("desktop/store/model-state")
export const key = Storage.Key.make("model")

export type ModelRef = {
  providerID: string
  modelID: string
}

export type State = {
  recent: ModelRef[]
  favorite: ModelRef[]
  variant: Record<string, string>
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export const make = Effect.fn("ModelStorage.make")(function* () {
  const storage = yield* Storage.Service

  const read = Effect.fn("ModelStorage.read")(function* () {
    const stored = yield* storage.get({ scope, key })
    return stored ? decode(stored.value) : empty()
  })

  const saveVariant = Effect.fn("ModelStorage.saveVariant")(function* (model: ModelRef, variant: string | undefined) {
    return yield* update(storage, (current) => {
      const variants = { ...current.variant }
      const address = `${model.providerID}/${model.modelID}`
      if (variant) variants[address] = variant
      if (!variant) delete variants[address]
      return { ...current, variant: variants }
    })
  })

  return { read, saveVariant }
})

function update(storage: Storage.Interface, change: (current: State) => State): Effect.Effect<State> {
  return Effect.gen(function* () {
    const current = yield* storage.get({ scope, key })
    const value = change(current ? decode(current.value) : empty())
    yield* storage
      .compareAndSwap({
        scope,
        key,
        value: JSON.stringify(value),
        expectedRevision: current?.revision ?? null,
      })
      .pipe(Effect.catchTag("Storage.RevisionConflict", () => update(storage, change)))
    return value
  })
}

function decode(value: string) {
  const parsed = decodeJson(value)
  if (Option.isNone(parsed)) return empty()
  return fromUnknown(parsed.value) ?? empty()
}

function fromUnknown(value: unknown): State | undefined {
  if (!isRecord(value)) return
  return {
    recent: refs(value.recent),
    favorite: refs(value.favorite),
    variant: isRecord(value.variant)
      ? Object.fromEntries(
          Object.entries(value.variant).flatMap(([address, variant]) =>
            typeof variant === "string" ? [[address, variant] as const] : [],
          ),
        )
      : {},
  }
}

function refs(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    if (typeof item.providerID !== "string" || typeof item.modelID !== "string") return []
    return [{ providerID: item.providerID, modelID: item.modelID }]
  })
}

function empty(): State {
  return { recent: [], favorite: [], variant: {} }
}

export * as ModelStorage from "./model-storage"
