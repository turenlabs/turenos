import type { Hooks } from "./registration.js"
import type { SkillV2Source } from "../types.js"

export interface SkillDraft {
  source(source: SkillV2Source): void
  list(): readonly SkillV2Source[]
}

export type SkillHooks = Hooks<{
  transform: SkillDraft
}>
