import { createCliRenderer } from "@opentui/core"
import type { ConnectionOptions } from "./server"
import { color } from "./theme"
import { closedLine, settleTerminalInput } from "./terminal-exit"
import { createServers } from "./servers"
import { CliError } from "./tui-auth"
import { mountApp } from "./dashboard/app"

/**
 * Without a URL the client opens the local TurenOS (desktop app, then this host's own servers),
 * and `s` switches servers at any time. `directory` applies only to the first server.
 */
export async function runTui(options: Omit<ConnectionOptions, "url"> & { url?: string; server?: string }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The TurenOS TUI requires an interactive terminal.")
  const servers = createServers({ username: options.username })
  await servers.load()
  const explicit = options.url
    ? ({
        kind: "url",
        id: "cli",
        name: new URL(options.url).host,
        url: new URL(options.url).origin,
        saved: false,
      } as const)
    : undefined
  if (explicit && options.password) servers.remember(explicit, options.password)
  const initial = explicit ?? (options.server ? servers.find(options.server) : await servers.preferred())
  if (options.server && !initial) throw new CliError({ message: `No saved server named ${options.server}.` })
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, backgroundColor: color.bg })
  let app: ReturnType<typeof mountApp> | undefined
  let discarded = 0
  try {
    await new Promise<void>((resolve) => {
      renderer.once("destroy", resolve)
      app = mountApp(renderer, servers, {
        initial,
        directory: options.directory,
        onQuit: (drafts) => {
          discarded = drafts
          void settleTerminalInput(renderer).then(
            () => renderer.destroy(),
            () => renderer.destroy(),
          )
        },
      })
    })
  } finally {
    app?.dispose()
    renderer.destroy()
  }
  // Reached only after a normal quit; a failure above throws and reports itself.
  process.stdout.write(closedLine(discarded))
}

export { mountApp } from "./dashboard/app"
export { mountDashboard, type Dashboard } from "./dashboard/mount"
