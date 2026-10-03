import { afterEach, expect, test } from "bun:test"
import { connect } from "../src/server"

const location = {
  directory: "/srv/project",
  workspaceID: "wrk_project",
  project: { id: "prj_project", directory: "/srv/project" },
}
const command = {
  name: "review",
  description: "Review a change",
  template: "Remote template $ARGUMENTS\n!`remote-command`",
  agent: "reviewer",
  model: { providerID: "local", id: "review-model" },
  subtask: false,
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture() {
  const state = {
    inventory: { location, data: [command] } as unknown,
    createFailures: 0,
    admissionFailures: 0,
    admission: (data: Record<string, unknown>): unknown => data,
  }
  const calls: { url: URL; method: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {}
      calls.push({ url, method: request.method, body })
      if (url.pathname === "/api/command") return Response.json(state.inventory)
      if (url.pathname === "/api/session") {
        if (state.createFailures-- > 0) return new Response("ambiguous create", { status: 503 })
        return Response.json({
          data: {
            id: body.id,
            title: "New session",
            location: body.location,
            agent: body.agent,
            model: body.model,
            time: { created: 1, updated: 1 },
          },
        })
      }
      if (/^\/api\/session\/[^/]+\/(command|prompt)$/.test(url.pathname)) {
        if (state.admissionFailures-- > 0) return new Response("ambiguous admission", { status: 503 })
        return Response.json({
          data: state.admission({
            id: body.id,
            sessionID: url.pathname.split("/")[3],
            admittedSeq: 1,
            prompt: { text: "Server-expanded template" },
            delivery: "queue",
            timeCreated: 1,
            agent: "reviewer",
            model: { providerID: "local", id: "review-model" },
            source: "user",
            promotedSeq: 2,
          }),
        })
      }
      return new Response("unexpected route", { status: 404 })
    },
  })
  const connection = connect({ url: server.url.href })
  cleanups.push(async () => {
    connection.close()
    await server.stop(true)
  })
  return { state, calls, connection }
}

/** Command inventory reads; each also asks /extension for skills, which these tests do not serve. */
const inventory = (calls: { url: URL }[]) => calls.filter((call) => call.url.pathname === "/api/command")

test("command discovery verifies metadata and requested directory/workspace identity", async () => {
  const { connection, calls } = fixture()
  expect(await connection.commands(location.directory, location.workspaceID)).toEqual([command])
  const [call] = inventory(calls)
  expect(inventory(calls)).toHaveLength(1)
  expect(call!.url.searchParams.get("location[directory]")).toBe(location.directory)
  expect(call!.url.searchParams.get("location[workspace]")).toBe(location.workspaceID)
})

test("only candidate slash prefixes fetch inventory and argument text is not expanded or trimmed", async () => {
  const { connection, calls } = fixture()
  for (const text of [
    "plain text",
    " /review x",
    "/usr/file",
    "/review/path x",
    "/review\\path",
    "/",
    "//review",
    `/${"a".repeat(513)}`,
  ]) {
    expect(await connection.resolveCommand(text, location.directory)).toBeUndefined()
  }
  expect(calls).toHaveLength(0)
  for (const [text, args] of [
    ["/review", ""],
    ["/review one  two\nthree\n", "one  two\nthree\n"],
    ["/review  quoted 'x' $ARGUMENTS", " quoted 'x' $ARGUMENTS"],
    ["/review\t tab\nline", " tab\nline"],
    ["/review\nline one\nline two", "line one\nline two"],
  ] as const) {
    expect(await connection.resolveCommand(text!, location.directory, location.workspaceID)).toEqual({
      command: "review",
      arguments: args,
    })
  }
  expect(await connection.resolveCommand("/unknown text", location.directory)).toBeUndefined()
  expect(inventory(calls)).toHaveLength(6)
})

for (const failure of ["create", "admission"] as const) {
  test(`new command launch freezes route and IDs after ambiguous ${failure}`, async () => {
    const { connection, calls, state } = fixture()
    state[failure === "create" ? "createFailures" : "admissionFailures"] = 1
    const launch = connection.launch()
    const input = {
      directory: location.directory,
      prompt: "/review  first\nsecond\n",
      agent: "chosen",
      model: "provider/chosen-model",
    }
    expect(launch.input()).toBeUndefined()
    await expect(launch(input)).rejects.toThrow()
    expect(launch.input()).toEqual(input)
    expect(Object.keys(launch.input()!).sort()).toEqual(Object.keys(input).sort())
    const saved = launch.input()!
    saved.prompt = "mutated"
    expect(launch.input()).toEqual(input)
    state.inventory = { location, data: [] }
    await expect(launch({ ...input, prompt: "changed" })).rejects.toThrow("original fields")
    expect((await launch(input)).id).toBe(launch.sessionID)
    expect(calls.filter((call) => call.url.pathname === "/api/command")).toHaveLength(1)
    expect(calls[0]!.url.pathname).toBe("/api/command")
    const creates = calls.filter((call) => call.url.pathname === "/api/session")
    expect(creates).toHaveLength(failure === "create" ? 2 : 1)
    for (const create of creates)
      expect(create.body).toEqual({
        id: launch.sessionID,
        location: { directory: location.directory },
        agent: "chosen",
        model: { providerID: "provider", id: "chosen-model" },
      })
    const admissions = calls.filter((call) => call.url.pathname.endsWith("/command") && call.method === "POST")
    expect(admissions).toHaveLength(failure === "admission" ? 2 : 1)
    for (const admission of admissions) {
      expect(admission.url.pathname).toBe(`/api/session/${launch.sessionID}/command`)
      expect(admission.body).toEqual({
        id: admissions[0]!.body.id,
        command: "review",
        arguments: " first\nsecond\n",
        agent: "chosen",
        model: { providerID: "provider", id: "chosen-model" },
        resume: true,
      })
      expect(admission.body.id).toMatch(/^msg_/)
      expect(admission.body).not.toHaveProperty("delivery")
    }
    expect(calls.some((call) => call.url.pathname.endsWith("/prompt"))).toBe(false)
  })
}

