export * as ShellTree from "./shell-tree"

export interface Tree {
  readonly rootNode: Node
  delete(): void
}

export interface Node {
  readonly type: string
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
  readonly hasError: boolean
  readonly isMissing: boolean
  readonly parent: Node | null
  readonly childCount: number
  readonly children: ReadonlyArray<Node | null>
  child(index: number): Node | null
  descendantsOfType(type: string): ReadonlyArray<Node | null>
}
