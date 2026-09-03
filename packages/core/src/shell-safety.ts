export * as ShellSafety from "./shell-safety"

import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { Node, Tree } from "web-tree-sitter"
import { lazy } from "./util/lazy"

export type Kind = "bash" | "powershell" | "cmd"

export type Violation = {
  readonly operation: "recursive-delete"
  readonly target: string
  readonly reason: "root" | "home" | "working-directory" | "parent-directory" | "wildcard" | "dynamic"
}

export const PROCESS_SAFETY_GUIDANCE =
  "When starting background work, capture its PID or process group and stop that exact identifier. Avoid broad command-line or process-name matching such as `pkill -f`, `killall`, `taskkill /IM`, or wildcard PowerShell process selection because agent, task, and command text can also appear in TurenOS, sidecar, test-runner, or harness parent command lines."

export const blockedMessage = (violation: Violation) =>
  `Blocked dangerous recursive deletion of ${violation.target}. TurenOS only allows recursive shell deletion of a narrow literal child of the working directory or temporary directory, such as ./dist. Filesystem roots, home directories, working-directory roots, parent directories, wildcard roots, and targets that cannot be resolved statically are not allowed. Use the appropriate TurenOS file tool for other cleanup.`

export const kind = (shell: string): Kind => {
  const name = path
    .basename(shell)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  if (name === "powershell" || name === "pwsh") return "powershell"
  if (name === "cmd") return "cmd"
  return "bash"
}

type Part = {
  readonly type: string
  readonly text: string
  readonly changedDirectory?: boolean
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

const parsers = lazy(async () => {
  const { Language, Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  await Parser.init({ locateFile: () => resolveWasm(treeWasm) })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const [bashLanguage, psLanguage] = await Promise.all([
    Language.load(resolveWasm(bashWasm)),
    Language.load(resolveWasm(psWasm)),
  ])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const powershell = new Parser()
  powershell.setLanguage(psLanguage)
  return { bash, powershell }
})

const parseText = async (command: string, shell: Exclude<Kind, "cmd">) => {
  const tree = (await parsers())[shell].parse(command)
  if (!tree) throw new Error("Unable to parse shell command for safety validation")
  return tree
}

export const parse = Effect.fn("ShellSafety.parse")(function* (input: {
  readonly command: string
  readonly shell: Exclude<Kind, "cmd">
}) {
  return yield* Effect.promise(() => parseText(input.command, input.shell))
})

const parts = (node: Node): Part[] => {
  const output: Part[] = []
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let itemIndex = 0; itemIndex < child.childCount; itemIndex++) {
        const item = child.child(itemIndex)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        output.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "number" &&
      child.type !== "integer_literal" &&
      child.type !== "simple_expansion" &&
      child.type !== "expansion" &&
      child.type !== "command_substitution" &&
      child.type !== "process_substitution" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation" &&
      child.type !== "command_parameter"
    )
      continue
    output.push({ type: child.type, text: child.text })
  }
  return output
}

const unquote = (value: string) => {
  if (value.length < 2) return value
  const first = value[0]
  return (first === '"' || first === "'") && value.at(-1) === first ? value.slice(1, -1) : value
}

