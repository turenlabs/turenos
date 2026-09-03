import { Storage } from "@turenlabs/core/storage"
import { Effect, Schema, Semaphore } from "effect"
import { McpRuntime } from "@/mcp/runtime"
import { SecurityRegistry } from "./registry"

const updateLock = Semaphore.makeUnsafe(1)
const MCP_RUNTIME_SCOPE = Storage.Scope.make("internal/security/mcp-runtime")
const MCP_RUNTIME_SETTINGS_KEY = Storage.Key.make("settings")
const MCP_RUNTIME_DOCKER_QUALIFICATION_KEY = Storage.Key.make("docker-qualification")
const decodeMcpRuntimeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(McpRuntime.Settings))
const decodeMcpRuntimeDockerQualification = Schema.decodeUnknownOption(
  Schema.fromJsonString(McpRuntime.DockerQualification),
)

export const mcpRuntimeSettingsFor = Effect.fn("SecurityStorage.mcpRuntimeSettingsFor")(function* () {
  const storage = yield* Storage.Service
  const stored = yield* storage.get({ scope: MCP_RUNTIME_SCOPE, key: MCP_RUNTIME_SETTINGS_KEY })
  const decoded = stored ? decodeMcpRuntimeSettings(stored.value) : undefined
  return decoded?._tag === "Some" ? decoded.value : McpRuntime.DEFAULT_SETTINGS
})

export const mcpRuntimeSettingsUpdate = Effect.fn("SecurityStorage.mcpRuntimeSettingsUpdate")(function* (
  input: McpRuntime.SettingsInput,
) {
  const storage = yield* Storage.Service
  return yield* updateLock.withPermit(
    Effect.gen(function* () {
      const stored = yield* storage.get({ scope: MCP_RUNTIME_SCOPE, key: MCP_RUNTIME_SETTINGS_KEY })
      const decoded = stored ? decodeMcpRuntimeSettings(stored.value) : undefined
      const current = decoded?._tag === "Some" ? decoded.value : McpRuntime.DEFAULT_SETTINGS
      const settings: McpRuntime.Settings = {
        version: 1,
        backend: input.backend,
        localProcess: { enabled: input.backend === "local" || current.localProcess.enabled },
      }
      const changed = current.backend !== settings.backend
      if (changed) {
        yield* storage.set({
          scope: MCP_RUNTIME_SCOPE,
          key: MCP_RUNTIME_SETTINGS_KEY,
          value: JSON.stringify(settings),
        })
      }
      return { settings, changed }
    }),
  )
})

export const mcpRuntimeSettingsSet = Effect.fn("SecurityStorage.mcpRuntimeSettingsSet")(function* (
  input: McpRuntime.SettingsInput,
) {
  return (yield* mcpRuntimeSettingsUpdate(input)).settings
})

export const mcpRuntimeDockerQualificationFor = Effect.fn("SecurityStorage.mcpRuntimeDockerQualificationFor")(
  function* () {
    const storage = yield* Storage.Service
    const stored = yield* storage.get({ scope: MCP_RUNTIME_SCOPE, key: MCP_RUNTIME_DOCKER_QUALIFICATION_KEY })
    const decoded = stored ? decodeMcpRuntimeDockerQualification(stored.value) : undefined
    return decoded?._tag === "Some" ? decoded.value : McpRuntime.DEFAULT_DOCKER_QUALIFICATION
  },
)

export const mcpRuntimeDockerQualificationSet = Effect.fn("SecurityStorage.mcpRuntimeDockerQualificationSet")(
  function* (qualification: McpRuntime.DockerQualification) {
    const storage = yield* Storage.Service
    yield* storage.set({
      scope: MCP_RUNTIME_SCOPE,
      key: MCP_RUNTIME_DOCKER_QUALIFICATION_KEY,
      value: JSON.stringify(qualification),
    })
    return qualification
  },
)

export function withoutSecurityEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== SecurityRegistry.INTEGRATIONS_ENV &&
        !entry[0].startsWith(SecurityRegistry.SECRET_ENV_PREFIX),
    ),
  )
}

export function bootstrapEntry(input: { command: string[]; enabled: boolean }) {
  return {
    type: "local" as const,
    command: input.command,
    enabled: input.enabled,
    environment: undefined,
  }
}

export * as SecurityStorage from "./storage"
