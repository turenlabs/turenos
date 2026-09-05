import { Duration } from "effect"
import { OpenApiMethods, type OpenApiSpec, type Options, type Result, type Scenario } from "./types"

type ScenarioTimeout = `${number} ${Duration.Unit}`

const durationUnits = new Set<string>([
  "nano",
  "nanos",
  "micro",
  "micros",
  "milli",
  "millis",
  "second",
  "seconds",
  "minute",
  "minutes",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "weeks",
])

export function routeKeys(spec: OpenApiSpec) {
  return Object.entries(spec.paths ?? {})
    .flatMap(([path, item]) =>
      OpenApiMethods.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort()
}

export function routeKey(scenario: Scenario) {
  return `${scenario.method} ${scenario.path}`
}

export function coverageResult(scenario: Scenario): Result {
  if (scenario.kind === "todo") return { status: "skip", scenario }
  return { status: "pass", scenario }
}

export function parseOptions(args: string[]): Options {
  const mode = option(args, "--mode") ?? "effect"
  if (mode !== "effect" && mode !== "coverage" && mode !== "auth") throw new Error(`invalid --mode ${mode}`)
  return {
    mode,
    shard: parseShard(option(args, "--shard")),
    include: option(args, "--include"),
    startAt: option(args, "--start-at"),
    stopAt: option(args, "--stop-at"),
    failOnMissing: args.includes("--fail-on-missing"),
    missingBaseline: option(args, "--missing-baseline"),
    knownFailures: option(args, "--known-failures"),
    failOnSkip: args.includes("--fail-on-skip"),
    scenarioTimeout: parseScenarioTimeout(option(args, "--scenario-timeout") ?? "30 seconds"),
    progress: args.includes("--progress"),
    trace: args.includes("--trace"),
  }
}

export function matches(options: Options, scenario: Scenario) {
  if (!options.include) return true
  return (
    scenario.name.includes(options.include) ||
    scenario.path.includes(options.include) ||
    scenario.method.includes(options.include.toUpperCase())
  )
}

export function selectedScenarios(options: Options, scenarios: Scenario[]) {
  if (options.shard && (options.include || options.startAt || options.stopAt))
    throw new Error("--shard cannot be combined with scenario filters")
  if (options.shard) {
    const shard = options.shard
    if (shard.total > scenarios.length) throw new Error("--shard would create empty scenario partitions")
    return scenarios.filter((_, index) => index % shard.total === shard.index - 1)
  }
  const included = scenarios.filter((scenario) => matches(options, scenario))
  const start = options.startAt ? included.findIndex((scenario) => matchesName(options.startAt!, scenario)) : 0
  const end = options.stopAt
    ? included.findIndex((scenario) => matchesName(options.stopAt!, scenario))
    : included.length - 1
  if (start === -1) throw new Error(`--start-at matched no scenario: ${options.startAt}`)
  if (end === -1) throw new Error(`--stop-at matched no scenario: ${options.stopAt}`)
  return included.slice(start, end + 1)
}

function matchesName(value: string, scenario: Scenario) {
  return scenario.name.includes(value) || scenario.path.includes(value) || scenario.method.includes(value.toUpperCase())
}

function option(args: string[], name: string) {
  const found = args.flatMap((value, index) =>
    value === name ? [args[index + 1]] : value.startsWith(`${name}=`) ? [value.slice(name.length + 1)] : [],
  )
  if (found.length === 0) return undefined
  if (found.length > 1) throw new Error(`duplicate ${name}`)
  if (!found[0] || found[0].startsWith("--")) throw new Error(`missing value for ${name}`)
  return found[0]
}

function parseScenarioTimeout(input: string) {
  if (!isScenarioTimeout(input)) throw new Error(`invalid --scenario-timeout ${input}`)
  return Duration.fromInputUnsafe(input)
}

function isScenarioTimeout(input: string): input is ScenarioTimeout {
  const [amount, unit, extra] = input.trim().split(/\s+/)
  return extra === undefined && amount !== undefined && Number.isFinite(Number(amount)) && durationUnits.has(unit ?? "")
}

function parseShard(input: string | undefined) {
  if (input === undefined) return undefined
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(input)) throw new Error(`invalid --shard ${input}; expected index/total`)
  const values = input.split("/").map(Number)
  const index = values[0]!
  const total = values[1]!
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total)
    throw new Error(`invalid --shard ${input}; expected 1 <= index <= total`)
  return { index, total }
}

export function failureRatchet(results: Result[], known: Set<string>) {
  const failures = results.filter((result) => result.status === "fail")
  return {
    unexpected: failures.filter((result) => !known.has(result.scenario.name)),
    fixed: results
      .filter((result) => result.status === "pass" && known.has(result.scenario.name))
      .map((result) => result.scenario.name)
      .sort(),
  }
}