const executable = (value: string) =>
  path
    .basename(
      unquote(value)
        .replace(/'([^']*)'/g, "$1")
        .replace(/"([^"$`]*)"/g, "$1")
        .replace(/\^(.)/g, "$1")
        .replace(/\\(.)/g, "$1")
        .replaceAll("\\", "/"),
    )
    .replace(/\.exe$/i, "")
    .toLowerCase()

const windowsExecutable = (value: string) =>
  path.win32
    .basename(
      unquote(value)
        .replace(/'([^']*)'/g, "$1")
        .replace(/"([^"$`]*)"/g, "$1")
        .replace(/\^(.)/g, "$1")
        .replace(/`(.)/g, "$1"),
    )
    .replace(/\.exe$/i, "")
    .toLowerCase()

const cmdExecutable = (value: string) => windowsExecutable(value).replace(/^@+/, "").replace(/^\(+/, "")
const powerShellExecutable = (value: string) => windowsExecutable(value)
const cmdToken = (value: string) => unquote(value).replace(/\^(.)/g, "$1")
const recursiveCmd = (value: string) => cmdToken(value).toLowerCase().split("/").slice(1).includes("s")

const PREFIX = new Set(["builtin", "busybox", "command", "nohup", "setsid", "stdbuf"])
const SUDO_VALUE = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-t", "-T", "-u", "--chdir"])

const withDirectoryChange = (input: Part[], changedDirectory: boolean) => {
  if (!changedDirectory || !input[0]) return input
  return [{ ...input[0], changedDirectory: true }, ...input.slice(1)]
}

const command = (input: ReadonlyArray<Part>): Part[] => {
  let index = 0
  let changedDirectory = input[0]?.changedDirectory === true
  while (index < input.length) {
    const name = executable(input[index].text)
    if (name === "command" && input.slice(index + 1).some((part) => part.text === "-V" || part.text === "-v")) break
    if (name === "exec") {
      index++
      while (input[index]?.text.startsWith("-")) index += input[index].text === "-a" ? 2 : 1
      continue
    }
    if (name === "nice") {
      index++
      while (input[index]?.text.startsWith("-")) index += input[index].text === "-n" ? 2 : 1
      continue
    }
    if (name === "timeout") {
      index++
      while (input[index]?.text.startsWith("-")) {
        const flag = input[index].text
        index += flag === "-k" || flag === "-s" || flag === "--kill-after" || flag === "--signal" ? 2 : 1
      }
      if (input[index]) index++
      continue
    }
    if (name === "stdbuf") {
      index++
      while (input[index]?.text.startsWith("-"))
        index += input[index].text === "-e" || input[index].text === "-i" || input[index].text === "-o" ? 2 : 1
      continue
    }
    if (PREFIX.has(name)) {
      index++
      while (input[index]?.text.startsWith("-")) index++
      continue
    }
    if (name === "sudo" || name === "doas") {
      index++
      while (input[index]?.text.startsWith("-")) {
        const flag = input[index].text
        if (flag.startsWith("-D") || flag === "--chdir" || flag.startsWith("--chdir=")) changedDirectory = true
        index += SUDO_VALUE.has(flag) ? 2 : 1
      }
      continue
    }
    if (name === "env") {
      index++
      while (
        input[index] &&
        (input[index].text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(input[index].text))
      ) {
        const flag = input[index].text
        if (
          flag === "-C" ||
          flag.startsWith("-C") ||
          (/^-[^-]*C/.test(flag) && !flag.startsWith("-S")) ||
          flag === "--chdir" ||
          flag.startsWith("--chdir=")
        )
          changedDirectory = true
        if (flag.startsWith("--split-string="))
          return command(
            withDirectoryChange(
              [...lexicalParts(unquote(flag.slice("--split-string=".length))), ...input.slice(index + 1)],
              changedDirectory,
            ),
          )
        const splitIndex = flag.startsWith("-") && !flag.startsWith("--") ? flag.indexOf("S", 1) : -1
        if (splitIndex > 0) {
          const attached = flag.slice(splitIndex + 1)
          const source = attached || input[index + 1]?.text
          if (source)
            return command(
              withDirectoryChange(
                [...lexicalParts(unquote(source)), ...input.slice(index + (attached ? 1 : 2))],
                changedDirectory,
              ),
            )
        }
        if (flag.startsWith("-S") && flag !== "-S")
          return command(
            withDirectoryChange([...lexicalParts(unquote(flag.slice(2))), ...input.slice(index + 1)], changedDirectory),
          )
        if ((flag === "-S" || flag === "--split-string") && input[index + 1])
          return command(
            withDirectoryChange(
              [...lexicalParts(unquote(input[index + 1].text)), ...input.slice(index + 2)],
              changedDirectory,
            ),
          )
        index += new Set(["-C", "--chdir", "-u", "--unset"]).has(flag) || /^-[^-]*C$/.test(flag) ? 2 : 1
      }
      continue
    }
    break
  }
  return withDirectoryChange(input.slice(index), changedDirectory)
}

const recursiveRm = (input: ReadonlyArray<Part>) => {
  for (const part of input.slice(1)) {
    if (part.text === "--") return false
    if (
      part.text === "--recursive" ||
      part.text.startsWith("--r") ||
      /^-[^-]*[rR]/.test(part.text) ||
      (/[{}]/.test(part.text) && part.text.includes("-") && /[rR]/.test(part.text))
    )
      return true
  }
  return false
}

const powerShellToken = (value: string) => value.replace(/`(.)/g, "$1")

