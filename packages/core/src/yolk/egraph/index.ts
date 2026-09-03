export type ID = number

export type ENode = {
  op: string
  children: ID[]
}

export type EClass = {
  nodes: Map<string, ENode>
}

export type Pattern = {
  variable: string
  op: string
  children: Pattern[]
}

export type Subst = Map<string, ID>

export type Rewrite = {
  name: string
  lhs: Pattern
  rhs: Pattern
}

export type RunnerLimits = {
  iterations?: number
  nodeLimit?: number
  timeLimitMs?: number
  signal?: AbortSignal
}

export type RunnerReport = {
  iterations: number
  rewriteApplications: Record<string, number>
  rebuildMerges: number
  stopReason: "saturated" | "iteration-limit" | "node-limit" | "time-limit"
  elapsedMs: number
}

export type ClassAnalysis = {
  calls: Set<string>
  unresolvedCalls: Set<string>
}

export type Extracted = {
  cost: number
  text: string
  ok: boolean
}

export class NodeLimitError extends Error {
  constructor(readonly limit: number) {
    super(`e-graph node limit reached (${limit})`)
    this.name = "NodeLimitError"
  }
}

const languageSpecificPrefixes = ["go-", "java-", "ts-", "js-", "py-", "csharp-", "php-", "cpp-", "hcl-", "shell-"]

function nodeKey(op: string, children: readonly ID[]) {
  return `${op.length}:${op}${children.map((child) => `|${child}`).join("")}`
}

function compareText(a: string, b: string) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function orderedNodes(cls: EClass) {
  return [...cls.nodes.entries()].sort(([a], [b]) => compareText(a, b)).map(([, node]) => node)
}

function copySubst(subst: Subst) {
  return new Map(subst)
}

function unionStringSet(destination: Set<string>, source: Set<string>) {
  const before = destination.size
  source.forEach((value) => destination.add(value))
  return destination.size !== before
}

function opCost(op: string) {
  if (languageSpecificPrefixes.some((prefix) => op.startsWith(prefix))) return 20
  if (op.startsWith("invoke:")) return 3
  if (op.startsWith("str:") || op.startsWith("arg:") || op === "true" || op === "false" || op === "null") return 1
  if (op.startsWith("opaque")) return 100
  return 2
}

function renderNode(op: string, children: readonly string[]) {
  if (children.length === 0) return op
  return `(${op} ${children.join(" ")})`
}

async function checkpoint(signal?: AbortSignal) {
  signal?.throwIfAborted()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  signal?.throwIfAborted()
}

export class EGraph {
  private readonly parent: ID[] = []
  private readonly size: number[] = []
  private readonly classes: Array<EClass | undefined> = []
  private memo = new Map<string, ID>()

  constructor(private readonly hardNodeLimit = Number.POSITIVE_INFINITY) {}

  private makeClass(node: ENode) {
    if (this.parent.length >= this.hardNodeLimit) throw new NodeLimitError(this.hardNodeLimit)
    const id = this.parent.length
    this.parent.push(id)
    this.size.push(1)
    const key = nodeKey(node.op, node.children)
    this.classes.push({ nodes: new Map([[key, node]]) })
    this.memo.set(key, id)
    return id
  }

  private canonicalChildren(children: readonly ID[]) {
    return children.map((child) => this.find(child))
  }

  private matchPattern(pattern: Pattern, id: ID, input: Subst): Subst[] {
    id = this.find(id)
    if (pattern.variable !== "") {
      const bound = input.get(pattern.variable)
      if (bound !== undefined) return this.find(bound) === id ? [input] : []
      const result = copySubst(input)
      result.set(pattern.variable, id)
      return [result]
    }

    const cls = this.classes[id]
    if (!cls) return []
    return orderedNodes(cls).flatMap((node) => {
      if (node.op !== pattern.op || node.children.length !== pattern.children.length) return []
      return pattern.children.reduce<Subst[]>(
        (partial, childPattern, index) => {
          return partial.flatMap((subst) => this.matchPattern(childPattern, node.children[index], subst))
        },
        [copySubst(input)],
      )
    })
  }

  private instantiate(pattern: Pattern, subst: Subst): ID {
    if (pattern.variable !== "") {
      // A missing RHS variable has the Go map zero value. Keeping that behavior
      // also makes malformed rewrites fail at the same graph boundary.
      return this.find(subst.get(pattern.variable) ?? 0)
    }
    return this.add(pattern.op, ...pattern.children.map((child) => this.instantiate(child, subst)))
  }

  find(id: ID): ID {
    const parent = this.parent[id]
    if (parent === undefined) throw new RangeError(`invalid e-class ID ${id}`)
    if (parent !== id) this.parent[id] = this.find(parent)
    return this.parent[id]
  }

  add(op: string, ...children: ID[]): ID {
    const canonical = this.canonicalChildren(children)
    const key = nodeKey(op, canonical)
    const existing = this.memo.get(key)
    if (existing !== undefined) return this.find(existing)
    return this.makeClass({ op, children: [...canonical] })
  }

