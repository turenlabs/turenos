export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/define"
import { Effect } from "effect"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { REQUEST_CONTROL_KEYS } from "../../session/runner/model"
import { ClaudeCodeCLI } from "../../provider/claude-code"
import { MuseCodeCLI } from "../../provider/muse-code"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const files = routableDocuments(yield* config.entries())
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              providerEnv(file, provider) === undefined ? [] : [id],
            ),
          ),
        )
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            const env = providerEnv(file, item)
            if (env !== undefined) {
              integrations.method.update({
                integrationID,
                method: { type: "env", names: [...env] },
              })
            }
          }
        }
      }),
    )

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        const files = routableDocuments(entries)
        const configuredDefault = Config.latest(entries, "model")
        if (configuredDefault !== undefined) {
          const model = ModelV2.parse(configuredDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const providerID = id
            catalog.provider.update(providerID, (provider) => {
              if (item.name !== undefined) provider.name = item.name
              if (file.global && item.api !== undefined) provider.api = { ...item.api }
              if (item.request !== undefined) {
                if (file.global) Object.assign(provider.request.headers, item.request.headers)
                Object.assign(provider.request.body, requestBody(file, item.request.body))
              }
            })
            for (const [id, config] of Object.entries(item.models ?? {})) {
              catalog.model.update(providerID, id, (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.name !== undefined) model.name = config.name
                if (config.api !== undefined)
                  model.api = file.global
                    ? { ...model.api, ...config.api }
                    : { ...model.api, id: config.api.id ?? model.api.id }
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                } else if (
                  model.api.type === "native" &&
                  model.api.id === model.id &&
                  model.capabilities.input.length === 0 &&
                  model.capabilities.output.length === 0 &&
                  model.cost.length === 0 &&
                  model.limit.context === 0
                ) {
                  // Legacy custom-provider forms only captured a model ID and
                  // name. Treat a new configured model as a normal text chat
                  // model instead of leaving it unselectable.
                  model.capabilities = { tools: true, input: ["text"], output: ["text"] }
                }
                if (config.request !== undefined) {
                  if (file.global) Object.assign(model.request.headers, config.request.headers)
                  Object.assign(model.request.body, requestBody(file, config.request.body))
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                if (config.variants !== undefined) {
                  for (const variant of config.variants) {
                    let existing = model.variants.find((item) => item.id === variant.id)
                    if (!existing) {
                      existing = {
                        id: variant.id,
                        headers: {},
                        body: {},
                      }
                      model.variants.push(existing)
                    }
                    if (file.global) Object.assign(existing.headers, variant.headers)
                    Object.assign(existing.body, requestBody(file, variant.body))
                  }
                }
                if (config.cost !== undefined) {
                  model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                    tier: cost.tier && { ...cost.tier },
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache?.read ?? 0,
                      write: cost.cache?.write ?? 0,
                    },
                  }))
                }
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
              })
            }
          }
        }
      }),
    )
  }),
})

/**
 * Tags each config document with whether it came from the user's global config directory.
 *
 * Project documents are read from whatever repository is opened, so a cloned repo controls them.
 * Stored credentials are resolved by provider ID, so a project document that could set a
 * provider's endpoint, SDK package, headers, transport options, or credential env names could
 * send the user's key to a host of the repo's choosing or load the repo's code as a provider SDK.
 * Those routing fields are honoured only from global config; project documents keep the
 * presentation and generation settings (names, capabilities, limits, cost, variants, bodies).
 */
function routableDocuments(entries: readonly Config.Entry[]) {
  // Config.Service lists the global documents first, terminated by the global directory entry.
  const boundary = entries.findIndex((entry) => entry.type === "directory")
  return entries.flatMap((entry, index) =>
    entry.type === "document" ? [{ info: entry.info, global: boundary < 0 || index < boundary }] : [],
  )
}

function providerEnv(file: { readonly global: boolean }, provider: { readonly env?: readonly string[] }) {
  return file.global ? provider.env : undefined
}

function requestBody(file: { readonly global: boolean }, body: Readonly<Record<string, unknown>> | undefined) {
  if (file.global || body === undefined) return body
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !REQUEST_CONTROL_KEYS.has(key) && !CLI_LAUNCH_KEYS.has(key)),
  )
}

// The Claude Code and Muse Code bridges spawn `executable` from the request body in `directory`.
const CLI_LAUNCH_KEYS = new Set([ClaudeCodeCLI.EXECUTABLE_KEY, ClaudeCodeCLI.DIRECTORY_KEY, MuseCodeCLI.EXECUTABLE_KEY])
