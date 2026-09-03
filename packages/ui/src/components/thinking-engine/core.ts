// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

export interface Dot {
  x: number
  y: number
  z: number
  r: number
  /** Ink value: 0 = darkest ink on paper. Mirrored on dark themes. */
  white: number
  a?: number
}

export type Projector = (x: number, y: number, z: number) => [number, number, number]

/** Deterministic hash in [0, 1). */
export function hashD(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return h - Math.floor(h)
}

/** Stable directions on a unit sphere (Fibonacci lattice). */
export function fibDir(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const y = 1 - (2 * (i + 0.5)) / n
  const rad = Math.sqrt(1 - y * y)
  const a = i * golden
  return [rad * Math.cos(a), y, rad * Math.sin(a)]
}

/** Shortest signed angular distance, wrapped to (-π, π]. */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

/** Shared spin + tilt + orthographic projection. */
export function makeProj(yaw: number, tilt: number, cx: number, cy: number, scale: number): Projector {
  const st = Math.sin(tilt)
  const ct = Math.cos(tilt)
  const sy = Math.sin(yaw)
  const cyw = Math.cos(yaw)
  return (x, y, z) => {
    const x1 = x * cyw + z * sy
    const z1 = -x * sy + z * cyw
    const y1 = y * ct - z1 * st
    const z2 = y * st + z1 * ct
    return [cx + x1 * scale, cy - y1 * scale, z2]
  }
}

/**
 * Painter: z-sort far to near, matte grayscale dots. On dark substrates the
 * ink value is mirrored so near dots read bright.
 */
export function paint(ctx: CanvasRenderingContext2D, dots: Dot[], dark: boolean, rMin = 0.3): void {
  dots.sort((a, b) => a.z - b.z)
  dots.forEach((dot) => {
    const alpha = dot.a ?? 1
    if (alpha < 0.02) return
    const white = Math.min(1, Math.max(0, dot.white))
    const gray = Math.round((dark ? 1 - white : white) * 255)
    ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, Math.max(rMin, dot.r), 0, Math.PI * 2)
    ctx.fill()
  })
}

/**
 * Dot radii were tuned for a 300pt frame; sub-linear scaling keeps small
 * spinners legible.
 */
export function radiusScale(size: number, pow: number): number {
  return (size / 300) ** pow
}
