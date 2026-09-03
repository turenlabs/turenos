import type { UserMessage } from "@turenlabs/sdk/v2"

type Local = {
  session: {
    reset(): void
    restore(msg: UserMessage): void
  }
}

type ModelSelection = {
  model: {
    current(): { id: string; provider: { id: string } } | undefined
    variant: {
      current(): string | undefined
    }
  }
}

type SessionModelSelection = ModelSelection & {
  session: {
    hasState(): boolean
  }
  model: {
    set(model: { providerID: string; modelID: string }): void
    variant: {
      set(variant: string | undefined): void
    }
  }
}

type PromptReader = {
  model: {
    current(): { providerID: string; modelID: string; variant?: string | null } | undefined
  }
}

type PromptState = PromptReader & {
  model: {
    set(model: { providerID: string; modelID: string; variant?: string | null }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage) => {
  local.session.restore(msg)
}

export const syncPromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = local.model.current()
  if (!model) return
  const next = {
    providerID: model.provider.id,
    modelID: model.id,
    variant: local.model.variant.current(),
  }
  const current = prompt.model.current()
  if (current?.providerID === next.providerID && current.modelID === next.modelID && current.variant === next.variant)
    return
  prompt.model.set(next)
}

export const restorePromptModel = (local: SessionModelSelection, prompt: PromptReader) => {
  if (local.session.hasState()) return false
  const model = prompt.model.current()
  if (!model) return false
  local.model.set({ providerID: model.providerID, modelID: model.modelID })
  local.model.variant.set(model.variant ?? undefined)
  return true
}
