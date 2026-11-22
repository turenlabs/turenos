export * as ShellNative from "./shell-native"

import { join } from "node:path"
import type { Node, Tree } from "./shell-tree"
import { lazy } from "./util/lazy"

export const libraryName = "libturen_shell_parser.dylib"
const abi = 1
const wordsPerNode = 7
const firstRow = 1
const noParent = 0xffff_ffff
const maximumNodes = 262_144

export async function open(file = join(import.meta.dir, libraryName)) {
  if (!process.versions.bun || !(await Bun.file(file).exists())) return
  const { CString, dlopen, FFIType, toArrayBuffer } = await import("bun:ffi")
  try {
    const library = dlopen(file, {
      shell_abi: { args: [], returns: FFIType.u32 },
      shell_kind_count: { args: [FFIType.u32], returns: FFIType.u32 },
      shell_kind: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      shell_parse: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      shell_words: { args: [FFIType.ptr], returns: FFIType.u32 },
      shell_free: { args: [FFIType.ptr], returns: FFIType.void },
    })
    if (library.symbols.shell_abi() !== abi) {
      library.close()
      return
    }

    const grammar = (shell: number) =>
      lazy(() => {
        const count = library.symbols.shell_kind_count(shell)
        if (!count || count > 65535) return
        return Array.from({ length: count }, (_, id) => {
          const pointer = library.symbols.shell_kind(shell, id)
          return pointer ? new CString(pointer).toString() : null
        })
      })
    const kinds = { bash: grammar(0), powershell: grammar(1) }

    return {
      parse(command: string, shell: "bash" | "powershell"): Tree | undefined {
        if (command.length > 65_536) return
        const types = kinds[shell]()
        if (!types) return
        const units = command.length ? Buffer.from(command, "utf16le") : Buffer.alloc(2)
        const pointer = library.symbols.shell_parse(units, command.length, shell === "bash" ? 0 : 1)
        if (!pointer) return
        try {
          const words = library.symbols.shell_words(pointer)
          const nodes = (words - firstRow) / wordsPerNode
          if (!Number.isInteger(nodes) || nodes <= 0 || nodes > maximumNodes) return
          const buffer = toArrayBuffer(pointer, 0, words * 4)
          // Copy the packed nodes before releasing the Rust allocation.
          const rows = new Uint32Array(buffer).slice()
          return {
            rootNode: new PackedNode({ rows, source: command, kinds: types }, 0),
            delete() {
              // The tree owns only JavaScript memory.
            },
          }
        } finally {
          library.symbols.shell_free(pointer)
        }
      },
    }
  } catch {
    // Use the portable parser if the packaged library cannot load.
    return
  }
}

type PackedTree = {
  rows: Uint32Array
  source: string
  kinds: ReadonlyArray<string | null>
}

class PackedNode implements Node {
  constructor(
    private tree: PackedTree,
    private index: number,
  ) {}

  private word(field: number) {
    return this.tree.rows[firstRow + wordsPerNode * this.index + field]!
  }

  get type() {
    const id = this.word(0)
    return id === 65535 ? "ERROR" : this.tree.kinds[id]!
  }

  get startIndex() {
    return this.word(1)
  }

  get endIndex() {
    return this.word(2)
  }

  get hasError() {
    return (this.word(6) & 1) !== 0
  }

  get isMissing() {
    return (this.word(6) & 2) !== 0
  }

  get parent(): Node | null {
    const index = this.word(3)
    return index === noParent ? null : new PackedNode(this.tree, index)
  }

  get childCount() {
    return this.word(5)
  }

  get text() {
    return this.tree.source.slice(this.startIndex, this.endIndex)
  }

  private get nextIndex() {
    return this.word(4)
  }

  child(position: number) {
    if (position < 0 || position >= this.childCount) return null
    let index = this.index + 1
    for (let i = 0; i < position; i++) index = this.tree.rows[firstRow + wordsPerNode * index + 4]!
    return new PackedNode(this.tree, index)
  }

  get children() {
    const children: PackedNode[] = []
    for (let index = this.index + 1; index < this.nextIndex; ) {
      const child = new PackedNode(this.tree, index)
      children.push(child)
      index = child.nextIndex
    }
    return children
  }

  descendantsOfType(type: string) {
    const nodes: PackedNode[] = []
    for (let index = this.index; index < this.nextIndex; index++) {
      const row = firstRow + wordsPerNode * index
      if (this.tree.rows[row + 2] === 0) continue
      const id = this.tree.rows[row]!
      if ((id === 65535 ? "ERROR" : this.tree.kinds[id]) === type) nodes.push(new PackedNode(this.tree, index))
    }
    return nodes
  }
}
