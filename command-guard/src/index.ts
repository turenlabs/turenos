#!/usr/bin/env bun

export type Shell = "bash" | "powershell" | "cmd" | "unknown"
export type Risk = "safe" | "low" | "medium" | "high" | "critical"
export type Decision = "allow" | "review" | "block"
export type Category =
  | "destructive-filesystem"
  | "privilege-escalation"
  | "credential-exposure"
  | "remote-code-execution"
  | "process-control"
  | "system-control"
  | "data-exfiltration"
  | "repository-destruction"
  | "network"
  | "other"

export type Finding = {
  readonly id: string
  readonly risk: Exclude<Risk, "safe">
  readonly category: Category
  readonly message: string
  readonly evidence: string
}

export type SemanticAssessment = {
  readonly model: string
  readonly dangerous: number
  readonly confirmation: number
  readonly riskScore: number
  readonly confidence?: number
  readonly category: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
}

export type Assessment = {
  readonly command: string
  readonly shell: Shell
  readonly risk: Risk
  readonly decision: Decision
  readonly dangerous: boolean
  readonly requiresConfirmation: boolean
  readonly findings: readonly Finding[]
  readonly semantic?: SemanticAssessment
}

type Segment = {
  readonly args: readonly string[]
  readonly piped: boolean
}

const RISK_VALUE: Record<Risk, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

const DECISION_FOR_RISK: Record<Risk, Decision> = {
  safe: "allow",
  low: "allow",
  medium: "review",
  high: "block",
  critical: "block",
}