const recursivePowerShell = (input: ReadonlyArray<Part>) =>
  input
    .slice(1)
    .some((part) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/i.test(powerShellToken(part.text)))

const dynamicRecursivePowerShell = (input: ReadonlyArray<Part>) =>
  input
    .slice(1)
    .some((part) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?:(?!\$?true$)/i.test(powerShellToken(part.text)))

const quoted = (value: string) =>
  value.length > 1 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]

const same = (left: string, right: string, windows: boolean) =>
  windows ? left.toLowerCase() === right.toLowerCase() : left === right

const directChild = (target: string, base: string, api: typeof path.posix | typeof path.win32) => {
  const relative = api.relative(api.resolve(base), target)
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative) &&
    !relative.includes(api.sep)
  )
}

const POWERSHELL_VALUE_PARAMETERS = new Set([
  "-credential",
  "-erroraction",
  "-errorvariable",
  "-exclude",
  "-filter",
  "-include",
  "-informationaction",
  "-informationvariable",
  "-outbuffer",
  "-outvariable",
  "-pipelinevariable",
  "-progressaction",
  "-stream",
  "-warningaction",
  "-warningvariable",
])
const POWERSHELL_VALUE_ALIASES = new Set(["-ea", "-ev", "-ia", "-iv", "-ob", "-ov", "-pv", "-wa", "-wv"])
const powerShellValueParameter = (value: string) => {
  const flag = value.toLowerCase()
  if (POWERSHELL_VALUE_PARAMETERS.has(flag) || POWERSHELL_VALUE_ALIASES.has(flag)) return true
  if (flag.length < 5) return false
  return [...POWERSHELL_VALUE_PARAMETERS].filter((candidate) => candidate.startsWith(flag)).length === 1
}

const violation = (target: string, cwd: string, shell: Kind, literal = false): Violation | undefined => {
  const raw = target.trim()
  if (!raw) return { operation: "recursive-delete", target: "a dynamic input", reason: "dynamic" }
  const quote = quoted(raw) ? raw[0] : undefined
  let value = unquote(raw)
  if (shell === "powershell") {
    value = value.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, "")
    if (/^[A-Za-z]:($|[^\\/])/.test(value)) return { operation: "recursive-delete", target: raw, reason: "dynamic" }
    if (/^[A-Za-z]{2,}:(?![\\/])/.test(value)) return
  }
  if (shell === "powershell" && (value.startsWith("(") || value.startsWith("@(")))
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  if (
    quote !== "'" &&
    (value.includes("$") ||
      value.includes("`") ||
      (shell === "powershell" && /^@[A-Za-z_][A-Za-z0-9_:]*$/.test(value)) ||
      (shell === "cmd" && (/%(?:[^%]+%|[0-9A-Za-z*])/.test(value) || /![^!]+!/.test(value))))
  )
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  if (!literal && (shell !== "bash" || !quote) && /[*?\[\]{}]/.test(value))
    return { operation: "recursive-delete", target: raw, reason: "wildcard" }
  if ((shell === "powershell" || !quote) && value === "~")
    return { operation: "recursive-delete", target: raw, reason: "home" }
  if (!quote && (value === "~+" || value.startsWith("~+/") || value.startsWith("~+\\")))
    return { operation: "recursive-delete", target: raw, reason: "working-directory" }
  if (!quote && (value === "~-" || value.startsWith("~-/") || value.startsWith("~-\\")))
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  if (!quote && /^~[^\\/]/.test(value)) return { operation: "recursive-delete", target: raw, reason: "home" }
  if ((shell === "powershell" || !quote) && (value.startsWith("~/") || value.startsWith("~\\")))
    value = path.join(os.homedir(), value.slice(2))
  if (value === "." || value === "./" || value === ".\\")
    return { operation: "recursive-delete", target: raw, reason: "working-directory" }
  if (value.split(/[\\/]+/).includes(".."))
    return { operation: "recursive-delete", target: raw, reason: "parent-directory" }
  if (value === "/" || value === "//" || /^[A-Za-z]:[\\/]*$/.test(value) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(value))
    return { operation: "recursive-delete", target: raw, reason: "root" }

  const windows =
    shell === "cmd" ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(cwd) ||
    cwd.startsWith("\\\\")
  const api = windows ? path.win32 : path
  if (
    windows &&
    value.split(/[\\/]+/).some((component) => component !== "." && component !== ".." && /[ .]$/.test(component))
  )
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  if (!api.isAbsolute(value)) {
    const components = value.split(/[\\/]+/)
    const child = components[0] === "." ? components.slice(1) : components
    if (child.length !== 1 || child[0] === "" || /[\\/]$/.test(value))
      return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  }
  if (api.isAbsolute(value) && /[\\/]$/.test(value))
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  if (api.isAbsolute(value) && value.split(/[\\/]+/).includes("."))
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
  const base = windows && api.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(cwd) ? path.win32.dirname(value) : cwd
  const resolved = api.resolve(base, value)
  const root = api.parse(resolved).root
  if (same(resolved, root, windows)) return { operation: "recursive-delete", target: raw, reason: "root" }
  if (same(resolved, api.resolve(os.homedir()), windows))
    return { operation: "recursive-delete", target: raw, reason: "home" }
  if (same(resolved, api.resolve(cwd), windows))
    return { operation: "recursive-delete", target: raw, reason: "working-directory" }
  const relative = api.relative(resolved, api.resolve(cwd))
  if (relative && relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
    return { operation: "recursive-delete", target: raw, reason: "parent-directory" }
  const temporary = api.resolve(os.tmpdir())
  const systemTemporary = windows ? undefined : api.resolve("/tmp")
  if (
    !directChild(resolved, cwd, api) &&
    !directChild(resolved, temporary, api) &&
    (!systemTemporary || !directChild(resolved, systemTemporary, api))
  )
    return { operation: "recursive-delete", target: raw, reason: "dynamic" }
}

