export * as ProviderPrompt from "./provider-prompt"

import PROMPT_ANTHROPIC from "./provider-prompt/anthropic.txt"
import PROMPT_BEAST from "./provider-prompt/beast.txt"
import PROMPT_CODEX from "./provider-prompt/codex.txt"
import PROMPT_DEFAULT from "./provider-prompt/default.txt"
import PROMPT_GEMINI from "./provider-prompt/gemini.txt"
import PROMPT_GPT from "./provider-prompt/gpt.txt"
import PROMPT_KIMI from "./provider-prompt/kimi.txt"
import PROMPT_META from "./provider-prompt/meta.txt"
import PROMPT_TRINITY from "./provider-prompt/trinity.txt"

/**
 * Selects the model-family system prompt for one provider turn.
 *
 * Models do not respond equally well to the same instructions, so the shipped prompt text is
 * chosen from the provider's own model identifier -- the id actually sent on the wire
 * (`LLM.Model.id`, which is `ModelV2.Info["api"]["id"]`), not the catalog id, so a re-badged or
 * gateway-fronted model still resolves by what the upstream model really is.
 *
 * This is the *provider* axis. The *agent* axis lives in `plugin/agent.ts` and wins outright: an
 * agent that declares its own `system` never receives a provider prompt, matching V1.
 *
 * Order matters. `gpt-4`/`o1`/`o3` are matched before the general `gpt` branch, and `codex` is
 * matched inside it, so the broader rule never shadows the narrower one. Anything unmatched --
 * including every provider with no prompt of its own -- falls back to `default.txt` rather than to
 * no prompt at all.
 *
 * @module
 */

/** Ordered id substring -> prompt rules. First match wins; see the module note on ordering. */
const RULES: ReadonlyArray<{ readonly match: (id: string) => boolean; readonly prompt: string }> = [
  { match: (id) => id.includes("muse-spark"), prompt: PROMPT_META },
  { match: (id) => id.includes("gpt-4") || id.includes("o1") || id.includes("o3"), prompt: PROMPT_BEAST },
  { match: (id) => id.includes("gpt") && id.includes("codex"), prompt: PROMPT_CODEX },
  { match: (id) => id.includes("gpt"), prompt: PROMPT_GPT },
  { match: (id) => id.includes("gemini-"), prompt: PROMPT_GEMINI },
  { match: (id) => id.includes("claude"), prompt: PROMPT_ANTHROPIC },
  { match: (id) => id.toLowerCase().includes("trinity"), prompt: PROMPT_TRINITY },
  { match: (id) => id.toLowerCase().includes("kimi"), prompt: PROMPT_KIMI },
]

/** The prompt used by any model that matches no rule. */
export const fallback = PROMPT_DEFAULT

/**
 * Resolves the system prompt for a provider model id, never returning empty.
 *
 * `modelID` is the upstream/wire model id (`LLM.Model["id"]`).
 */
export function forModel(modelID: string): string {
  return RULES.find((rule) => rule.match(modelID))?.prompt ?? fallback
}
