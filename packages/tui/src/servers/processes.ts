export const running = new Set<ReturnType<typeof Bun.spawn>>()

// Servers and tunnels started here are private to this process; never leave one holding the database.
process.once("exit", () => running.forEach((child) => child.kill()))
