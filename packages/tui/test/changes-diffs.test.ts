import { expect, test } from "bun:test"
import { mergeTurnDiffs } from "../src/changes/diffs"

test("last-turn diffs keep touched order, the first match, and entries without a patch", () => {
  const current = [
    { file: "a.ts", additions: 1, deletions: 0 },
    { file: "a.ts", additions: 9, deletions: 0 },
    { file: "b.ts", additions: 2, deletions: 0 },
    { file: "unrelated.ts", additions: 3, deletions: 0 },
  ] as const
  const touched = ["b.ts", "missing.ts", "a.ts", ...Array.from({ length: 6 }, (_, index) => `old-${index}.ts`)]

  expect(mergeTurnDiffs(touched, current)).toEqual([
    current[2],
    { file: "missing.ts", additions: 0, deletions: 0 },
    current[0],
    ...touched.slice(3).map((file) => ({ file, additions: 0, deletions: 0 })),
  ])
})