const SHELL_NAMES = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "mksh", "ash", "csh", "tcsh"])
const POWERSHELL_NAMES = new Set(["powershell", "pwsh"])
const WINDOWS_SHELL_NAMES = new Set(["cmd", "cmd.exe"])
const POSIX_DOWNLOADERS = new Set(["curl", "wget"])
const POWER_SHELL_DOWNLOADERS = new Set(["invoke-webrequest", "iwr", "irm", "bitsadmin"])
const SHELL_EVALUATORS = new Set(["eval", "iex", "invoke-expression"])
const CODE_INTERPRETERS = new Set(["python", "python3", "perl", "ruby", "node"])
const SHELL_WRAPPERS = new Set([
  "ash",
  "bash",
  "csh",
  "dash",
  "fish",
  "ksh",
  "mksh",
  "sh",
  "tcsh",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
])
const SHELL_PREFIXES = new Set([
  "!",
  "{",
  "}",
  "(",
  ")",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
])
const SUBCOMMAND_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]),
  docker: new Set(["-H", "--host", "--context", "--config", "--log-level"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--kubeconfig"]),
  terraform: new Set(["-chdir"]),
}

const sensitivePath =
  /(?:^|[\s"'\/])(?:\.env(?:\.[^\/]*)?|\.npmrc|id_(?:rsa|dsa|ecdsa|ed25519)|\.pem|\.key|credentials?|secrets?|tokens?|passwords?|kubeconfig|shadow)(?=$|[\s"'\/])/i
const sensitiveWord = /(?:secret|credential|token|password|private[-_ ]key|api[-_ ]key)/i

export function detect(command: string, shell: Shell = defaultShell()): Assessment {
  const findings = deduplicate(inspectCommand(command, shell))
  const risk = highestRisk(findings)
  return makeAssessment(command, shell, risk, findings)
}

export async function analyze(
  command: string,
  options: {
    readonly shell?: Shell
    readonly semantic?: boolean
    readonly endpoint?: string
    readonly timeoutMs?: number
  } = {},
): Promise<Assessment> {
  const local = detect(command, options.shell ?? defaultShell())
  if (!options.semantic) return local

  const semantic = await askTypeSafe(
    local,
    options.endpoint ?? process.env.TYPESAFE_ENDPOINT,
    options.timeoutMs ?? 10_000,
  )
  const risk = maxRisk(local.risk, semanticRisk(semantic))
  return {
    ...local,
    risk,
    decision: DECISION_FOR_RISK[risk],
    dangerous: RISK_VALUE[risk] >= RISK_VALUE.high,
    requiresConfirmation: RISK_VALUE[risk] >= RISK_VALUE.medium,
    semantic,
  }
}

function makeAssessment(command: string, shell: Shell, risk: Risk, findings: readonly Finding[]): Assessment {
  return {
    command,
    shell,
    risk,
    decision: DECISION_FOR_RISK[risk],
    dangerous: RISK_VALUE[risk] >= RISK_VALUE.high,
    requiresConfirmation: RISK_VALUE[risk] >= RISK_VALUE.medium,
    findings,
  }
}

function inspectCommand(command: string, shell: Shell, depth = 0): Finding[] {
  if (!command.trim()) return []

  const findings: Finding[] = []
  if (/:\s*\(\)\s*\{[^}]*:\s*\|\s*:\s*[;&]/.test(command) || /fork\s*bomb/i.test(command)) {
    findings.push({
      id: "fork-bomb",
      risk: "critical",
      category: "system-control",
      message: "The command resembles a fork bomb and can exhaust process resources.",
      evidence: command,
    })
  }

  const segments = splitSegments(command)
  for (const segment of segments) {
    findings.push(...inspectSegment(segment, shell))
    if (depth >= 2) continue
    const commandArgs = segment.args.slice(commandStart(segment.args))
    const nested = nestedCommand(unwrap(commandArgs), shell)
    if (!nested) continue
    if (nested.dynamic) {
      findings.push({
        id: "dynamic-shell-evaluation",
        risk: "high",
        category: "remote-code-execution",
        message: "The command evaluates a dynamically supplied command string.",
        evidence: segment.args.join(" "),
      })
      continue
    }
    findings.push(...inspectCommand(nested.command, nested.shell, depth + 1))
  }

  if (depth < 2) {
    for (const substitution of commandSubstitutions(command)) {
      findings.push(...inspectCommand(substitution, shell, depth + 1))
    }
  }

  const pipelines: Segment[][] = []
  let pipeline: Segment[] = []
  for (const segment of segments) {
    if (!segment.piped && pipeline.length > 0) {
      pipelines.push(pipeline)
      pipeline = []
    }
    pipeline.push(segment)
  }
  if (pipeline.length > 0) pipelines.push(pipeline)

  for (const current of pipelines) {
    if (current.length < 2) continue
    const names = current.map((segment) => commandName(unwrap(segment.args.slice(commandStart(segment.args)))))
    const downloaderIndex = names.findIndex((name) => POSIX_DOWNLOADERS.has(name) || POWER_SHELL_DOWNLOADERS.has(name))
    const interpreterIndex = names.findIndex(
      (name, index) =>
        index > downloaderIndex &&
        (SHELL_NAMES.has(name) ||
          POWERSHELL_NAMES.has(name) ||
          SHELL_EVALUATORS.has(name) ||
          CODE_INTERPRETERS.has(name)),
    )
    const evidence = current.map((segment) => segment.args.join(" ")).join(" | ")
    if (downloaderIndex >= 0 && interpreterIndex > downloaderIndex) {
      findings.push({
        id: "download-to-interpreter",
        risk: "critical",
        category: "remote-code-execution",
        message: "Remote content is piped directly into a shell or evaluator.",
        evidence,
      })
    }

    const networkIndex = names.findIndex(
      (name, index) => index > 0 && (POSIX_DOWNLOADERS.has(name) || POWER_SHELL_DOWNLOADERS.has(name)),
    )
    const sensitiveSource = current
      .slice(0, networkIndex < 0 ? current.length : networkIndex)
      .some((segment) => sensitivePath.test(segment.args.join(" ")) || sensitiveWord.test(segment.args.join(" ")))
    if (networkIndex >= 0 && sensitiveSource) {
      findings.push({
        id: "secret-to-network",
        risk: "critical",
        category: "data-exfiltration",
        message: "Sensitive-looking data is piped into a network client.",
        evidence,
      })
    }
  }

  return findings
}

function inspectSegment(segment: Segment, shell: Shell): Finding[] {
  const commandArgs = segment.args.slice(commandStart(segment.args))
  const originalName = executable(commandArgs[0] ?? "")
  const unwrapped = unwrap(commandArgs)
  const name = commandName(unwrapped)
  const args = unwrapped.slice(1)
  const text = segment.args.join(" ")
  const lowerText = text.toLowerCase()
  const findings: Finding[] = []

  const add = (finding: Finding) => findings.push(finding)

  if (originalName === "sudo" || originalName === "doas" || originalName === "runas") {
    add({
      id: "privilege-escalation",
      risk: "medium",
      category: "privilege-escalation",
      message: "The command requests elevated privileges.",
      evidence: text,
    })
  }

  if (originalName === "env" && segment.args.some((arg) => arg === "-S" || arg.startsWith("-S"))) {
    add({
      id: "dynamic-shell-evaluation",
      risk: "high",
      category: "remote-code-execution",
      message: "env -S evaluates a command string that may hide additional operations.",
      evidence: text,
    })
  }

  if (
    name === "rm" ||
    name === "rmdir" ||
    name === "remove-item" ||
    name === "del" ||
    name === "erase" ||
    name === "rd"
  ) {
    const recursive = recursiveFlag(args, shell, name)
    const operands = commandOperands(args, shell, name)
    const broad = operands.find((operand) => broadTarget(operand))
    if (recursive && broad !== undefined) {
      add({
        id: "recursive-delete-broad-target",
        risk: "critical",
        category: "destructive-filesystem",
        message:
          "Recursive deletion targets a root, home directory, parent, current directory, wildcard, or dynamic path.",
        evidence: `${name} ${broad}`,
      })
    } else if (recursive) {
      add({
        id: "recursive-delete",
        risk: "high",
        category: "destructive-filesystem",
        message: "Recursive deletion can remove an entire directory tree.",
        evidence: text,
      })
    } else if (broad !== undefined) {
      add({
        id: "delete-broad-target",
        risk: "high",
        category: "destructive-filesystem",
        message: "Deletion targets a broad or dynamically resolved path.",
        evidence: `${name} ${broad}`,
      })
    } else if (operands.length > 0) {
      add({
        id: "delete-files",
        risk: "medium",
        category: "destructive-filesystem",
        message: "The command deletes files or directories.",
        evidence: text,
      })
    }
  }

  const subcommand = firstSubcommand(name, args)
  if (name === "git" && subcommand.name === "reset" && subcommand.args.includes("--hard")) {
    add({
      id: "git-reset-hard",
      risk: "high",
      category: "repository-destruction",
      message: "A hard Git reset discards tracked working-tree changes.",
      evidence: text,
    })
  }
  if (
    name === "git" &&
    subcommand.name === "clean" &&
    subcommand.args.some((arg) => arg.startsWith("-") && arg.includes("f"))
  ) {
    add({
      id: "git-clean",
      risk: "high",
      category: "repository-destruction",
      message: "Git clean with force and directory flags permanently removes untracked content.",
      evidence: text,
    })
  }
  if (
    name === "git" &&
    subcommand.name === "push" &&
    subcommand.args.some((arg) => arg === "--force" || arg === "-f" || arg === "--force-with-lease")
  ) {
    add({
      id: "git-force-push",
      risk: "high",
      category: "repository-destruction",
      message: "A forced Git push can rewrite shared remote history.",
      evidence: text,
    })
  }

  if (
    name === "docker" &&
    ((subcommand.name === "system" && subcommand.args[0] === "prune") ||
      (subcommand.name === "volume" && subcommand.args[0] === "prune"))
  ) {
    add({
      id: "docker-prune",
      risk: "high",
      category: "destructive-filesystem",
      message: "Docker prune removes resources outside the current project.",
      evidence: text,
    })
  }
  if (name === "kubectl" && subcommand.name === "delete") {
    add({
      id: "cluster-delete",
      risk: "high",
      category: "system-control",
      message: "The command deletes resources from a Kubernetes cluster.",
      evidence: text,
    })
  }
  if (name === "terraform" && subcommand.name === "destroy") {
    add({
      id: "terraform-destroy",
      risk: "critical",
      category: "system-control",
      message: "Terraform destroy can remove provisioned infrastructure.",
      evidence: text,
    })
  }

  if (name === "chmod" || name === "chown") {
    const recursive = args.some((arg) => /^-[^-]*R/i.test(arg) || arg === "--recursive")
    const broadMode = args.some((arg) => /(?:^|\s)777(?:$|\s)/.test(arg) || arg.includes("a+rwx"))
    if (recursive || broadMode) {
      add({
        id: "recursive-permission-change",
        risk: "high",
        category: "destructive-filesystem",
        message: "A recursive or world-writable permission change can affect many files.",
        evidence: text,
      })
    }
  }

  if (
    name === "dd" ||
    name === "mkfs" ||
    name === "fdisk" ||
    name === "parted" ||
    (name === "diskutil" && /\berasedisk\b/i.test(lowerText))
  ) {
    add({
      id: "disk-operation",
      risk: "critical",
      category: "destructive-filesystem",
      message: "The command can overwrite, format, or erase a disk or partition.",
      evidence: text,
    })
  }
  if (name === "shutdown" || name === "reboot" || name === "poweroff" || name === "halt" || name === "format") {
    add({
      id: "system-power-control",
      risk: "high",
      category: "system-control",
      message: "The command controls system power or formatting.",
      evidence: text,
    })
  }

  if (name === "kill" || name === "pkill" || name === "killall" || name === "taskkill") {
    const force = args.some((arg) => arg === "-9" || arg === "/f" || arg === "--signal=KILL")
    add({
      id: "process-control",
      risk: force || name !== "kill" ? "high" : "medium",
      category: "process-control",
      message: force ? "The command forcefully terminates processes." : "The command terminates processes.",
      evidence: text,
    })
  }

  const readsSensitiveData = new Set([
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "type",
    "get-content",
    "printenv",
    "env",
    "security",
  ])
  if (
    (readsSensitiveData.has(name) &&
      (sensitivePath.test(text) ||
        sensitiveWord.test(text) ||
        (name === "env" && args.length === 0) ||
        (name === "printenv" && args.length === 0))) ||
    ((originalName === "env" || originalName === "printenv") && name === "") ||
    (name === "security" &&
      ["find-generic-password", "find-internet-password", "dump-keychain"].includes(args[0] ?? ""))
  ) {
    add({
      id: "credential-exposure",
      risk: "high",
      category: "credential-exposure",
      message: "The command may print credentials, private keys, or sensitive environment data.",
      evidence: text,
    })
  }

  if (name === "curl" || name === "wget" || POWER_SHELL_DOWNLOADERS.has(name)) {
    const upload = args.some(
      (arg) =>
        arg === "-d" ||
        arg.startsWith("--data") ||
        arg === "-T" ||
        arg === "--upload-file" ||
        arg === "--post-data" ||
        arg === "-X" ||
        arg.toLowerCase() === "post",
    )
    add({
      id: upload ? "network-upload" : "network-access",
      risk: upload ? "high" : "low",
      category: upload ? "data-exfiltration" : "network",
      message: upload
        ? "The command sends data to a network endpoint."
        : "The command retrieves content from a network endpoint.",
      evidence: text,
    })
  }
  if ((name === "nc" || name === "netcat") && args.some((arg) => arg === "-e" || arg === "--exec")) {
    add({
      id: "network-shell",
      risk: "critical",
      category: "remote-code-execution",
      message: "Netcat is configured to attach a command shell to a network connection.",
      evidence: text,
    })
  }

  if (SHELL_EVALUATORS.has(name) || (SHELL_WRAPPERS.has(name) && hasCommandStringFlag(args, name))) {
    const encoded = args.some((arg) => arg.toLowerCase() === "-encodedcommand")
    if (encoded) {
      add({
        id: "encoded-command",
        risk: "critical",
        category: "remote-code-execution",
        message: "An encoded command hides the command being evaluated.",
        evidence: text,
      })
    } else if (SHELL_EVALUATORS.has(name)) {
      add({
        id: "command-evaluation",
        risk: "high",
        category: "remote-code-execution",
        message: "The command evaluates another command string at runtime.",
        evidence: text,
      })
    }
  }

  return findings
}

function splitSegments(command: string): Segment[] {
  const tokens = tokenize(command)
  const segments: Segment[] = []
  let args: string[] = []
  let piped = false
  for (const token of tokens) {
    if (!isSeparator(token)) {
      args.push(token)
      continue
    }
    if (args.length > 0) segments.push({ args, piped })
    args = []
    piped = token === "|" || token === "|&"
  }
  if (args.length > 0) segments.push({ args, piped })
  return segments
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  const flush = () => {
    if (!current) return
    tokens.push(current)
    current = ""
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (/\s/.test(char)) {
      flush()
      if (char === "\n") tokens.push("\n")
      continue
    }
    const pair = command.slice(index, index + 2)
    if (pair === "&&" || pair === "||" || pair === "|&") {
      flush()
      tokens.push(pair)
      index++
      continue
    }
    if (char === ";" || char === "|" || char === "&") {
      flush()
      tokens.push(char)
      continue
    }
    current += char
  }
  flush()
  return tokens
}

function isSeparator(token: string): boolean {
  return (
    token === "&&" ||
    token === "||" ||
    token === ";" ||
    token === "|" ||
    token === "|&" ||
    token === "&" ||
    token === "\n"
  )
}

function commandStart(args: readonly string[]): number {
  let index = 0
  while (index < args.length) {
    const token = args[index]!
    const lower = token.toLowerCase()
    if (/^[a-z_][a-z0-9_]*=/i.test(token)) {
      index++
      continue
    }
    if (SHELL_PREFIXES.has(lower)) {
      index++
      continue
    }
    if (lower === "function") {
      index += args[index + 1] ? 2 : 1
      continue
    }
    if (/^\d*(?:>>?|<<|>&|<&)/.test(token)) {
      const standalone = /^\d*(?:>>?|<<|>&|<&)$/.test(token)
      index += standalone ? 2 : 1
      continue
    }
    break
  }
  return index
}

function commandSubstitutions(command: string): string[] {
  const substitutions: string[] = []
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === "\\") {
      index++
      continue
    }
    if (char === "'") {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (char === "$" && command[index + 1] === "(") {
      const end = matchingParen(command, index + 1)
      if (end === undefined) continue
      const nested = command.slice(index + 2, end)
      if (nested.trim()) substitutions.push(nested)
      index = end
      continue
    }
    if ((char === "<" || char === ">") && command[index + 1] === "(") {
      const end = matchingParen(command, index + 1)
      if (end === undefined) continue
      const nested = command.slice(index + 2, end)
      if (nested.trim()) substitutions.push(nested)
      index = end
      continue
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1)
      if (end < 0) continue
      const nested = command.slice(index + 1, end)
      if (nested.trim()) substitutions.push(nested)
      index = end
    }
  }
  return substitutions
}

function matchingParen(command: string, opening: number): number | undefined {
  let depth = 0
  let quote: "'" | '"' | undefined
  for (let index = opening; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === "\\") {
      index++
      continue
    }
    if (char === "'") {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (char === "(") depth++
    if (char === ")") {
      depth--
      if (depth === 0) return index
    }
  }
}

function executable(value: string): string {
  const normalized = value.replace(/^@+/, "").replaceAll("\\", "/")
  return (normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.exe$/i, "") || normalized).toLowerCase()
}

