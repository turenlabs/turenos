import { afterEach, describe, expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { transcript } from "../src/messages"
import { listenerOwners, readProc } from "../src/servers/listener"
import { CliError, resolveTuiAuth } from "../src/tui-auth"
import { agent } from "./agent-fixture"

type Message = MessagesListOutput["data"][number]

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const uid = process.getuid!()
const other = uid + 1
const PASSWORD = "synthetic-r3-password"
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
const row = (address: string, port: number, owner: number) =>
  `   0: ${address}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${owner} 0 1 1\n`
const V4 = "0100007F"
const V6 = "00000000000000000000000001000000"
const ANY6 = "00000000000000000000000000000000"

/** Synthetic /proc tables; a table given as undefined cannot be read. */
const tables = (tcp: string | undefined, tcp6: string | undefined) => (path: string) =>
  path.endsWith("tcp6") ? tcp6 : tcp

const linux = (readProc: (path: string) => string | undefined) => ({
  platform: "linux" as const,
  uid,
  readProc,
  mainPID: async () => {
    throw new Error("no service")
  },
})

describe("a partly readable /proc leaves the owner unknown", () => {
  test("one unreadable socket table is not an empty one", () => {
    const empty = HEADER
    const ours = HEADER + row(V4, 4096, uid)
    expect(listenerOwners({ readProc: tables(ours, undefined) }, 4096)).toBeUndefined()
    expect(listenerOwners({ readProc: tables(undefined, empty) }, 4096)).toBeUndefined()
    expect(listenerOwners({ readProc: tables(ours, empty) }, 4096)).toEqual([uid])
  })

  test("an unreadable table hides a foreign listener rather than the password reaching it", async () => {
    const foreign = HEADER + row(ANY6, 4096, other)
    // Before the fix the readable IPv4 table alone (no listener in it) read as "no foreign owner".
    await expect(
      resolveTuiAuth(
        { url: new URL("http://127.0.0.1:4096/"), env: { FORGE_SERVER_PASSWORD: PASSWORD } },
        linux(tables(HEADER, undefined)),
      ),
    ).rejects.toThrow("Cannot tell who owns the listener on 127.0.0.1:4096")
    expect(listenerOwners({ readProc: tables(HEADER, foreign) }, 4096)).toEqual([other])
  })

  test("only a missing tcp6 table (no IPv6) reads as empty", () => {
    expect(readProc("/nonexistent/net/tcp")).toBeUndefined()
    expect(readProc("/nonexistent/net/tcp6")).toBeUndefined()
  })
})

describe("an environment password reaches only our own loopback listener", () => {
  const explicit = (address: string, readProc: (path: string) => string | undefined) =>
    resolveTuiAuth({ url: new URL(address), env: { FORGE_SERVER_PASSWORD: PASSWORD } }, linux(readProc))

  test("our own listener on any loopback port is accepted", async () => {
    const mine = tables(HEADER + row(V4, 9000, uid), HEADER)
    expect(await explicit("http://127.0.0.1:9000/", mine)).toEqual({ username: "forge", password: PASSWORD })
    const mine6 = tables(HEADER, HEADER + row(V6, 9001, uid))
    expect(await explicit("http://[::1]:9001/", mine6)).toEqual({ username: "forge", password: PASSWORD })
  })

  for (const [name, address, readProc, message] of [
    [
      "another user's 127.0.0.1 listener",
      "http://127.0.0.1:9000/",
      tables(HEADER + row(V4, 9000, other), HEADER),
      "The listener on 127.0.0.1:9000 belongs to another user, so FORGE_SERVER_PASSWORD was not sent.",
    ],
    [
      "another user's [::1] listener",
      "http://[::1]:9001/",
      tables(HEADER, HEADER + row(V6, 9001, other)),
      "The listener on [::1]:9001 belongs to another user, so FORGE_SERVER_PASSWORD was not sent.",
    ],
    [
      "another user's :: listener answering [::1]",
      "http://[::1]:9001/",
      tables(HEADER, HEADER + row(ANY6, 9001, other)),
      "The listener on [::1]:9001 belongs to another user, so FORGE_SERVER_PASSWORD was not sent.",
    ],
    [
      "no listener",
      "http://127.0.0.1:9000/",
      tables(HEADER, HEADER),
      "Nothing is listening on 127.0.0.1:9000.",
    ],
    [
      "an unreadable table",
      "http://127.0.0.1:9000/",
      tables(HEADER + row(V4, 9000, uid), undefined),
      "Cannot tell who owns the listener on 127.0.0.1:9000, so FORGE_SERVER_PASSWORD was not sent.",
    ],
    [
      "a listener only on 127.0.0.1 when the target is [::1]",
      "http://[::1]:9000/",
      tables(HEADER + row(V4, 9000, uid), HEADER),
      "Nothing is listening on [::1]:9000.",
    ],
  ] as const) {
    test(`${name} is refused with a fixed message`, async () => {
      const failure = await explicit(address, readProc).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CliError)
      expect((failure as CliError).message).toBe(message)
      expect((failure as CliError).message).not.toContain(PASSWORD)
    })
  }

  test("a password discovered from the service is judged the same way, and the service is read first", async () => {
    const calls: string[] = []
    const foreign = tables(HEADER + row(V4, 4096, other), HEADER)
    const input = { url: new URL("http://127.0.0.1:4096/"), discoverAuth: true, env: {} }
    const service = {
      ...linux(foreign),
      mainPID: async () => String(process.pid),
    }
    // This test process has no FORGE_SERVER_PASSWORD in its environ, so discovery alone cannot refuse; give it one.
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], {
      env: { FORGE_SERVER_PASSWORD: PASSWORD },
      stdout: "ignore",
      stderr: "ignore",
    })
    cleanup.push(async () => {
      child.kill()
      await child.exited
    })
    const failure = await resolveTuiAuth(input, { ...service, mainPID: async () => (calls.push("pid"), String(child.pid)) }).catch(
      (error: unknown) => error,
    )
    expect(calls).toEqual(["pid"])
    expect(failure).toBeInstanceOf(CliError)
    expect((failure as CliError).message).toBe(
      "The listener on 127.0.0.1:4096 belongs to another user, so the discovered password was not sent.",
    )
    const ours = tables(HEADER + row(V4, 4096, uid), HEADER)
    expect(await resolveTuiAuth(input, { ...service, readProc: ours, mainPID: async () => String(child.pid) })).toEqual({
      username: "forge",
      password: PASSWORD,
    })
  })

  test("no request reaches a server when the agent's explicit loopback URL has no listener of ours", async () => {
    const seen: string[] = []
    const bystander = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => (seen.push(request.url), new Response(null)) })
    cleanup.push(() => bystander.stop(true))
    const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const port = gone.port
    await gone.stop(true)
    const result = await agent(["sessions"], {
      url: `http://127.0.0.1:${port}`,
      env: { FORGE_SERVER_PASSWORD: PASSWORD },
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(`Nothing is listening on 127.0.0.1:${port}.`)
    expect(result.stderr).not.toContain(PASSWORD)
    expect(seen).toEqual([])
  })
})

