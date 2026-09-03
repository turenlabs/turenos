import { Effect, Schema } from "effect"
import { ShellToolRouting } from "@turenlabs/core/shell-tool-routing"

const Case = Schema.Struct({
  id: Schema.String,
  shell: Schema.Literals(["bash", "powershell", "cmd"]),
  command: Schema.String,
  expected: Schema.Literals(["allow", "grep", "glob", "edit", "apply_patch"]),
})
const cases = Schema.decodeUnknownSync(Schema.Array(Case))(
  await Bun.file(new URL("../fixtures/tool-routing.json", import.meta.url)).json(),
)

const evaluate = async (predict: (fixture: (typeof cases)[number]) => Promise<string>) => {
  const results = await Promise.all(cases.map(async (fixture) => ({ fixture, actual: await predict(fixture) })))
  const routed = results.filter((result) => result.fixture.expected !== "allow")
  const predicted = results.filter((result) => result.actual !== "allow")
  const correct = results.filter((result) => result.actual === result.fixture.expected)
  const truePositive = routed.filter((result) => result.actual === result.fixture.expected).length
  const precision = predicted.length === 0 ? 0 : truePositive / predicted.length
  const recall = routed.length === 0 ? 0 : truePositive / routed.length
  return {
    accuracy: correct.length / results.length,
    precision,
    recall,
    failures: results.filter((result) => result.actual !== result.fixture.expected),
  }
}

const baseline = await evaluate(async () => "allow")
const current = await evaluate(async (fixture) =>
  Effect.runPromise(
    ShellToolRouting.inspect({ command: fixture.command, cwd: process.cwd(), shell: fixture.shell }).pipe(
      Effect.map((result) => result?.tool ?? "allow"),
    ),
  ),
)

console.log(`Shell specialized-tool routing benchmark (${cases.length} cases)`)
console.log(
  `baseline accuracy=${percent(baseline.accuracy)} precision=${percent(baseline.precision)} recall=${percent(baseline.recall)}`,
)
console.log(
  `current  accuracy=${percent(current.accuracy)} precision=${percent(current.precision)} recall=${percent(current.recall)}`,
)
for (const failure of current.failures)
  console.log(`FAIL ${failure.fixture.id}: expected=${failure.fixture.expected} actual=${failure.actual}`)
console.log(`METRIC tool_routing_accuracy=${current.accuracy.toFixed(4)}`)
console.log(`METRIC tool_routing_precision=${current.precision.toFixed(4)}`)
console.log(`METRIC tool_routing_recall=${current.recall.toFixed(4)}`)

if (current.failures.length > 0) process.exitCode = 1

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}
