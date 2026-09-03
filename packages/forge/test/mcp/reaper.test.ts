import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import { isStrandedSecurityMcp, parseProcessList } from "../../src/mcp/reaper"
import { watchOrphaned } from "../../src/security/mcp/server"

const SELF = 99999

// Representative `ps -xo pid=,ppid=,command=` rows with leaked security MCP
// children, unrelated MCP servers, and a live forge instance that must survive.
const REAL_PS_OUTPUT = `
 7250 97253 /Applications/Forge Dev.app/Contents/Resources/forge-cli security-mcp
97326 97253 /Applications/Forge Dev.app/Contents/Resources/forge-cli security-mcp
40130     1 /opt/homebrew/bin/bun run --cwd /Users/example/project/packages/forge --conditions=browser /Users/example/project/packages/forge/src/index.ts security-mcp
 4880  4842 /Applications/Other.app/Contents/MacOS/../Resources/other-memory-mcp --db /Users/example/Library/Application Support/com.example.other/other.db --agent-id other-0cec559b
95643     1 /Applications/Other.app/Contents/MacOS/../Resources/other-memory-mcp --db /Users/example/Library/Application Support/com.example.other/other.db --agent-id other-48b76381
88150 88118 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer
`

describe("parseProcessList", () => {
  test("reads pid, ppid and the full command including spaces", () => {
    expect(
      parseProcessList(" 7250 97253 /Applications/Forge Dev.app/Contents/Resources/forge-cli security-mcp"),
    ).toEqual([
      { pid: 7250, ppid: 97253, command: "/Applications/Forge Dev.app/Contents/Resources/forge-cli security-mcp" },
    ])
  })

  test("drops header rows and malformed lines", () => {
    expect(parseProcessList("  PID  PPID COMMAND\n\nnot a row\n1 0 /sbin/launchd")).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
    ])
  })
})

describe("isStrandedSecurityMcp", () => {
  const swept = parseProcessList(REAL_PS_OUTPUT).filter((entry) => isStrandedSecurityMcp(entry, SELF))

  test("selects only the orphaned forge child from a real process listing", () => {
    expect(swept.map((entry) => entry.pid)).toEqual([40130])
  })

  test("never matches an unrelated MCP server, even when that server is itself orphaned", () => {
    // The unrelated server at pid 95643 has ppid 1 and "mcp" in its name.
    expect(swept.some((entry) => entry.command.includes("other"))).toBe(false)
    expect(
      isStrandedSecurityMcp(
        { pid: 95643, ppid: 1, command: "/Applications/Other.app/Contents/Resources/other-memory-mcp --db x" },
        SELF,
      ),
    ).toBe(false)
  })

  test("spares a live forge instance's own children", () => {
    for (const pid of [7250, 97326]) {
      expect(
        isStrandedSecurityMcp(
          { pid, ppid: 97253, command: "/Applications/Forge Dev.app/Contents/Resources/forge-cli security-mcp" },
          SELF,
        ),
      ).toBe(false)
    }
  })

  test("accepts every shape of forge entry point when orphaned", () => {
    const commands = [
      "/Applications/Forge Dev.app/Contents/Resources/forge-cli security-mcp",
      "/usr/local/bin/forge security-mcp",
      "/opt/homebrew/bin/bun run --cwd /repo/packages/forge /repo/packages/forge/src/index.ts security-mcp",
      "/usr/bin/node /opt/forge/dist/node/index.js security-mcp",
    ]
    for (const command of commands) expect(isStrandedSecurityMcp({ pid: 1234, ppid: 1, command }, SELF)).toBe(true)
  })

  test("rejects command lines that merely mention forge or security-mcp", () => {
    const commands = [
      // security-mcp appears, but not as the trailing argument
      "/usr/local/bin/forge security-mcp --inspect",
      // forge appears in a path, but the executable is not a forge entry point
      "/usr/bin/python3 /Users/example/project/tools/watch.py security-mcp",
      // an editor holding the source file open
      "/usr/bin/vim /Users/example/project/packages/forge/src/cli/cmd/security-mcp.ts",
      // a grep for the very thing we are sweeping for
      "/usr/bin/grep -r security-mcp /Users/example/project",
      // the argument alone, with no executable in front of it
      "security-mcp",
      // a lookalike binary
      "/opt/evil/notforge-cli security-mcp",
    ]
    for (const command of commands) expect(isStrandedSecurityMcp({ pid: 1234, ppid: 1, command }, SELF)).toBe(false)
  })

  test("never targets the sweeping process itself", () => {
    const command = "/usr/local/bin/forge security-mcp"
    expect(isStrandedSecurityMcp({ pid: SELF, ppid: 1, command }, SELF)).toBe(false)
  })
})

describe("watchOrphaned", () => {
  const stdin = () => Object.assign(new EventEmitter(), { off: EventEmitter.prototype.removeListener })

  test("resolves when stdin reaches EOF", async () => {
    const pipe = stdin()
    const watch = watchOrphaned({ stdin: pipe as never, ppid: () => 42, intervalMs: 10_000 })
    pipe.emit("end")
    expect(await watch.orphaned).toBe("stdin closed")
    watch.stop()
  })

  test("resolves when the process is reparented to init", async () => {
    let ppid = 42
    const watch = watchOrphaned({ stdin: stdin() as never, ppid: () => ppid, intervalMs: 5, platform: "darwin" })
    ppid = 1
    expect(await watch.orphaned).toBe("parent exited")
    watch.stop()
  })

  test("does not treat a process legitimately launched by pid 1 as orphaned", async () => {
    const watch = watchOrphaned({ stdin: stdin() as never, ppid: () => 1, intervalMs: 5, platform: "darwin" })
    const settled = await Promise.race([watch.orphaned, Bun.sleep(60).then(() => "still running")])
    expect(settled).toBe("still running")
    watch.stop()
  })

  test("relies on stdin EOF alone on windows", async () => {
    let ppid = 42
    const pipe = stdin()
    const watch = watchOrphaned({ stdin: pipe as never, ppid: () => ppid, intervalMs: 5, platform: "win32" })
    ppid = 1
    expect(await Promise.race([watch.orphaned, Bun.sleep(40).then(() => "still running")])).toBe("still running")
    pipe.emit("close")
    expect(await watch.orphaned).toBe("stdin closed")
    watch.stop()
  })

  test("stop() detaches its listeners and timer", async () => {
    const pipe = stdin()
    const watch = watchOrphaned({ stdin: pipe as never, ppid: () => 42, intervalMs: 5 })
    watch.stop()
    expect(pipe.listenerCount("end")).toBe(0)
    expect(pipe.listenerCount("close")).toBe(0)
  })
})