type Target = { readonly value: string; readonly literal: boolean }

const targets = (input: ReadonlyArray<Part>, shell: Kind): Target[] => {
  const output: Target[] = []
  let pathValue = false
  let literalPath = false
  let optionValue = false
  let options = true
  for (const part of input.slice(1)) {
    if (pathValue) {
      output.push({ value: part.text, literal: literalPath })
      pathValue = false
      literalPath = false
      continue
    }
    if (optionValue) {
      optionValue = false
      continue
    }
    if (part.text === "--") {
      options = false
      continue
    }
    if (options && part.text.startsWith("-")) {
      if (shell === "powershell" && /^-(?:literal)?path$/i.test(part.text)) {
        pathValue = true
        literalPath = /^-literalpath$/i.test(part.text)
      }
      if (shell === "powershell" && /^-lp$/i.test(part.text)) {
        pathValue = true
        literalPath = true
      }
      if (shell === "powershell" && powerShellValueParameter(part.text)) optionValue = true
      continue
    }
    output.push({ value: part.text, literal: false })
  }
  return output
}

const dynamicEvaluator = (value: string, shell: Kind) => {
  if (value.startsWith("'") && value.endsWith("'")) return false
  if (shell === "cmd") return /%(?:[^%]+%|[0-9A-Za-z*])|![^!]+!/.test(value)
  return (
    value.includes("$") ||
    value.includes("`") ||
    (shell === "powershell" && (/^@[A-Za-z_]/.test(unquote(value)) || value.startsWith("(") || value.startsWith("@(")))
  )
}

const WRAPPER_SCAN = new Set([
  "builtin",
  "busybox",
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "timeout",
])
// One list, because these names were previously spelled out in three places and
// drifted: `fish` was in none of them, so `fish -c "<recursive delete>"` walked
// straight through the interpreter defence that exists to stop exactly that.
// Anything that takes a command string on `-c` belongs here. Membership only
// decides whether the nested string is parsed and re-inspected, so an unusual
// dialect costs a redundant parse, while an omission costs the whole check.
const POSIX_SHELL = ["ash", "bash", "csh", "dash", "fish", "ksh", "mksh", "sh", "tcsh", "zsh"] as const
const WINDOWS_SHELL = ["cmd", "powershell", "pwsh"] as const

