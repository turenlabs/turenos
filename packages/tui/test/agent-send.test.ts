import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { agent, document, inventory, permission, refusal, task, user, world } from "./agent-fixture"
import { session } from "./support"

test("send delivers plain text by steer or queue, from an argument or stdin", async () => {
  const server = world()
  const steer = await agent(["send", "ses_main", "fix the build"], { url: server.url })
  expect(steer.code).toBe(0)
  expect(steer.stdout).toMatch(/^sent message msg_[0-9a-f]{32} to session ses_main \(steer\)\n$/)
  const queued = document(await agent(["send", "ses_main", "later", "--queue", "--json"], { url: server.url }))
  expect(queued).toMatchObject({ session: "ses_main", state: "sent", delivery: "queue" })
  await agent(["send", "ses_main", "-"], { url: server.url, stdin: "from stdin\n" })
  await agent(["send", "ses_main"], { url: server.url, stdin: "also stdin\n\n" })
  expect(server.state.prompts.map((item) => [item.prompt, item.delivery])).toEqual([
    [{ text: "fix the build" }, "steer"],
    [{ text: "later" }, "queue"],
    [{ text: "from stdin" }, "steer"],
    [{ text: "also stdin" }, "steer"],
  ])
  const ids = server.state.prompts.map((item) => item.id)
  expect(new Set(ids).size).toBe(4)
  expect(ids.every((id) => /^msg_[0-9a-f]{32}$/.test(id))).toBe(true)
})

test("send refuses empty text, a terminal without text, and bad IDs before sending anything", async () => {
  const server = world()
  expect((await agent(["send", "ses_main", "   "], { url: server.url })).code).toBe(2)
  expect((await agent(["send", "ses_main"], { url: server.url })).code).toBe(2)
  expect((await agent(["send", "ses_main", "-"], { url: server.url, stdin: "\n" })).code).toBe(2)
  expect((await agent(["send", "ses_main", "x".repeat(32001)], { url: server.url })).code).toBe(2)
  expect((await agent(["send", "ses_main", "hi", "--id", "bad id"], { url: server.url })).code).toBe(2)
  expect((await agent(["send", "ses_main", "hi", "--model", "p/m"], { url: server.url })).code).toBe(2)
  expect(server.state.prompts).toEqual([])
})

test("send routes /commands and !shell like the dashboard, and neither can be queued", async () => {
  const bodies: unknown[] = []
  const server = world({
    ...inventory,
    "POST /api/session/ses_main/command": async (request) => {
      const body = await request.json()
      bodies.push(body)
      return { data: { id: (body as { id: string }).id, sessionID: "ses_main" } }
    },
    "POST /api/session/ses_main/shell": async (request) => {
      const body = (await request.json()) as { id: string; command: string }
      bodies.push(body)
      return { data: { id: body.id, type: "shell", command: body.command, output: "", status: "running" } }
    },
  })
  expect((await agent(["send", "ses_main", "/review the diff"], { url: server.url })).code).toBe(0)
  expect((await agent(["send", "ses_main", "!ls -la"], { url: server.url })).code).toBe(0)
  // Not an inventory command: an ordinary prompt.
  expect((await agent(["send", "ses_main", "/unknown thing"], { url: server.url })).code).toBe(0)
  expect(bodies).toMatchObject([{ command: "review", arguments: "the diff", resume: true }, { command: "ls -la" }])
  expect(server.state.prompts.map((item) => item.prompt)).toEqual([{ text: "/unknown thing" }])

  for (const text of ["/review x", "!ls"]) {
    const queued = await agent(["send", "ses_main", text, "--queue"], { url: server.url })
    expect(queued.code).toBe(2)
    expect(queued.stderr).toContain("do not support --queue")
  }
  expect(bodies).toHaveLength(2)
})

