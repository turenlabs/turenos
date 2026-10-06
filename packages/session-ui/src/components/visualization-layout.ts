/** Split each region in half by item count. Its areas follow the item weights. */
export function visualizationTreemap(values: readonly number[], width = 800, height = 360) {
  const items = values
    .slice(0, 500)
    .flatMap((value, index) => (Number.isFinite(value) && value > 0 && value <= 1e12 ? [{ index, value }] : []))
  const rectangles: { index: number; x: number; y: number; width: number; height: number }[] = []
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return rectangles

  function split(start: number, end: number, x: number, y: number, w: number, h: number, total: number) {
    if (end <= start || total <= 0) return
    if (end - start === 1) {
      rectangles.push({ index: items[start]!.index, x, y, width: w, height: h })
      return
    }
    const middle = Math.floor((start + end) / 2)
    const left = items.slice(start, middle).reduce((sum, item) => sum + item.value, 0)
    const right = items.slice(middle, end).reduce((sum, item) => sum + item.value, 0)
    const fraction = left / total
    if (w >= h) {
      split(start, middle, x, y, w * fraction, h, left)
      split(middle, end, x + w * fraction, y, w * (1 - fraction), h, right)
      return
    }
    split(start, middle, x, y, w, h * fraction, left)
    split(middle, end, x, y + h * fraction, w, h * (1 - fraction), right)
  }

  split(
    0,
    items.length,
    0,
    0,
    width,
    height,
    items.reduce((sum, item) => sum + item.value, 0),
  )
  return rectangles
}