for (const prompt of ["plain task", "/usr/file", "/unknown  keep\ntext"]) {
  test(`new launch retains ordinary prompt routing for ${JSON.stringify(prompt)}`, async () => {
    const { connection, calls, state } = fixture()
    state.admissionFailures = 1
    const launch = connection.launch()
    const input = { directory: location.directory, prompt }
    await expect(launch(input)).rejects.toThrow()
    state.inventory = { location, data: [{ ...command, name: "unknown" }] }
    await launch(input)
    expect(calls.filter((call) => call.url.pathname === "/api/command")).toHaveLength(
      prompt.startsWith("/unknown") ? 1 : 0,
    )
    const admissions = calls.filter((call) => call.url.pathname.endsWith("/prompt"))
    expect(admissions).toHaveLength(2)
    expect(admissions[0]!.body).toEqual(admissions[1]!.body)
    expect(admissions[0]!.body).toEqual({ id: admissions[0]!.body.id, prompt: { text: prompt } })
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(3)
  })
}

const badInventories = [
  { location: { ...location, directory: "/srv/wrong" }, data: [command] },
  { location: { ...location, workspaceID: "wrk_wrong" }, data: [command] },
  { location: { directory: location.directory }, data: [command] },
  { location, data: {} },
  { location, data: Array.from({ length: 257 }, (_, index) => ({ ...command, name: `command${index}` })) },
  { location, data: [command, command] },
  ...[
    { name: "" },
    { name: "bad name" },
    { name: "usr/file" },
    { name: "bad\u001b" },
    { name: "a".repeat(513) },
    { description: 4 },
    { description: "x".repeat(64001) },
    { template: null },
    { template: "x".repeat(1024 * 1024 + 1) },
    { agent: "bad\u001b" },
    { model: { id: "m" } },
    { subtask: "yes" },
  ].map((change) => ({ location, data: [{ ...command, ...change }] })),
]
for (const [index, inventory] of badInventories.entries()) {
  test(`malformed command inventory ${index} fails before new-session admission`, async () => {
    const { connection, calls, state } = fixture()
    state.inventory = inventory
    await expect(connection.commands(location.directory, location.workspaceID)).rejects.toThrow()
    // Launch has no workspace field; force the same invalid payload for both identity cases.
    if (index === 1 || index === 2)
      state.inventory = { location: { ...location, directory: "/wrong" }, data: [command] }
    const launch = connection.launch()
    const input = { directory: location.directory, prompt: "/review args" }
    await expect(launch(input)).rejects.toThrow()
    expect(calls.every((call) => call.method === "GET")).toBe(true)
    state.inventory = { location, data: [command] }
    await launch(input)
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2)
  })
}

for (const [field, value] of [
  ["sessionID", "ses_wrong"],
  ["id", "msg_wrong"],
  ["id", "invalid/id"],
  ["admittedSeq", -1],
  ["promotedSeq", 1.5],
  ["prompt", { text: 3 }],
  ["delivery", "invalid"],
  ["source", "invalid"],
  ["agent", "bad\u001b"],
  ["model", { id: "m" }],
  ["timeCreated", "yesterday"],
] as const) {
  test(`command admission validates ${field} and retries identical request`, async () => {
    const { connection, calls, state } = fixture()
    state.admission = (data) => ({ ...data, [field]: value })
    const launch = connection.launch()
    const input = { directory: location.directory, prompt: "/review args" }
    await expect(launch(input)).rejects.toThrow()
    state.admission = (data) => data
    await launch(input)
    const admissions = calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/command"))
    expect(admissions).toHaveLength(2)
    expect(admissions[0]!.body).toEqual(admissions[1]!.body)
    expect(calls.filter((call) => call.url.pathname === "/api/session")).toHaveLength(1)
    expect(inventory(calls)).toHaveLength(1)
  })
}
