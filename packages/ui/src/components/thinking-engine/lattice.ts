// Ported from thinking-orbs at commit eda2d708b99ab871993bbea5a5f08d23a14da436.
// Copyright (c) 2026 Jakub Antalik. MIT licensed; see THIRD_PARTY_LICENSE.txt.

import { angleDelta, hashD, makeProj, paint, radiusScale } from "./core"
import type { Dot, ModeDraw } from "./types"

interface Move {
  axis: 0 | 1 | 2
  lo: number
  hi: number
  ang: number
}

function solveCycle(time: number, count: number, slotDuration: number, rest: number) {
  const cycle = 2 * count * slotDuration + rest
  const elapsed = time % cycle
  const amount = new Array<number>(count).fill(0)
  if (elapsed >= 2 * count * slotDuration) return { amount, active: -1 }

  const slot = Math.floor(elapsed / slotDuration)
  const progress = (elapsed - slot * slotDuration) / slotDuration
  const eased = 1 - (1 - Math.min(1, progress / 0.7)) ** 3
  if (slot < count) {
    amount.fill(1, 0, slot)
    amount[slot] = eased
    return { amount, active: slot }
  }
  const active = 2 * count - 1 - slot
  amount.fill(1, 0, active)
  amount[active] = 1 - eased
  return { amount, active }
}

function applyMoves(
  point: [number, number, number],
  moves: Move[],
  cycle: { amount: number[]; active: number },
): [number, number, number, boolean] {
  const result = moves.reduce(
    (current, move, index) => {
      if (cycle.amount[index] <= 0) return current
      const coordinate = move.axis === 0 ? current.x : move.axis === 1 ? current.y : current.z
      if (coordinate < move.lo || coordinate >= move.hi) return current
      const angle = move.ang * cycle.amount[index]
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      if (move.axis === 0)
        return {
          x: current.x,
          y: current.y * cosine - current.z * sine,
          z: current.y * sine + current.z * cosine,
          active: current.active || index === cycle.active,
        }
      if (move.axis === 1)
        return {
          x: current.x * cosine + current.z * sine,
          y: current.y,
          z: -current.x * sine + current.z * cosine,
          active: current.active || index === cycle.active,
        }
      return {
        x: current.x * cosine - current.y * sine,
        y: current.x * sine + current.y * cosine,
        z: current.z,
        active: current.active || index === cycle.active,
      }
    },
    { x: point[0], y: point[1], z: point[2], active: false },
  )
  return [result.x, result.y, result.z, result.active]
}

function makeMoves(count: number): Move[] {
  return Array.from({ length: count }, (_, index) => {
    const axis = Math.min(2, Math.floor(hashD(index, 2.3) * 3)) as 0 | 1 | 2
    const lo = -1 + 0.5 * Math.min(3, Math.floor(hashD(index, 5.9) * 4))
    const direction = hashD(index, 7.7) < 0.5 ? 1 : -1
    return { axis, lo, hi: lo + 0.5, ang: (direction * Math.PI) / 2 }
  })
}

export const drawGlobe: ModeDraw = (ctx, size, time, dark, opts) => {
  const spin = 0.5
  const center = size / 2
  const radius = (size / 2) * 0.82
  const tilt = 0.4 + 0.06 * Math.sin(time * 0.35)
  const project = makeProj(time * spin, tilt, center, center, radius)
  const scan = time * (spin + (1.7 - spin) * (opts.scanMul ?? 1))
  const radiusMultiplier = radiusScale(size, opts.rsPow ?? 0.6)
  const dimBase = opts.dimBase ?? 1
  const latitudeRings = opts.latRings ?? 17
  const longitudeDensity = opts.lonDensity ?? 44
  const dots: Dot[] = []

  Array.from({ length: latitudeRings + 1 }, (_, latitudeIndex) => latitudeIndex).forEach((latitudeIndex) => {
    const latitude = -Math.PI / 2 + (latitudeIndex / latitudeRings) * Math.PI
    const cosineLatitude = Math.cos(latitude)
    const sineLatitude = Math.sin(latitude)
    const longitudeCount = Math.max(1, Math.round(Math.abs(cosineLatitude) * longitudeDensity))
    Array.from({ length: longitudeCount }, (_, longitudeIndex) => longitudeIndex).forEach((longitudeIndex) => {
      const longitude = (longitudeIndex / longitudeCount) * 2 * Math.PI
      const [x, y, z] = project(
        cosineLatitude * Math.cos(longitude),
        sineLatitude,
        cosineLatitude * Math.sin(longitude),
      )
      const depth = (z + 1) / 2
      const delta = angleDelta(longitude + time * spin, scan)
      const boost = Math.exp(-(delta * delta) / 0.18) * Math.max(0, z)
      dots.push({
        x,
        y,
        z,
        r: ((opts.rBase ?? 0.6) + (opts.rDepth ?? 1.7) * depth + (opts.rBoost ?? 1) * boost) * radiusMultiplier,
        white: (opts.inkFar ?? 0.62) - (opts.inkSpan ?? 0.54) * depth,
        a: dimBase + (1 - dimBase) * Math.min(1, boost),
      })
    })
  })
  paint(ctx, dots, dark, opts.rMin)
}

