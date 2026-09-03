type Model = {
  id: string
  api?: { id: string }
  provider: { id: string }
}

export function getFastMode<T extends Model>(current: T | undefined, models: T[]) {
  if (!current?.api?.id) return
  const baseID = current.api.id
  if (current.id !== baseID && current.id !== `${baseID}-fast`) return
  const sameProvider = (model: T) => model.provider.id === current.provider.id && model.api?.id === baseID
  const base = models.find((model) => sameProvider(model) && model.id === baseID)
  const fast = models.find((model) => sameProvider(model) && model.id === `${baseID}-fast`)
  if (!base || !fast) return
  return { base, fast, enabled: current.id === fast.id }
}

export function isFastModePair(left: Model | undefined, right: Model | undefined) {
  if (!left?.api?.id || !right?.api?.id) return false
  if (left.provider.id !== right.provider.id) return false
  if (left.api.id !== right.api.id) return false
  const baseID = left.api.id
  if (left.id === right.id) return false
  return [left.id, right.id].every((id) => id === baseID || id === `${baseID}-fast`)
}

export function carryFastModeVariant(input: {
  selected: string | null | undefined
  effective: string | undefined
  variants: string[]
}) {
  if (input.selected === null) return null
  const variant = input.selected ?? input.effective
  if (variant && input.variants.includes(variant)) return variant
  return undefined
}