function commandName(args: readonly string[]): string {
  return executable(args[0] ?? "")
}

function firstSubcommand(
  name: string,
  args: readonly string[],
): { readonly name: string; readonly args: readonly string[] } {
  const valueOptions = SUBCOMMAND_VALUE_OPTIONS[name] ?? new Set<string>()
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (arg === "--") {
      index++
      break
    }
    if (!arg.startsWith("-")) break
    if (arg.includes("=")) {
      index++
      continue
    }
    index += valueOptions.has(arg) ? 2 : 1
  }
  return { name: args[index] ?? "", args: args.slice(index + 1) }
}

function unwrap(args: readonly string[]): string[] {
  let index = 0
  while (index < args.length) {
    const name = executable(args[index] ?? "")
    if (name === "sudo" || name === "doas") {
      index++
      while (index < args.length && args[index]!.startsWith("-")) {
        index += takesOptionValue(args[index]!) ? 2 : 1
      }
      continue
    }
    if (name === "env") {
      index++
      while (index < args.length && (args[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[index]!))) {
        index += takesOptionValue(args[index]!) ? 2 : 1
      }
      continue
    }
    if (name === "command" || name === "builtin" || name === "exec" || name === "nohup" || name === "setsid") {
      index++
      while (index < args.length && args[index]!.startsWith("-")) index++
      continue
    }
    if (name === "nice" || name === "timeout" || name === "stdbuf") {
      index++
      while (index < args.length && args[index]!.startsWith("-")) index += takesOptionValue(args[index]!) ? 2 : 1
      if (name === "timeout") index++
      continue
    }
    break
  }
  return args.slice(index)
}