  union(a: ID, b: ID): [ID, boolean] {
    a = this.find(a)
    b = this.find(b)
    if (a === b) return [a, false]
    if (this.size[a] < this.size[b]) [a, b] = [b, a]

    this.parent[b] = a
    this.size[a] += this.size[b]
    const destination = this.classes[a] ?? { nodes: new Map<string, ENode>() }
    this.classes[a] = destination
    const source = this.classes[b]
    if (source) orderedNodes(source).forEach((node) => destination.nodes.set(nodeKey(node.op, node.children), node))
    this.classes[b] = undefined
    return [a, true]
  }

  // Rebuilding after a batch of unions restores congruence. This intentionally
  // uses a global repair pass rather than egg's optimized parent worklist.
  rebuild(): number {
    let totalMerges = 0
    for (;;) {
      const roots = this.roots()
      const canonicalNodes = new Map<ID, Map<string, ENode>>()
      const newMemo = new Map<string, ID>()
      const duplicates: Array<[ID, ID]> = []

      roots.forEach((originalRoot) => {
        const root = this.find(originalRoot)
        const cls = this.classes[root]
        if (!cls) return
        const destination = canonicalNodes.get(root) ?? new Map<string, ENode>()
        canonicalNodes.set(root, destination)
        orderedNodes(cls).forEach((node) => {
          const canonical = { op: node.op, children: this.canonicalChildren(node.children) }
          const key = nodeKey(canonical.op, canonical.children)
          destination.set(key, canonical)
          const existing = newMemo.get(key)
          if (existing === undefined) {
            newMemo.set(key, root)
            return
          }
          const other = this.find(existing)
          const currentRoot = this.find(root)
          if (other !== currentRoot) duplicates.push([other, currentRoot])
        })
      })

      roots.forEach((originalRoot) => {
        const root = this.find(originalRoot)
        const nodes = canonicalNodes.get(root)
        const cls = this.classes[root]
        if (nodes && cls) cls.nodes = nodes
      })

      if (duplicates.length === 0) {
        this.memo = new Map()
        this.roots().forEach((root) => {
          const cls = this.classes[root]
          if (!cls) return
          cls.nodes.forEach((_, key) => this.memo.set(key, root))
        })
        return totalMerges
      }

      const mergedThisRound = duplicates.reduce((count, pair) => {
        const [, changed] = this.union(pair[0], pair[1])
        if (changed) totalMerges++
        return count + Number(changed)
      }, 0)
      if (mergedThisRound !== 0) continue

      // Defensive termination: rebuild a clean memo from the current roots.
      this.memo = new Map()
      this.roots().forEach((root) => {
        const cls = this.classes[root]
        if (!cls) return
        const clean = new Map<string, ENode>()
        orderedNodes(cls).forEach((node) => {
          const canonical = { op: node.op, children: this.canonicalChildren(node.children) }
          const key = nodeKey(canonical.op, canonical.children)
          clean.set(key, canonical)
          this.memo.set(key, root)
        })
        cls.nodes = clean
      })
      return totalMerges
    }
  }

  roots(): ID[] {
    return this.parent
      .map((_, id) => id)
      .filter((id) => this.find(id) === id && this.classes[id] !== undefined)
      .sort((a, b) => a - b)
  }

  numClasses() {
    return this.roots().length
  }

  numNodes() {
    return this.roots().reduce((count, root) => count + (this.classes[root]?.nodes.size ?? 0), 0)
  }

  equivalent(a: ID, b: ID) {
    return this.find(a) === this.find(b)
  }

  async run(rules: readonly Rewrite[], limits: RunnerLimits = {}): Promise<RunnerReport> {
    const iterations = limits.iterations && limits.iterations > 0 ? limits.iterations : 8
    const nodeLimit = limits.nodeLimit && limits.nodeLimit > 0 ? limits.nodeLimit : 200_000
    const timeLimitMs = limits.timeLimitMs && limits.timeLimitMs > 0 ? limits.timeLimitMs : 2_000
    const start = performance.now()
    const report: RunnerReport = {
      iterations: 0,
      rewriteApplications: Object.create(null) as Record<string, number>,
      rebuildMerges: 0,
      stopReason: "iteration-limit",
      elapsedMs: 0,
    }
    const finish = (stopReason: RunnerReport["stopReason"], completedIterations: number, rebuild = true) => {
      report.iterations = completedIterations
      report.stopReason = stopReason
      if (rebuild) report.rebuildMerges += this.rebuild()
      report.elapsedMs = performance.now() - start
      return report
    }
    let workUnits = 0

    for (let iteration = 0; iteration < iterations; iteration++) {
      limits.signal?.throwIfAborted()
      let changed = 0
      const roots = this.roots()
      for (const rule of rules) {
        for (let index = 0; index < roots.length; index++) {
          if (workUnits++ % 512 === 0) await checkpoint(limits.signal)
          const root = roots[index]
          for (const subst of this.matchPattern(rule.lhs, root, new Map<string, ID>())) {
            try {
              const rhs = this.instantiate(rule.rhs, subst)
              const [, didChange] = this.union(root, rhs)
              if (!didChange) continue
              changed++
              report.rewriteApplications[rule.name] = (report.rewriteApplications[rule.name] ?? 0) + 1
            } catch (error) {
              if (error instanceof NodeLimitError) return finish("node-limit", iteration + 1)
              throw error
            }
          }
        }
        if (this.numNodes() >= nodeLimit) return finish("node-limit", iteration + 1)
        if (performance.now() - start >= timeLimitMs) return finish("time-limit", iteration + 1)
      }
      report.rebuildMerges += this.rebuild()
      report.iterations = iteration + 1
      if (changed !== 0) continue
      return finish("saturated", iteration + 1, false)
    }
    report.elapsedMs = performance.now() - start
    return report
  }

