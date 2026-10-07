import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Visualization } from "@turenlabs/schema/visualization"
import { line, scaleBand, scaleLinear } from "d3"
import { visualizationSpec } from "./visualization-data"
import { visualizationTreemap } from "./visualization-layout"
import { VisualizationLicenses } from "./visualization-licenses"

export default function VisualizationViewer(props: { metadata: unknown }) {
  const spec = createMemo(() => visualizationSpec(props.metadata))
  return (
    <Show when={spec()} fallback={<p role="status">Visualization data is unavailable or invalid.</p>}>
      {(value) => <VisualizationChart spec={value()} />}
    </Show>
  )
}

function VisualizationChart(props: { spec: Visualization.Spec }) {
  type Item = Visualization.Spec["items"][number]
  const [search, setSearch] = createSignal("")
  const [group, setGroup] = createSignal("")
  const [mode, setMode] = createSignal<"chart" | "table">("chart")
  const [selection, setSelection] = createSignal<Item>()
  const groups = createMemo(() => [
    ...new Set(props.spec.items.flatMap((item) => (item.group === undefined ? [] : [item.group]))),
  ])
  const items = createMemo(() => {
    const query = search().trim().toLowerCase()
    return props.spec.items.filter(
      (item) =>
        (group() === "" || item.group === groups()[Number(group())]) &&
        (!query || [item.label, item.group, item.detail].some((value) => value?.toLowerCase().includes(query))),
    )
  })
  const selected = createMemo(() => items().find((item) => item === selection()))
  const maximum = createMemo(() => Math.max(0, ...items().map((item) => item.value)) || 1)
  const rectangles = createMemo(() => visualizationTreemap(items().map((item) => item.value)))
  const format = (value: number) => `${value.toLocaleString()}${props.spec.unit ? ` ${props.spec.unit}` : ""}`
  const xScale = createMemo(() =>
    scaleLinear()
      .domain([0, Math.max(1, items().length - 1)])
      .range([48, 776]),
  )
  const barScale = createMemo(() =>
    scaleBand<number>()
      .domain(items().map((_, index) => index))
      .range([48, 776])
      .paddingInner(0.15),
  )
  const yScale = createMemo(() => scaleLinear().domain([0, maximum()]).range([320, 40]))
  const x = (index: number) => (items().length === 1 ? 400 : xScale()(index))
  const y = (value: number) => yScale()(value)
  const linePath = createMemo(
    () =>
      line<Item>()
        .x((_, index) => x(index))
        .y((item) => y(item.value))(items()) ?? "",
  )
  const palette = ["#2563eb", "#0f766e", "#7c3aed", "#b45309", "#be123c", "#0369a1"]
  const color = (value: string | undefined) =>
    palette[(value === undefined ? 0 : groups().indexOf(value) + 1) % palette.length]!
  const summary = (item: Item) => `${item.label}: ${format(item.value)}${item.group ? `, ${item.group}` : ""}`
  const tileLabel = (item: Item, width: number) => {
    const length = Math.max(1, Math.floor((width - 16) / 8))
    return item.label.length <= length ? item.label : `${item.label.slice(0, Math.max(1, length - 3))}...`
  }
  const marks = (item: Item) => ({
    role: "button" as const,
    tabindex: 0,
    "aria-label": summary(item),
    style: { fill: color(item.group) },
    "aria-pressed": selected() === item,
    "data-selected": selected() === item ? "" : undefined,
    onClick: () => setSelection(item),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      setSelection(item)
    },
  })

  return (
    <section data-component="visualization-viewer" aria-label={props.spec.title}>
      <header>
        <h3>{props.spec.title}</h3>
        <Show when={props.spec.description}>
          <p>{props.spec.description}</p>
        </Show>
      </header>
      <div data-slot="visualization-toolbar">
        <label>
          Search
          <input type="search" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
        </label>
        <label>
          Group
          <select value={group()} onChange={(event) => setGroup(event.currentTarget.value)}>
            <option value="">All groups</option>
            <For each={groups()}>
              {(value, index) => <option value={String(index())}>{value || "Unnamed group"}</option>}
            </For>
          </select>
        </label>
        <div role="group" aria-label="Visualization view">
          <button type="button" aria-pressed={mode() === "chart"} onClick={() => setMode("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={mode() === "table"} onClick={() => setMode("table")}>
            Table
          </button>
        </div>
        <span role="status">
          {items().length} / {props.spec.items.length} items
        </span>
      </div>
      <Show when={groups().length > 0 && mode() === "chart"}>
        <div data-slot="visualization-legend" aria-label="Group colors">
          <For each={groups().slice(0, 12)}>
            {(value) => (
              <span>
                <i style={{ background: color(value) }} aria-hidden="true" />
                {value}
              </span>
            )}
          </For>
          <Show when={groups().length > 12}>
            <span>Use Group to find more groups.</span>
          </Show>
        </div>
      </Show>
      <Show when={items().length > 0} fallback={<p role="status">No items match these filters.</p>}>
        <Show
          when={mode() === "chart"}
          fallback={
            <div
              data-slot="visualization-scroll"
              data-scrollable
              tabIndex={0}
              role="region"
              aria-label="Visualization table"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Value</th>
                    <th scope="col">Group</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={items()}>
                    {(item) => (
                      <tr data-selected={selected() === item ? "" : undefined}>
                        <td>
                          <button type="button" aria-pressed={selected() === item} onClick={() => setSelection(item)}>
                            {item.label}
                          </button>
                        </td>
                        <td>{format(item.value)}</td>
                        <td>{item.group ?? "-"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          }
        >
          <Show
            when={props.spec.kind !== "treemap" || rectangles().length > 0}
            fallback={<p role="status">All values are zero. Use Table to inspect these items.</p>}
          >
            <svg
              viewBox="0 0 800 360"
              role="group"
              aria-label={`${props.spec.title}, ${props.spec.kind} chart. Select an item for details.`}
            >
              <Switch>
                <Match when={props.spec.kind === "bar"}>
                  <For each={items()}>
                    {(item, index) => (
                      <rect
                        {...marks(item)}
                        x={barScale()(index())}
                        y={y(item.value)}
                        width={barScale().bandwidth()}
                        height={Math.max(1, 320 - y(item.value))}
                      >
                        <title>{summary(item)}</title>
                      </rect>
                    )}
                  </For>
                </Match>
                <Match when={props.spec.kind === "line"}>
                  <path data-slot="visualization-line" d={linePath()} />
                  <For each={items()}>
                    {(item, index) => (
                      <circle {...marks(item)} cx={x(index())} cy={y(item.value)} r="4">
                        <title>{summary(item)}</title>
                      </circle>
                    )}
                  </For>
                </Match>
                <Match when={props.spec.kind === "treemap"}>
                  <For each={rectangles()}>
                    {(rectangle) => (
                      <g>
                        <rect
                          {...marks(items()[rectangle.index]!)}
                          x={rectangle.x}
                          y={rectangle.y}
                          width={rectangle.width}
                          height={rectangle.height}
                          data-slot="visualization-tile"
                        >
                          <title>{summary(items()[rectangle.index]!)}</title>
                        </rect>
                        <Show when={rectangle.width >= 64 && rectangle.height >= 24}>
                          <svg
                            x={rectangle.x}
                            y={rectangle.y}
                            width={rectangle.width}
                            height={rectangle.height}
                            data-slot="visualization-tile-label"
                            aria-hidden="true"
                          >
                            <text x="8" y="18">
                              {tileLabel(items()[rectangle.index]!, rectangle.width)}
                            </text>
                          </svg>
                        </Show>
                      </g>
                    )}
                  </For>
                </Match>
              </Switch>
              <Show when={props.spec.kind !== "treemap"}>
                <text x="4" y="20">
                  {format(maximum())}
                </text>
                <text x="4" y="324">
                  0
                </text>
                <text x="48" y="350">
                  {items()[0]?.label.slice(0, 32)}
                </text>
                <Show when={items().length > 1}>
                  <text x="776" y="350" text-anchor="end">
                    {items().at(-1)?.label.slice(0, 32)}
                  </text>
                </Show>
              </Show>
            </svg>
            <p data-slot="visualization-hint">Select an item for details. Use Table for all labels and zero values.</p>
          </Show>
        </Show>
      </Show>
      <Show when={selected()}>
        {(item) => (
          <aside aria-label="Selected item" aria-live="polite">
            <strong>{item().label}</strong>
            <p>
              {format(item().value)}
              {item().group === undefined ? "" : ` - ${item().group}`}
            </p>
            <Show when={item().detail}>
              <p>{item().detail}</p>
            </Show>
            <button type="button" onClick={() => setSelection(undefined)}>
              Clear selection
            </button>
          </aside>
        )}
      </Show>
      <VisualizationLicenses />
    </section>
  )
}
