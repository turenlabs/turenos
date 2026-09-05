import { expect, test } from "bun:test"

// Each entry point needs a fresh module cache: a whole-suite import order can hide a cycle.
test.each(["skill", "plugin", "permission", "session/command"])(
  "initializes session commands when %s is imported first",
  async (entry) => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `await import("./src/${entry}.ts"); const { SessionCommand } = await import("./src/session/command.ts"); if (!SessionCommand.node) throw new Error("missing command node")`,
      ],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
  },
)
