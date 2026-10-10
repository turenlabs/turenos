/** Grid points along each side of the distance field. */
export const GRID = 240
/** The field covers -EXTENT to EXTENT on both axes; the shape's longer side spans -1 to 1. */
export const EXTENT = 1.08
/** The distance between neighboring grid points. */
export const STEP = (EXTENT * 2) / (GRID - 1)

/**
 * The anvil in profile, horn to the left, as an SVG path of lines and cubic curves: the horn's point, the
 * table a step below the face, the heel, the waist, and two feet with an arch between them.
 */
const PROFILE = [
  "M0.6 4.6 C2.2 4.1 4.4 3.85 6.4 3.9 L8 3.9 L8 3 L23.2 3 L23.4 3.2 L23.4 5.2 L21.2 5.4",
  "C18.6 5.5 16.6 6.2 16.2 8.2 C16 9.4 16.3 10.3 17.6 10.9 L19.6 11.4 L19.6 12.6 L16.4 12.6",
  "C15.6 11.6 11.2 11.6 10.4 12.6 L7.2 12.6 L7.2 11.4 L9.2 10.9 C10.5 10.3 10.8 9.4 10.6 8.2",
  "C10.2 6.4 7.4 5.8 4.6 5.4 C3 5.15 1.6 4.9 0.6 4.6 Z",
].join(" ")

type Point = [number, number]

/**
 * The anvil's signed distance field, row by row from the top: positive inside, negative outside. Built once,
 * by filling the outline scanline by scanline and measuring each point's distance to the nearest edge.
 */
export const field = distances(fill(outline(PROFILE)))

/** The path's edges as straight segments, centered and scaled so its longer side spans -1 to 1. */
function outline(path: string) {
  const tokens = path.match(/[MLCZ]|-?\d*\.?\d+/g) ?? []
  const segments: [Point, Point][] = []
  let point: Point = [0, 0]
  let start: Point = [0, 0]
  const read = (at: number): Point => [Number(tokens[at]), Number(tokens[at + 1])]
  for (let at = 0; at < tokens.length; ) {
    const command = tokens[at++]
    if (command === "M") {
      point = start = read(at)
      at += 2
      continue
    }
    const ends = command === "C" ? [read(at), read(at + 2), read(at + 4)] : [command === "Z" ? start : read(at)]
    at += command === "C" ? 6 : command === "Z" ? 0 : 2
    for (const next of command === "C" ? curve(point, ends[0]!, ends[1]!, ends[2]!) : ends) {
      segments.push([point, next])
      point = next
    }
  }
  const xs = segments.flatMap(([a]) => [a[0]])
  const ys = segments.flatMap(([a]) => [a[1]])
  const center: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2
  const place = (p: Point): Point => [(p[0] - center[0]) / scale, (p[1] - center[1]) / scale]
  return segments.map(([a, b]): [Point, Point] => [place(a), place(b)])
}

/** A cubic curve as twelve straight steps. */
function curve(from: Point, a: Point, b: Point, end: Point) {
  return Array.from({ length: 12 }, (_, step): Point => {
    const t = (step + 1) / 12
    const u = 1 - t
    const at = (axis: 0 | 1) => u * u * u * from[axis] + 3 * u * u * t * a[axis] + 3 * u * t * t * b[axis] + t * t * t * end[axis]
    return [at(0), at(1)]
  })
}

/** Which grid points are inside the outline, by counting the edges each row crosses (nonzero winding). */
function fill(segments: [Point, Point][]) {
  const inside = new Uint8Array(GRID * GRID)
  for (let row = 0; row < GRID; row++) {
    const y = row * STEP - EXTENT
    const crossings = segments
      .filter(([a, b]) => (a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))
      .map(([a, b]) => ({ x: a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), turn: b[1] > a[1] ? 1 : -1 }))
      .toSorted((a, b) => a.x - b.x)
    let cursor = 0
    let winding = 0
    for (let column = 0; column < GRID; column++) {
      const x = column * STEP - EXTENT
      for (; cursor < crossings.length && crossings[cursor]!.x <= x; cursor++) winding += crossings[cursor]!.turn
      inside[row * GRID + column] = winding === 0 ? 0 : 1
    }
  }
  return inside
}

/** Each point's distance to the outline in the shape's units, by a two-pass chamfer sweep from the edge points. */
function distances(inside: Uint8Array) {
  const distance = new Float32Array(GRID * GRID).fill(GRID)
  for (let row = 1; row < GRID - 1; row++) {
    for (let column = 1; column < GRID - 1; column++) {
      const i = row * GRID + column
      if ([i - 1, i + 1, i - GRID, i + GRID].some((j) => inside[j] !== inside[i])) distance[i] = 0.5
    }
  }
  for (const reverse of [false, true]) {
    for (let row = 1; row < GRID - 1; row++) {
      for (let column = 1; column < GRID - 1; column++) {
        const i = reverse ? (GRID - 1 - row) * GRID + GRID - 1 - column : row * GRID + column
        const sign = reverse ? 1 : -1
        distance[i] = Math.min(
          distance[i]!,
          distance[i + sign]! + 1,
          distance[i + sign * GRID]! + 1,
          distance[i + sign * (GRID - 1)]! + Math.SQRT2,
          distance[i + sign * (GRID + 1)]! + Math.SQRT2,
        )
      }
    }
  }
  return distance.map((value, i) => value * STEP * (inside[i] ? 1 : -1))
}
