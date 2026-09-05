import { createMemo, createSignal, For, Show } from "solid-js"
import { writeClipboard } from "./clipboard"
import type { BinarySnapshot } from "./binary-snapshot"

export type { BinarySnapshot } from "./binary-snapshot"

export function BinaryViewer(props: { snapshot: BinarySnapshot }) {
  const [mode, setMode] = createSignal<"hex" | "disassembly">(props.snapshot.kind)
  const [selection, setSelection] = createSignal<number>()
  const [page, setPage] = createSignal(0)
  const [copied, setCopied] = createSignal(false)
  const pages = () => Math.max(1, Math.ceil(props.snapshot.rows.length / 128))
  const currentPage = () => Math.min(page(), pages() - 1)
  const rows = createMemo(() => props.snapshot.rows.slice(currentPage() * 128, (currentPage() + 1) * 128))
  const selected = () => props.snapshot.rows.find((row) => row.offset === selection())
  const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`
  const range = () => {
    const first = props.snapshot.rows[0]
    const last = props.snapshot.rows.at(-1)
    return first && last ? `${hex(first.offset)} - ${hex(last.offset + last.bytes.length)} (end exclusive)` : "No bytes"
  }
  const copy = async () => {
    const row = selected()
    if (!row) return
    setCopied(
      await writeClipboard(
        `${props.snapshot.path}\nFile offset ${hex(row.offset)}${row.address ? ` / VA ${row.address}` : ""}\n${row.bytes.join(" ")}${row.text ? `  ${row.text}` : ""}`,
      ),
    )
  }

  return (
    <section data-component="binary-viewer" aria-label="Binary inspection snapshot">
      <div data-slot="binary-toolbar">
        <div role="group" aria-label="Binary view">
          <button type="button" aria-pressed={mode() === "hex"} onClick={() => setMode("hex")}>
            Hex
          </button>
          <Show when={props.snapshot.kind === "disassembly"}>
            <button type="button" aria-pressed={mode() === "disassembly"} onClick={() => setMode("disassembly")}>
              Disassembly
            </button>
          </Show>
        </div>
        <span>
          Read-only snapshot
          {props.snapshot.bitness ? ` / ${props.snapshot.architecture ?? "x86"} ${props.snapshot.bitness}-bit` : ""}
        </span>
      </div>
      <div data-slot="binary-range">File offsets: {range()}</div>
      <div
        data-slot="binary-scroll"
        data-scrollable
        tabIndex={0}
        role="region"
        aria-label={mode() === "hex" ? "Hex bytes and ASCII" : "Disassembly instructions"}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">File Offset</th>
              <Show when={props.snapshot.kind === "disassembly"}>
                <th scope="col">Virtual Address</th>
              </Show>
              <th scope="col">Bytes</th>
              <th scope="col">{mode() === "hex" ? "ASCII" : "Instruction"}</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr data-selected={selection() === row.offset ? "" : undefined}>
                  <td>
                    <button
                      type="button"
                      aria-label={`Select file offset ${hex(row.offset)}`}
                      aria-pressed={selection() === row.offset}
                      onClick={() => {
                        setSelection(row.offset)
                        setCopied(false)
                      }}
                    >
                      {hex(row.offset)}
                    </button>
                  </td>
                  <Show when={props.snapshot.kind === "disassembly"}>
                    <td>{row.address}</td>
                  </Show>
                  <td data-slot="binary-bytes">{row.bytes.join(" ")}</td>
                  <td data-slot={mode() === "hex" ? "binary-ascii" : "binary-instruction"}>
                    {mode() === "hex"
                      ? row.bytes
                          .map((byte) => {
                            const value = Number.parseInt(byte, 16)
                            return value >= 32 && value <= 126 ? String.fromCharCode(value) : "."
                          })
                          .join("")
                      : row.text}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={pages() > 1}>
        <div data-slot="binary-toolbar">
          <button type="button" disabled={currentPage() === 0} onClick={() => setPage(currentPage() - 1)}>
            Previous
          </button>
          <span>
            Page {currentPage() + 1} / {pages()}
          </span>
          <button type="button" disabled={currentPage() + 1 >= pages()} onClick={() => setPage(currentPage() + 1)}>
            Next
          </button>
        </div>
      </Show>
      <div data-slot="binary-toolbar">
        <span>
          {selected()
            ? `Selected ${hex(selected()!.offset)} / ${selected()!.bytes.length} bytes`
            : "Select an offset to inspect its bytes"}
        </span>
        <button type="button" disabled={!selected()} onClick={copy}>
          {copied() ? "Copied" : "Copy selection"}
        </button>
      </div>
      <For each={props.snapshot.warnings}>{(warning) => <p data-slot="binary-warning">{warning}</p>}</For>
      <p data-slot="binary-note">
        Only captured bytes are shown. No file is opened or executed.
        {props.snapshot.nextOffset !== undefined
          ? ` More bytes available at file offset ${hex(props.snapshot.nextOffset)}.`
          : ""}
      </p>
    </section>
  )
}