function takesOptionValue(value: string): boolean {
  return new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-C",
    "-D",
    "--chdir",
    "-n",
    "-k",
    "-s",
    "--signal",
    "--kill-after",
    "-a",
  ]).has(value)
}

function recursiveFlag(args: readonly string[], shell: Shell, name: string): boolean {
  if (name === "remove-item") return args.some((arg) => /^-(?:recurse|r)(?::\$?true)?$/i.test(arg))
  if (
    shell === "powershell" &&
    name !== "rm" &&
    name !== "del" &&
    name !== "erase" &&
    name !== "rd" &&
    name !== "rmdir"
  )
    return args.some((arg) => /^-(?:recurse|r)(?::\$?true)?$/i.test(arg))
  if (shell === "cmd" || name === "del" || name === "erase" || name === "rd" || name === "rmdir")
    return args.some((arg) => /^\/s$/i.test(arg))
  return args.some((arg) => arg === "--recursive" || /^-[^-]*r/i.test(arg))
}

function commandOperands(args: readonly string[], shell: Shell, name: string): string[] {
  const operands: string[] = []
  let options = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (options && arg === "--") {
      options = false
      continue
    }
    if (options && arg.startsWith("-")) {
      if ((shell === "powershell" || name === "remove-item") && /^-(?:literal)?path$/i.test(arg)) {
        const value = args[index + 1]
        if (value !== undefined) operands.push(value)
        index++
      }
      continue
    }
    if (
      options &&
      (shell === "cmd" || name === "del" || name === "erase" || name === "rd" || name === "rmdir") &&
      /^\/[a-z]+$/i.test(arg)
    )
      continue
    operands.push(arg)
  }
  return operands
}