test("an ambiguous failure prints the ID to retry, and the retry is admitted once", async () => {
  const lost = { next: true }
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string }
      // The first admission is stored, but its acknowledgement is lost; the server drops a repeated ID.
      if (!server.state.prompts.some((item) => item.id === body.id)) server.state.prompts.push(body)
      if (!lost.next) return { data: { id: body.id, sessionID: "ses_main" } }
      lost.next = false
      return new Response("down", { status: 503 })
    },
  })

  const first = await agent(["send", "ses_main", "do it", "--json"], { url: server.url })
  expect(first.code).toBe(1)
  const error = document(first).error as { message: string; retry: { id: string; sessionID: string } }
  expect(error.retry.sessionID).toBe("ses_main")
  expect(error.retry.id).toMatch(/^msg_[0-9a-f]{32}$/)
  expect(error.message).toContain("Outcome unknown: Server returned HTTP 503")
  expect(error.message).toContain(
    `Retry with the same ID so it cannot be sent twice: turen-tui send ses_main --id ${error.retry.id}`,
  )
  expect(first.stderr).toBe(`turen-tui: ${error.message}\n`)

  const retried = await agent(["send", "ses_main", "do it", "--id", error.retry.id], { url: server.url })
  expect(retried.code).toBe(0)
  expect(server.state.prompts.map((item) => item.id)).toEqual([error.retry.id])
})

test("a definite 4xx is reported as refused, with nothing sent", async () => {
  const server = world({ "POST /api/session/ses_main/prompt": refusal })
  const result = await agent(["send", "ses_main", "hello"], { url: server.url })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("The server refused the message")
  expect(result.stderr).toContain("Nothing was sent.")
  expect(result.stderr).not.toContain("Outcome unknown")
  expect(document(await agent(["send", "ses_main", "hello", "--json"], { url: server.url })).error).not.toHaveProperty(
    "retry",
  )
})

test("a task-owned subagent session takes no replies, and the owner is named", async () => {
  const child = { ...session("main"), parentID: "ses_parent" }
  const server = world({
    "GET /api/session/ses_main": () => ({ data: child }),
    "GET /api/session/ses_parent/task": () => ({
      data: [],
      active: [task("tsk_child", { childSessionID: "ses_main" })],
      cursor: {},
    }),
  })
  const result = await agent(["send", "ses_main", "hello"], { url: server.url })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("task-owned subagent")
  expect(result.stderr).toContain("ses_parent")
  expect(server.state.prompts).toEqual([])

  // A server that knows better than the task list refuses it too.
  const refusing = world({
    "GET /api/session/ses_main": () => ({ data: child }),
    "POST /api/session/ses_main/prompt": () =>
      Response.json({ _tag: "InvalidRequestError", kind: "session_task_owned", message: "owned" }, { status: 400 }),
  })
  const late = await agent(["send", "ses_main", "hello"], { url: refusing.url })
  expect(late.code).toBe(1)
  expect(late.stderr).toContain("ses_parent")
})

const reply = (id: string, text: string) => ({
  id: `msg_${id}`,
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "model" },
  time: { created: 2 },
  content: [{ id: `text_${id}`, type: "text", text }],
})

