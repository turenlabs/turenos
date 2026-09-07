export * as MuseCodeProvider from "./muse-code"

import { ModelV2 } from "@turenlabs/core/model"
import { MuseCodeCLI } from "@turenlabs/core/provider/muse-code"
import type { ModelsDev } from "@turenlabs/core/models-dev"
import type { Info, Model } from "./provider"

export const ID = MuseCodeCLI.ID
export const DEFAULT_EXECUTABLE = MuseCodeCLI.DEFAULT_EXECUTABLE
export const probe = MuseCodeCLI.probe
export type ProbeResult = MuseCodeCLI.ProbeResult

/** Installed is not signed in: Muse verifies the user's login on first use. */
export function info(catalog?: Record<string, ModelsDev.Provider>): Info {
  return {
    id: ID,
    name: MuseCodeCLI.NAME,
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries(
      MuseCodeCLI.MODELS.map((item) => [
        item.id,
        {
          id: ModelV2.ID.make(item.id),
          providerID: ID,
          api: { id: item.apiID, npm: MuseCodeCLI.NPM, url: MuseCodeCLI.API_URL },
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
          limit: MuseCodeCLI.windowFor(item, catalog?.[MuseCodeCLI.CATALOG_PROVIDER]?.models[item.apiID]?.limit),
          status: "active",
          options: {},
          headers: {},
          release_date: "",
          variants: Object.fromEntries(item.efforts.map((effort) => [effort, { [MuseCodeCLI.EFFORT_KEY]: effort }])),
        } satisfies Model,
      ]),
    ),
  }
}
