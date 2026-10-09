import { For, createMemo, createSignal } from "solid-js"

export const pixelAvatarPalette = [
  "#e5e5e5",
  "#52525b",
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#a78bfa",
  "#fb923c",
] as const

const colorNames = ["Light gray", "Dark gray", "Blue", "Green", "Yellow", "Red", "Purple", "Orange"] as const
const colors = ["0", "1", "2", "3", "4", "5", "6", "7", "."] as const
type PixelColor = (typeof colors)[number]

export interface PixelAvatarProps {
  avatar?: readonly string[]
  seed: string
  size?: number
  label?: string
}

export interface PixelAvatarEditorProps {
  value?: readonly string[]
  seed: string
  onChange: (avatar: string[]) => void
}

export function generatePixelAvatar(seed: string): string[] {
  const hash = (value: string) => {
    let result = 2166136261
    for (const character of value) result = Math.imul(result ^ character.codePointAt(0)!, 16777619)
    return result >>> 0
  }
  const color = String(2 + (hash(seed) % 6))
  return Array.from({ length: 8 }, (_, row) => {
    const half = Array.from({ length: 4 }, (_, column) =>
      hash(`${seed}:${row}:${column}`) % 3 === 0 ? "." : color,
    )
    return [...half, ...half.toReversed()].join("")
  })
}

export function resolvePixelAvatar(avatar: readonly string[] | undefined, seed: string): string[] {
  if (avatar?.length === 8 && Array.from(avatar).every((row) => typeof row === "string" && /^[.0-7]{8}$/.test(row)))
    return [...avatar]
  return generatePixelAvatar(seed)
}

export function paintPixelAvatar(avatar: readonly string[], index: number, color: PixelColor): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= 64) return [...avatar]
  return avatar.map((row, y) =>
    y === Math.floor(index / 8) ? row.slice(0, index % 8) + color + row.slice((index % 8) + 1) : row,
  )
}

export function pixelAvatarNavigation(index: number, key: string) {
  const row = Math.floor(index / 8)
  const column = index % 8
  if (key === "ArrowLeft") return row * 8 + Math.max(0, column - 1)
  if (key === "ArrowRight") return row * 8 + Math.min(7, column + 1)
  if (key === "ArrowUp") return Math.max(0, row - 1) * 8 + column
  if (key === "ArrowDown") return Math.min(7, row + 1) * 8 + column
  if (key === "Home") return row * 8
  if (key === "End") return row * 8 + 7
}

function colorName(color: string) {
  return color === "." ? "Transparent" : colorNames[Number(color)]!
}

export function PixelAvatar(props: PixelAvatarProps) {
  const pixels = createMemo(() =>
    resolvePixelAvatar(props.avatar, props.seed).flatMap((row, y) =>
      [...row].flatMap((color, x) => (color === "." ? [] : [{ x, y, fill: pixelAvatarPalette[Number(color)] }])),
    ),
  )
  return (
    <svg
      viewBox="0 0 8 8"
      width={props.size ?? 32}
      height={props.size ?? 32}
      shape-rendering="crispEdges"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      class="shrink-0"
    >
      <For each={pixels()}>{(pixel) => <rect x={pixel.x} y={pixel.y} width="1" height="1" fill={pixel.fill} />}</For>
    </svg>
  )
}

export function PixelAvatarEditor(props: PixelAvatarEditorProps) {
  const avatar = createMemo(() => resolvePixelAvatar(props.value, props.seed))
  const [selected, setSelected] = createSignal<PixelColor>("2")
  const [active, setActive] = createSignal(0)
  const [generation, setGeneration] = createSignal(0)
  const cells: HTMLButtonElement[] = []

  return (
    <div class="flex w-[194px] max-w-full flex-col gap-2 text-[12px] text-v2-text-text-base">
      <input type="hidden" name="avatar" value={JSON.stringify(avatar())} />
      <div class="flex items-center justify-between gap-2">
        <span>Avatar</span>
        <PixelAvatar avatar={avatar()} seed={props.seed} size={32} label="Avatar preview" />
      </div>
      <div role="group" aria-label="Paint color" class="grid grid-cols-5 gap-1">
        <For each={colors}>
          {(color) => (
            <button
              type="button"
              aria-label={colorName(color)}
              title={colorName(color)}
              aria-pressed={selected() === color}
              class="flex h-7 items-center justify-center border border-v2-border-border-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-text-text-base"
              classList={{ "ring-2 ring-v2-text-text-base": selected() === color }}
              onClick={() => setSelected(color)}
            >
              <span
                aria-hidden="true"
                class="flex h-4 w-4 items-center justify-center border border-v2-border-border-base"
                style={{ "background-color": color === "." ? "transparent" : pixelAvatarPalette[Number(color)] }}
              >
                {color === "." ? "×" : ""}
              </span>
            </button>
          )}
        </For>
      </div>
      <span class="text-v2-text-text-subtle">Paint: {colorName(selected())}</span>
      <div role="grid" aria-label="Avatar pixels" aria-rowcount={8} aria-colcount={8} class="border border-v2-border-border-base">
        <For each={Array.from({ length: 8 }, (_, index) => index)}>
          {(row) => (
            <div role="row" class="flex">
              <For each={Array.from({ length: 8 }, (_, index) => index)}>
                {(column) => (
                  <div role="gridcell" class="h-6 w-6 shrink-0">
                    <button
                      ref={(element) => (cells[row * 8 + column] = element)}
                      type="button"
                      tabIndex={active() === row * 8 + column ? 0 : -1}
                      aria-label={`Row ${row + 1}, column ${column + 1}: ${colorName(avatar()[row]![column]!)}`}
                      class="relative block h-6 w-6 border border-v2-border-border-base focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-v2-text-text-base"
                      style={{
                        "background-color": avatar()[row]![column] === "." ? "transparent" : pixelAvatarPalette[Number(avatar()[row]![column])],
                      }}
                      onFocus={() => setActive(row * 8 + column)}
                      onClick={() => props.onChange(paintPixelAvatar(avatar(), row * 8 + column, selected()))}
                      onKeyDown={(event) => {
                        const next = pixelAvatarNavigation(row * 8 + column, event.key)
                        if (next === undefined) return
                        event.preventDefault()
                        setActive(next)
                        cells[next]?.focus()
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <span class="text-v2-text-text-subtle">Arrow keys move. Space paints.</span>
      <button
        type="button"
        class="min-h-7 border border-v2-border-border-base px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-text-text-base"
        onClick={() => {
          const next = generation() + 1
          setGeneration(next)
          props.onChange(generatePixelAvatar(`${props.seed}:pattern:${next}`))
        }}
      >
        Generate new pattern
      </button>
    </div>
  )
}