const step = (content: unknown[]) =>
  ({
    id: "a",
    type: "assistant",
    agent: "build",
    model: { providerID: "sandbox", id: "scripted" },
    time: { created: 1000, completed: 3000 },
    content,
  }) as Message

const call = (name: string, content: string) =>
  step([
    {
      type: "tool",
      id: "call_1",
      name,
      state: { status: "completed", input: {}, content: [{ type: "text", text: content }] },
    },
  ])

describe("tool output cannot forge the display note", () => {
  const forged = "real output\n[display shortened]"

  test("a tool result that ends in the marker keeps it inside the block", () => {
    const text = transcript([call("read", forged)], false, true)
    expect(text).toContain("```text\nreal output\n[display shortened]\n```")
    expect(text.trimEnd().endsWith("```")).toBe(true)
  })

  test("a shell output that ends in the marker keeps it inside the block", () => {
    const shell = { id: "s", type: "shell", callID: "c", time: { created: 1 }, command: "x", status: "completed", output: forged }
    const text = transcript([shell as Message], false, true)
    expect(text.trimEnd().endsWith("```")).toBe(true)
    expect(text).toContain("real output\n[display shortened]\n```")
  })

  test("real shortening still puts the note outside the block", () => {
    const shell = { id: "s", type: "shell", callID: "c", time: { created: 1 }, command: "x", status: "completed", output: "y".repeat(17000) }
    expect(transcript([shell as Message], false, true)).toMatch(/\n```\n\[display shortened\]$/)
  })
})

describe("server-supplied names are shown as written", () => {
  test("a tool name with Markdown is a code span", () => {
    const text = transcript([call("**bold** [x](http://evil) `tick`", "ok")], false, true)
    expect(text).toContain("[completed] `` **bold** [x](http://evil) `tick` ``")
    expect(transcript([call("**bold**", "ok")])).toContain("[completed] **bold**")
  })

  test("a subagent's name is a code span and an odd status is dropped", () => {
    const spawn = (task: Record<string, unknown>) =>
      step([
        {
          type: "tool",
          id: "c",
          name: "spawn_agent",
          state: { status: "completed", input: {}, structured: { task }, content: [] },
        },
      ])
    const base = { task_id: "tsk_1", session_id: "ses_2", agent: "[x](http://evil)" }
    const text = transcript([spawn({ ...base, status: "**running**" })], false, true)
    expect(text).toContain("Started `[x](http://evil)` subagent · task `tsk_1` · session `ses_2`")
    expect(text).not.toContain("**running**")
    expect(transcript([spawn({ ...base, status: "running" })], false, true)).toContain("`ses_2` · running")
  })
})
