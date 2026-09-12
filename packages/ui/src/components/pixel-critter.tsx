import { createMemo } from "solid-js"

const SIZE = 8

const EMPTY = 0
const BODY = 1
const HOLE = 2
const BLUSH = 3
const SHADE = 4

function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  if ((h >>>= 0) === 0) h = 0x9e3779b9
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return (h >>>= 0) / 4294967296
  }
}

export function critterCells(seed: string): number[][] {
  for (let salt = 0; ; salt++) {
    const cells = generate(salt === 0 ? seed : `${seed}#${salt}`)
    if (!shaftLike(cells)) return cells
  }
}

// a run of 5+ rows that are each a single contiguous block at most 4 wide
// reads as a shaft — decorations like ears and arms break the run
function shaftLike(cells: number[][]) {
  let run = 0
  for (const row of cells) {
    const xs = row.flatMap((c, x) => (c === EMPTY ? [] : [x]))
    const block = xs.length > 0 && xs.length === xs[xs.length - 1] - xs[0] + 1 && xs.length <= 4
    run = block ? run + 1 : 0
    if (run >= 5) return true
  }
  return false
}

function generate(seed: string): number[][] {
  const rand = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
  const cells = Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(EMPTY))
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || x > 3 || y < 0 || y >= SIZE) return
    cells[y][x] = v
    cells[y][SIZE - 1 - x] = v
  }

  const half = pick([2, 3, 3])
  const top = pick([1, 2])
  const feet = pick(["none", "out", "in", "out", "skirt"])
  const bottom = feet === "none" ? 6 : pick([5, 6])

  for (let y = top; y <= bottom; y++) for (let x = 4 - half; x <= 3; x++) set(x, y, BODY)
  if (rand() < 0.6) set(4 - half, top, EMPTY)

  const topper = pick(["none", "ears", "antenna", "hair", "ears"])
  if (topper === "ears") set(4 - half, top - 1, BODY)
  if (topper === "antenna") set(3, top - 1, BODY)
  if (topper === "hair") for (let x = 4 - half; x <= 3; x++) set(x, top - 1, BODY)

  if (rand() < 0.25) set(3 - half, top, BODY)
  if (rand() < 0.35) set(3 - half, pick([top + 2, bottom - 1]), BODY)

  const face = top + 1
  const eyes =
    half === 2 ? pick(["cyclops", "tall", "cyclops"]) : pick(["wide", "cyclops", "tall", "tallWide", "shades", "wide"])
  const eyeH = eyes === "tall" || eyes === "tallWide" ? 2 : 1
  if (eyes === "wide") set(2, face, HOLE)
  if (eyes === "cyclops") set(3, face, HOLE)
  if (eyes === "tall") {
    set(3, face, HOLE)
    set(3, face + 1, HOLE)
  }
  if (eyes === "tallWide") {
    set(2, face, HOLE)
    set(2, face + 1, HOLE)
  }
  if (eyes === "shades") {
    set(2, face, HOLE)
    set(3, face, HOLE)
  }

  const mouthY = face + eyeH + 1
  const mouth = half === 2 ? pick(["none", "smile", "open", "smile"]) : pick(["none", "smile", "open", "fangs", "smile"])
  if (mouth === "smile" && mouthY <= bottom) set(3, mouthY, HOLE)
  if (mouth === "open" && mouthY <= bottom) {
    set(3, mouthY, HOLE)
    if (mouthY + 1 <= bottom) set(3, mouthY + 1, HOLE)
  }
  if (mouth === "fangs" && mouthY <= bottom) set(2, mouthY, HOLE)

  if (rand() < 0.5) {
    const blushX = half === 3 ? 1 : 2
    if (cells[face + 1]?.[blushX] === BODY) set(blushX, face + 1, BLUSH)
  }

  if (feet !== "none" && bottom + 1 < SIZE) {
    if (feet === "out") set(4 - half, bottom + 1, BODY)
    if (feet === "in") set(3, bottom + 1, BODY)
    if (feet === "skirt") for (let x = 4 - half; x <= 3; x++) set(x, bottom + 1, BODY)
  }

  if (rand() < 0.35) for (let x = 4 - half; x <= 3; x++) if (cells[bottom][x] === BODY) set(x, bottom, SHADE)

  return cells
}

function cellRuns(cells: number[][], match: (v: number) => boolean) {
  const parts: string[] = []
  for (let y = 0; y < SIZE; y++) {
    let x = 0
    while (x < SIZE) {
      if (!match(cells[y][x])) {
        x++
        continue
      }
      let w = 1
      while (x + w < SIZE && match(cells[y][x + w])) w++
      parts.push(`M${x} ${y}h${w}v1h${-w}z`)
      x += w
    }
  }
  return parts.join("")
}

export function critterPaths(seed: string) {
  const cells = critterCells(seed)
  return {
    // hole cells appear twice so fill-rule="evenodd" punches them out of the body
    body: cellRuns(cells, (v) => v !== EMPTY && v !== SHADE) + cellRuns(cells, (v) => v === HOLE),
    shade: cellRuns(cells, (v) => v === SHADE),
    blush: cellRuns(cells, (v) => v === BLUSH),
  }
}

export function PixelCritter(props: { seed: string; class?: string; shade?: string }) {
  const paths = createMemo(() => critterPaths(props.seed))
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      class={props.class}
      fill="currentColor"
      shape-rendering="crispEdges"
      aria-hidden="true"
      style="width:100%;height:100%;display:block"
    >
      <path d={paths().body} fill-rule="evenodd" />
      <path d={paths().shade} fill={props.shade} opacity="0.35" />
      <path d={paths().blush} fill="#ffa4c0" />
    </svg>
  )
}
