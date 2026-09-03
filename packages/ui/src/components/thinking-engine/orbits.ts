// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import { hashD, makeProj, paint, radiusScale } from "./core"
import type { Dot, ModeDraw } from "./types"

export const drawOrbits: ModeDraw = (ctx, size, time, dark, opts) => {
  const center = size / 2
  const radius = (size / 2) * 0.82
  const project = makeProj(time * 0.12, 0.3, center, center, 1)
  const radiusMultiplier = radiusScale(size, opts.rsPow ?? 0.6)
  const dots: Dot[] = []
  const orbitCount = opts.orbitN ?? 12
  const ghostCount = opts.ghostN ?? 40
  const particles = opts.particles ?? 3

  Array.from({ length: orbitCount }, (_, orbit) => orbit).forEach((orbit) => {
    const first = hashD(orbit, 1.7)
    const second = hashD(orbit, 5.2)
    const third = hashD(orbit, 8.9)
    const orbitRadius = radius * (0.45 + 0.52 * first)
    const theta = first * 2 * Math.PI
    const phi = Math.acos(2 * second - 1)
    const normalX = Math.sin(phi) * Math.cos(theta)
    const normalY = Math.cos(phi)
    const normalZ = Math.sin(phi) * Math.sin(theta)
    const rawX = -normalY
    const rawY = normalX
    const vectorLength = Math.max(1e-6, Math.sqrt(rawX * rawX + rawY * rawY))
    const unitX = rawX / vectorLength
    const unitY = rawY / vectorLength
    const unitZ = 0
    const vectorX = normalY * unitZ - normalZ * unitY
    const vectorY = normalZ * unitX - normalX * unitZ
    const vectorZ = normalX * unitY - normalY * unitX
    const speed = (0.25 + 0.55 * third) * (third > 0.5 ? 1 : -1)

    Array.from({ length: ghostCount }, (_, index) => index).forEach((index) => {
      const angle = (index / ghostCount) * 2 * Math.PI
      const [x, y, z] = project(
        (unitX * Math.cos(angle) + vectorX * Math.sin(angle)) * orbitRadius,
        (unitY * Math.cos(angle) + vectorY * Math.sin(angle)) * orbitRadius,
        (unitZ * Math.cos(angle) + vectorZ * Math.sin(angle)) * orbitRadius,
      )
      const depth = (z / orbitRadius + 1) / 2
      dots.push({
        x,
        y,
        z,
        r: (opts.ghostR ?? 0.9) * radiusMultiplier,
        white: 0.72,
        a: (opts.ghostA ?? 0.5) * (0.4 + 0.6 * depth),
      })
    })

    Array.from({ length: particles }, (_, index) => index).forEach((index) => {
      const angle = time * speed + (index / particles) * 2 * Math.PI + second * 6
      const [x, y, z] = project(
        (unitX * Math.cos(angle) + vectorX * Math.sin(angle)) * orbitRadius,
        (unitY * Math.cos(angle) + vectorY * Math.sin(angle)) * orbitRadius,
        (unitZ * Math.cos(angle) + vectorZ * Math.sin(angle)) * orbitRadius,
      )
      const depth = (z / orbitRadius + 1) / 2
      dots.push({
        x,
        y,
        z,
        r: ((opts.partR ?? 1.2) + (opts.partRDepth ?? 1.6) * depth) * radiusMultiplier,
        white: 0.3 - 0.22 * depth,
      })
    })
  })
  paint(ctx, dots, dark, opts.rMin)
}
