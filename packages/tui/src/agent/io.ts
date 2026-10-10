import { isUtf8 } from "node:buffer"
import { currentFolder } from "../working-folders"
import { usage } from "./errors"

/** Everything a command touches outside the server, so tests can run it in-process. */
export type Io = {
  env: NodeJS.ProcessEnv
  /** The folder the command was run in; listings and new sessions default to it on a server on this computer. */
  cwd?: string
  stdout: (text: string) => unknown
  stderr: (text: string) => unknown
  stdin: { tty: boolean; read: () => Promise<string> }
}

const stdinLimit = 256 * 1024

export function processIo(): Io {
  // A reader that closes early (`turen-tui show ses --all | head`) ends the command quietly.
  process.stdout.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0)
    throw error
  })
  return {
    env: process.env,
    cwd: currentFolder(),
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
  const bytes = Buffer.concat(chunks)
  if (!isUtf8(bytes)) throw usage("Standard input is not valid UTF-8.")
  // A byte-order mark from a Windows pipe is not part of the message, and would hide a leading / or !.
  return bytes.toString("utf8").replace(/^\uFEFF/, "")
}
