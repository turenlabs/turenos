import { hierarchy, treemap, treemapSquarify } from "d3"

export function visualizationTreemap(values: readonly number[], width = 800, height = 360) {
  const items = values
    .slice(0, 500)
    .flatMap((value, index) => (Number.isFinite(value) && value > 0 && value <= 1e12 ? [{ index, value }] : []))
  if (!items.length || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return []
  const root = hierarchy<{ index: number; value: number; children?: typeof items }>({
    index: -1,
    value: 0,
    children: items,
  }).sum((item) => item.value)
  return treemap<typeof root.data>()
    .tile(treemapSquarify)
    .size([width, height])
    .round(false)(root)
    .leaves()
    .map((node) => ({
      index: node.data.index,
      x: node.x0,
      y: node.y0,
      width: node.x1 - node.x0,
      height: node.y1 - node.y0,
    }))
}
