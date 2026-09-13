export * as ShellToolRouting from "./shell-tool-routing"

import path from "node:path"
import { Effect } from "effect"
import type { Node, Tree } from "web-tree-sitter"
import { ShellSafety } from "./shell-safety"

export type Tool = "grep" | "glob" | "edit" | "apply_patch"

export type Recommendation = {
  readonly tool: Tool
  readonly reason: "workspace-search" | "workspace-mutation"
}

export const blockedMessage = (recommendation: Recommendation) => {
  if (recommendation.tool === "grep")
    return "This command is a workspace content search. Use the grep tool instead so search stays bounded, permissioned, and structured. The shell command was not executed."
  if (recommendation.tool === "glob")
    return "This command searches for workspace files. Use the glob tool instead so discovery stays bounded, permissioned, and structured. The shell command was not executed."
  if (recommendation.tool === "edit")
    return "This command mutates workspace text. Use the edit tool for an exact replacement, or apply_patch for a coordinated change. The shell command was not executed."
  return "This command mutates workspace files. Use apply_patch for additions, deletions, or coordinated updates instead. The shell command was not executed."
}

const unquote = (value: string) => {
  if (value.length < 2) return value
  const first = value[0]
  return (first === '"' || first === "'") && value.at(-1) === first ? value.slice(1, -1) : value
}

const executable = (value: string) =>
  path
    .basename(unquote(value).replaceAll("\\", "/"))
    .replace(/\.exe$/i, "")
    .toLowerCase()

const tokens = (value: string) => (value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(unquote)

const command = (node: Node) => {
  const input = tokens(node.text)
  let index = 0
  while (index < input.length) {
    const name = executable(input[index] ?? "")
    if (new Set(["builtin", "command", "nohup"]).has(name)) {
      index++
      while (input[index]?.startsWith("-")) index++
      continue
    }
    if (name === "env") {
      index++
      while (input[index] && (input[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(input[index]!))) index++
      continue
    }
    break
  }
  return { name: executable(input[index] ?? ""), args: input.slice(index + 1) }
}

const commandTokens = (value: string) => {
  const input = tokens(value)
  return { name: executable(input[0] ?? "").replace(/^@+/, ""), args: input.slice(1) }
}

const pipelineInput = (node: Node) => {
  let parent = node.parent
  while (parent && parent.type !== "pipeline" && parent.type !== "program") parent = parent.parent
  if (parent?.type !== "pipeline") return false
  const commands = parent.descendantsOfType("command").filter((item): item is Node => item !== null)
  return commands.findIndex((item) => item.startIndex === node.startIndex && item.endIndex === node.endIndex) > 0
}

const recursiveGrep = (args: ReadonlyArray<string>) =>
  args.some((arg) => arg === "--recursive" || arg === "--dereference-recursive" || /^-[^-]*[rR]/.test(arg))

const grepHasFile = (args: ReadonlyArray<string>) => {
  let positional = 0
  let optionValue = false
  for (const arg of args) {
    if (optionValue) {
      optionValue = false
      continue
    }
    if (new Set(["-e", "--regexp", "-f", "--file", "--include", "--exclude", "--exclude-dir"]).has(arg)) {
      optionValue = true
      continue
    }
    if (arg.startsWith("-")) continue
    positional++
  }
  return positional >= 2
}

const informational = (args: ReadonlyArray<string>) => args.some((arg) => arg === "--help" || arg === "--version")

const searchArguments = (args: ReadonlyArray<string>, values: ReadonlySet<string>, patterns: ReadonlySet<string>) => {
  const positional: string[] = []
  let optionValue: string | undefined
  let explicitPattern = false
  for (const arg of args) {
    if (optionValue) {
      if (patterns.has(optionValue)) explicitPattern = true
      optionValue = undefined
      continue
    }
    if (values.has(arg)) {
      optionValue = arg
      continue
    }
    if (arg.startsWith("-")) continue
    positional.push(arg)
  }
  return { positional, explicitPattern }
}

const workspaceTarget = (cwd: string, target: string) => {
  const relative = path.relative(cwd, path.resolve(cwd, target))
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const RG_VALUES = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-g",
  "--glob",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-j",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "--encoding",
  "--engine",
  "--ignore-file",
  "--max-count",
  "-m",
  "--max-depth",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
])
const GREP_VALUES = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-m",
  "--max-count",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--binary-files",
  "--color",
  "--label",
])

