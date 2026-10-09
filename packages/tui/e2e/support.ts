import { afterAll, beforeAll } from "bun:test"
import { join } from "node:path"
import { packageDir, paths, readPassword, type Record } from "../script/sandbox/run"
import { request, sandboxEnv, start, stop } from "../script/sandbox/server"
import { close, exited, keys, open, resize, screen, settle, type, waitFor, type Size } from "../script/sandbox/terminal"

/**
 * One sandbox server per test file, with the TUI from `src` in a private tmux server. Tests in a
 * file share it and run in order, so each test leaves the dashboard where the next one expects.
 */
export function sandbox(file: string, size: Size = { cols: 120, rows: 36 }) {
  const name = `e2e-${file}`
  const state: { record?: Record } = {}
  beforeAll(async () => {
    state.record = await start(name)
    open(name, size)
    await waitFor(name, "Connected", 30_000)
  }, 120_000)
  afterAll(() => stop(name), 30_000)
  /** Leaves the selected session's reply editor open: it already is after a launch or a send. */
  async function compose() {
    if (!(await settle(name)).includes("Typing")) await keys(name, "f")
    await waitFor(name, "Typing")
  }
  return {
    name,
    keys: (...names: string[]) => keys(name, ...names),
    type: (text: string) => type(name, text),
    waitFor: (pattern: Parameters<typeof waitFor>[1], timeout?: number) => waitFor(name, pattern, timeout),
    screen: () => screen(name),
    settle: () => settle(name),
    resize: (next: Size) => resize(name, next),
    relaunch: async (next: Size = size, args: string[] = []) => {
      close(name)
      open(name, next, { args })
      await waitFor(name, "Connected", 30_000)
    },
    exited: () => exited(name),
    api: (method: string, path: string, body?: unknown) => request(state.record!, method, path, body),
    /** Waits until the server reports no running session: ground truth, not the screen. */
    idle: async (timeout = 30_000) => {
      const deadline = Date.now() + timeout
      while (
        Object.keys(((await request(state.record!, "GET", "/api/session/active")) as { data: object }).data).length
      ) {
        if (Date.now() > deadline)
          throw new Error(`Sessions still running after ${timeout} ms. Screen:\n${screen(name)}`)
        await Bun.sleep(200)
      }
    },
    /** Runs the non-interactive CLI (`turen-tui <args>`) against the sandbox, as an agent would. */
    cli: async (args: string[], stdin?: string) => {
      const p = paths(name)
      const child = Bun.spawn(["bun", join(packageDir, "src/cli.ts"), ...args], {
        env: { ...sandboxEnv(p), TURENOS_SERVER_URL: state.record!.url, FORGE_SERVER_PASSWORD: readPassword(p) },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { status, stdout, stderr }
    },
    /** Starts a new session with `text` from the dashboard and waits for it to open. */
    launch: async (text: string) => {
      await keys(name, "n")
      await waitFor(name, "What would you like to do?")
      await type(name, text)
      await keys(name, "Enter")
      await waitFor(name, "USER")
    },
    compose,
    /** Replies to the selected session. */
    reply: async (text: string) => {
      await compose()
      await type(name, text)
      await keys(name, "Enter")
    },
  }
}

export type Sandbox = ReturnType<typeof sandbox>
