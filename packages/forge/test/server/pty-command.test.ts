import { describe, expect, test } from "bun:test"
import { resolvePtyCommand } from "@/server/pty-command"

describe("resolvePtyCommand", () => {
  test("leaves normal PTY commands unchanged", () => {
    expect(
      resolvePtyCommand("zsh", ["-l"], "/worktree", {
        env: {},
        execPath: "/usr/local/bin/bun",
        argv: ["bun", "/repo/packages/forge/src/index.ts", "serve"],
      }),
    ).toEqual({ command: "zsh", args: ["-l"] })
  })

  test("uses the desktop-provided headless runtime binary", () => {
    expect(
      resolvePtyCommand("forge", ["--mini"], "/worktree", {
        env: {
          FORGE_CLI_COMMAND: "/Applications/Forge.app/Contents/Resources/forge-cli",
          FORGE_CLI_ENTRY: "/inherited/stale-entry.ts",
        },
        execPath: "/Applications/Forge.app/Contents/MacOS/Forge",
        argv: [],
      }),
    ).toEqual({
      command: "/Applications/Forge.app/Contents/Resources/forge-cli",
      args: ["--mini"],
    })
  })

  test("runs the source entrypoint for desktop development", () => {
    expect(
      resolvePtyCommand("forge", ["--mini"], "/worktree", {
        env: { FORGE_CLI_COMMAND: "bun", FORGE_CLI_ENTRY: "/repo/packages/forge/src/index.ts" },
        execPath: "/Applications/Electron.app/Contents/MacOS/Electron",
        argv: [],
      }),
    ).toEqual({
      command: "bun",
      args: [
        "run",
        "--cwd",
        "/repo/packages/forge",
        "--conditions=browser",
        "/repo/packages/forge/src/index.ts",
        "/worktree",
        "--mini",
      ],
    })
  })

  test("reuses the serving Forge binary outside desktop", () => {
    expect(
      resolvePtyCommand("forge", undefined, "/worktree", {
        env: {},
        execPath: "/usr/local/bin/forge",
        argv: ["/usr/local/bin/forge", "serve"],
      }),
    ).toEqual({ command: "/usr/local/bin/forge", args: undefined })
  })

  test("falls back to the Forge command on PATH for a Node server build", () => {
    expect(
      resolvePtyCommand("forge", ["--mini"], "/worktree", {
        env: {},
        execPath: "/usr/local/bin/node",
        argv: ["node", "/repo/packages/forge/dist-node/forge.js", "serve"],
      }),
    ).toEqual({ command: "forge", args: ["--mini"] })
  })

  test("does not treat an unrelated bun-prefixed executable as Bun", () => {
    expect(
      resolvePtyCommand("forge", undefined, "/worktree", {
        env: {},
        execPath: "/usr/local/bin/bundle",
        argv: ["bundle", "/repo/packages/forge/src/index.ts", "serve"],
      }),
    ).toEqual({ command: "forge", args: undefined })
  })

  test("never re-executes the running bun test file as the Forge CLI", () => {
    expect(
      resolvePtyCommand("forge", ["security-mcp"], undefined, {
        env: {},
        execPath: "/usr/local/bin/bun",
        argv: ["/usr/local/bin/bun", "/repo/packages/forge/test/mcp/lifecycle.test.ts"],
      }),
    ).toEqual({ command: "forge", args: ["security-mcp"] })
  })

  test("runs a Bun-hosted source server from its package while targeting the requested worktree", () => {
    expect(
      resolvePtyCommand("forge", ["--mini"], "/worktree", {
        env: {},
        execPath: "/usr/local/bin/bun",
        argv: ["bun", "/repo/packages/forge/src/index.ts", "serve"],
      }),
    ).toEqual({
      command: "/usr/local/bin/bun",
      args: [
        "run",
        "--cwd",
        "/repo/packages/forge",
        "--conditions=browser",
        "/repo/packages/forge/src/index.ts",
        "/worktree",
        "--mini",
      ],
    })
  })
})