function broadTarget(value: string): boolean {
  const target = value.toLowerCase()
  if (
    !target ||
    target === "." ||
    target === "./" ||
    target === ".." ||
    target === "../" ||
    target === "~" ||
    target === "~+"
  )
    return true
  if (target === "/" || /^[a-z]:[\\/]?$/.test(target) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(target)) return true
  if (
    target.includes("$home") ||
    target.includes("$env:home") ||
    target.includes("%userprofile%") ||
    target.includes("%homepath%")
  )
    return true
  if (target.includes("*") || target.includes("?") || target.includes("[")) return true
  if (target.split(/[\\/]+/).includes("..")) return true
  return target.startsWith("/") && target.split("/").filter(Boolean).length <= 1
}

function hasCommandStringFlag(args: readonly string[], name: string): boolean {
  if (SHELL_EVALUATORS.has(name)) return true
  if (SHELL_NAMES.has(name)) return args.some((arg) => /^-[^-]*c$/.test(arg))
  if (POWERSHELL_NAMES.has(name)) return args.some((arg) => /^-command$|^-c$|^-encodedcommand$/i.test(arg))
  if (WINDOWS_SHELL_NAMES.has(name)) return args.some((arg) => /^\/[ck]$/i.test(arg))
  return false
}

function nestedCommand(
  args: readonly string[],
  shell: Shell,
): { readonly command: string; readonly shell: Shell; readonly dynamic: boolean } | undefined {
  const name = commandName(args)
  if (SHELL_EVALUATORS.has(name)) {
    const command = args
      .slice(1)
      .filter((arg) => !arg.startsWith("-"))
      .join(" ")
    return {
      command,
      shell: name === "iex" || name === "invoke-expression" ? "powershell" : shell,
      dynamic: !command || command.includes("$"),
    }
  }
  if (!SHELL_WRAPPERS.has(name)) return
  const index = args.findIndex((arg) => {
    if (SHELL_NAMES.has(name)) return /^-[^-]*c$/.test(arg)
    if (POWERSHELL_NAMES.has(name)) return /^-command$|^-c$/i.test(arg)
    return /^\/[ck]$/i.test(arg)
  })
  if (index < 0) return
  const command = args.slice(index + 1).join(" ")
  const nestedShell = SHELL_NAMES.has(name) ? "bash" : POWERSHELL_NAMES.has(name) ? "powershell" : "cmd"
  return { command, shell: nestedShell, dynamic: !command || command.includes("$") || command.includes("%") }
}

