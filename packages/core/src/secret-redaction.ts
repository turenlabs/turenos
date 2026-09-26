export * as SecretRedaction from "./secret-redaction"

import { types } from "node:util"
import { SecretVault } from "./secret-vault"

// Leave room for producer captures and their structured/text representations before
// downstream truncation. Never truncate first: that can split a supported credential.
export const MAX_BYTES = 16 * 1024 * 1024
/** Configured values shorter than this are indistinguishable from ordinary words and are not masked. */
export const MIN_KNOWN_LENGTH = 12
const MIN_KNOWN_VARIETY = 6
const MAX_KNOWN_VALUES = 256
const MAX_KNOWN_BYTES = 65_536
const MAX_NODES = 100_000
const MAX_DEPTH = 64
// Detected formats and references are shorter than this; a longer run can no longer become one.
const MAX_FINDING = 128
// Every private key header the PEM detector recognizes, so a partially received one can be held.
const HEADERS = ["", "RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED "].map((type) => `-----BEGIN ${type}PRIVATE KEY`)
/** Stands in for a value the lenient walk refuses to read or cannot bound. */
export const WITHHELD = "[withheld: secret redaction failed]"
// Well-known placeholders that local OpenAI-compatible servers document as "any key works".
const PLACEHOLDERS = new Set([
  "sk-no-key-required",
  "no-key-required",
  "your-api-key",
  "your_api_key",
  "your-api-key-here",
  "your_api_key_here",
  "placeholder-api-key",
  "api-key-placeholder",
])
const MARKER = /\[SECRET:v1:[a-z][a-z0-9-]{0,63}:[a-f0-9]{32}\]/g
const PEM = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)/g

// Each detected format fills a whole token run and starts with one of the listed prefixes.
const RULES = [
  [
    "github",
    /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})(?![A-Za-z0-9_-])/g,
    ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
  ],
  ["gitlab", /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20}(?![A-Za-z0-9_-])/g, ["glpat-"]],
  [
    "slack",
    /(?<![A-Za-z0-9_-])(?:xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,32}|xoxp-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{32})(?![A-Za-z0-9_-])/g,
    ["xoxb-", "xoxp-"],
  ],
  ["stripe", /(?<![A-Za-z0-9_-])(?:sk|rk)_live_[A-Za-z0-9]{24,99}(?![A-Za-z0-9_-])/g, ["sk_live_", "rk_live_"]],
  ["aws-access-key-id", /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_-])/g, ["AKIA", "ASIA"]],
  ["google-api-key", /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, ["AIza"]],
] as const
const STARTS: readonly string[] = RULES.flatMap(([, , starts]) => starts)

/**
 * Whether a configured value is specific enough to mask wherever it appears. Short, repetitive
 * and documented dummy keys ("ollama", "EMPTY", "sk-no-key-required") would otherwise rewrite
 * ordinary words in prompts, tool output and source that the agent needs to edit.
 */
export function eligible(value: string) {
  if (value.length < MIN_KNOWN_LENGTH) return false
  if (PLACEHOLDERS.has(value.trim().toLowerCase())) return false
  return new Set(value).size >= MIN_KNOWN_VARIETY
}

/**
 * Prepares one operation's redactor. Literal secrets live only in the returned closures: at
 * most 256 values / 64 KiB UTF-8 are accepted, and ineligible values are dropped rather than
 * masked. Compile once per operation and reuse it for every string that operation emits.
 */
