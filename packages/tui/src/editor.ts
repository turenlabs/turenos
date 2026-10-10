import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { display } from "./messages"

export const EDITOR_LIMIT = 32000
// The editor is the operator's own program; it has no use for this client's server password or vault key.
const WITHHELD = new Set(["FORGE_SERVER_PASSWORD", "FORGE_SECRET_VAULT_KEY", "FORGE_SECRET_VAULT_KEY_ID"])
export const MISSING_EDITOR = "Set $EDITOR (or $VISUAL) to compose in an editor, for example EDITOR=vim."

/**
 * The editor argv, by POSIX precedence: `VISUAL`, then `EDITOR`. Quoting applies
 * to whole arguments (`"/opt/my editor" --wait`); this is a deliberate split
 * rather than a shell, so the draft's path is never interpreted by a shell.
 */
export function editorArgv(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim()
  if (!configured) return undefined
  const argv = (configured.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    /^["']/.test(token) ? token.slice(1, -1) : token,
  )
  return argv.length && argv[0] ? argv : undefined
}

/**
 * Hand one draft to the operator's editor and read back what they saved.
 *
 * The draft is operator text that can contain anything they typed, so it lives
 * in a private 0700 directory as a 0600 file and is removed even when the editor
 * fails. A non-zero exit (`:cq`) keeps the original draft rather than saving a
 * partial edit.
 */
export async function composeInEditor(text: string, env: NodeJS.ProcessEnv = process.env) {
  const argv = editorArgv(env)
  if (!argv) throw new Error(MISSING_EDITOR)
  const directory = await mkdtemp(join(tmpdir(), "turen-tui-"))
  // `.md` so editors pick reasonable highlighting and wrapping for a message.
  const file = join(directory, "message.md")
  try {
    await writeFile(file, text, { mode: 0o600 })
    await run(argv, file, env)
    const edited = await readFile(file, "utf8")
    if (edited.length > EDITOR_LIMIT) throw new Error("Keep the message below 32,000 characters.")
    // Editors append a final newline; trailing blank lines are not draft content.
    return display(edited, EDITOR_LIMIT).replace(/\n+$/, "")
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

function run(argv: string[], file: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0]!, [...argv.slice(1), file], {
      stdio: "inherit",
      env: Object.fromEntries(Object.entries(env).filter(([key]) => !WITHHELD.has(key))),
    })
    child.on("error", () => reject(new Error(`Cannot start ${argv[0]}. Check $EDITOR and your PATH.`)))
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve()
      reject(
        new Error(
          signal
            ? `The editor stopped on ${signal}. Your draft is unchanged.`
            : `The editor exited with status ${code}. Your draft is unchanged.`,
        ),
      )
    })
  })
}