function highestRisk(findings: readonly Finding[]): Risk {
  return findings.reduce<Risk>((risk, finding) => maxRisk(risk, finding.risk), "safe")
}

function maxRisk(left: Risk, right: Risk): Risk {
  return RISK_VALUE[left] >= RISK_VALUE[right] ? left : right
}

function deduplicate(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.id}:${finding.evidence}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function semanticRisk(semantic: SemanticAssessment): Risk {
  if (semantic.dangerous >= 0.85 || semantic.riskScore >= 2.5) return "critical"
  if (semantic.dangerous >= 0.6 || semantic.riskScore >= 1.5) return "high"
  if (semantic.confirmation >= 0.5 || semantic.riskScore >= 0.75) return "medium"
  if (semantic.dangerous >= 0.25 || semantic.riskScore > 0) return "low"
  return "safe"
}

async function askTypeSafe(
  local: Assessment,
  endpoint: string | undefined,
  timeoutMs: number,
): Promise<SemanticAssessment> {
  const apiKey = process.env.TYPESAFE_API_KEY
  if (!apiKey) throw new Error("--semantic requires TYPESAFE_API_KEY")

  const target = typeSafeEndpoint(endpoint)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "jev-latest",
        state: {
          shell: local.shell,
          command: local.command,
          local_findings: local.findings,
        },
        questions: {
          is_dangerous: {
            type: "noul",
            instructions:
              "Does this command create a meaningful risk of data loss, privilege abuse, credential exposure, remote code execution, or harmful system control?",
          },
          requires_confirmation: {
            type: "noul",
            instructions: "Should a careful operator explicitly confirm this command before it is run?",
          },
          risk: {
            type: "score",
            instructions: "How risky would it be to run this command in the stated shell?",
            criteria: [
              "Harmless or read-only",
              "Limited and recoverable side effect",
              "Potentially destructive, privileged, or sensitive",
              "Critical: broad destruction, hidden execution, or serious data exposure",
            ],
          },
          category: {
            type: "choice",
            instructions: "What is the primary risk category of this command?",
            criteria: {
              safe: "No meaningful security or data-loss risk",
              destructive_filesystem: "Deletes, overwrites, formats, or broadly changes files",
              privilege_escalation: "Requests elevated privileges",
              credential_exposure: "Reads or prints credentials or private key material",
              remote_code_execution: "Downloads or evaluates code, or opens a remote shell",
              process_control: "Kills or broadly controls processes",
              system_control: "Controls infrastructure, clusters, power, or system state",
              data_exfiltration: "Sends sensitive data to a remote endpoint",
              repository_destruction: "Rewrites or destroys repository history or content",
              network: "Makes a network request without another primary risk",
              other: "A meaningful risk not covered above",
            },
          },
        },
      }),
      signal: controller.signal,
    })

    const bodyText = await response.text()
    const body = parseJson(bodyText)
    if (!response.ok) {
      const detail = readString(isRecord(body) ? body.error : undefined) ?? response.statusText
      throw new Error(`TypeSafe request failed (${response.status}): ${detail}`)
    }
    return decodeSemantic(body)
  } finally {
    clearTimeout(timer)
  }
}