test("send --wait waits for the reply even when the first active read comes before the turn is marked busy", async () => {
  const turns = { count: 0 }
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      const turn = ++turns.count
      server.state.prompts.push(body)
      server.state.messages.push({ id: body.id, type: "user", time: { created: 1 }, text: body.prompt.text })
      // The server marks the session busy a moment after admitting, and replies a moment after that.
      setTimeout(() => server.state.active.add("ses_main"), 300)
      setTimeout(() => {
        server.state.messages.push(reply(`turn${turn}`, `answer ${turn}`))
        server.state.active.delete("ses_main")
      }, 900)
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const begin = Date.now()
  const result = await agent(["send", "ses_main", "question", "--wait"], { url: server.url })
  expect(result.code).toBe(0)
  expect(Date.now() - begin).toBeGreaterThanOrEqual(850)
  expect(result.stdout).toStartWith("session ses_main · idle\n")
  expect(result.stdout).toContain("answer 1")
  // Only what came after the sent message, not the reply that was already there.
  expect(result.stdout).not.toContain("hello")

  const json = document(await agent(["send", "ses_main", "again", "--wait", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "idle" })
  expect((json.messages as { id: string }[]).map((message) => message.id)).toEqual(["msg_turn2"])
})

test("send --wait exits 3 with the follow-up commands when a permission appears, and 4 on timeout", async () => {
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string }
      server.state.prompts.push(body)
      server.state.active.add("ses_main")
      setTimeout(() => server.state.permissions.push(permission("per_7")), 200)
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const waiting = await agent(["send", "ses_main", "run it", "--wait"], { url: server.url })
  expect(waiting.code).toBe(3)
  expect(waiting.stdout).toContain("session ses_main · needs-input")
  expect(waiting.stdout).toContain("  approve: turen-tui approve ses_main per_7")
  expect(waiting.stdout).toContain("  reject:  turen-tui reject ses_main per_7")
  const json = document(await agent(["wait", "ses_main", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "needs-input" })

  server.state.permissions.length = 0
  server.state.active.add("ses_main")
  const timeout = await agent(["wait", "ses_main", "--timeout", "1"], { url: server.url })
  expect(timeout.code).toBe(4)
  expect(timeout.stdout).toContain("session ses_main · timeout")
  expect(document(await agent(["wait", "ses_main", "--timeout", "1", "--json"], { url: server.url }))).toMatchObject({
    state: "timeout",
  })
})

test("wait on an idle session prints its last reply", async () => {
  const server = world()
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("session ses_main · idle")
  expect(result.stdout).toContain("hello")
})

test("send --new starts a session under frozen IDs, and a retry with them cannot duplicate it", async () => {
  const created: { id: string; location: unknown }[] = []
  const server = world({
    "POST /api/session": async (request) => {
      const body = (await request.json()) as { id: string; location: unknown }
      created.push(body)
      return { data: { ...session("new"), id: body.id, location: body.location } }
    },
    "POST /api/session/ses_fresh/prompt": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_fresh" },
    }),
  })
  const run = await agent(
    [
      "send",
      "--new",
      "build it",
      "--dir",
      "/srv/other",
      "--model",
      "prov/mod",
      "--agent",
      "plan",
      "--session-id",
      "ses_fresh",
      "--id",
      "msg_first",
    ],
    { url: server.url },
  )
  expect(run.code).toBe(0)
  expect(run.stdout).toBe("started session ses_fresh with message msg_first\n")
  expect(created[0]).toMatchObject({
    id: "ses_fresh",
    location: { directory: "/srv/other" },
    agent: "plan",
    model: { providerID: "prov", id: "mod" },
  })
  expect(server.sent("/api/session/ses_fresh/prompt")[0]!.body).toMatchObject({
    id: "msg_first",
    prompt: { text: "build it" },
  })

  // The directory defaults to the server location, and --queue makes no sense here.
  const defaults = await agent(["send", "--new", "hello", "--session-id", "ses_fresh"], {
    url: server.url,
    stdin: undefined,
  })
  expect(defaults.code).toBe(0)
  expect(created[1]!.location).toEqual({ directory: "/srv/main" })
  expect((await agent(["send", "--new", "hello", "--queue"], { url: server.url })).code).toBe(2)
})

test("send --new reports an ambiguous launch with both IDs for the retry", async () => {
  const server = world({
    "POST /api/session": () => new Response("down", { status: 503 }),
  })
  const result = await agent(["send", "--new", "hello", "--json"], { url: server.url })
  expect(result.code).toBe(1)
  const error = document(result).error as { message: string; retry: { id: string; sessionID: string } }
  expect(error.retry.sessionID).toMatch(/^ses_[0-9a-f]{32}$/)
  expect(error.retry.id).toMatch(/^msg_[0-9a-f]{32}$/)
  expect(error.message).toContain(`turen-tui send --new --session-id ${error.retry.sessionID} --id ${error.retry.id}`)
})

const failed = (id: string, message: string) => ({ ...reply(id, "partial"), finish: "error", error: { message } })
const providerFailure =
  'Provider request failed with HTTP 401: {"error":{"message":"invalid x-api-key","type":"authentication_error"}}'

test("wait exits 5 when the idle session's latest turn failed, and a recovered or successful turn exits 0", async () => {
  const server = world()
  server.state.messages.push(user("q", "go"), failed("f", providerFailure))
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout).toStartWith("session ses_main · failed\nHTTP 401: invalid x-api-key\n")
  const json = document(await agent(["wait", "ses_main", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "failed", message: { id: "msg_f" } })

  server.state.messages.push(user("r", "again"), reply("ok", "fine"))
  const recovered = await agent(["wait", "ses_main"], { url: server.url })
  expect(recovered.code).toBe(0)
  expect(recovered.stdout).toStartWith("session ses_main · idle\n")
  expect(document(await agent(["wait", "ses_main", "--json"], { url: server.url }))).toMatchObject({ state: "idle" })
})

