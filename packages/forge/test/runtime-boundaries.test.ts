import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

/**
 * The server does not always run under Bun.
 *
 * `forge serve` does, but the desktop app forks the same server into an Electron
 * `utilityProcess` (packages/desktop/src/main/server.ts), which is plain Node.
 * There `Bun` is undefined, so the first Bun API call throws -- and because these
 * call sites sit behind `catch` handlers that degrade to a friendly message, the
 * failure surfaces as a feature that quietly never works rather than as a crash.
 * That is exactly how `ProviderQuota` came to report "Current quota could not be
 * loaded." for every Claude Code user of the desktop app.
 *
 * `packages/forge/src/cli` is exempt: it is only ever reached through the Bun
 * `forge-cli` binary, never through the sidecar.
 */
const roots = [
  { name: "forge", directory: resolve(import.meta.dir, "../src"), exempt: ["cli/"] },
  { name: "core", directory: resolve(import.meta.dir, "../../core/src"), exempt: [] },
]

describe("server runtime boundaries", () => {
  test.each(roots)("$name server source uses no unguarded Bun API", async (root) => {
    const offenders: string[] = []
    for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root.directory })) {
      const relative = file.replaceAll("\\", "/")
      if (root.exempt.some((prefix) => relative.startsWith(prefix))) continue
      const source = await Bun.file(resolve(root.directory, file)).text()
      // A file that checks for Bun before using it has already made the Node
      // path explicit, which is the whole point of the rule.
      if (source.includes('typeof Bun === "undefined"')) continue
      for (const [index, line] of source.split("\n").entries()) {
        if (!/(?<![\w.$])Bun\.\w/.test(line)) continue
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue
        offenders.push(`${relative}:${index + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
