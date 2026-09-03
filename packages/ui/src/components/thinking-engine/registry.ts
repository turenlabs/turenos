// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import { drawGlobe, drawRubik, drawWave } from "./lattice"
import { drawMorph } from "./morph"
import { drawOrbits } from "./orbits"
import type { ThinkingMode } from "./presets"
import { drawRibbon } from "./ribbon"
import type { ModeDraw } from "./types"

export const MODE_DRAWS: Record<ThinkingMode, ModeDraw> = {
  orbits: drawOrbits,
  globe: drawGlobe,
  rubik: drawRubik,
  wave: drawWave,
  ribbon: drawRibbon,
  morph: drawMorph,
}
