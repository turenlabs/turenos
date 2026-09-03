import { expect, test, mock, afterAll } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BatouPlugin, fileChangesFor, type BatouPluginDeps } from "@/plugin/batou"

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "/repo",
  worktree: "/repo",
  experimental_workspace: { register() {} },
  serverUrl: new URL("https://example.com"),
  $: {} as never,
}

// --- Scan-result builders (shape: { exitCode, timedOut, output }) ---

/** Enterprise/managed build: permissionDecision:"deny" in the JSON, exit 0. */
function denyJson(reason: string, exitCode = 0) {
  return {
    exitCode,
    timedOut: false,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    },
  }
}

/** Public v2.0.0 build: permissionDecision:"allow" but a block signalled via exit 2. */
function exit2Block(context: string, permissionDecisionReason?: string) {
  return {
    exitCode: 2,
    timedOut: false,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow" as const,
        ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
        additionalContext: context,
      },
    },
  }
}

/** An allow with some additionalContext, at an arbitrary exit code. */
function allowJson(context: string, exitCode = 0) {
  return {
    exitCode,
    timedOut: false,
    output: {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        permissionDecision: "allow" as const,
        additionalContext: context,
      },
    },
  }
}

/** Ran but stdout could not be parsed into a decision. */
function unparseable(exitCode: number) {
  return { exitCode, timedOut: false, output: undefined }
}

function timedOut() {
  return { exitCode: 1, timedOut: true, output: undefined }
}

/** BatouPlugin with binary resolution stubbed to a fixed path and injectable spawn. */
function makePlugin(overrides: Partial<BatouPluginDeps> = {}, enabled = true) {
  const deps: BatouPluginDeps = {
    isEnabled: async () => enabled,
    ensureBinary: async () => "/usr/bin/batou",
    resolveBinary: async () => "/usr/bin/batou",
    logger: () => {},
    ...overrides,
  }
  return BatouPlugin(pluginInput, deps)
}

const writeArgs = { filePath: "/repo/app.ts", content: "const x = 1" }
const beforeInput = { tool: "write", sessionID: "s", callID: "c" }

test("file changes accept V2 write and edit path inputs", () => {
  expect(fileChangesFor("write", { path: "src/app.ts", content: "const x = 1" }, "/repo")).toEqual([
    {
      toolName: "Write",
      filePath: "src/app.ts",
      toolInput: { file_path: "src/app.ts", content: "const x = 1" },
    },
  ])
  expect(fileChangesFor("edit", { path: "src/app.ts", oldString: "1", newString: "2" }, "/repo")).toEqual([
    {
      toolName: "Edit",
      filePath: "src/app.ts",
      toolInput: { file_path: "src/app.ts", old_string: "1", new_string: "2" },
    },
  ])
})

// --- deny/allow via JSON (enterprise build) ---

test("deny in JSON aborts the write with a model-actionable reason", async () => {
  const spawn = mock(async () => denyJson("hardcoded AWS secret detected"))
  const hooks = makePlugin({ spawnBatou: spawn })
  await expect(hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })).rejects.toThrow(
    /Batou blocked this write of \/repo\/app\.ts.*hardcoded AWS secret detected/s,
  )
  expect(spawn).toHaveBeenCalledTimes(1)
})

test("allow (exit 0) lets the write proceed", async () => {
  const spawn = mock(async () => allowJson("=== Batou ===\nNo security issues detected"))
  const hooks = makePlugin({ spawnBatou: spawn })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(spawn).toHaveBeenCalledTimes(1)
})

// --- exit code 2 (public build) ---

test("exit code 2 with allow-JSON blocks, passing additionalContext through as the reason", async () => {
  const block =
    "=== Batou ===\nBatou BLOCKED WRITE: user_input flows to exec()\nACTION: Rewrite the code to avoid shelling out with untrusted input.\n=== End Batou ==="
  const spawn = mock(async () => exit2Block(block))
  const hooks = makePlugin({ spawnBatou: spawn })
  await expect(hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })).rejects.toThrow(/Batou BLOCKED WRITE/)
  try {
    await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
    throw new Error("should have blocked")
  } catch (error) {
    expect((error as Error).message).toContain("ACTION: Rewrite the code")
  }
})

test("exit code 2 prefers a meaningful permissionDecisionReason over additionalContext", async () => {
  const spawn = mock(async () => exit2Block("full taint dump here", "SQL injection via string concatenation"))
  const hooks = makePlugin({ spawnBatou: spawn })
  try {
    await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
    throw new Error("should have blocked")
  } catch (error) {
    expect((error as Error).message).toContain("SQL injection via string concatenation")
    expect((error as Error).message).not.toContain("full taint dump here")
  }
})

