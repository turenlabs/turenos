import { describe, expect, test } from "bun:test"
import { ComplexityRatchetPlugin } from "@turenlabs/core/plugin/complexity-ratchet"
import { PluginV2 } from "@turenlabs/core/plugin"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const Case = Schema.Struct({
  id: Schema.String,
  label: Schema.Literals(["clean", "erosion"]),
  path: Schema.String,
  before: Schema.String,
  after: Schema.String,
})
const cases = Schema.decodeUnknownSync(Schema.Array(Case))(
  await Bun.file(new URL("./fixtures/complexity-ratchet.json", import.meta.url)).json(),
)

describe("ComplexityRatchet score calibration", () => {
  for (const fixture of cases) {
    test(fixture.id, () => {
      const result = ComplexityRatchetPlugin.assess(fixture)
      expect(result.score >= ComplexityRatchetPlugin.threshold).toBe(fixture.label === "erosion")
    })
  }

  test("configured threshold is the quietest threshold with maximum F1", () => {
    const evaluations = Array.from({ length: 16 }, (_, index) => index + 1).map((candidate) => ({
      threshold: candidate,
      ...evaluate(candidate),
    }))
    const selected = evaluations.find((item) => item.threshold === ComplexityRatchetPlugin.threshold)
    expect(selected).toBeDefined()
    if (!selected) return
    expect(selected.f1).toBe(Math.max(...evaluations.map((item) => item.f1)))
    expect(selected.threshold).toBe(
      Math.max(...evaluations.filter((item) => item.f1 === selected.f1).map((item) => item.threshold)),
    )
    expect(selected.precision).toBe(1)
    expect(selected.recall).toBe(1)
  })
})

describe("ComplexityRatchet loop capability", () => {
  test("stays silent for healthy edits", () => {
    const event = editEvent("return service.run(input)", "const parsed = parse(input)\nreturn service.run(parsed)")
    ComplexityRatchetPlugin.makeObserver()(event)
    expect(event.notes).toEqual([])
  })

  test("accounts for all replacements in replaceAll", () => {
    const event = editEvent("HOOK", "if (a) runA()\nif (b) runB()", {
      replaceAll: true,
      result: "Edited file successfully: src/command.ts\nReplacements: 10",
    })
    ComplexityRatchetPlugin.makeObserver()(event)
    expect(event.notes).toEqual(["Quality ratchet: this change adds substantial duplicated code; simplify it."])
  })

  test("stays silent for a mechanical replaceAll modification", () => {
    // A rename replayed across many sites replaces as much as it adds; it must
    // not be scolded as new duplication.
    const event = editEvent("service.legacyPath.execute(request)", "service.modernPath.execute(request)", {
      replaceAll: true,
      result: "Edited file successfully: src/command.ts\nReplacements: 10",
    })
    ComplexityRatchetPlugin.makeObserver()(event)
    expect(event.notes).toEqual([])
  })

  test("detects duplication created across replaceAll copies", () => {
    const event = editEvent("HOOK", "validateRequired(input.name, 'name')", {
      replaceAll: true,
      result: "Edited file successfully: src/command.ts\nReplacements: 10",
    })
    ComplexityRatchetPlugin.makeObserver()(event)
    expect(event.notes).toEqual(["Quality ratchet: this change adds substantial duplicated code; simplify it."])
  })

  test("scores successful apply_patch input without reading the workspace", () => {
    const event: ToolInterceptor.AfterEvent = {
      ...identity,
      tool: "apply_patch",
      input: {
        patchText:
          "*** Begin Patch\n*** Add File: src/provider.py\n+def execute(request):\n+    raise NotImplementedError('pending')\n*** End Patch",
      },
      result: { type: "text", value: "Applied patch sequentially:\nA src/provider.py" },
      denied: false,
      notes: [],
    }
    ComplexityRatchetPlugin.makeObserver()(event)
    expect(event.notes).toEqual(["Quality ratchet: complete or remove the new placeholder implementation."])
  })

  test("checks unequivocal placeholder state after an overwrite without scoring unknown growth", () => {
    const event: ToolInterceptor.AfterEvent = {
      ...identity,
      tool: "write",
      input: { path: "src/provider.py", content: "def execute(request):\n    raise NotImplementedError()" },
      result: { type: "text", value: "Wrote file successfully: src/provider.py" },
      denied: false,
      notes: [],
    }
    ComplexityRatchetPlugin.makeObserver()(event)
    expect(event.notes).toEqual(["Quality ratchet: complete or remove the new placeholder implementation."])
  })

  test("bounds work for oversized inputs", () => {
    const result = ComplexityRatchetPlugin.assess({
      path: "src/large.ts",
      before: "",
      after: `throw new Error("not implemented")\n${"if (ready) run()\n".repeat(10_000)}`,
    })
    expect(result.score).toBe(0)
  })
})

testEffect(PluginTestLayer).effect("plugin registers the observer through the public V2 hook", () =>
  Effect.gen(function* () {
    const plugins = yield* PluginV2.Service
    yield* plugins.add(PluginV2.ID.make(ComplexityRatchetPlugin.Plugin.id), ComplexityRatchetPlugin.Plugin.effect)
    const notes = yield* (yield* ToolInterceptor.Service).runAfter({
      ...identity,
      tool: "edit",
      input: {
        path: "src/provider.py",
        oldString: "def execute(request):\n    return provider(request)",
        newString: "def execute(request):\n    raise NotImplementedError('pending')",
      },
      result: { type: "text", value: "Edited file successfully: src/provider.py" },
      denied: false,
    })
    expect(notes).toEqual(["Quality ratchet: complete or remove the new placeholder implementation."])
  }),
)

const identity = {
  sessionID: "ses_ratchet",
  agent: "build",
  assistantMessageID: "msg_assistant",
  callID: "call_edit",
}

function editEvent(
  oldString: string,
  newString: string,
  options: { readonly replaceAll?: boolean; readonly result?: string } = {},
): ToolInterceptor.AfterEvent {
  return {
    ...identity,
    tool: "edit",
    input: { path: "src/command.ts", oldString, newString, replaceAll: options.replaceAll },
    result: { type: "text", value: options.result ?? "Edited file successfully: src/command.ts" },
    denied: false,
    notes: [],
  }
}

function evaluate(threshold: number) {
  const classified = cases.map((fixture) => ({
    expected: fixture.label === "erosion",
    actual: ComplexityRatchetPlugin.assess(fixture).score >= threshold,
  }))
  const truePositive = classified.filter((item) => item.expected && item.actual).length
  const falsePositive = classified.filter((item) => !item.expected && item.actual).length
  const falseNegative = classified.filter((item) => item.expected && !item.actual).length
  const precision = truePositive === 0 ? 0 : truePositive / (truePositive + falsePositive)
  const recall = truePositive === 0 ? 0 : truePositive / (truePositive + falseNegative)
  return { precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) }
}