  // Analysis is a monotone fixed point over all e-classes. Calls are arbitrary
  // metadata attached to each class, matching egg's e-class analysis model.
  analyze(): Map<ID, ClassAnalysis> {
    const data = new Map<ID, ClassAnalysis>()
    this.roots().forEach((root) => data.set(root, { calls: new Set<string>(), unresolvedCalls: new Set<string>() }))
    for (;;) {
      let changed = false
      this.roots().forEach((originalRoot) => {
        const root = this.find(originalRoot)
        const current = data.get(root) ?? { calls: new Set<string>(), unresolvedCalls: new Set<string>() }
        const cls = this.classes[root]
        if (!cls) return
        const beforeCalls = current.calls.size
        const beforeUnresolvedCalls = current.unresolvedCalls.size
        orderedNodes(cls).forEach((node) => {
          if (node.op.startsWith("invoke:")) current.calls.add(node.op.slice("invoke:".length))
          if (node.op.startsWith("invoke-unresolved:"))
            current.unresolvedCalls.add(node.op.slice("invoke-unresolved:".length))
          if (node.op.startsWith("invoke-unresolved-method:")) {
            current.unresolvedCalls.add(`method:${node.op.slice("invoke-unresolved-method:".length)}`)
          }
          node.children.forEach((child) => {
            const childData = data.get(this.find(child))
            if (!childData) return
            changed = unionStringSet(current.calls, childData.calls) || changed
            changed = unionStringSet(current.unresolvedCalls, childData.unresolvedCalls) || changed
          })
        })
        if (current.calls.size !== beforeCalls || current.unresolvedCalls.size !== beforeUnresolvedCalls) changed = true
        data.set(root, current)
      })
      if (!changed) return data
    }
  }

  extractAll(): Map<ID, Extracted> {
    const best = new Map<ID, Extracted>()
    const roots = this.roots()
    for (let pass = 0; pass < roots.length * 8 + 32; pass++) {
      let changed = false
      roots.forEach((originalID) => {
        const id = this.find(originalID)
        const cls = this.classes[id]
        if (!cls) return
        orderedNodes(cls).forEach((node) => {
          const children = node.children.map((child) => best.get(this.find(child)))
          if (children.some((child) => !child?.ok)) return
          const childTexts = children.map((child) => child?.text ?? "")
          const cost = children.reduce((total, child) => total + (child?.cost ?? 0), opCost(node.op))
          const candidate = { cost, text: renderNode(node.op, childTexts), ok: true }
          const previous = best.get(id)
          if (
            previous?.ok &&
            (candidate.cost > previous.cost || (candidate.cost === previous.cost && candidate.text >= previous.text))
          )
            return
          best.set(id, candidate)
          changed = true
        })
      })
      if (!changed) break
    }
    return best
  }

  extract(root: ID): Extracted {
    return this.extractAll().get(this.find(root)) ?? { cost: 0, text: "", ok: false }
  }
}

export function createEGraph() {
  return new EGraph()
}

function tokenizePattern(input: string) {
  const tokens: string[] = []
  let current = ""
  const flush = () => {
    if (current === "") return
    tokens.push(current)
    current = ""
  }
  for (const character of input) {
    if (character === "(" || character === ")") {
      flush()
      tokens.push(character)
      continue
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      flush()
      continue
    }
    current += character
  }
  flush()
  return tokens
}

export function parsePattern(input: string): Pattern {
  const tokens = tokenizePattern(input)
  let position = 0
  const parseOne = (): Pattern => {
    if (position >= tokens.length) throw new Error("unexpected end of pattern")
    const token = tokens[position++]
    if (token.startsWith("?")) return { variable: token, op: "", children: [] }
    if (token !== "(") return { variable: "", op: token, children: [] }
    if (position >= tokens.length) throw new Error("missing pattern operator")
    const op = tokens[position++]
    const node: Pattern = { variable: "", op, children: [] }
    for (;;) {
      if (position >= tokens.length) throw new Error("unterminated pattern")
      if (tokens[position] === ")") {
        position++
        return node
      }
      node.children.push(parseOne())
    }
  }

  const pattern = parseOne()
  if (position !== tokens.length) throw new Error(`extra pattern tokens near ${JSON.stringify(tokens[position])}`)
  return pattern
}

export function mustRewrite(name: string, lhs: string, rhs: string): Rewrite {
  return { name, lhs: parsePattern(lhs), rhs: parsePattern(rhs) }
}

export function sortedSet(values: ReadonlySet<string>) {
  return [...values].sort(compareText)
}
