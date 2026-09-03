// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import { fibDir, makeProj, paint, radiusScale } from "./core"
import type { Dot, ModeDraw } from "./types"

export const drawRibbon: ModeDraw = (ctx, size, time, dark, opts) => {
  const center = size / 2
  const radius = (size / 2) * 0.78
  const spin = opts.spin ?? 1
  const project = makeProj(time * 0.1 * spin, 0.3, center, center, 1)
  const radiusMultiplier = radiusScale(size, opts.rsPow ?? 0.6)
  const dots: Dot[] = []
  const ghostCount = opts.ghostN ?? 150

  Array.from({ length: ghostCount }, (_, index) => index).forEach((index) => {
    const direction = fibDir(index, ghostCount)
    const [x, y, z] = project(direction[0] * radius, direction[1] * radius, direction[2] * radius)
    const depth = (z / radius + 1) / 2
    dots.push({ x, y, z, r: 0.8 * radiusMultiplier, white: 0.78, a: 0.1 + 0.22 * depth })
  })

  const yaw = time * 0.24 * spin
  const tilt = 0.55 + 0.3 * Math.sin(time * 0.18) * spin
  const unitX = Math.cos(yaw)
  const unitY = 0
  const unitZ = Math.sin(yaw)
  const vectorX = -unitZ * Math.sin(tilt)
  const vectorY = Math.cos(tilt)
  const vectorZ = unitX * Math.sin(tilt)
  const normalX = unitY * vectorZ - unitZ * vectorY
  const normalY = unitZ * vectorX - unitX * vectorZ
  const normalZ = unitX * vectorY - unitY * vectorX
  const laneCount = Math.max(1, Math.round((opts.lanes ?? 5) * (opts.bandMul ?? 1)))
  const segments = opts.segs ?? 88

  Array.from({ length: laneCount }, (_, lane) => lane).forEach((lane) => {
    const laneOffset = (lane - (laneCount - 1) / 2) * 0.075
    const edge = Math.abs(lane - (laneCount - 1) / 2) / Math.max(1, (laneCount - 1) / 2)
    Array.from({ length: segments }, (_, index) => index).forEach((index) => {
      const angle = (index / segments) * 2 * Math.PI
      const wobble =
        (0.16 * Math.sin(angle * 3 - time * 1.7 + lane * 0.22) + 0.07 * Math.sin(angle * 5 + time * 1.1)) *
        (opts.wobMul ?? 1)
      const offset = laneOffset + wobble
      const rawX = unitX * Math.cos(angle) + vectorX * Math.sin(angle) + normalX * offset
      const rawY = unitY * Math.cos(angle) + vectorY * Math.sin(angle) + normalY * offset
      const rawZ = unitZ * Math.cos(angle) + vectorZ * Math.sin(angle) + normalZ * offset
      const length = Math.sqrt(rawX * rawX + rawY * rawY + rawZ * rawZ)
      const [x, y, z] = project((rawX / length) * radius, (rawY / length) * radius, (rawZ / length) * radius)
      const depth = (z / radius + 1) / 2
      dots.push({
        x,
        y,
        z,
        r: ((opts.rBase ?? 1.1) + (opts.rDepth ?? 1.7) * depth) * (1 - 0.25 * edge) * radiusMultiplier,
        white: 0.52 - 0.44 * depth + 0.18 * edge,
        a: 0.4 + 0.6 * depth,
      })
    })
  })
  paint(ctx, dots, dark, opts.rMin)
}
