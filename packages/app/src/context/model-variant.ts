type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

type VariantInput = {
  variants: string[]
  selected: string | null | undefined
  configured: string | undefined
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined
  if (!input.agent.model) return undefined
  if (!input.model?.variants) return undefined
  if (input.agent.model.providerID !== input.model.providerID) return undefined
  if (input.agent.model.modelID !== input.model.modelID) return undefined
  if (!(input.agent.variant in input.model.variants)) return undefined
  return input.agent.variant
}

/**
 * Decides whether a variant selection survives a change of model.
 *
 * A variant belongs to the model it was chosen for. Letting it follow a switch hands the
 * new model an id it may never publish, and because the choice is persisted onto the
 * session it then fails every later turn rather than just the next one. Keep it only while
 * the model is unchanged; otherwise return `undefined` so the caller re-resolves the new
 * model's own saved selection.
 */
export function carryModelVariant(input: {
  previous: AgentModel | undefined
  next: AgentModel | undefined
  variant: string | null | undefined
}) {
  if (!input.next || !input.previous) return undefined
  if (input.previous.providerID !== input.next.providerID) return undefined
  if (input.previous.modelID !== input.next.modelID) return undefined
  return input.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected && input.variants.includes(input.selected)) return input.selected
  if (input.configured && input.variants.includes(input.configured)) return input.configured
  return undefined
}

/**
 * The level the user explicitly chose, or undefined when the turn follows the inherited default
 * (the agent's pinned variant, else whatever the server applies when none is sent).
 */
export function explicitModelVariant(input: VariantInput & { saved: string | undefined }) {
  if (input.selected && input.variants.includes(input.selected)) return input.selected
  if (input.selected === null) return undefined
  // A pinned agent variant outranks the level remembered for this model.
  if (input.configured && input.variants.includes(input.configured)) return undefined
  if (input.saved && input.variants.includes(input.saved)) return input.saved
  return undefined
}

export function resolveEffectiveModelVariant(input: VariantInput & { saved: string | undefined }) {
  return explicitModelVariant(input) ?? resolveModelVariant({ ...input, selected: undefined })
}

export function cycleModelVariant(input: VariantInput) {
  if (input.variants.length === 0) return undefined
  if (input.selected && input.variants.includes(input.selected)) {
    const index = input.variants.indexOf(input.selected)
    if (index === input.variants.length - 1) return undefined
    return input.variants[index + 1]
  }
  if (input.configured && input.variants.includes(input.configured)) {
    const index = input.variants.indexOf(input.configured)
    if (index === input.variants.length - 1) return input.variants[0]
    return input.variants[index + 1]
  }
  return input.variants[0]
}
