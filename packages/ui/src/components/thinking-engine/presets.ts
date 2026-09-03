// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import { BASE_PROFILES, scaleCounts, scaleRadii, type ModeOpts } from "./profiles"

export type ThinkingState = "working" | "searching" | "solving" | "listening" | "composing" | "shaping"
export type ThinkingSize = 20 | 64
export type ThinkingMode = "orbits" | "globe" | "rubik" | "wave" | "ribbon" | "morph"

export const STATE_TO_MODE: Record<ThinkingState, ThinkingMode> = {
  working: "orbits",
  searching: "globe",
  solving: "rubik",
  listening: "wave",
  composing: "ribbon",
  shaping: "morph",
}

interface Preset {
  speed: number
  count: number
  size: number
  extra?: ModeOpts
}

const PRESETS: Record<ThinkingMode, Record<ThinkingSize, Preset>> = {
  orbits: {
    64: { speed: 1.885, count: 1, size: 1 },
    20: { speed: 3.9, count: 0.238, size: 2.4 },
  },
  globe: {
    64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } },
    20: { speed: 2.665, count: 0.105, size: 1.75, extra: { scanMul: 4.335, dimBase: 0.45 } },
  },
  rubik: {
    64: { speed: 1.82, count: 0.35, size: 1.05 },
    20: { speed: 1.95, count: 0.088, size: 1.9 },
  },
  wave: {
    64: { speed: 4.388, count: 0.341, size: 1 },
    20: { speed: 3.998, count: 0.105, size: 1.6 },
  },
  ribbon: {
    64: { speed: 2.34, count: 0.25, size: 0.85, extra: { spin: 0, bandMul: 3.9, wobMul: 1 } },
    20: { speed: 3.12, count: 0.051, size: 1.073, extra: { spin: 0, bandMul: 4.94, wobMul: 1 } },
  },
  morph: {
    64: { speed: 2.405, count: 0.54, size: 0.395, extra: { spread: 1.45 } },
    20: { speed: 2.08, count: 0.53, size: 1.011, extra: { spread: 1.45 } },
  },
}

export interface ResolvedPreset {
  mode: ThinkingMode
  speed: number
  opts: ModeOpts
}

const cache = new Map<string, ResolvedPreset>()

/** Resolve a state and tuned size to its mode and fully scaled draw options. */
export function resolvePreset(state: ThinkingState, size: ThinkingSize): ResolvedPreset {
  const key = `${state}-${size}`
  const hit = cache.get(key)
  if (hit) return hit

  const mode = STATE_TO_MODE[state]
  const preset = PRESETS[mode][size]
  const counted = preset.count === 1 ? { ...BASE_PROFILES[mode] } : scaleCounts(BASE_PROFILES[mode], preset.count)
  const sized = preset.size === 1 ? counted : scaleRadii(counted, preset.size)
  const resolved = {
    mode,
    speed: preset.speed,
    opts: preset.extra ? { ...sized, ...preset.extra } : sized,
  }
  cache.set(key, resolved)
  return resolved
}