const rgWorkspaceSearch = (args: ReadonlyArray<string>, cwd: string) => {
  const parsed = searchArguments(args, RG_VALUES, new Set(["-e", "--regexp", "-f", "--file"]))
  if (args.includes("--files")) {
    return parsed.positional.length === 0 || parsed.positional.some((target) => workspaceTarget(cwd, target))
  }
  const targets = parsed.explicitPattern ? parsed.positional : parsed.positional.slice(1)
  return targets.length === 0 || targets.some((target) => workspaceTarget(cwd, target))
}

const grepWorkspaceSearch = (args: ReadonlyArray<string>, cwd: string) => {
  const parsed = searchArguments(args, GREP_VALUES, new Set(["-e", "--regexp", "-f", "--file"]))
  const targets = parsed.explicitPattern ? parsed.positional : parsed.positional.slice(1)
  if (targets.length === 0) return recursiveGrep(args)
  return targets.some((target) => workspaceTarget(cwd, target))
}

const findWorkspaceSearch = (args: ReadonlyArray<string>, cwd: string) => {
  const roots = args.filter((arg) => !arg.startsWith("-") && !new Set(["!", "(", ")"]).has(arg))
  if (roots.length === 0) return true
  return workspaceTarget(cwd, roots[0]!)
}

const searchRecommendation = (
  node: Node,
  name: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Recommendation | undefined => {
  if (pipelineInput(node)) return
  if (name === "git" && args[0] === "grep") return { tool: "grep", reason: "workspace-search" }
  if (name === "rg" && !informational(args) && rgWorkspaceSearch(args, cwd))
    return { tool: args.includes("--files") ? "glob" : "grep", reason: "workspace-search" }
  if (
    name === "grep" &&
    !informational(args) &&
    (recursiveGrep(args) || grepHasFile(args)) &&
    grepWorkspaceSearch(args, cwd)
  )
    return { tool: "grep", reason: "workspace-search" }
  if (
    name === "find" &&
    !informational(args) &&
    !args.some((arg) => new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]).has(arg)) &&
    findWorkspaceSearch(args, cwd)
  )
    return { tool: "glob", reason: "workspace-search" }
}

const mutationRecommendation = (name: string, args: ReadonlyArray<string>): Recommendation | undefined => {
  if (name === "apply_patch") return { tool: "apply_patch", reason: "workspace-mutation" }
  if (name === "sed" && args.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-i/.test(arg)))
    return { tool: "edit", reason: "workspace-mutation" }
  if (
    name === "perl" &&
    args.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[^-]*i/.test(arg))
  )
    return { tool: "edit", reason: "workspace-mutation" }
  if (new Set(["set-content", "add-content", "out-file"]).has(name))
    return { tool: "edit", reason: "workspace-mutation" }
}