test("exit code 2 with unparseable output fails open (cannot distinguish block from crash)", async () => {
  const spawn = mock(async () => unparseable(2))
  const logs: string[] = []
  const hooks = makePlugin({ spawnBatou: spawn, logger: (m) => logs.push(m) })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(logs.some((m) => m.includes("exited 2 with unparseable"))).toBe(true)
})

test("nonzero exit other than 2 with allow-JSON does not block", async () => {
  const spawn = mock(async () => allowJson("advisory: minor style issue", 3))
  const hooks = makePlugin({ spawnBatou: spawn })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(spawn).toHaveBeenCalledTimes(1)
})

test("a timeout fails open and does not block", async () => {
  const spawn = mock(async () => timedOut())
  const logs: string[] = []
  const hooks = makePlugin({ spawnBatou: spawn, logger: (m) => logs.push(m) })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(logs.some((m) => m.includes("timed out"))).toBe(true)
})

// --- after-hook (advisory) ---

test("after-hook appends advisory findings to the tool output", async () => {
  const note = "=== Batou [/repo/app.ts] ===\n1. [WARN] weak hash used\n=== End Batou ==="
  const spawn = mock(async () => allowJson(note))
  const hooks = makePlugin({ spawnBatou: spawn })
  const output = { title: "app.ts", output: "Wrote file successfully.", metadata: {} }
  await hooks["tool.execute.after"]!({ ...beforeInput, args: writeArgs }, output)
  expect(output.output).toContain("Wrote file successfully.")
  expect(output.output).toContain("weak hash used")
})

test("one tool call reuses its pre-write scan for post-write advice", async () => {
  const spawn = mock(async () => allowJson("Potential SQL injection"))
  const hooks = makePlugin({ spawnBatou: spawn })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  const output = { title: "app.ts", output: "Wrote file successfully.", metadata: {} }
  await hooks["tool.execute.after"]!({ ...beforeInput, args: writeArgs }, output)

  expect(spawn).toHaveBeenCalledTimes(1)
  expect(output.output).toContain("Potential SQL injection")
})

test("after-hook surfaces advisory findings even at a nonzero exit code", async () => {
  const spawn = mock(async () => allowJson("=== Batou ===\nadvisory: TODO left in code", 1))
  const hooks = makePlugin({ spawnBatou: spawn })
  const output = { title: "app.ts", output: "Wrote file successfully.", metadata: {} }
  await hooks["tool.execute.after"]!({ ...beforeInput, args: writeArgs }, output)
  expect(output.output).toContain("advisory: TODO left in code")
})

test("after-hook skips the clean 'No security issues detected' note", async () => {
  const spawn = mock(async () => allowJson("=== Batou ===\nNo security issues detected. Code looks clean."))
  const hooks = makePlugin({ spawnBatou: spawn })
  const output = { title: "app.ts", output: "Wrote file successfully.", metadata: {} }
  await hooks["tool.execute.after"]!({ ...beforeInput, args: writeArgs }, output)
  expect(output.output).toBe("Wrote file successfully.")
})

// --- gating: enabled / binary / tool ---

test("disabled integration never resolves a binary or spawns", async () => {
  const spawn = mock(async () => denyJson("should not run"))
  const ensure = mock(async () => "/usr/bin/batou")
  const hooks = makePlugin({ spawnBatou: spawn, ensureBinary: ensure }, false)
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(ensure).toHaveBeenCalledTimes(0)
  expect(spawn).toHaveBeenCalledTimes(0)
})

test("Storage authority disables Batou even if stale config would enable it", async () => {
  const spawn = mock(async () => denyJson("should not run"))
  const isEnabled = mock(async () => false)
  const hooks = makePlugin({ spawnBatou: spawn, isEnabled })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(isEnabled).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledTimes(0)
})

test("missing binary fails open: no spawn, no throw", async () => {
  const spawn = mock(async () => denyJson("should not run"))
  const hooks = makePlugin({ spawnBatou: spawn, ensureBinary: async () => undefined })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(spawn).toHaveBeenCalledTimes(0)
})

test("exit 0 with unparseable output fails open (allows the write)", async () => {
  const spawn = mock(async () => unparseable(0))
  const hooks = makePlugin({ spawnBatou: spawn })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(spawn).toHaveBeenCalledTimes(1)
})

test("a thrown scanner error fails open instead of blocking", async () => {
  const spawn = mock(async () => {
    throw new Error("spawn exploded")
  })
  const logs: string[] = []
  const hooks = makePlugin({ spawnBatou: spawn, logger: (m) => logs.push(m) })
  await hooks["tool.execute.before"]!(beforeInput, { args: writeArgs })
  expect(logs.some((m) => m.includes("pre-write scan failed"))).toBe(true)
})

