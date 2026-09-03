import { Effect } from "effect"
import { define } from "../define"
import { Location } from "../../location"
import { ClaudeCodeCLI } from "../../provider/claude-code"
import { ProviderV2 } from "../../provider"

/**
 * Registers Claude Code (local) in the v2 catalog.
 *
 * This provider has no credential — there is nothing in `auth.json` and no
 * integration to connect. Availability is therefore driven entirely by a live
 * probe of the `claude` binary, cached briefly so catalog reloads do not fork a
 * process each time. Missing and logged-out installations stay in the catalog
 * as disabled so Settings can explain how to connect them, while the runtime
 * still never offers a model it cannot run.
 */

const PROBE_TTL = 60_000

const live = () => ClaudeCodeCLI.probe()

let probeImpl: () => Promise<ClaudeCodeCLI.ProbeResult> = live
let cached: { readonly at: number; readonly result: ClaudeCodeCLI.ProbeResult } | undefined

const currentProbe = Effect.fnUntraced(function* () {
  const now = Date.now()
  if (cached && now - cached.at < PROBE_TTL) return cached.result
  const result = yield* Effect.promise(() => probeImpl())
  cached = { at: Date.now(), result }
  return result
})

export const resetProbeCache = () => {
  cached = undefined
}

/**
 * Test seam. Replaces the live CLI probe and drops the memoised result so a
 * catalog reload observes the new answer; call with no argument to restore.
 */
export const overrideProbe = (impl?: () => Promise<ClaudeCodeCLI.ProbeResult>) => {
  probeImpl = impl ?? live
  resetProbeCache()
}

export const ClaudeCodePlugin = define({
  id: "claude-code",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const probe = yield* currentProbe()
        // Resolved from the anthropic catalog rather than the static table: the
        // CLI serves those models, so their published windows are the truth.
        // This plugin runs after the models.dev transform, so the entries are
        // already in the draft.
        const upstream = catalog.provider.get(ProviderV2.ID.make(ClaudeCodeCLI.CATALOG_PROVIDER))
        const byFamily = ClaudeCodeCLI.windowsByFamily(
          [...(upstream?.models.values() ?? [])].map((model) => ({
            family: model.family,
            released: model.time.released,
            limit: { context: model.limit.context, output: model.limit.output },
          })),
        )
        catalog.provider.update(ClaudeCodeCLI.ID, (provider) => {
          provider.name = ClaudeCodeCLI.NAME
          provider.disabled = probe.status !== "authenticated"
          provider.api = { type: "native", url: ClaudeCodeCLI.API_URL, settings: {} }
          if (probe.status === "authenticated") {
            provider.request.body[ClaudeCodeCLI.EXECUTABLE_KEY] = probe.executable
          } else {
            delete provider.request.body[ClaudeCodeCLI.EXECUTABLE_KEY]
          }
          provider.request.body[ClaudeCodeCLI.DIRECTORY_KEY] = location.directory
        })
        for (const item of ClaudeCodeCLI.MODELS) {
          catalog.model.update(ClaudeCodeCLI.ID, item.id, (model) => {
            model.name = item.name
            model.family = item.family
            model.api = { type: "native", id: item.apiID, url: ClaudeCodeCLI.API_URL, settings: {} }
            model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            // Published as real variants so the composer's selector and the v2
            // runner agree the levels exist; the body key is what the CLI
            // transport turns into `--effort <level>`.
            model.variants = item.efforts.map((effort) => ({
              id: effort,
              headers: {},
              body: { [ClaudeCodeCLI.EFFORT_KEY]: effort },
            }))
            // Billed against the user's Claude subscription, not per token.
            model.cost = []
            model.status = "active"
            model.enabled = true
            // Zero keeps these out of `model.default()` and `model.small()`,
            // which both rank by release recency — TurenOS should not silently
            // fork a CLI for background work like title generation.
            model.time.released = 0
            model.limit = ClaudeCodeCLI.windowFor(item, byFamily)
          })
        }
      }),
    )
  }),
})
