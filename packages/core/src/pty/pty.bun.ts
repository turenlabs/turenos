import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const data = new Set<(value: string) => void>()
  const exits = new Set<(value: { exitCode: number; signal?: number | string }) => void>()
  const decoder = new TextDecoder()
  const drained = Promise.withResolvers<void>()
  const child = Bun.spawn([file, ...args], {
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), TERM: opts.name },
    // An inline terminal releases its slave handle on process exit so the reader can reach EOF.
    terminal: {
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      data(_terminal, bytes) {
        const value = decoder.decode(bytes, { stream: true })
        if (value) data.forEach((listener) => listener(value))
      },
      exit() {
        drained.resolve()
      },
    },
    async onExit(_child, exitCode, signal) {
      // Process exit can arrive before the final PTY read, including a partial UTF-8 character.
      await drained.promise
      const value = decoder.decode()
      if (value) data.forEach((listener) => listener(value))
      _child.terminal?.close()
      exits.forEach((listener) => listener({ exitCode: exitCode ?? 1, signal: signal ?? undefined }))
    },
  })
  const terminal = child.terminal!
  return {
    pid: child.pid,
    onData(listener) {
      data.add(listener)
      return {
        dispose: () => {
          data.delete(listener)
        },
      }
    },
    onExit(listener) {
      exits.add(listener)
      return {
        dispose: () => {
          exits.delete(listener)
        },
      }
    },
    write(data) {
      terminal.write(data)
    },
    resize(cols, rows) {
      terminal.resize(cols, rows)
    },
    kill(signal) {
      // On Windows, closing a ConPTY does not terminate its child.
      child.kill(signal as NodeJS.Signals | undefined)
      terminal.close()
      drained.resolve()
    },
  }
}
