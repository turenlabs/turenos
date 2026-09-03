import type { Integration } from "../registry"

/**
 * Batou is an automatic integration, not a model-invoked scanner: the bundled
 * plugin in `src/plugin/batou.ts` runs it inline on every agent file write and
 * blocks critical findings. It contributes no MCP tools — the entry exists so
 * the toggle, self-installing binary lifecycle, and status show up under
 * Settings -> Security Integrations -> Tools, and so `enabledIds` can gate the
 * plugin from the same config the settings UI writes.
 */
export const Batou: Integration = {
  id: "batou",
  executables: ["batou"],
  category: "tools",
  group: "sast",
  description: "Automatic Batou SAST on every agent file write; blocks critical findings",
  tools: [],
}