function typeSafeEndpoint(value?: string): URL {
  const target = new URL(value ?? "https://api.typesafe.ai/v1/systemone")
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  if (target.protocol !== "https:" && !loopback) {
    throw new Error("TypeSafe endpoint must use HTTPS; plain HTTP is allowed only for localhost testing")
  }
  return target
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("TypeSafe returned invalid JSON")
  }
}

function decodeSemantic(value: unknown): SemanticAssessment {
  if (!isRecord(value)) throw new Error("TypeSafe response is not an object")
  const answers = value.answers
  if (!isRecord(answers)) throw new Error("TypeSafe response has no answers")
  const dangerous = answerNumber(answers, "is_dangerous", "noul")
  const confirmation = answerNumber(answers, "requires_confirmation", "noul")
  const riskAnswer = answerRecord(answers, "risk")
  const categoryAnswer = answerRecord(answers, "category")
  const usage = isRecord(value.usage)
    ? {
        ...(typeof value.usage.input_tokens === "number" ? { inputTokens: value.usage.input_tokens } : {}),
        ...(typeof value.usage.output_tokens === "number" ? { outputTokens: value.usage.output_tokens } : {}),
      }
    : undefined
  return {
    model: readString(value.model) ?? "unknown",
    dangerous,
    confirmation,
    riskScore: readScore(riskAnswer.score, "risk.score"),
    confidence:
      typeof riskAnswer.confidence === "number" ? readProbability(riskAnswer.confidence, "risk.confidence") : undefined,
    category: readString(categoryAnswer.choice) ?? "other",
    usage,
  }
}

function answerNumber(answers: Record<string, unknown>, name: string, field: string): number {
  return readProbability(answerRecord(answers, name)[field], `${name}.${field}`)
}

function answerRecord(answers: Record<string, unknown>, name: string): Record<string, unknown> {
  const answer = answers[name]
  if (!isRecord(answer)) throw new Error(`TypeSafe response has no ${name} answer`)
  return answer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`TypeSafe response has invalid ${field}`)
  return value
}

