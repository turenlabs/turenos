import { EXTENT, GRID, STEP, field } from "./field"

/** The rounding of the anvil's edges; the horn rounds into a cone. */
const BEVEL = 0.07

/**
 * The anvil as points on its surface, six numbers to a point: position (y points down) and outward normal. The
 * profile is extruded with its front and back faces rounded at the edges and joined by side walls; the face and
 * the feet are wider than the waist, and the horn, as thin as its rounding, comes out round. Built once.
 */
export const solid = (() => {
  const points: number[] = []
  for (let row = 1; row < GRID - 1; row++) {
    for (let column = 1; column < GRID - 1; column++) {
      const i = row * GRID + column
      if (field[i]! < -STEP) continue
      const dx = field[i + 1]! - field[i - 1]!
      const dy = field[i + GRID]! - field[i - GRID]!
      const length = Math.hypot(dx, dy) || 1
      extrude(points, column * STEP - EXTENT, row * STEP - EXTENT, dx / length, dy / length, field[i]!)
    }
  }
  return Float32Array.from(points)
})()

/** The surface points over one point of the profile: on both faces when inside it, along the wall at its edge. */
function extrude(points: number[], x: number, y: number, gx: number, gy: number, d: number) {
  const horn = smooth((-0.36 - x) / 0.2)
  const round = BEVEL + horn * 0.03
  const waist = y < 0 ? 0.13 + 0.08 * smooth(-y / 0.25) : 0.13 + 0.11 * smooth((y - 0.12) / 0.2)
  const side = waist * (1 - horn) + round * horn - round
  if (d > 0) {
    const edge = Math.min(Math.max(1 - d / round, 0), 1)
    const nz = Math.sqrt(1 - edge * edge)
    // A slight barrel along the length and a ripple, as in hammered steel, sweep the sheen across the face as
    // the anvil turns.
    const [u, v] = [x * 2.2 + y * 0.7, y * 2.8 - x * 0.4]
    const z = side + round * nz + (Math.sin(u) * 0.05 + Math.sin(v) * 0.025 - x * x * 0.06) * nz
    const nx = -gx * edge - nz * (Math.cos(u) * 0.12 - Math.cos(v) * 0.012 - x * 0.28)
    const ny = -gy * edge - nz * (Math.cos(u) * 0.04 + Math.cos(v) * 0.08)
    const length = Math.hypot(nx, ny, nz)
    points.push(x, y, z, nx / length, ny / length, nz / length)
    points.push(x, y, -z, nx / length, ny / length, -nz / length)
  }
  if (Math.abs(d) >= STEP * 0.8 || side <= 0) return
  const layers = Math.ceil((side * 2) / STEP)
  for (let layer = 0; layer <= layers; layer++)
    points.push(x - gx * d, y - gy * d, -side + (layer / layers) * side * 2, -gx, -gy, 0)
}

/** Smootherstep from 0 to 1. */
function smooth(value: number) {
  const t = Math.min(Math.max(value, 0), 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
