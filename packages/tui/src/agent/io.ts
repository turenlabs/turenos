import { usage } from "./errors"

/** Everything a command touches outside the server, so tests can run it in-process. */
export type Io = {
  env: NodeJS.ProcessEnv
  stdout: (text: string) => unknown
  stderr: (text: string) => unknown
  stdin: { tty: boolean; read: () => Promise<string> }
}

const stdinLimit = 256 * 1024

export function processIo(): Io {
  return {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: { tty: !!process.stdin.isTTY, read: readStdin },
  }
}

async function readStdin() {
  const reader = Bun.stdin.stream().getReader()
  const chunks: Uint8Array[] = []
  const total = { size: 0 }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total.size += chunk.value.byteLength
      if (total.size > stdinLimit) throw usage("Standard input is larger than 256 KiB.")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString("utf8")
}