test("wait exits 5 and says interrupted when the turn was stopped", async () => {
  const server = world()
  server.state.messages.push(user("q", "go"), failed("i", "Provider turn interrupted"))
  const result = await agent(["wait", "ses_main"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout).toStartWith("session ses_main · interrupted\nThe turn was stopped before it finished.\n")
  expect(document(await agent(["wait", "ses_main", "--json"], { url: server.url }))).toMatchObject({
    state: "interrupted",
  })
})

test("send --wait exits 5 when the reply to the sent message is a failed turn", async () => {
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      server.state.prompts.push(body)
      server.state.messages.push(
        user(body.id.slice(4), body.prompt.text),
        failed(`late${server.state.prompts.length}`, providerFailure),
      )
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
  })
  const result = await agent(["send", "ses_main", "go", "--wait"], { url: server.url })
  expect(result.code).toBe(5)
  expect(result.stdout).toStartWith("session ses_main · failed\nHTTP 401: invalid x-api-key\n")
  const json = document(await agent(["send", "ses_main", "go again", "--wait", "--json"], { url: server.url }))
  expect(json).toMatchObject({ session: "ses_main", state: "failed" })
})

test("send --new checks mentions outside the directory even when the text starts with /", async () => {
  const created: unknown[] = []
  const server = world({
    ...inventory,
    "POST /api/session": async (request) => {
      const body = (await request.json()) as { id: string }
      created.push(body)
      return { data: { ...session("new"), id: body.id } }
    },
    "POST /api/session/ses_fresh/command": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_fresh" },
    }),
    "POST /api/session/ses_fresh/prompt": async (request) => ({
      data: { id: ((await request.json()) as { id: string }).id, sessionID: "ses_fresh" },
    }),
  })
  // Not a server command, so its mention is a mention that leaves /srv/main.
  const refused = await agent(["send", "--new", "/tmp/notes.md: see @../secret", "--session-id", "ses_fresh"], {
    url: server.url,
  })
  expect(refused.code).toBe(2)
  expect(refused.stderr).toContain("--allow-outside")
  expect(created).toEqual([])
  // A real command's arguments are not mentions.
  const command = await agent(["send", "--new", "/review @../secret", "--session-id", "ses_fresh"], { url: server.url })
  expect(command.code).toBe(0)
  expect(created).toHaveLength(1)
})

test("send --wait that fails after the message landed names the sent message and how to resume", async () => {
  const failNext = { messages: false }
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string }
      server.state.prompts.push(body)
      failNext.messages = true
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
    "GET /api/session/ses_main/message": () => {
      if (!failNext.messages) return { data: server.state.messages.toReversed(), cursor: {} }
      failNext.messages = false
      return refusal()
    },
  })
  const result = await agent(["send", "ses_main", "go", "--wait", "--json"], { url: server.url })
  expect(result.code).toBe(1)
  const error = document(result).error as { message: string; messageID: string; state: string }
  expect(error.state).toBe("sent")
  expect(error.messageID).toMatch(/^msg_[0-9a-f]{32}$/)
  expect(error.message).toContain(`Message ${error.messageID} was sent to session ses_main`)
  expect(error.message).toContain("turen-tui wait ses_main")
  expect(error).not.toHaveProperty("retry")
})