const WRAPPED_COMMAND = new Set<string>([...POSIX_SHELL, ...WINDOWS_SHELL, "find", "rm"])
const INTERPRETER = new Set<string>([...POSIX_SHELL, ...WINDOWS_SHELL])

const nested = (input: ReadonlyArray<Part>, shell: Kind) => {
  const name =
    shell === "cmd"
      ? cmdExecutable(input[0]?.text ?? "")
      : shell === "powershell"
        ? powerShellExecutable(input[0]?.text ?? "")
        : executable(input[0]?.text ?? "")
  const bash = new Set<string>([...POSIX_SHELL, "eval"])
  const powershell = new Set<string>(["powershell", "pwsh"])
  if (bash.has(name)) {
    if (name === "eval" && input[1]) {
      const values = input[1].text === "--" ? input.slice(2) : input.slice(1)
      return {
        command: values.map((part) => unquote(part.text)).join(" "),
        shell: "bash" as const,
        dynamic: values.some((part) => dynamicEvaluator(part.text, "bash")),
      }
    }
    const index = input.findIndex((part) => /^-[^-]*c/.test(part.text)) + 1
    if (index > 0 && input[index])
      return {
        command: unquote(input[index].text),
        shell: "bash" as const,
        dynamic: dynamicEvaluator(input[index].text, "bash"),
      }
    return {
      command: "",
      shell: "bash" as const,
      dynamic: true,
    }
  }
  if (powershell.has(name)) {
    if (input.slice(1).some((part) => "-encodedcommand".startsWith(powerShellToken(part.text).toLowerCase())))
      return {
        command: "",
        shell: "powershell" as const,
        dynamic: true,
      }
    const index =
      input.findIndex((part) => /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(powerShellToken(part.text))) + 1
    if (index > 0 && input[index]) {
      if (input[index].text === "-")
        return {
          command: "",
          shell: "powershell" as const,
          dynamic: true,
        }
      return {
        command: input
          .slice(index)
          .map((part) => unquote(part.text))
          .join(" "),
        shell: "powershell" as const,
        dynamic: input.slice(index).some((part) => dynamicEvaluator(part.text, "powershell")),
      }
    }
    return {
      command: "",
      shell: "powershell" as const,
      dynamic: true,
    }
  }
  if (name === "cmd") {
    const index = input.findIndex((part) => /^\/(?:c|k)$/i.test(cmdToken(part.text))) + 1
    if (index > 0 && input[index])
      return {
        command: unquote(
          input
            .slice(index)
            .map((part) => part.text)
            .join(" "),
        ),
        shell: "cmd" as const,
        dynamic: input.slice(index).some((part) => dynamicEvaluator(part.text, "cmd")),
      }
    return {
      command: "",
      shell: "cmd" as const,
      dynamic: true,
    }
  }
  if (shell === "powershell" && (name === "iex" || name === "invoke-expression")) {
    if (!input[1])
      return {
        command: "",
        shell: "powershell" as const,
        dynamic: true,
      }
    let index = 1
    while (powerShellToken(input[index]?.text ?? "").startsWith("-")) {
      if (/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(powerShellToken(input[index].text))) {
        index++
        break
      }
      index += powerShellValueParameter(powerShellToken(input[index].text)) ? 2 : 1
    }
    if (!input[index])
      return {
        command: "",
        shell: "powershell" as const,
        dynamic: true,
      }
    return {
      command: unquote(input[index].text),
      shell: "powershell" as const,
      dynamic: dynamicEvaluator(input[index].text, "powershell"),
    }
  }
  if (name === "xargs") {
    const index = input.findIndex(
      (part, partIndex) =>
        partIndex > 0 && new Set(["bash", "dash", "sh", "zsh", "powershell", "pwsh"]).has(executable(part.text)),
    )
    if (index > 0) return nested(input.slice(index), shell)
  }
}