export const drawRubik: ModeDraw = (ctx, size, time, dark, opts) => {
  const center = size / 2
  const radius = (size / 2) * 0.82
  const project = makeProj(time * 0.55, 0.35 + 0.1 * Math.sin(time * 0.9), center, center, radius)
  const radiusMultiplier = radiusScale(size, opts.rsPow ?? 0.6)
  const moveCount = opts.moveCount ?? 14
  const moves = makeMoves(moveCount)
  const cycle = solveCycle(time, moveCount, 0.42, 1.2)
  const latitudeRings = opts.latRings ?? 15
  const longitudeDensity = opts.lonDensity ?? 40
  const dots: Dot[] = []

  Array.from({ length: latitudeRings + 1 }, (_, latitudeIndex) => latitudeIndex).forEach((latitudeIndex) => {
    const latitude = -Math.PI / 2 + (latitudeIndex / latitudeRings) * Math.PI
    const cosineLatitude = Math.cos(latitude)
    const sineLatitude = Math.sin(latitude)
    const longitudeCount = Math.max(1, Math.round(Math.abs(cosineLatitude) * longitudeDensity))
    Array.from({ length: longitudeCount }, (_, longitudeIndex) => longitudeIndex).forEach((longitudeIndex) => {
      const longitude = (longitudeIndex / longitudeCount) * 2 * Math.PI
      const [movedX, movedY, movedZ, active] = applyMoves(
        [cosineLatitude * Math.cos(longitude), sineLatitude, cosineLatitude * Math.sin(longitude)],
        moves,
        cycle,
      )
      const [x, y, z] = project(movedX, movedY, movedZ)
      const depth = (z + 1) / 2
      dots.push({
        x,
        y,
        z,
        r:
          ((opts.rBase ?? 0.6) + (opts.rDepth ?? 1.7) * depth + (active ? (opts.rActive ?? 0.3) : 0)) *
          radiusMultiplier,
        white: (opts.inkFar ?? 0.62) - (opts.inkSpan ?? 0.54) * depth - (active ? 0.14 : 0),
      })
    })
  })
  paint(ctx, dots, dark, opts.rMin)
}

export const drawWave: ModeDraw = (ctx, size, time, dark, opts) => {
  const center = size / 2
  const radius = (size / 2) * 0.874
  const project = makeProj(time * 0.18, 0.38, center, center, 1)
  const radiusMultiplier = radiusScale(size, opts.rsPow ?? 0.6)
  const ringCount = opts.rings ?? 15
  const longitudeDensity = opts.lonDensity ?? 40
  const dots: Dot[] = []

  Array.from({ length: ringCount + 1 }, (_, ring) => ring).forEach((ring) => {
    const latitude = -Math.PI / 2 + (ring / ringCount) * Math.PI
    const cosineLatitude = Math.cos(latitude)
    const sineLatitude = Math.sin(latitude)
    const wave = 0.62 * Math.sin(time * 2.1 - ring * 0.52) + 0.38 * Math.sin(time * 1.27 + ring * 0.83)
    const ringRadius = radius * (0.88 + 0.105 * wave)
    const longitudeCount = Math.max(1, Math.round(Math.abs(cosineLatitude) * longitudeDensity))
    Array.from({ length: longitudeCount }, (_, longitudeIndex) => longitudeIndex).forEach((longitudeIndex) => {
      const longitude = (longitudeIndex / longitudeCount) * 2 * Math.PI
      const [x, y, z] = project(
        cosineLatitude * Math.cos(longitude) * ringRadius,
        sineLatitude * ringRadius,
        cosineLatitude * Math.sin(longitude) * ringRadius,
      )
      const depth = (z / radius + 1) / 2
      const crest = Math.max(0, wave)
      dots.push({
        x,
        y,
        z,
        r: ((opts.rBase ?? 0.6) + (opts.rDepth ?? 1.7) * depth) * (1 + 0.4 * crest) * radiusMultiplier,
        white: 0.66 - 0.56 * depth - 0.1 * crest,
      })
    })
  })
  paint(ctx, dots, dark, opts.rMin)
}