test("non-hooked tools are ignored", async () => {
  const spawn = mock(async () => denyJson("should not run"))
  const hooks = makePlugin({ spawnBatou: spawn })
  await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls" } })
  const output = { title: "", output: "done", metadata: {} }
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output)
  expect(spawn).toHaveBeenCalledTimes(0)
  expect(output.output).toBe("done")
})

// --- event shapes ---

test("edit tool sends an Edit-shaped PreToolUse event", async () => {
  let seen: any
  const spawn = mock(async (_bin: string, event: any) => {
    seen = event
    return allowJson("clean")
  })
  const hooks = makePlugin({ spawnBatou: spawn })
  const editArgs = { filePath: "/repo/a.ts", oldString: "old", newString: "new" }
  await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "s", callID: "c" }, { args: editArgs })
  expect(seen.tool_name).toBe("Edit")
  expect(seen.hook_event_name).toBe("PreToolUse")
  expect(seen.tool_input).toEqual({ file_path: "/repo/a.ts", old_string: "old", new_string: "new" })
})

test("apply_patch add hunk maps to a Write event and can be denied", async () => {
  const patchText = ["*** Begin Patch", "*** Add File: secrets.ts", '+const token = "AKIA123"', "*** End Patch"].join(
    "\n",
  )
  let seen: any
  const spawn = mock(async (_bin: string, event: any) => {
    seen = event
    return denyJson("hardcoded credential")
  })
  const hooks = makePlugin({ spawnBatou: spawn })
  await expect(
    hooks["tool.execute.before"]!({ tool: "apply_patch", sessionID: "s", callID: "c" }, { args: { patchText } }),
  ).rejects.toThrow(/Batou blocked this apply_patch/)
  expect(seen.tool_name).toBe("Write")
  expect(seen.tool_input.file_path).toBe("/repo/secrets.ts")
  expect(seen.tool_input.content).toContain("AKIA123")
})

test("fileChangesFor decomposes apply_patch add hunks into Write changes", () => {
  const patchText = ["*** Begin Patch", "*** Add File: new.ts", "+export const a = 1", "*** End Patch"].join("\n")
  const changes = fileChangesFor("apply_patch", { patchText }, "/repo")
  expect(changes).toHaveLength(1)
  expect(changes[0].toolName).toBe("Write")
  expect(changes[0].filePath).toBe("/repo/new.ts")
})

test("fileChangesFor returns nothing for an unparseable patch", () => {
  expect(fileChangesFor("apply_patch", { patchText: "not a patch" }, "/repo")).toEqual([])
})

// --- end-to-end against a real stub binary (exercises spawn + exit-code capture) ---

const scriptDirs: string[] = []
afterAll(async () => {
  for (const dir of scriptDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** Writes an executable stub `batou` script and returns its dir (a real, existing cwd) and path. */
async function stubBinary(body: string): Promise<{ dir: string; script: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batou-stub-"))
  scriptDirs.push(dir)
  const script = path.join(dir, "batou")
  await fs.writeFile(script, body, { mode: 0o755 })
  await fs.chmod(script, 0o755)
  return { dir, script }
}

/** Plugin whose cwd (input.directory) is a real dir, so the actual Process.spawn can run. */
function e2ePlugin(dir: string, script: string) {
  return BatouPlugin(
    { ...pluginInput, directory: dir, worktree: dir },
    {
      isEnabled: async () => true,
      ensureBinary: async () => script,
      resolveBinary: async () => script,
      logger: () => {},
    },
  )
}

test.skipIf(process.platform === "win32")(
  "end-to-end: a real binary that exits 2 blocks the write with its additionalContext",
  async () => {
    const json =
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"=== Batou ===\\nBatou BLOCKED WRITE: tainted user_input reaches exec\\nACTION: Rewrite the code to sanitize input.\\n=== End Batou ==="}}'
    const { dir, script } = await stubBinary(`#!/bin/sh\ncat > /dev/null\nprintf '%s' '${json}'\nexit 2\n`)
    const hooks = e2ePlugin(dir, script)
    await expect(
      hooks["tool.execute.before"]!(beforeInput, { args: { filePath: path.join(dir, "app.ts"), content: "x" } }),
    ).rejects.toThrow(/Batou BLOCKED WRITE/)
  },
)

test.skipIf(process.platform === "win32")(
  "end-to-end: a real binary that exits 0 with a clean decision allows the write",
  async () => {
    const json =
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"=== Batou ===\\nNo security issues detected"}}'
    const { dir, script } = await stubBinary(`#!/bin/sh\ncat > /dev/null\nprintf '%s' '${json}'\nexit 0\n`)
    const hooks = e2ePlugin(dir, script)
    await hooks["tool.execute.before"]!(beforeInput, { args: { filePath: path.join(dir, "app.ts"), content: "x" } })
  },
)
