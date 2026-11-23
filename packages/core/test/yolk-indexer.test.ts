import { expect, test } from "bun:test"
import { mkdtempDisposable } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildIndex } from "../src/yolk/indexer"

test("indexes equivalent functions in sorted order and resolves calls by name", async () => {
  await using fixture = await mkdtempDisposable(join(tmpdir(), "yolk-index-"))
  await Bun.write(
    join(fixture.path, "sample.go"),
    `package bench
func third(x int) int { return x + 1 }
func first(x int) int { return x + 1 }
func second(x int) int { return x + 1 }
func caller(x int) int { return first(x) }
`,
  )
  const index = await buildIndex(fixture.path)
  const symbols = new Map([...index.functions.values()].map((fn) => [fn.decl.name, fn.decl.symbol]))
  expect(index.equivalents(symbols.get("third")!)).toEqual([symbols.get("first")!, symbols.get("second")!])
  expect(index.functions.get(symbols.get("caller")!)?.calls).toEqual([symbols.get("first")!])
})
