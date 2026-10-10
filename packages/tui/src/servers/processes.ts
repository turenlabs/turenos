export const running = new Set<ReturnType<typeof Bun.spawn>>()

function stopAll() {
  running.forEach((child) => child.kill())
}

// Servers and tunnels started here are private to this process; never leave one holding the database.
process.once("exit", stopAll)
// A closing terminal, Ctrl-C or a service manager signals this client, which runs no exit handlers; stop the
// children first, then let the signal end this process as it would have.
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.once(signal, () => {
    stopAll()
    process.kill(process.pid, signal)
  })