function readProbability(value: unknown, field: string): number {
  const number = readNumber(value, field)
  if (number < 0 || number > 1) throw new Error(`TypeSafe response has out-of-range ${field}`)
  return number
}

function readScore(value: unknown, field: string): number {
  const number = readNumber(value, field)
  if (number < 0 || number > 3) throw new Error(`TypeSafe response has out-of-range ${field}`)
  return number
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function defaultShell(): Shell {
  const configured = process.platform === "win32" ? (process.env.ComSpec ?? process.env.SHELL) : process.env.SHELL
  const name = executable(configured ?? "bash")
  if (SHELL_NAMES.has(name)) return "bash"
  if (POWERSHELL_NAMES.has(name)) return "powershell"
  if (WINDOWS_SHELL_NAMES.has(name)) return "cmd"
  return "unknown"
}

function parseShell(value: string): Shell {
  const name = executable(value)
  if (SHELL_NAMES.has(name)) return "bash"
  if (POWERSHELL_NAMES.has(name)) return "powershell"
  if (WINDOWS_SHELL_NAMES.has(name)) return "cmd"
  if (value === "unknown") return "unknown"
  throw new Error(`Unsupported shell "${value}". Use bash, powershell, cmd, or unknown.`)
}

async function main(args: readonly string[]): Promise<number> {
  const separator = args.indexOf("--")
  const helpIndex = args.findIndex((arg) => arg === "--help" || arg === "-h")
  if (helpIndex >= 0 && (separator < 0 || helpIndex < separator)) {
    printHelp()
    return 0
  }

  let json = false
  let semantic = false
  let shell = defaultShell()
  let passthrough = false
  const commandParts: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!passthrough && arg === "--") {
      passthrough = true
      continue
    }
    if (!passthrough && arg === "--json") {
      json = true
      continue
    }
    if (!passthrough && arg === "--semantic") {
      semantic = true
      continue
    }
    if (!passthrough && arg === "--shell") {
      const next = args[index + 1]
      if (!next) throw new Error("--shell requires a value")
      shell = parseShell(next)
      index++
      continue
    }
    if (!passthrough && arg.startsWith("--shell=")) {
      shell = parseShell(arg.slice("--shell=".length))
      continue
    }
    commandParts.push(arg)
  }

  const command =
    commandParts.length > 0 ? commandParts.join(" ") : process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim()
  if (!command) throw new Error("Provide a command argument or pipe one on stdin")

  const assessment = await analyze(command, { shell, semantic })
  if (json) {
    process.stdout.write(JSON.stringify(assessment, null, 2) + "\n")
  } else {
    printAssessment(assessment)
  }
  return assessment.decision === "allow" ? 0 : 2
}

function printAssessment(assessment: Assessment): void {
  process.stdout.write(`Decision: ${assessment.decision.toUpperCase()}\n`)
  process.stdout.write(`Risk: ${assessment.risk.toUpperCase()}\n`)
  process.stdout.write(`Shell: ${assessment.shell}\n`)
  process.stdout.write(`Command: ${assessment.command}\n`)
  for (const finding of assessment.findings) {
    process.stdout.write(`- [${finding.risk}] ${finding.message} (${finding.evidence})\n`)
  }
  if (assessment.semantic) {
    process.stdout.write(
      `TypeSafe: dangerous=${assessment.semantic.dangerous.toFixed(3)} confirmation=${assessment.semantic.confirmation.toFixed(3)} risk=${assessment.semantic.riskScore.toFixed(3)} category=${assessment.semantic.category}\n`,
    )
  }
}

function printHelp(): void {
  process.stdout.write(`command-guard - detect risky shell commands without executing them\n\n`)
  process.stdout.write(
    `Usage:\n  command-guard [options] -- <command>\n  echo '<command>' | command-guard [options]\n\n`,
  )
  process.stdout.write(
    `Options:\n  --shell <name>  bash, powershell, cmd, or unknown (default: detected)\n  --semantic      add a TypeSafe Jev assessment; requires TYPESAFE_API_KEY\n  --json          print machine-readable JSON\n  -h, --help      show this help\n\n`,
  )
  process.stdout.write(`Exit codes:\n  0  allow\n  1  usage or TypeSafe error\n  2  review or block\n`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ error: message }) + "\n")
      else process.stderr.write(`command-guard: ${message}\n`)
      process.exitCode = 1
    },
  )
}
