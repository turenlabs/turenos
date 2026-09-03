import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { SecurityRegistry } from "@/security/registry"
import { SecurityStorage } from "@/security/storage"
import { McpRuntime } from "@/mcp/runtime"
import { Scanner } from "@/security/util/scanner"
import { BATOU_ID, batouStatus } from "@/security/batou-binary"
import { RootHttpApi } from "../api"

/** The install/lifecycle fields for one integration. `status`/`statusDetail`
 *  are Batou-only; every other integration reports just `installed`. */
export interface IntegrationStatusExtras {
  installed?: boolean
  status?: "not-installed" | "downloading" | "installed" | "failed"
  statusDetail?: string
}

export async function integrationStatusExtras(
  integration: SecurityRegistry.Integration,
): Promise<IntegrationStatusExtras> {
  if (integration.category !== "tools") return {}
  // Batou self-installs, so it reports a richer lifecycle: PATH or the managed
  // cache-dir download count as installed, and a download in flight/failed is
  // surfaced too. `installed` stays derived from status for older clients.
  if (integration.id === BATOU_ID) {
    const status = await batouStatus()
    return {
      installed: status.status === "installed",
      status: status.status,
      statusDetail: status.detail,
    }
  }
  const contribution = ExtensionCatalog.contribution(`security:${integration.id}`)
  const binaries = contribution?.type === "tool" ? contribution.commands : [integration.id]
  const found = await Promise.all(binaries.map((binary) => Scanner.which(binary)))
  return { installed: found.some((location) => location !== undefined) }
}

export function makeSecurityHandlers(qualifyDocker = McpRuntime.qualifyDocker) {
  return HttpApiBuilder.group(RootHttpApi, "security", (handlers) =>
    Effect.gen(function* () {
      const mcpRuntimeStatus = Effect.fn("SecurityHttpApi.mcpRuntimeStatus")(function* () {
        return McpRuntime.status(
          yield* SecurityStorage.mcpRuntimeSettingsFor(),
          yield* SecurityStorage.mcpRuntimeDockerQualificationFor(),
        )
      })

      const mcpRuntimeGet = Effect.fn("SecurityHttpApi.mcpRuntimeGet")(function* () {
        return yield* mcpRuntimeStatus()
      })

      const mcpRuntimeUpdate = Effect.fn("SecurityHttpApi.mcpRuntimeUpdate")(function* (ctx: {
        payload: McpRuntime.SettingsInput
      }) {
        const result = yield* SecurityStorage.mcpRuntimeSettingsUpdate(ctx.payload)
        if (result.changed) yield* Effect.promise(() => McpRuntime.invalidateActiveConnections())
        return yield* mcpRuntimeStatus()
      })

      const mcpRuntimeTest = Effect.fn("SecurityHttpApi.mcpRuntimeTest")(function* () {
        const qualification = yield* Effect.tryPromise(() => qualifyDocker()).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ...McpRuntime.DEFAULT_DOCKER_QUALIFICATION,
              status: "failed" as const,
              checkedAt: Date.now(),
              detail: McpRuntime.redactErrorDiagnostic(error) || "Docker qualification failed.",
            }),
          ),
        )
        const stored = yield* SecurityStorage.mcpRuntimeDockerQualificationSet(qualification).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )
        const settings = yield* SecurityStorage.mcpRuntimeSettingsFor()
        if (stored) return McpRuntime.status(settings, qualification)
        return McpRuntime.status(settings, {
          ...qualification,
          status: "failed",
          detail: "Docker qualification could not be saved. Check server storage and test again.",
        })
      })

      return handlers
        .handle("mcpRuntimeGet", mcpRuntimeGet)
        .handle("mcpRuntimeUpdate", mcpRuntimeUpdate)
        .handle("mcpRuntimeTest", mcpRuntimeTest)
    }),
  )
}

export const securityHandlers = makeSecurityHandlers()