const inspectParts = (input: ReadonlyArray<Part>, cwd: string, shell: Kind): Violation | undefined => {
  const wrapper = executable(input[0]?.text ?? "")
  const commandQuery = wrapper === "command" && input.slice(1).some((part) => part.text === "-V" || part.text === "-v")
  if (WRAPPER_SCAN.has(wrapper) && !commandQuery) {
    const index = input.findIndex((part, partIndex) => partIndex > 0 && WRAPPED_COMMAND.has(executable(part.text)))
    if (index > 0) {
      if (INTERPRETER.has(executable(input[index].text)))
        return { operation: "recursive-delete", target: "dynamic evaluator input", reason: "dynamic" }
      const result = inspectParts(input.slice(index), cwd, shell)
      if (result) return result
    }
  }
  const list = command(input)
  const name = shell === "powershell" ? powerShellExecutable(list[0]?.text ?? "") : executable(list[0]?.text ?? "")
  const dynamicName =
    list[0]?.type === "command_name_expr" ||
    list[0]?.type === "command_substitution" ||
    list[0]?.text.startsWith("(") ||
    list[0]?.text.includes("$") ||
    list[0]?.text.includes("`") ||
    /[*?\[]/.test(list[0]?.text ?? "")
  const braceCommand = /[{}]/.test(list[0]?.text ?? "")
  const braceRm = braceCommand && /r.*m/i.test(list[0]!.text)
  const braceRecursive =
    braceRm &&
    ((list[0]!.text.includes("-") && /[rR]/.test(list[0]!.text)) ||
      list.slice(1).some((part) => part.text.includes("-") && /[rR]/.test(part.text)))
  if (list[0]?.changedDirectory && (recursiveRm(list) || recursivePowerShell(list) || braceRecursive))
    return { operation: "recursive-delete", target: "target after a directory change", reason: "dynamic" }
  if (braceRecursive) {
    const result = list
      .slice(1)
      .map((part) => violation(part.text, cwd, shell))
      .find((item) => item !== undefined)
    if (result) return result
  }
  if (
    (dynamicName || /^@[A-Za-z_]/.test(unquote(list[0]?.text ?? ""))) &&
    (recursiveRm(list) || recursivePowerShell(list))
  ) {
    const result = targets(list, shell)
      .map((target) => violation(target.value, cwd, shell, target.literal))
      .find((item) => item !== undefined)
    if (result) return result
  }
  if (dynamicName && (recursiveRm(list) || recursivePowerShell(list)))
    return { operation: "recursive-delete", target: "dynamic command input", reason: "dynamic" }
  const nativeRm =
    name === "rm" && (/[\\/]/.test(unquote(list[0]?.text ?? "")) || /\.exe["']?$/i.test(list[0]?.text ?? ""))
  if (nativeRm) {
    const values = targets(list, "bash")
    if (!recursiveRm(list)) {
      if (
        list
          .slice(1)
          .some(
            (part) =>
              dynamicEvaluator(part.text, "bash") || (part.text.startsWith("-") && /[*?\[\]{}]/.test(part.text)),
          ) &&
        values.some((target) => violation(target.value, cwd, "bash", target.literal))
      )
        return { operation: "recursive-delete", target: "dynamic recursion switch", reason: "dynamic" }
      return
    }
    return values
      .map((target) => violation(target.value, cwd, "bash", target.literal))
      .find((item) => item !== undefined)
  }
  if (
    (shell === "powershell" && new Set(["del", "erase", "rd", "remove-item", "ri", "rm", "rmdir"]).has(name)) ||
    name === "remove-item"
  ) {
    const splatted = list.slice(1).some((part) => /^@[A-Za-z_][A-Za-z0-9_:]*$/.test(unquote(part.text)))
    if (!recursivePowerShell(list) && !dynamicRecursivePowerShell(list)) {
      if (splatted) return { operation: "recursive-delete", target: "dynamic recursion switch", reason: "dynamic" }
      return
    }
    const values = targets(list, "powershell")
    if (values.length === 0)
      return { operation: "recursive-delete", target: "pipeline or dynamic input", reason: "dynamic" }
    if (dynamicRecursivePowerShell(list))
      return { operation: "recursive-delete", target: "dynamic recursion switch", reason: "dynamic" }
    return values
      .map((target) => violation(target.value, cwd, "powershell", target.literal))
      .find((item) => item !== undefined)
  }
  if (name === "rm") {
    const values = targets(list, "bash")
    if (!recursiveRm(list)) {
      if (
        list
          .slice(1)
          .some(
            (part) =>
              dynamicEvaluator(part.text, "bash") || (part.text.startsWith("-") && /[*?\[\]{}]/.test(part.text)),
          ) &&
        values.some((target) => violation(target.value, cwd, "bash", target.literal))
      )
        return { operation: "recursive-delete", target: "dynamic recursion switch", reason: "dynamic" }
      return
    }
    return values
      .map((target) => violation(target.value, cwd, "bash", target.literal))
      .find((item) => item !== undefined)
  }
  if (name === "xargs") {
    const index = list.findIndex((part) => executable(part.text) === "rm")
    if (index > 0 && recursiveRm(list.slice(index)))
      return { operation: "recursive-delete", target: "xargs input", reason: "dynamic" }
    if (list.some((part) => executable(part.text) === "find"))
      return { operation: "recursive-delete", target: "xargs input", reason: "dynamic" }
  }
  if (name === "find") {
    const destructive =
      list.some((part) => part.text === "-delete") || list.some((part) => /^-exec(?:dir)?$/.test(part.text))
    if (destructive) return { operation: "recursive-delete", target: "find traversal", reason: "dynamic" }
  }
}

const CWD_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const recursiveCandidate = (input: ReadonlyArray<Part>, shell: Exclude<Kind, "cmd">) => {
  const list = command(input)
  const name = shell === "powershell" ? powerShellExecutable(list[0]?.text ?? "") : executable(list[0]?.text ?? "")
  if (name === "rm") return recursiveRm(list) || list.slice(1).some((part) => dynamicEvaluator(part.text, "bash"))
  if (shell === "powershell" && new Set(["del", "erase", "rd", "remove-item", "ri", "rm", "rmdir"]).has(name))
    return recursivePowerShell(list) || dynamicRecursivePowerShell(list)
  if (name === "find")
    return (
      list.some((part) => part.text === "-delete") ||
      list.some((part, index) => executable(part.text) === "rm" && recursiveRm(list.slice(index)))
    )
  return (
    name === "xargs" && list.some((part, index) => executable(part.text) === "rm" && recursiveRm(list.slice(index)))
  )
}

const splitCommands = (value: string) => {
  const output: string[] = []
  let start = 0
  let quote = ""
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '"' && value[index - 1] !== "^") quote = quote === char ? "" : quote || char
    if (quote || (char !== "&" && char !== "|" && char !== ";" && char !== "\n" && char !== "\r")) continue
    output.push(value.slice(start, index))
    start = index + 1
  }
  output.push(value.slice(start))
  return output.filter((item) => item.trim())
}

const lexicalParts = (value: string): Part[] =>
  (value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((text) => ({ type: "word", text }))

const inspectCmd = async (value: string, cwd: string, depth: number): Promise<Violation | undefined> => {
  let changedDirectory = false
  for (const segment of splitCommands(value)) {
    const original = lexicalParts(segment).map((part) => ({
      ...part,
      text: part.text.replace(/^\(+/, "").replace(/\)+$/, ""),
    }))
    const control = new Set(["cd", "chdir", "del", "erase", "rd", "rmdir"])
    const controlIndex = new Set(["for", "if"]).has(cmdExecutable(original[0]?.text ?? ""))
      ? original.findIndex((part, index) => index > 0 && control.has(cmdExecutable(part.text)))
      : -1
    const controlled = controlIndex > 0 ? original.slice(controlIndex) : original
    const list =
      cmdExecutable(controlled[0]?.text ?? "") === "call" ? command(controlled.slice(1)) : command(controlled)
    const name = cmdExecutable(list[0]?.text ?? "")
    if (name === "cd" || name === "chdir" || name === "popd" || name === "pushd") {
      changedDirectory = true
      continue
    }
    const childShell = new Set(["bash", "dash", "ksh", "sh", "zsh"]).has(name)
      ? ("bash" as const)
      : new Set(["powershell", "pwsh"]).has(name)
        ? ("powershell" as const)
        : name === "cmd"
          ? ("cmd" as const)
          : undefined
    if (childShell) {
      const child = nested(list, childShell)
      if (child) {
        if (child.dynamic)
          return { operation: "recursive-delete", target: "dynamic evaluator input", reason: "dynamic" }
        const result = await inspectText(child.command, cwd, child.shell, depth + 1)
        if (result) return result
      }
    }
    if (name === "start") {
      if (list.slice(1).some((part) => dynamicEvaluator(part.text, "cmd")))
        return { operation: "recursive-delete", target: "dynamic evaluator input", reason: "dynamic" }
      const index = list.findIndex(
        (part, partIndex) =>
          partIndex > 0 &&
          new Set(["cmd", "del", "erase", "powershell", "pwsh", "rd", "rmdir"]).has(cmdExecutable(part.text)),
      )
      if (index > 0) {
        const childName = cmdExecutable(list[index].text)
        const childCommand = list
          .slice(index)
          .map((part) => part.text)
          .join(" ")
        const result = new Set(["powershell", "pwsh"]).has(childName)
          ? await inspectText(childCommand, cwd, "powershell", depth + 1)
          : await inspectCmd(childCommand, cwd, depth + 1)
        if (result) return result
      }
    }
    const deleteCommand = new Set(["del", "erase", "rd", "rmdir"]).has(name)
    const dynamicCommand = /%(?:[^%]+%|[0-9A-Za-z*])|![^!]+!/.test(list[0]?.text ?? "")
    if (!deleteCommand && !dynamicCommand) continue
    if (dynamicCommand && list.slice(1).some((part) => recursiveCmd(part.text)))
      return { operation: "recursive-delete", target: "dynamic command or recursion switch", reason: "dynamic" }
    if (list.slice(1).some((part) => /%(?:[^%]+%|[0-9A-Za-z*])|![^!]+!/.test(part.text)))
      return { operation: "recursive-delete", target: "dynamic command or recursion switch", reason: "dynamic" }
    if (!deleteCommand) continue
    if (!list.slice(1).some((part) => recursiveCmd(part.text))) continue
    if (changedDirectory)
      return { operation: "recursive-delete", target: "target after a directory change", reason: "dynamic" }
    const values = list
      .slice(1)
      .filter((part) => !cmdToken(part.text).startsWith("/"))
      .map((part) => part.text)
    if (values.length === 0) return { operation: "recursive-delete", target: "a dynamic input", reason: "dynamic" }
    for (const target of values) {
      const result = violation(target, cwd, "cmd")
      if (result) return result
    }
  }
}

const inspectRoot = async (
  root: Node,
  cwd: string,
  shell: Exclude<Kind, "cmd">,
  depth: number,
): Promise<Violation | undefined> => {
  let changedDirectory = false
  for (const node of root.descendantsOfType("command").filter((item): item is Node => item !== null)) {
    const list = parts(node)
    const normalized = command(list)
    if (
      CWD_COMMANDS.has(
        shell === "powershell"
          ? powerShellExecutable(normalized[0]?.text ?? "")
          : executable(normalized[0]?.text ?? ""),
      )
    ) {
      changedDirectory = true
      continue
    }
    const result = inspectParts(list, cwd, shell)
    if (result) return result
    if (changedDirectory && recursiveCandidate(list, shell))
      return { operation: "recursive-delete", target: "target after a directory change", reason: "dynamic" }
    const child = nested(command(list), shell)
    if (!child) continue
    if (child.dynamic) return { operation: "recursive-delete", target: "dynamic evaluator input", reason: "dynamic" }
    const nestedResult = await inspectText(child.command, cwd, child.shell, depth + 1)
    if (nestedResult) return nestedResult
  }
}

export const inspectParsed = Effect.fn("ShellSafety.inspectParsed")(function* (input: {
  readonly tree: Tree
  readonly cwd: string
  readonly shell: Exclude<Kind, "cmd">
}) {
  return yield* Effect.promise(() => inspectRoot(input.tree.rootNode, input.cwd, input.shell, 0))
})

const inspectText = async (value: string, cwd: string, shell: Kind, depth: number): Promise<Violation | undefined> => {
  if (depth > 4) return { operation: "recursive-delete", target: "nested dynamic input", reason: "dynamic" }
  if (shell === "cmd") return inspectCmd(value, cwd, depth)
  const tree = await parseText(value, shell)
  const result = await inspectRoot(tree.rootNode, cwd, shell, depth)
  tree.delete()
  return result
}

export const inspect = Effect.fn("ShellSafety.inspect")(function* (input: {
  readonly command: string
  readonly cwd: string
  readonly shell: Kind
}) {
  return yield* Effect.promise(() => inspectText(input.command, input.cwd, input.shell, 0))
})
