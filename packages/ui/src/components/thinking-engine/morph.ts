// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import { paint } from "./core"
import type { Dot, ModeDraw } from "./types"

type Path = (fraction: number) => [number, number]

function smooth(value: number): number {
  return value * value * (3 - 2 * value)
}

function polygonPath(vertices: ReadonlyArray<readonly [number, number]>): Path {
  const lengths = vertices.map((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length]
    return Math.hypot(next[0] - vertex[0], next[1] - vertex[1])
  })
  const total = lengths.reduce((sum, length) => sum + length, 0)
  return (fraction) => {
    const target = fraction * total
    const segment = lengths.reduce(
      (result, length, index) => {
        if (result.done) return result
        if (result.offset + length >= target || index === lengths.length - 1)
          return { index, offset: result.offset, done: true }
        return { index: result.index, offset: result.offset + length, done: false }
      },
      { index: 0, offset: 0, done: false },
    )
    const start = vertices[segment.index]
    const end = vertices[(segment.index + 1) % vertices.length]
    const progress = lengths[segment.index] ? Math.min(1, (target - segment.offset) / lengths[segment.index]) : 0
    return [start[0] + (end[0] - start[0]) * progress, start[1] + (end[1] - start[1]) * progress]
  }
}

const CIRCLE: Path = (fraction) => {
  const angle = -Math.PI / 2 + fraction * 2 * Math.PI
  return [Math.cos(angle) * 0.24, Math.sin(angle) * 0.24]
}
const TRIANGLE = polygonPath([
  [0, -0.26],
  [0.24, 0.16],
  [-0.24, 0.16],
])
const SQUARE = polygonPath([
  [0, -0.2],
  [0.2, -0.2],
  [0.2, 0.2],
  [-0.2, 0.2],
  [-0.2, -0.2],
])
const CYCLE: Path[] = [CIRCLE, TRIANGLE, SQUARE]
const HOLD = 1.4
const MORPH = 0.9
const SEGMENT = HOLD + MORPH

export const drawMorph: ModeDraw = (ctx, size, time, dark, opts) => {
  const elapsed = time % (SEGMENT * CYCLE.length)
  const cycleIndex = Math.floor(elapsed / SEGMENT)
  const local = elapsed - cycleIndex * SEGMENT
  const morph = local > HOLD ? smooth((local - HOLD) / MORPH) : 0
  const spread = opts.spread ?? 1
  const current = CYCLE[cycleIndex]
  const next = CYCLE[(cycleIndex + 1) % CYCLE.length]
  const sampleCount = 160
  const points = Array.from({ length: sampleCount }, (_, index): [number, number] => {
    const fraction = index / sampleCount
    const start = current(fraction)
    const end = next(fraction)
    return [(start[0] + (end[0] - start[0]) * morph) * spread, (start[1] + (end[1] - start[1]) * morph) * spread]
  })
  const lengths = points.map((point, index) => {
    const following = points[(index + 1) % sampleCount]
    return Math.hypot(following[0] - point[0], following[1] - point[1])
  })
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const dotCount = Math.max(6, Math.round(34 * (opts.iconD ?? 1)))
  const dotRadius = (opts.rDot ?? 0.021) * 1.35 * spread
  const pulse = 1 + 0.02 * Math.sin(local * 3.1)
  const center = size / 2

  const dots = Array.from({ length: dotCount }, (_, index): Dot => {
    const target = (index / dotCount) * total
    const segment = lengths.reduce(
      (result, length, segmentIndex) => {
        if (result.done) return result
        if (result.offset + length >= target || segmentIndex === lengths.length - 1)
          return { index: segmentIndex, offset: result.offset, done: true }
        return { index: result.index, offset: result.offset + length, done: false }
      },
      { index: 0, offset: 0, done: false },
    )
    const start = points[segment.index]
    const end = points[(segment.index + 1) % sampleCount]
    const progress = lengths[segment.index] ? Math.min(1, (target - segment.offset) / lengths[segment.index]) : 0
    const x = (start[0] + (end[0] - start[0]) * progress) * pulse
    const y = (start[1] + (end[1] - start[1]) * progress) * pulse
    return {
      x: center + x * size,
      y: center + y * size,
      z: 0,
      r: Math.max(0.35, dotRadius * size),
      white: 0.1,
    }
  })
  paint(ctx, dots, dark, opts.rMin)
}
