import { describe, expect, test } from "bun:test"
import { Patch } from "@turenlabs/core/patch"

describe("Patch", () => {
  test("parses add, update, and delete hunks", () => {
    expect(
      Patch.parse(
        "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch",
      ),
    ).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
      {
        type: "update",
        path: "update.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: "section", endOfFile: undefined }],
        movePath: undefined,
      },
      { type: "delete", path: "delete.txt" },
    ])
  })

  test("strips a heredoc wrapper", () => {
    expect(Patch.parse("cat <<'EOF'\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF")).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
    ])
  })

  test("derives fuzzy line updates while preserving BOM", () => {
    const update = Patch.derive("update.txt", [{ oldLines: ["  old   "], newLines: ["new"] }], "\uFEFFold\n")
    expect(update).toEqual({ content: "new\n", bom: true })
    expect(Patch.joinBom(update.content, update.bom)).toBe("\uFEFFnew\n")
  })

  test("matches EOF-anchored chunks from the end", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
        "marker\nmiddle\nmarker\nend\n",
      ).content,
    ).toBe("marker\nmiddle\nmarker changed\nend\n")
  })

  test("parses the EOF marker inside update chunks", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"),
    ).toEqual([
      {
        type: "update",
        path: "update.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, endOfFile: true }],
      },
    ])
  })

  test("applies out-of-order chunks", () => {
    expect(
      Patch.derive("update.txt", [
        { oldLines: ["d", "e"], newLines: ["D", "E"] },
        { oldLines: ["a", "b"], newLines: ["A", "B"] },
      ], "a\nb\nc\nd\ne\n").content,
    ).toBe("A\nB\nc\nD\nE\n")
  })

  test("rejects ambiguous blocks instead of picking the first occurrence", () => {
    const block = { oldLines: ["x", "y"], newLines: ["X", "Y"] }
    expect(() => Patch.derive("update.txt", [block], "x\ny\nmid\nx\ny\n")).toThrow("match multiple locations")
    expect(
      Patch.derive(
        "update.txt",
        [{ ...block, changeContext: "mid" }],
        "x\ny\nmid\nx\ny\n",
      ).content,
    ).toBe("x\ny\nmid\nX\nY\n")
  })

  test("tolerates a single drifted line inside a matched block", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["a", "b", "c", "d"], newLines: ["A", "B", "C", "D"] }],
        "a\nb\nchanged elsewhere\nd\n",
      ).content,
    ).toBe("A\nB\nC\nD\n")
  })

  test("treats a blank update line as context", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n@@\n keep\n\n-last\n+new\n*** End Patch"),
    ).toEqual([
      {
        type: "update",
        path: "update.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["keep", "", "last"], newLines: ["keep", "", "new"], changeContext: undefined, endOfFile: undefined }],
      },
    ])
    expect(
      Patch.derive("update.txt", [{ oldLines: ["keep", "", "last"], newLines: ["keep", "", "new"] }], "keep\n\nlast\n")
        .content,
    ).toBe("keep\n\nnew\n")
  })

  test("applies when the file gained a line inside the region", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["alpha", "beta", "gamma", "delta"], newLines: ["alpha", "BETA", "gamma", "DELTA"] }],
        "alpha\nbeta\n// foreign insert\ngamma\ndelta\n",
      ).content,
    ).toBe("alpha\nBETA\n// foreign insert\ngamma\nDELTA\n")
  })

  test("applies when the file lost a line inside the region", () => {
    expect(
      Patch.derive(
        "update.txt",
        [
          {
            oldLines: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
            newLines: ["alpha", "BETA", "gamma", "DELTA", "epsilon", "ZETA"],
          },
        ],
        "alpha\nbeta\ngamma\nepsilon\nzeta\n",
      ).content,
    ).toBe("alpha\nBETA\ngamma\nepsilon\nZETA\n")
  })

  test("consumes duplicate occurrences in chunk order", () => {
    expect(
      Patch.derive(
        "update.txt",
        [
          { oldLines: ["dup", "line"], newLines: ["first", "line"] },
          { oldLines: ["dup", "line"], newLines: ["second", "line"] },
        ],
        "dup\nline\nmid\ndup\nline\n",
      ).content,
    ).toBe("first\nline\nmid\nsecond\nline\n")
  })

  test("rejects a pure insert when the context line is ambiguous", () => {
    expect(() =>
      Patch.derive("update.txt", [{ oldLines: [], newLines: ["added"], changeContext: "anchor" }], "anchor\nx\nanchor\n"),
    ).toThrow("multiple locations")
  })

  test("rejects a fuzzy best challenged by a strong rival", () => {
    // intended region drifted (uniform trailing whitespace) while a second
    // window still scores >=0.8 — no safe single placement exists
    const block = Array.from({ length: 10 }, (_, i) => `line ${i}`)
    const file = [...block.map((l) => l + "   "), "mid", ...block.slice(0, 8), "other", "lines"].join("\n") + "\n"
    expect(() => Patch.derive("update.txt", [{ oldLines: block, newLines: ["edited"] }], file)).toThrow(
      "multiple locations",
    )
  })

  test("rejects malformed hunk bodies", () => {
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\nmissing plus\n*** End Patch")).toThrow(
      "Invalid add file line",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch")).toThrow(
      "expected at least one @@ chunk",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Delete File: delete.txt\nunexpected body\n*** End Patch")).toThrow(
      "Invalid patch line",
    )
  })

  test("parses unified-diff line headers into a positional hint", () => {
    const hunks = Patch.parse(
      "*** Begin Patch\n*** Update File: f.ts\n@@ -12,3 +12,4 @@ function foo\n-old\n+new\n*** End Patch",
    )
    expect(hunks).toEqual([
      {
        type: "update",
        path: "f.ts",
        movePath: undefined,
        chunks: [
          { oldLines: ["old"], newLines: ["new"], changeContext: "function foo", hint: 11, endOfFile: undefined },
        ],
      },
    ])
    // bare numbers without a closing @@, and a bare @@ stays context-free
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: f.ts\n@@ -7,2 +7,2\n-old\n+new\n*** End Patch")[0],
    ).toMatchObject({ chunks: [{ hint: 6 }] })
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: f.ts\n@@ some context @@\n-old\n+new\n*** End Patch")[0],
    ).toMatchObject({ chunks: [{ changeContext: "some context", hint: undefined }] })
  })

  test("hint resolves a verbatim-twin ambiguity toward the drifted intent", () => {
    // intent block's first line drifted; a verbatim copy sits 40 lines away —
    // undecidable from text alone, decidable from the model's stated position
    const block = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    const file = [
      ...Array.from({ length: 10 }, (_, i) => `filler ${i}`),
      "drifted-anchor",
      ...block.slice(1),
      ...Array.from({ length: 40 }, (_, i) => `pad ${i}`),
      ...block,
      "tail",
    ].join("\n") + "\n"
    const newLines = [...block.slice(0, 3), "CHANGED", ...block.slice(4)]
    // no hint: the verbatim twin is the natural reading and wins outright —
    // the drifted intent spot is left alone
    const plain = Patch.derive("f.ts", [{ oldLines: block, newLines }], file).content.split("\n")
    const twinStart = plain.indexOf("alpha", 20)
    expect(plain.slice(twinStart, twinStart + 6)).toEqual(newLines)
    expect(plain[10]).toBe("drifted-anchor")
    // with a hint, the model's stated position wins instead
    const updated = Patch.derive("f.ts", [{ oldLines: block, newLines, hint: 10 }], file).content
    const lines = updated.split("\n")
    expect(lines.slice(10, 16)).toEqual(newLines)
    // twin untouched
    const twinAt = lines.indexOf("alpha", 20)
    expect(lines.slice(twinAt, twinAt + 6)).toEqual(block)
  })

  test("hint still rejects when two strong windows sit inside the stated neighborhood", () => {
    const block = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    const file = [...block, "gap", ...block, "tail"].join("\n") + "\n"
    expect(() =>
      Patch.derive("f.ts", [{ oldLines: block, newLines: ["x"], hint: 0 }], file),
    ).toThrow("multiple locations")
  })

  test("positions a pure insert at a line-number hint", () => {
    const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
    const updated = Patch.derive("f.ts", [{ oldLines: [], newLines: ["inserted"], hint: 10 }], file).content
    expect(updated.split("\n")[11]).toBe("inserted")
  })

  test("a stale hint does not displace a unique strong text match", () => {
    const block = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    const file = ["head", ...block, "tail"].join("\n") + "\n"
    const updated = Patch.derive("f.ts", [{ oldLines: block, newLines: ["x"], hint: 400 }], file).content
    expect(updated).toBe(["head", "x", "tail", ""].join("\n"))
  })

  test("reports the closest matching region when a chunk fails", () => {
    const file = ["const a = 1", "const b = 2", "different tail()", "const d = 4", "const e = 5", "const f = 6"].join(
      "\n",
    ) + "\n"
    try {
      Patch.derive(
        "f.ts",
        [
          {
            oldLines: ["const a = 1", "const b = 2", "changed body", "const d = 4", "changed again"],
            newLines: ["x"],
          },
        ],
        file,
      )
      expect.unreachable()
    } catch (error) {
      const message = String(error)
      expect(message).toContain("Closest match")
      expect(message).toContain("starts at line 1")
      expect(message).toContain("first difference")
      expect(message).toContain("changed body")
      expect(message).toContain("different tail()")
    }
  })

  test("preserves CRLF line endings on patched output", () => {
    const file = "const a = 1\r\nconst b = 2\r\nconst c = 3\r\n"
    const updated = Patch.derive(
      "f.ts",
      [{ oldLines: ["const a = 1", "const b = 2", "const c = 3"], newLines: ["const a = 1", "const b = 9", "const c = 3"] }],
      file,
    ).content
    expect(updated).toBe("const a = 1\r\nconst b = 9\r\nconst c = 3\r\n")
    expect(updated).not.toContain("const b = 9\n")
  })

  test("strips a trailing @@ from context headers", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: f.ts\n@@ marker @@\n-old\n+new\n*** End Patch")[0],
    ).toMatchObject({ chunks: [{ changeContext: "marker" }] })
  })
})
