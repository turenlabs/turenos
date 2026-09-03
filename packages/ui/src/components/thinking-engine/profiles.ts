// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

export interface ModeOpts {
  [key: string]: number | undefined
}

const COUNT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["latRings", "lonDensity"],
  ["rings", "lonDensity"],
  ["lanes", "segs"],
]
const COUNT_KEYS = ["orbitN", "ghostN"] as const
const ICON_DENSITY_KEYS = ["iconD"] as const
const RADIUS_KEYS = ["rBase", "rDepth", "rActive", "rDot", "ghostR", "partR", "partRDepth"] as const

export function scaleCounts(opts: ModeOpts, scale: number): ModeOpts {
  const out: ModeOpts = { ...opts }
  const done = new Set<string>()
  const root = Math.sqrt(scale)
  COUNT_PAIRS.forEach(([a, b]) => {
    const first = out[a]
    const second = out[b]
    if (first == null || second == null || done.has(a) || done.has(b)) return
    out[a] = Math.max(2, Math.round(first * root))
    out[b] = Math.max(2, Math.round(second * root))
    done.add(a)
    done.add(b)
  })
  COUNT_KEYS.forEach((key) => {
    const value = out[key]
    if (value != null && !done.has(key)) out[key] = Math.max(1, Math.round(value * scale))
  })
  ICON_DENSITY_KEYS.forEach((key) => {
    const value = out[key]
    if (value != null) out[key] = Math.max(0.02, value * scale)
  })
  return out
}

export function scaleRadii(opts: ModeOpts, scale: number): ModeOpts {
  const out: ModeOpts = { ...opts }
  RADIUS_KEYS.forEach((key) => {
    const value = out[key]
    if (value != null) out[key] = value * scale
  })
  out.rSizeMul = (out.rSizeMul ?? 1) * scale
  return out
}

/** Base fine profiles per mode, before preset multipliers. */
export const BASE_PROFILES: Record<string, ModeOpts> = {
  globe: {
    latRings: 17,
    lonDensity: 44,
    rBase: 0.6,
    rDepth: 1.7,
    rBoost: 1,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  orbits: {
    orbitN: 12,
    ghostN: 40,
    ghostR: 0.9,
    ghostA: 0.5,
    particles: 3,
    partR: 1.2,
    partRDepth: 1.6,
    rsPow: 0.6,
    rMin: 0.3,
  },
  rubik: {
    latRings: 15,
    lonDensity: 40,
    moveCount: 14,
    rBase: 0.6,
    rDepth: 1.7,
    rActive: 0.3,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  wave: {
    rings: 15,
    lonDensity: 40,
    rBase: 0.6,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  ribbon: {
    lanes: 5,
    segs: 88,
    ghostN: 150,
    rBase: 1.1,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  morph: {
    rDot: 0.021,
    iconD: 1,
    rMin: 0.25,
  },
}
