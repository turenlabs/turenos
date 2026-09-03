export * as ConfigMcpLegacy from "./mcp-legacy"

import { ConfigMcpLegacyV1 } from "@turenlabs/core/v1/config/mcp-legacy"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Flag } from "@turenlabs/core/flag/flag"
import { Storage } from "@turenlabs/core/storage"
import { Effect } from "effect"

/**
 * One-shot markers for the retired `mcp` config key, keyed by the extension a legacy server mapped
 * onto. Their only job is to make the migration a *one-time* nudge rather than a standing override:
 * once an extension has been offered, a user who later turns it off in Settings stays turned off.
 */
const scope = Storage.Scope.make("internal/config-migration")
const markerKey = (extension: string) => Storage.Key.make(`legacy-mcp/${extension}`)

export interface Result {
  /** Extensions activated by this call. Empty on every run after the first. */
  readonly activated: readonly string[]
  /** Extensions this call left alone because the migration had already offered them. */
  readonly skipped: readonly string[]
}

/**
 * Activates the extensions that replaced a user's legacy `mcp` servers.
 *
 * Applied on read: the user's config file is never rewritten. The `mcp` block stays exactly as
 * authored -- comments, ordering and every unrelated key intact -- and this reads the classification
 * the config layer derived from it. Rewriting was rejected because a `.jsonc` file cannot be
 * round-tripped through the v1 schema without dropping comments and any key the schema does not
 * declare, and losing a user's config is the failure this whole change exists to stop.
 *
 * Only `enable` entries do anything. `obsolete` (the old bundled security server) and `unmapped`
 * entries are warned about at config load and deliberately not recreated here.
 */
export const activate = Effect.fn("ConfigMcpLegacy.activate")(function* (
  entries: readonly ConfigMcpLegacyV1.Entry[] | undefined,
) {
  const enable = (entries ?? []).filter((item): item is ConfigMcpLegacyV1.Enable => item.kind === "enable")
  if (!enable.length) return { activated: [], skipped: [] } satisfies Result

  const storage = yield* Storage.Service
  const runtime = yield* ExtensionRuntime.Service
  // Mirrors `localExtensionRequest` in the HTTP handler: a workspace deployment is not the local
  // machine, so it must not auto-enable a `localOnly` extension on the user's behalf.
  const admission = { local: !Flag.FORGE_WORKSPACE_ID }

  const activated: string[] = []
  const skipped: string[] = []
  for (const item of enable) {
    const key = markerKey(item.extension)
    if (yield* storage.get({ scope, key })) {
      skipped.push(item.extension)
      continue
    }
    const result = yield* runtime.update(item.extension, { enabled: true }, admission).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to migrate a legacy MCP server onto its extension", {
          server: item.name,
          extension: item.extension,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    )
    if (!result) continue
    // Marked only after the activation lands. A marker written first would silently swallow the
    // server on a transient failure, which is the exact outcome this migration exists to prevent.
    yield* storage.set({ scope, key, value: JSON.stringify({ server: item.name, url: item.detail }) })
    activated.push(item.extension)
    yield* Effect.logInfo("migrated a legacy MCP server onto its extension", {
      server: item.name,
      extension: item.extension,
    })
  }
  return { activated, skipped } satisfies Result
})
