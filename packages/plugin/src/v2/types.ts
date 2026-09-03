export type ProviderV2Request = {
  headers: Record<string, string>
  body: Record<string, unknown>
}

export type ProviderV2Api =
  | {
      type: "aisdk"
      package: string
      url?: string
      settings?: Record<string, unknown>
    }
  | {
      type: "native"
      url?: string
      settings: Record<string, unknown>
    }

export type ProviderV2Info = {
  id: string
  name: string
  disabled?: boolean
  integrationID?: string
  api: ProviderV2Api
  request: ProviderV2Request
}

export type ModelV2Info = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ProviderV2Api & { id: string }
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
    interleaved?: { field: "reasoning" | "reasoning_content" | "reasoning_details" }
  }
  request: ProviderV2Request & { variant?: string }
  variants: Array<{ id: string } & ProviderV2Request>
  time: { released: number }
  cost: Array<{
    tier?: { type: "context"; size: number }
    input: number
    output: number
    cache: { read: number; write: number }
  }>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}

export type ReferenceLocalSource = {
  type: "local"
  path: string
  description?: string
  hidden?: boolean
}

export type ReferenceGitSource = {
  type: "git"
  repository: string
  branch?: string
  description?: string
  hidden?: boolean
}

export type SkillV2Source =
  | {
      type: "embedded"
      skill: {
        name: string
        description?: string
        slash?: boolean
        location: string
        content: string
      }
    }
  | {
      type: "directory"
      directory: string
    }
