import { batch, createMemo, startTransition } from "solid-js"
import { useModels } from "@/context/models"
import type { ModelKey, ModelSelection } from "@/context/local"
import {
  carryModelVariant,
  cycleModelVariant,
  getConfiguredAgentVariant,
  resolveEffectiveModelVariant,
  resolveModelVariant,
} from "@/context/model-variant"
import { carryFastModeVariant, isFastModePair } from "@/context/model-fast-mode"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { isRemovedProvider } from "@/hooks/provider-visibility"

export function createPromptModelSelection(input: { agent: () => { model?: ModelKey; variant?: string } | undefined }) {
  const sync = useSync()
  const models = useModels()
  const prompt = usePrompt()
  const providers = createMemo(() => sync().data.provider)
  const connected = createMemo(
    () => new Set(providers().connected.filter((providerID) => !isRemovedProvider(providerID))),
  )

  const valid = (model: ModelKey) => {
    if (isRemovedProvider(model.providerID)) return false
    const provider = providers().all.get(model.providerID)
    return !!provider?.models[model.modelID] && connected().has(model.providerID)
  }

  const available = (model: ModelKey) => valid(model) && !models.provider.excluded(model.providerID)

  const configured = () => {
    const value = sync().data.config.model
    if (!value) return
    const [providerID, modelID] = value.split("/")
    const model = { providerID, modelID }
    if (available(model)) return model
  }

  const recent = () => models.recent.list().find(available)
  const fallback = () => {
    const defaults = providers().default
    return providers()
      .connected.filter((providerID) => !isRemovedProvider(providerID) && !models.provider.excluded(providerID))
      .flatMap((providerID) => {
        const provider = providers().all.get(providerID)
        if (!provider) return []
        const modelID = defaults[providerID] ?? Object.values(provider.models)[0]?.id
        return modelID ? [{ providerID, modelID }] : []
      })[0]
  }

  const current = () => {
    const saved = prompt.model.current()
    const key =
      (saved && valid({ providerID: saved.providerID, modelID: saved.modelID }) ? saved : undefined) ??
      [input.agent()?.model, configured(), recent(), fallback()].find(
        (item): item is ModelKey => !!item && available(item),
      )
    if (!key) return
    return models.find(key)
  }
  const recentModels = createMemo(() =>
    models.recent
      .list()
      .filter((model) => !models.provider.excluded(model.providerID))
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )

  const configuredVariant = () => {
    const item = input.agent()
    const model = current()
    if (!item || !model) return
    return getConfiguredAgentVariant({
      agent: { model: item.model, variant: item.variant },
      model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
    })
  }

  const selection = {
    ready: models.ready,
    current,
    recent: recentModels,
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()
      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)
      if (index === -1) return
      const next = items[(index + direction + items.length) % items.length]
      if (next) selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    set(item: ModelKey | undefined, options?: { recent?: boolean }) {
      startTransition(() =>
        batch(() => {
          const previous = prompt.model.current()
          const previousModel = current()
          const nextModel = item ? models.find(item) : undefined
          const effectiveVariant =
            previous?.variant === null
              ? undefined
              : (resolveModelVariant({
                  variants: Object.keys(previousModel?.variants ?? {}),
                  selected: previous?.variant,
                  configured: configuredVariant(),
                }) ??
                (previousModel
                  ? models.variant.get({ providerID: previousModel.provider.id, modelID: previousModel.id })
                  : undefined))
          const variant = isFastModePair(previousModel, nextModel)
            ? carryFastModeVariant({
                selected: previous?.variant,
                effective: effectiveVariant,
                variants: Object.keys(nextModel?.variants ?? {}),
              })
            : carryModelVariant({ previous, next: item, variant: previous?.variant })
          prompt.model.set(item ? { ...item, variant } : undefined)
          if (!item) return
          models.setVisibility(item, true)
          if (options?.recent) models.recent.push(item)
        }),
      )
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured() {
        return configuredVariant()
      },
      selected() {
        return prompt.model.current()?.variant
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
        return Object.keys(current()?.variants ?? {})
      },
      set(value: string | undefined) {
        if (!value) return this.inherit()
        startTransition(() =>
          batch(() => {
            const model = current()
            if (!model) return
            prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: value })
            models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
          }),
        )
      },
      inherit() {
        startTransition(() =>
          batch(() => {
            const model = current()
            if (!model) return
            prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: undefined })
            models.variant.set({ providerID: model.provider.id, modelID: model.id }, undefined)
          }),
        )
      },
      cycle() {
        const variants = this.list()
        if (variants.length === 0) return
        this.set(
          cycleModelVariant({
            variants,
            selected: this.selected(),
            configured: this.configured(),
          }),
        )
      },
    },
  } satisfies ModelSelection

  return selection
}
