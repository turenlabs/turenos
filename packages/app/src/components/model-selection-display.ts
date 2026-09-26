type ModelCapabilities = {
  reasoning?: boolean
  input?: { image?: boolean }
}

export type ModelSelectionDisplay = {
  capabilities?: ModelCapabilities
  modalities?: { input?: string[] }
  reasoning?: boolean
}

const effort = {
  default: { label: "Default", description: "No level sent; the provider decides" },
  none: { label: "None", description: "Disable extra reasoning" },
  minimal: { label: "Minimal", description: "Very light reasoning for quick tasks" },
  low: { label: "Light", description: "Quick questions and small edits" },
  medium: { label: "Balanced", description: "Everyday coding and debugging" },
  high: { label: "Thorough", description: "Complex changes and careful review" },
  xhigh: { label: "Deep", description: "Hard problems; slower and more detailed" },
  max: { label: "Maximum", description: "Most careful analysis; slowest" },
} satisfies Record<string, { label: string; description: string }>

export function modelEffortDisplay(value: string) {
  const known = effort[value.toLowerCase() as keyof typeof effort]
  if (known) return known
  return {
    label: value.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()),
    description: "Provider-specific mode",
  }
}

export function modelEffortDefaultIndex(variants: string[]) {
  const medium = variants.indexOf("medium")
  if (medium >= 0) return medium
  return Math.max(0, Math.floor((variants.length - 1) / 2))
}

export function modelCapabilitySummary(model: ModelSelectionDisplay) {
  const reasoning = model.capabilities?.reasoning ?? model.reasoning ?? false
  const images = model.capabilities?.input?.image ?? model.modalities?.input?.includes("image") ?? false
  if (reasoning && images) return "Complex coding, debugging, and image analysis"
  if (reasoning) return "Complex coding and debugging"
  if (images) return "Coding and questions with image support"
  return "Text-based coding and questions"
}
