import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveForgeCommand } from "@/server/pty-command"
import { tmpdir } from "../fixture/fixture"

describe("resolveForgeCommand", () => {
  test.each(["desktop", "source server"])("preserves workspace and package startup config from %s", async (host) => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const pkg = path.join(directory, "forge package #1")
        const workspace = path.join(directory, "selected workspace #2")
        await fs.mkdir(workspace, { recursive: true })
        await Bun.write(path.join(pkg, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
        await Bun.write(path.join(pkg, "preload.ts"), "process.env.FORGE_PRELOAD_CWD = process.cwd()\n")
        await Bun.write(path.join(workspace, "bunfig.toml"), 'preload = ["./untrusted.ts"]\n')
        await Bun.write(path.join(workspace, "untrusted.ts"), 'throw new Error("workspace preload executed")\n')
        await Bun.write(
          path.join(pkg, "src/cli/source.ts"),
          Bun.file(path.join(import.meta.dir, "../../src/cli/source.ts")),
        )
        await Bun.write(
          path.join(pkg, "node_modules/condition-probe/package.json"),
          JSON.stringify({ exports: { browser: "./browser.js", default: "./default.js" } }),
        )
        await Bun.write(path.join(pkg, "node_modules/condition-probe/browser.js"), 'export default "browser"\n')
        await Bun.write(path.join(pkg, "node_modules/condition-probe/default.js"), 'export default "default"\n')
        const entry = path.join(pkg, "src/index.ts")
        await Bun.write(
          entry,
          'import condition from "condition-probe"\n' +
            "console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1), preload: process.env.FORGE_PRELOAD_CWD, condition }))\n",
        )
        return { pkg, workspace, entry }
      },
    })
    const args = ["debug", "argument with spaces", "--literal=one#two"]
    const command = resolveForgeCommand(args, tmp.extra.workspace, {
      env: host === "desktop" ? { FORGE_CLI_COMMAND: process.execPath, FORGE_CLI_ENTRY: tmp.extra.entry } : {},
      execPath: host === "desktop" ? "electron" : process.execPath,
      argv: host === "desktop" ? [] : [process.execPath, tmp.extra.entry, "serve"],
    })
    const child = Bun.spawn([command.command, ...(command.args ?? [])], {
      cwd: tmp.extra.workspace,
      env: { PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual({
      cwd: tmp.extra.workspace,
      argv: [tmp.extra.entry, ...args],
      preload: tmp.extra.pkg,
      condition: "browser",
    })
  })

  test.each(["forge-cli", "forge-cli.exe"])("keeps packaged %s command arguments unchanged", (binary) => {
    const command = path.join(path.parse(process.cwd()).root, "Application With Spaces", binary)
    expect(
      resolveForgeCommand(["security-mcp"], "/workspace", {
        env: { FORGE_CLI_COMMAND: command, FORGE_CLI_ENTRY: "/stale/src/index.ts" },
        execPath: "electron",
        argv: [],
      }),
    ).toEqual({ command, args: ["security-mcp"] })
  })

  test.each(["forge", "forge.exe"])("reuses a serving %s binary without source arguments", (binary) => {
    const command = path.join(path.parse(process.cwd()).root, "bin", binary)
    expect(
      resolveForgeCommand(["security-mcp"], "/workspace", {
        env: {},
        execPath: command,
        argv: [command, "serve"],
      }),
    ).toEqual({ command, args: ["security-mcp"] })
  })

  test("does not mistake a test runner for a source server", () => {
    expect(
      resolveForgeCommand(["security-mcp"], "/workspace", {
        env: {},
        execPath: process.execPath,
        argv: [process.execPath, path.join(import.meta.dir, "forge-command.test.ts")],
      }),
    ).toEqual({ command: "forge", args: ["security-mcp"] })
  })
})
