import { solid } from "./solid"

/** How the anvil stands: turned about its upright axis, tipped toward the viewer, and rolled. */
export type Pose = { turn: number; tip: number; roll: number }
/** A drawn cell: a Braille pattern and its color as 0xRRGGBB. */
export type Cell = { char: string; color: number }
type RGB = [number, number, number]

/** The camera's distance, in the anvil's units, for perspective. */
const CAMERA = 4.4
/** Braille dot bits, row by row: two dots across, four down. */
const DOT_BITS = [1, 8, 2, 16, 4, 32, 64, 128]
/** Studio lighting in the desktop's colors: steel key light, navy shadow, blue fill, a pale blue rim, cream gloss. */
const KEY: RGB = [196, 210, 228]
const SHADOW: RGB = [28, 46, 84]
const FILL: RGB = [38, 101, 172]
const RIM: RGB = [124, 200, 248]
const GLOSS: RGB = [255, 248, 232]

/** Draws the anvil in Braille cells, reusing its buffers from frame to frame. */
export function createRenderer() {
  const dots = { depth: new Float32Array(0), owner: new Int32Array(0), color: new Uint32Array(0) }

  function frame(columns: number, rows: number, pose: Pose, background: RGB) {
    const [width, height] = [columns * 2, rows * 4]
    if (dots.depth.length !== width * height) {
      dots.depth = new Float32Array(width * height)
      dots.owner = new Int32Array(width * height)
      dots.color = new Uint32Array(width * height)
    }
    dots.depth.fill(Number.NEGATIVE_INFINITY)
    dots.owner.fill(-1)
    const view = camera(width, height, pose)
    // Every point is placed, and the nearest at each dot owns it; only owners are lit.
    for (let at = 0; at < solid.length; at += 6) {
      const index = view.place(solid[at]!, solid[at + 1]!, solid[at + 2]!)
      if (index < 0 || view.z <= dots.depth[index]!) continue
      dots.depth[index] = view.z
      dots.owner[index] = at
    }
    dots.owner.forEach((at, index) => {
      if (at < 0) return
      const [nx, ny, nz] = view.turn(solid[at + 3]!, solid[at + 4]!, solid[at + 5]!)
      const grain = Math.sin(solid[at]! * 23 + solid[at + 1]! * 19) * 0.01
      dots.color[index] = shade(nx, ny, nz, dots.depth[index]!, grain, background)
    })
    return cells(columns, rows, dots)
  }

  return { frame }
}

/**
 * The view of the anvil: `place` puts a point on the dot grid in perspective and returns its dot, or -1 off the
 * grid, leaving its depth in `z`; `turn` turns a normal the way the anvil is turned.
 */
function camera(width: number, height: number, pose: Pose) {
  const [sinTurn, cosTurn, sinTip, cosTip] = [Math.sin(pose.turn), Math.cos(pose.turn), Math.sin(pose.tip), Math.cos(pose.tip)]
  const [sinRoll, cosRoll] = [Math.sin(pose.roll), Math.cos(pose.roll)]
  const turn = (x: number, y: number, z: number): RGB => {
    const x1 = x * cosTurn + z * sinTurn
    const z1 = -x * sinTurn + z * cosTurn
    const y2 = y * cosTip - z1 * sinTip
    return [x1 * cosRoll - y2 * sinRoll, x1 * sinRoll + y2 * cosRoll, y * sinTip + z1 * cosTip]
  }
  // The same turn as a matrix, its columns the turned axes, for the hot loop.
  const [ax, ay, az] = [turn(1, 0, 0), turn(0, 1, 0), turn(0, 0, 1)]
  // The profile spans x from -1 to 1 and y about -0.42 to 0.42; leave room for perspective and the tip.
  const scale = Math.min(width / 2.35, height / 1.1)
  const view = {
    z: 0,
    turn,
    place(x: number, y: number, z: number) {
      const px = ax[0] * x + ay[0] * y + az[0] * z
      const py = ax[1] * x + ay[1] * y + az[1] * z
      view.z = ax[2] * x + ay[2] * y + az[2] * z
      const perspective = (CAMERA / (CAMERA - view.z)) * scale
      const column = Math.floor(width / 2 + px * perspective)
      const row = Math.floor(height / 2 + py * perspective)
      return column < 0 || column >= width || row < 0 || row >= height ? -1 : row * width + column
    },
  }
  return view
}

/** Studio lighting from the upper left, after Codex's welcome animation, blended toward the background with depth. */
function shade(nx: number, ny: number, nz: number, depth: number, grain: number, background: RGB) {
  const diffuse = clamp(nx * -0.41 + ny * -0.564 + nz * 0.718 + grain)
  const bounce = clamp(nx * 0.55 + ny * 0.2 - nz * 0.35) * (1 - diffuse) * 0.38
  const edge = (1 - Math.min(Math.abs(nz), 1)) ** 2.4 * clamp(nx * 0.85 - ny * 0.38) * 0.82
  const gloss = clamp(nx * -0.22 + ny * -0.302 + nz * 0.928) ** 18 * 0.96
  const base = (1 - bounce) * (1 - edge) * (1 - gloss)
  const gain = Math.min(Math.max(0.9 + depth * 0.18, 0.68), 1)
  const channel = (i: 0 | 1 | 2) => {
    const value =
      SHADOW[i] * (1 - diffuse) * base +
      KEY[i] * diffuse * base +
      FILL[i] * bounce * (1 - edge) * (1 - gloss) +
      RIM[i] * edge * (1 - gloss) +
      GLOSS[i] * gloss
    return Math.round(background[i] + (value - background[i]) * gain)
  }
  return (channel(0) << 16) | (channel(1) << 8) | channel(2)
}

/** Each cell's Braille pattern from its eight dots, in the average color of its lit dots. */
function cells(columns: number, rows: number, dots: { depth: Float32Array; color: Uint32Array }) {
  const width = columns * 2
  return Array.from({ length: rows * columns }, (_, cell): Cell | undefined => {
    const [row, column] = [Math.floor(cell / columns), cell % columns]
    const sum = { r: 0, g: 0, b: 0, lit: 0, bits: 0 }
    for (const [point, bit] of DOT_BITS.entries()) {
      const i = (row * 4 + (point >> 1)) * width + column * 2 + (point & 1)
      if (dots.depth[i] === Number.NEGATIVE_INFINITY) continue
      sum.bits |= bit
      sum.r += dots.color[i]! >> 16
      sum.g += (dots.color[i]! >> 8) & 0xff
      sum.b += dots.color[i]! & 0xff
      sum.lit++
    }
    if (!sum.bits) return undefined
    const average = (total: number) => Math.round(total / sum.lit)
    const color = (average(sum.r) << 16) | (average(sum.g) << 8) | average(sum.b)
    return { char: String.fromCharCode(0x2800 + sum.bits), color }
  })
}

function clamp(value: number) {
  return Math.min(Math.max(value, 0), 1)
}