const within = (cwd: string, target: string) => {
  if (!target || target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr") return false
  const relative = path.relative(cwd, path.resolve(cwd, unquote(target)))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const redirectsWorkspace = (node: Node, cwd: string) => {
  const parent = node.parent?.type === "redirected_statement" ? node.parent : undefined
  if (!parent) return false
  return parent.descendantsOfType("file_redirect").some((redirect) => {
    const target = redirect?.text.match(/^\s*\d*>>?\s*(.+)$/)?.[1]
    return target && !target.startsWith("&") ? within(cwd, target) : false
  })
}

const inspectCommand = (node: Node, cwd: string) => {
  const input = command(node)
  const mutation = mutationRecommendation(input.name, input.args)
  if (mutation) return mutation
  if (input.name === "tee" && input.args.some((arg) => !arg.startsWith("-") && within(cwd, arg)))
    return { tool: "apply_patch", reason: "workspace-mutation" } as const
  if (new Set(["cat", "echo", "printf"]).has(input.name) && redirectsWorkspace(node, cwd))
    return { tool: "apply_patch", reason: "workspace-mutation" } as const
  return searchRecommendation(node, input.name, input.args, cwd)
}

export const inspectParsed = (input: { readonly tree: Tree; readonly cwd: string }) => {
  for (const node of input.tree.rootNode.descendantsOfType("command")) {
    if (!node) continue
    const recommendation = inspectCommand(node, input.cwd)
    if (recommendation) return recommendation
  }
}

const inspectCmd = (value: string, cwd: string): Recommendation | undefined => {
  for (const segment of value.split(/(?:&&|&|\|\||\r?\n)/).filter((item) => item.trim())) {
    const input = commandTokens(segment.trim().replace(/^\(+/, "").replace(/\)+$/, ""))
    if (input.name === "git" && input.args[0] === "grep") return { tool: "grep", reason: "workspace-search" }
    if (input.name === "rg" && !informational(input.args) && rgWorkspaceSearch(input.args, cwd))
      return { tool: input.args.includes("--files") ? "glob" : "grep", reason: "workspace-search" }
    if (input.name === "find" && !informational(input.args) && findWorkspaceSearch(input.args, cwd))
      return { tool: "glob", reason: "workspace-search" }
    if (new Set(["set-content", "add-content", "out-file"]).has(input.name))
      return { tool: "edit", reason: "workspace-mutation" }
    if (new Set(["echo", "type"]).has(input.name)) {
      const target = segment.match(/>>?\s*(?!&)([^\s]+)\s*$/)?.[1]
      if (target && within(cwd, target)) return { tool: "edit", reason: "workspace-mutation" }
    }
  }
}

export const inspect = Effect.fn("ShellToolRouting.inspect")(function* (input: {
  readonly command: string
  readonly cwd: string
  readonly shell: ShellSafety.Kind
}) {
  if (input.shell === "cmd") return inspectCmd(input.command, input.cwd)
  const tree = yield* ShellSafety.parse({ command: input.command, shell: input.shell })
  try {
    return inspectParsed({ tree, cwd: input.cwd })
  } finally {
    tree.delete()
  }
})

/**
 * The patch text when the command is exactly `apply_patch <<DELIM ... DELIM`
 * — no args, no chaining, no pipes. Codex-trained models emit this form; the
 * bash tool routes it through the real patch pipeline instead of executing a
 * binary that may not exist or bypassing permission and diff tracking.
 */
export const patchHeredoc = Effect.fn("ShellToolRouting.patchHeredoc")(function* (input: {
  readonly command: string
  readonly shell: ShellSafety.Kind
}) {
  if (input.shell === "cmd") return
  const tree = yield* ShellSafety.parse({ command: input.command, shell: input.shell })
  try {
    const root = tree.rootNode
    if (root.childCount !== 1 || root.child(0)?.type !== "redirected_statement") return
    const stmt = root.child(0)!
    let cmd: Node | undefined
    let redirect: Node | undefined
    for (let index = 0; index < stmt.childCount; index++) {
      const child = stmt.child(index)!
      if (child.type === "command") cmd = child
      else if (child.type === "heredoc_redirect") redirect = child
      else return
    }
    if (!cmd || !redirect) return
    // exactly `apply_patch`, no arguments
    if (cmd.childCount !== 1 || cmd.child(0)?.type !== "command_name") return
    if (executable(cmd.child(0)!.text) !== "apply_patch") return
    const start = redirect.descendantsOfType("heredoc_start")[0]
    const end = redirect.descendantsOfType("heredoc_end")[0]
    if (!start || !end) return
    const bodyStart = input.command.indexOf("\n", start.endIndex)
    if (bodyStart === -1) return
    const bodyEnd = input.command.lastIndexOf("\n", end.startIndex - 1)
    if (bodyEnd < bodyStart) return
    const body = input.command.slice(bodyStart + 1, bodyEnd)
    // `<<-` strips leading tabs from every line, shell-style
    return redirect.text.startsWith("<<-")
      ? body
          .split("\n")
          .map((line) => line.replace(/^\t+/, ""))
          .join("\n")
      : body
  } finally {
    tree.delete()
  }
})