test("wait polls through a transient failure, and reports a session deleted meanwhile", async () => {
  const failures = { active: 1 }
  const server = world({
    "GET /api/session/active": () => {
      if (failures.active-- > 0) return new Response("restarting", { status: 503 })
      return { data: {} }
    },
  })
  const begin = Date.now()
  const result = await agent(["wait", "ses_main", "--timeout", "10"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("session ses_main · idle")
  // A failed pass waits about two seconds before the next one instead of ending the wait.
  expect(Date.now() - begin).toBeGreaterThanOrEqual(1500)

  const gone = world({
    "GET /api/session/ses_main/message": () =>
      Response.json({ _tag: "SessionNotFoundError", message: "gone" }, { status: 404 }),
  })
  const deleted = await agent(["wait", "ses_main"], { url: gone.url })
  expect(deleted.code).toBe(1)
  expect(deleted.stderr).toContain("deleted while waiting")
})

test("wait ends with the input a running session's subagent is waiting for", async () => {
  const server = world({
    "GET /api/session/ses_main/task": () => ({
      data: [],
      active: [task("tsk_child", { childSessionID: "ses_child" })],
      cursor: {},
    }),
    "GET /api/session/ses_child/permission": () => ({
      data: [permission("per_child", { sessionID: "ses_child" })],
    }),
    "GET /api/session/ses_child/question": () => ({ data: [] }),
  })
  server.state.active.add("ses_main")
  const result = await agent(["wait", "ses_main", "--timeout", "5"], { url: server.url })
  expect(result.code).toBe(3)
  expect(result.stdout).toContain("session ses_main · needs-input")
  expect(result.stdout).toContain("  approve: turen-tui approve ses_child per_child")
  const json = document(await agent(["wait", "ses_main", "--timeout", "5", "--json"], { url: server.url }))
  expect((json.pending as { permissions: { sessionID: string }[] }).permissions[0]!.sessionID).toBe("ses_child")
})

test("send --queue --wait does not take the running turn's reply while the message is still queued", async () => {
  const queue: string[] = []
  const server = world({
    "POST /api/session/ses_main/prompt": async (request) => {
      const body = (await request.json()) as { id: string; prompt: { text: string } }
      server.state.prompts.push(body)
      queue.push(body.id)
      // The running turn ends first; the queued message is read and answered after it.
      setTimeout(() => {
        server.state.messages.push(reply("first", "answer A"))
        server.state.active.delete("ses_main")
      }, 200)
      setTimeout(() => {
        queue.length = 0
        server.state.messages.push(user(body.id.slice(4), body.prompt.text))
        server.state.active.add("ses_main")
      }, 700)
      setTimeout(() => {
        server.state.messages.push(reply("second", "answer B"))
        server.state.active.delete("ses_main")
      }, 1000)
      return { data: { id: body.id, sessionID: "ses_main" } }
    },
    "GET /api/session/ses_main/input": () => ({
      data: queue.map((id) => ({ id, sessionID: "ses_main", admittedSeq: 1, prompt: { text: "later" } })),
    }),
  })
  server.state.active.add("ses_main")
  const result = await agent(["send", "ses_main", "later", "--queue", "--wait"], { url: server.url })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("answer B")
  expect(result.stdout).not.toContain("answer A")
})

test("an invalid --model, --variant or --agent on send --new is a usage error, and nothing is created", async () => {
  const server = world({ "POST /api/session": () => new Response("unexpected", { status: 500 }) })
  for (const args of [
    ["--model", "bad"],
    ["--variant", "v"],
    ["--agent", "bad\u0007name"],
  ]) {
    const result = await agent(["send", "--new", "hi", ...args], { url: server.url })
    expect(result.code).toBe(2)
    expect(result.stderr).not.toContain("Outcome unknown")
  }
})

test("a server error message stays on one line in text and JSON output", async () => {
  const server = world({
    "GET /api/session/ses_main": () =>
      Response.json({ _tag: "InvalidRequestError", message: "bad\n  approve: turen-tui approve x y" }, { status: 400 }),
  })
  const result = await agent(["show", "ses_main", "--json"], { url: server.url })
  expect(result.code).toBe(1)
  expect(result.stderr.trimEnd()).not.toContain("\n")
  expect((document(result).error as { message: string }).message).not.toContain("\n")
})

test("the bin refuses stdin that is not UTF-8 and ignores a byte-order mark", async () => {
  const server = world()
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const run = async (stdin: Uint8Array<ArrayBuffer>) => {
    const child = Bun.spawn([process.execPath, cli, "send", "ses_main", "-"], {
      env: { PATH: "", TURENOS_SERVER_URL: server.url },
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { stderr, exitCode }
  }
  const invalid = await run(new Uint8Array([0xff, 0xfe, 0x68, 0x69]))
  expect(invalid.exitCode).toBe(2)
  expect(invalid.stderr).toContain("UTF-8")
  expect(server.state.prompts).toEqual([])
  const marked = await run(new TextEncoder().encode("﻿hi\n"))
  expect(marked.exitCode).toBe(0)
  expect(server.state.prompts.map((item) => item.prompt)).toEqual([{ text: "hi" }])
})