export function compile(secrets: readonly string[] = []) {
  if (secrets.length > MAX_KNOWN_VALUES) throw failure()
  if (secrets.reduce((bytes, secret) => bytes + Buffer.byteLength(secret, "utf8"), 0) > MAX_KNOWN_BYTES) throw failure()
  const literals = [...new Set(secrets)].filter(eligible).sort((a, b) => b.length - a.length)
  // Literal alternatives only, longest first, compiled once for the whole operation.
  const known =
    literals.length === 0
      ? undefined
      : new RegExp(literals.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
  return Object.freeze({
    text: (value: string) => guarded(() => redact(value, known)),
    json: (value: unknown) => guarded(() => traverse(value, (part) => redact(part, known))),
    boundary: (value: string) => guarded(() => boundary(value, known, literals)),
  })
}

/** Spans of the `[SECRET:v1:…]` references already present in `value`. */
export function references(value: string) {
  return [...value.matchAll(MARKER)].map((match) => ({ start: match.index, end: match.index + match[0].length }))
}

export function text(value: string, secrets?: readonly string[]): string {
  return guarded(() => compile(secrets).text(value))
}

export function json(value: unknown, secrets?: readonly string[]): unknown {
  return guarded(() => compile(secrets).json(value))
}

type Span = { readonly start: number; end: number; readonly rule: string | undefined }

/**
 * Every existing reference, private key block, detected token and configured value is located on
 * the original text first; overlapping findings are then replaced as one union. Applying the
 * detectors in sequence instead lets whichever runs first hide part of a longer secret from the
 * others: a stored `AKIA…:secret` pair lost its access-key prefix to the AWS rule and leaked the
 * secret half.
 */
function redact(value: string, known: RegExp | undefined): string {
  if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw failure()
  const spans = locate(value, known)
  if (spans.length === 0) return value
  const chunks: string[] = []
  // Repeated credentials share one keyed fingerprint per call.
  const references = new Map<string, string>()
  let offset = 0
  // UTF-16 length never exceeds UTF-8 bytes, so this lower bound can fail an expansion early.
  let length = 0
  const push = (chunk: string) => {
    length += chunk.length
    if (length > MAX_BYTES) throw failure()
    chunks.push(chunk)
  }
  for (const union of unions(spans)) {
    push(value.slice(offset, union.start))
    offset = union.end
    // A reference that already covers everything it overlaps is kept, so redaction is idempotent.
    const kept = union.members.some(
      (span) => span.rule === undefined && span.start === union.start && span.end === union.end,
    )
    if (kept) {
      push(value.slice(union.start, union.end))
      continue
    }
    const rule = label(union.members)
    const secret = value.slice(union.start, union.end)
    const key = `${rule}\u0000${secret}`
    const reference = references.get(key) ?? placeholder(rule, secret)
    references.set(key, reference)
    push(reference)
  }
  push(value.slice(offset))
  const result = chunks.join("")
  if (Buffer.byteLength(result, "utf8") > MAX_BYTES) throw failure()
  return result
}

/**
 * The longest prefix of streamed text that is already decided and can be redacted on its own.
 *
 * Only what later text could still turn into a finding is held back: an open run of token
 * characters that could still become a detected format (each fills a whole run from a fixed
 * prefix), a partial private key header, an unclosed reference, the start of a configured value,
 * and anything a finding spans -- an unterminated private key block holds everything from its
 * header. Ordinary output, including a trailing word with no delimiter yet, is released as soon as
 * it arrives, so a live preview never waits on text that cannot contain a credential.
 */
function boundary(value: string, known: RegExp | undefined, literals: readonly string[]) {
  if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw failure()
  let run = 0
  while (run <= MAX_FINDING && run < value.length && token(value.charCodeAt(value.length - 1 - run))) run += 1
  const word = value.slice(value.length - run)
  const open = value.lastIndexOf("[")
  const candidates = [
    run <= MAX_FINDING && STARTS.some((start) => start.startsWith(word) || word.startsWith(start))
      ? value.length - run
      : value.length,
    open !== -1 && value.length - open <= MAX_FINDING && !value.includes("]", open) ? open : value.length,
    ...HEADERS.map((header) => value.length - partial(value, header)),
    ...literals.map((literal) => value.length - partial(value, literal)),
  ]
  const held = Math.min(...candidates)
  // A finding that reaches the end may still grow (an unterminated key block always does).
  const cut =
    unions(locate(value, known)).find((union) => union.start < held && (union.end > held || union.end === value.length))
      ?.start ?? held
  // Each release is encoded on its own, so never end one between the halves of a surrogate pair.
  return high(value.charCodeAt(cut - 1)) ? cut - 1 : cut
}

// Length of the longest suffix of `value` that is a proper prefix of `target`.
function partial(value: string, target: string) {
  for (
    let index = value.indexOf(target[0], Math.max(0, value.length - target.length + 1));
    index !== -1;
    index = value.indexOf(target[0], index + 1)
  )
    if (target.startsWith(value.slice(index))) return value.length - index
  return 0
}

function token(code: number) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  )
}

