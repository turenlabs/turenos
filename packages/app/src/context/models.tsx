import { type Accessor, createContext, createMemo, createResource, type ParentProps, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@turenlabs/ui/context"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { isRemovedProvider } from "@/hooks/provider-visibility"
import { selectProviderCatalog } from "@/hooks/provider-catalog"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

function createModelPreferences() {
  const [store, setStore, _, ready] = persisted(
    Persist.global("model", ["model.v1"]),
    createStore<Store>({
      user: [],
      recent: [],
      variant: {},
    }),
  )
  return { store, setStore, ready }
}

const ModelPreferencesContext = createContext<ReturnType<typeof createModelPreferences>>()

const modelsContext = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const serverSync = useServerSync()
    const params = useParams()
    const preferences = useContext(ModelPreferencesContext)
    if (!preferences) throw new Error("Models context must be used within a model preferences provider")

    const providers = createMemo(() => {
      const directory = props.directory ? props.directory() : decode64(params.dir)
      const projectStore = directory ? serverSync().child(directory)[0] : undefined
      if (props.directory) {
        return selectProviderCatalog({
          explicit: true,
          directory,
          catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
        })
      }
      return selectProviderCatalog({
        explicit: false,
        directory,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
        global: serverSync().data.provider,
      })
    })

    const store = preferences.store
    const setStore = preferences.setStore
    const ready = preferences.ready

    const available = createMemo(() =>
      [...providers().all]
        .filter(([id]) => !isRemovedProvider(id) && providers().connected.includes(id))
        .map(([, p]) => p)
        .flatMap((p) =>
          Object.values(p.models).map((m) => ({
            ...m,
            provider: p,
          })),
        ),
    )

    const excluded = createMemo(() => new Set(serverSync().provider.excluded()))

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const catalog = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const list = createMemo(() => catalog().filter((model) => !excluded().has(model.provider.id)))

    const find = (key: ModelKey) => catalog().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      provider: {
        excluded: (providerID: string) => excluded().has(providerID),
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})

export const useModels = modelsContext.use
const ModelsContextProvider = modelsContext.provider

export function ModelsProvider(props: ParentProps<{ directory?: Accessor<string | undefined> }>) {
  const preferences = useContext(ModelPreferencesContext)
  if (preferences) {
    return <ModelsContextProvider directory={props.directory}>{props.children}</ModelsContextProvider>
  }

  const value = createModelPreferences()
  return (
    <ModelPreferencesContext.Provider value={value}>
      <ModelsContextProvider directory={props.directory}>{props.children}</ModelsContextProvider>
    </ModelPreferencesContext.Provider>
  )
}
