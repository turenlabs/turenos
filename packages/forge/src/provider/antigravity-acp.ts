export * as AntigravityAcpProvider from "./antigravity-acp"

import { ModelV2 } from "@turenlabs/core/model"
import { AntigravityAcpCLI } from "@turenlabs/core/provider/antigravity-acp"
import type { ModelsDev } from "@turenlabs/core/models-dev"
import type { Info, Model } from "./provider"

export const ID = AntigravityAcpCLI.ID
export const DEFAULT_EXECUTABLE = AntigravityAcpCLI.DEFAULT_EXECUTABLE
export const probe = AntigravityAcpCLI.probe
export type ProbeResult = AntigravityAcpCLI.ProbeResult

/** Installed is not signed in: Antigravity ACP verifies the user's login on first use. */
export function info(catalog?: Record<string, ModelsDev.Provider>): Info {
  return {
    id: ID,
    name: AntigravityAcpCLI.NAME,
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries(
      AntigravityAcpCLI.MODELS.map((item) => [
        item.id,
        {
          id: ModelV2.ID.make(item.id),
          providerID: ID,
          api: { id: item.apiID, npm: AntigravityAcpCLI.NPM, url: AntigravityAcpCLI.API_URL },
          name: item.name,
          family: item.family,
          capabilities: {
            temperature: false,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          // Zero denotes subscription usage, not a free per-token API.
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: AntigravityAcpCLI.windowFor(
            item,
            catalog?.[AntigravityAcpCLI.CATALOG_PROVIDER]?.models[item.apiID]?.limit,
          ),
          status: "active",
          options: {},
          headers: {},
          release_date: "",
          variants: Object.fromEntries(
            item.efforts.map((effort) => [effort, { [AntigravityAcpCLI.EFFORT_KEY]: effort }]),
          ),
        } satisfies Model,
      ]),
    ),
  }
}
