import { createSimpleContext } from "@turenlabs/ui/context"
import { base64Encode } from "@turenlabs/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { isRemovedProvider } from "@/hooks/provider-visibility"
import { Persist, persisted } from "@/utils/persist"
import { hasCustomAgent, resolveAgent } from "./local-agent"
import {
  carryModelVariant,
  cycleModelVariant,
  explicitModelVariant,
  getConfiguredAgentVariant,
  resolveEffectiveModelVariant,
  resolveModelVariant,
} from "./model-variant"
import { carryFastModeVariant, isFastModePair } from "./model-fast-mode"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const models = useModels()
    const settings = useSettings()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync().data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const agentsVisible = createMemo(() => settings.visibility.customAgents() || hasCustomAgent(list()))
    const providers = createMemo(() => sync().data.provider)
    const connected = createMemo(
      () => new Set(providers().connected.filter((providerID) => !isRemovedProvider(providerID))),
    )

    const [saved, setSaved, , savedReady] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK().scope, sdk().directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      promoting?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const validModel = (model: ModelKey) => {
      if (isRemovedProvider(model.providerID)) return false
      const provider = providers().all.get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const availableModel = (model: ModelKey) => validModel(model) && !models.provider.excluded(model.providerID)

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      return resolveAgent(list(), name)
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      return saved.session[session] ?? handoff.get(handoffKey(serverSDK().scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    const configuredModel = () => {
      const configured = sync().data.config.model
      if (!configured) return
      const [providerID, modelID] = configured.split("/")
      const model = { providerID, modelID }
      if (availableModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (availableModel(item)) return item
      }
    }

    const defaultModel = () => {
      const defaults = providers().default
      for (const providerID of connected()) {
        const provider = providers().all.get(providerID)
        if (!provider) continue
        const configured = defaults[providerID]
        if (configured) {
          const model = { providerID, modelID: configured }
          if (availableModel(model)) return model
        }

        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID, modelID: first.id }
        if (availableModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      visible: agentsVisible,
      current() {
        return pickAgent(agentsVisible() ? (scope()?.agent ?? store.current) : "build")
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          const prev = scope()
          const blockedModel = !!item.model && !availableModel(item.model)
          const nextModel = blockedModel ? prev?.model : (item.model ?? prev?.model)
          const nextVariant = blockedModel
            ? prev?.variant
            : (item.variant ?? carryModelVariant({ previous: prev?.model, next: nextModel, variant: prev?.variant }))
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: blockedModel ? null : item.model,
            variant: nextVariant ?? null,
          })
          const next = {
            agent: item.name,
            model: nextModel,
            variant: nextVariant,
          } satisfies State
          const session = id()
          if (session) {
            setSaved("session", session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = () => {
      const item = firstModel(
        () => scope()?.model,
        () => {
          const model = agent.current()?.model
          if (model && availableModel(model)) return model
        },
        fallback,
      )
      if (!item) return
      return models.find(item)
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() =>
      models.recent
        .list()
        .filter((model) => !models.provider.excluded(model.providerID))
        .map(models.find)
        .filter(Boolean),
    )

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        startTransition(() =>
          batch(() => {
            const previous = current()
            const next = item ? models.find(item) : undefined
            const selectedVariant = selected()
            const effectiveVariant =
              selectedVariant === null
                ? undefined
                : (resolveModelVariant({
                    variants: Object.keys(previous?.variants ?? {}),
                    selected: selectedVariant,
                    configured: configured(),
                  }) ??
                  (previous
                    ? models.variant.get({ providerID: previous.provider.id, modelID: previous.id })
                    : undefined))
            const variant = isFastModePair(previous, next)
              ? carryFastModeVariant({
                  selected: selectedVariant,
                  effective: effectiveVariant,
                  variants: Object.keys(next?.variants ?? {}),
                })
              : carryModelVariant({
                  previous: previous && { providerID: previous.provider.id, modelID: previous.id },
                  next: item,
                  variant: selectedVariant,
                })
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant,
            })
            write({ model: item, variant })
            if (!item) return
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        /**
         * The level a turn runs at when nothing is selected: the agent's pinned variant, else the
         * catalog default the runner applies server-side. Undefined means no reasoning setting is
         * sent and the provider's own default applies.
         */
        inherited() {
          const fallback = current()?.defaultVariant
          return this.configured() ?? (fallback && this.list().includes(fallback) ? fallback : undefined)
        },
        explicit() {
          return explicitModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
            saved: this.remembered(),
          })
        },
        /** The level last chosen manually for this model, if it still publishes it. */
        remembered() {
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          return saved && this.list().includes(saved) ? saved : undefined
        },
        current() {
          const model = current()
          return resolveEffectiveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
            saved: model ? models.variant.get({ providerID: model.provider.id, modelID: model.id }) : undefined,
          })
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          if (!value) return this.inherit()
          startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value,
              })
              write({ variant: value })
              if (model) {
                models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
              }
            }),
          )
        },
        /**
         * Follows the inherited default for this Session. The level remembered for the model is
         * kept so switching back to manual restores it; `null` stops that memory applying here.
         */
        inherit() {
          startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: null,
              })
              write({ variant: null })
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      session: {
        ready: savedReady,
        hasState: () => scope() !== undefined,
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string, state?: State) {
          const next = clone(state ?? snapshot())
          if (!next) return
          const key = handoffKey(serverSDK().scope, dir, session)
          handoff.set(key, next)

          if (dir === sdk().directory) {
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(serverSDK().scope, sdk().directory, session))) return

          setSaved("session", session, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})

export type ModelSelection = ReturnType<typeof useLocal>["model"]
