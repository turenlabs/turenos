import type { ServerConnection } from "@/context/server"

// Upper bound on how long a removal waits for the terminal-teardown batch
// before stopping the managed server anyway: a hung teardown must never block
// the user from removing a server.
export const REMOVE_SERVER_TEARDOWN_TIMEOUT_MS = 4_000

// Sequences a server removal so terminal teardown runs against a live server.
//
// Order matters for managed connections (wsl:/ssh:): stopping the managed
// forge server kills the transport the teardown still needs (disposing PTYs,
// archiving the hidden CLI session), which would strand a phantom chat row on
// re-add and surface an error per failed call. So the tab removal - whose
// returned promise is the teardown batch - runs first, the stop waits for
// that batch (bounded), and only then is the connection itself unregistered.
// Plain HTTP removals never stop a server, so they keep the teardown
// fire-and-forget.
export async function removeServerConnection(input: {
  key: ServerConnection.Key
  // tabs.removeServer: drops the server's tabs and returns the (never
  // rejecting) terminal-teardown batch.
  removeTabs: (key: ServerConnection.Key) => Promise<void>
  // server.remove: unregisters the connection.
  removeConnection: (key: ServerConnection.Key) => void
  // platform.wslServers/sshServers.removeServer: stops the managed server.
  stopManagedServer?: (key: ServerConnection.Key) => Promise<void>
  teardownTimeoutMs?: number
}) {
  const teardown = input.removeTabs(input.key)
  const managed = input.key.startsWith("wsl:") || input.key.startsWith("ssh:")
  if (managed && input.stopManagedServer) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      teardown,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, input.teardownTimeoutMs ?? REMOVE_SERVER_TEARDOWN_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    await input.stopManagedServer(input.key)
  }
  input.removeConnection(input.key)
}