function high(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

// Overlapping findings, in order, merged into the disjoint regions that get one reference each.
function unions(spans: readonly Span[]) {
  const result: { readonly start: number; end: number; readonly members: Span[] }[] = []
  for (const span of spans) {
    const last = result.at(-1)
    if (last && span.start < last.end) {
      last.members.push(span)
      last.end = Math.max(last.end, span.end)
      continue
    }
    result.push({ start: span.start, end: span.end, members: [span] })
  }
  return result
}

function locate(value: string, known: RegExp | undefined) {
  const spans: Span[] = []
  if (value.includes("[SECRET:v1:"))
    for (const match of value.matchAll(MARKER))
      spans.push({ start: match.index, end: match.index + match[0].length, rule: undefined })
  if (value.includes("-----BEGIN ")) {
    // Scan each PEM body once; an incomplete header or missing END consumes the tail.
    let offset = 0
    for (const match of value.matchAll(PEM)) {
      if (match.index < offset) continue
      const end = `-----END ${match[1]}-----`
      const position = value.indexOf(end, match.index + match[0].length)
      offset = position === -1 ? value.length : position + end.length
      spans.push({ start: match.index, end: offset, rule: "pem-private-key" })
      if (position === -1) break
    }
  }
  for (const [rule, pattern] of RULES) {
    for (const match of value.matchAll(pattern))
      spans.push({ start: match.index, end: match.index + match[0].length, rule })
  }
  if (known) {
    // Resume one character past each match start rather than past its end: longest-first
    // alternation then reports the longest value starting at every position, so overlapping
    // values are all covered. Overlaps merge as they are found, so a repetitive input cannot
    // allocate one span per character.
    let last: Span | undefined
    known.lastIndex = 0
    for (let match = known.exec(value); match; match = known.exec(value)) {
      const end = match.index + match[0].length
      if (last && match.index < last.end) last.end = Math.max(last.end, end)
      else {
        last = { start: match.index, end, rule: "known" }
        spans.push(last)
      }
      known.lastIndex = match.index + 1
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end)
}

// The widest finding names the union; on a tie a detected format outranks a configured value, so
// a stored GitHub token keeps the same reference whether or not it is configured.
function label(group: readonly Span[]) {
  const rank = (span: Span) => (span.rule === "known" ? 1 : 0)
  const named = group
    .filter((span) => span.rule !== undefined)
    .sort((a, b) => b.end - b.start - (a.end - a.start) || rank(a) - rank(b))
  return named[0]?.rule ?? "known"
}

export function containsPlaceholder(value: unknown): boolean {
  let found = false
  traverse(value, (part) => {
    // Previews can cut a generated reference mid-marker. Refuse those copies too.
    if (part.includes("[SECRET:v1")) found = true
    return part
  })
  return found
}

/**
 * JSON-compatible redaction for display metadata that older producers never constrained.
 *
 * The strict walk rejects anything that is not plain data; a whole metadata record then had to be
 * discarded because one field held a `Date` or a class instance. This walk instead produces what
 * the persisted JSON would contain -- dates as ISO strings, non-finite numbers as `null`, own
 * enumerable data properties of plain class instances -- and withholds only the nodes it will not
 * read: accessors and `toJSON` hooks are never invoked, and cycles, proxies that throw, bigints and
 * over-deep values become {@link WITHHELD}. Only the aggregate budgets fail the whole value.
 */
export function lenient(value: unknown, transform: (value: string) => string): unknown {
  return guarded(() => {
    const budget = { bytes: 0, output: 0, nodes: 0 }
    return relaxed(
      value,
      (part) => {
        budget.bytes += Buffer.byteLength(part, "utf8")
        if (budget.bytes > MAX_BYTES) throw EXHAUSTED
        const result = transform(part)
        budget.output += Buffer.byteLength(result, "utf8")
        if (budget.output > MAX_BYTES) throw EXHAUSTED
        return result
      },
      new WeakSet(),
      budget,
      0,
    )
  })
}

// Identity sentinel: aggregate budgets abort the whole walk. It is compared by reference so the
// walk never reads properties of whatever a hostile object throws.
const EXHAUSTED = Symbol("SecretRedaction.exhausted")

function relaxed(
  value: unknown,
  transform: (value: string) => string,
  active: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): unknown {
  if (++budget.nodes > MAX_NODES) throw EXHAUSTED
  if (typeof value === "string") return readable(() => transform(value))
  if (value === undefined || value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "function" || typeof value === "symbol") return undefined
  // A proxy's traps are hooks too: withhold it without enumerating or reading through it.
  if (typeof value !== "object" || depth > MAX_DEPTH || active.has(value) || types.isProxy(value)) return WITHHELD
  const time = dateValue(value)
  if (time !== undefined) return Number.isNaN(time) ? null : new Date(time).toISOString()
  active.add(value)
  const result = readable(() => {
    if (Array.isArray(value)) {
      if (value.length + budget.nodes > MAX_NODES) throw EXHAUSTED
      return Array.from({ length: value.length }, (_, index) =>
        field(value, String(index), (item) => relaxed(item, transform, active, budget, depth + 1) ?? null),
      )
    }
    if ("toJSON" in value) return WITHHELD
    const names = Object.keys(value)
    if (names.length + budget.nodes > MAX_NODES) throw EXHAUSTED
    const keys = new Set<string>()
    const entries = names.flatMap((key) => {
      const sanitized = transform(key)
      // Two keys that redact to the same reference cannot both be kept; drop the whole record.
      if (keys.has(sanitized)) throw WITHHELD
      keys.add(sanitized)
      const item = field(value, key, (entry) => relaxed(entry, transform, active, budget, depth + 1))
      return item === undefined ? [] : [[sanitized, item] as const]
    })
    return Object.fromEntries(entries)
  })
  active.delete(value)
  return result
}

// Anything a hostile object throws withholds only its own node; exhausted budgets propagate.
function readable(read: () => unknown) {
  try {
    return read()
  } catch (error) {
    if (error === EXHAUSTED) throw error
    return WITHHELD
  }
}

function field(value: object, key: string, read: (value: unknown) => unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) return WITHHELD
  return read(descriptor.value)
}

function dateValue(value: object) {
  try {
    // Reads the internal time slot without calling user code; throws for anything but a Date.
    return Date.prototype.getTime.call(value)
  } catch {
    return undefined
  }
}

function traverse(value: unknown, transform: (value: string) => string): unknown {
  try {
    const budget = { bytes: 0, output: 0, nodes: 0 }
    return walk(
      value,
      (part) => {
        budget.bytes += Buffer.byteLength(part, "utf8")
        if (budget.bytes > MAX_BYTES) throw failure()
        const result = transform(part)
        budget.output += Buffer.byteLength(result, "utf8")
        if (budget.output > MAX_BYTES) throw failure()
        return result
      },
      new WeakSet(),
      budget,
      0,
    )
  } catch {
    // Never attach the cause: proxies or other user objects can throw raw secrets.
    throw failure()
  }
}

function walk(
  value: unknown,
  transform: (value: string) => string,
  active: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): unknown {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw failure()
  if (typeof value === "string") return transform(value)
  // Effect tool codecs preserve absent optional fields as undefined until wire encoding.
  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value
  if (typeof value !== "object" || active.has(value) || types.isProxy(value)) throw failure()
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw failure()
  active.add(value)
  const keys = new Set<string>()
  const names = Object.keys(value)
  if (names.length + budget.nodes > MAX_NODES) throw failure()
  if (array && (names.length !== value.length || names.some((key, index) => key !== String(index)))) throw failure()
  const entries = names.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) throw failure()
    const sanitized = array ? key : transform(key)
    if (keys.has(sanitized)) throw failure()
    keys.add(sanitized)
    return [sanitized, walk(descriptor.value, transform, active, budget, depth + 1)] as const
  })
  active.delete(value)
  return array ? entries.map((entry) => entry[1]) : Object.fromEntries(entries)
}

function guarded<A>(run: () => A): A {
  try {
    return run()
  } catch {
    throw failure()
  }
}

function failure() {
  return new Error("Secret redaction failed")
}

function placeholder(rule: string, value: string) {
  return `[SECRET:v1:${rule}:${SecretVault.fingerprint("secret-redaction:v1", value).slice(0, 32)}]`
}
