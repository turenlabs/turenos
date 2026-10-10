import { afterEach, expect, test } from "bun:test"
import { connect } from "../src/server"

const location = { directory: "/srv/project", project: { id: "prj_project", directory: "/srv/project" } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function serve(routes: Record<string, unknown>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const body = routes[new URL(request.url).pathname]
      return body === undefined ? new Response("unexpected route", { status: 404 }) : Response.json(body)
    },
  })
  const connection = connect({ url: server.url.href })
  cleanups.push(async () => {
    connection.close()
    await server.stop(true)
  })
  return connection
}

const command = (name: string) => ({ name, template: `run ${name}`, description: `The ${name} command` })
const time = { created: 1 }
const user = (id: string) => ({ id, type: "user", text: `prompt ${id}`, time })
const assistant = (id: string, content: unknown[]) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "local", id: "model" },
  time,
  content,
})
const page = (...data: unknown[]) => ({ data, cursor: { next: null } })
const messages = (connection: ReturnType<typeof serve>) =>
  connection.client.messages.list({ sessionID: "ses_page", limit: 30 })

test("a 300-command inventory is delivered and a slash command still resolves", async () => {
  const data = Array.from({ length: 300 }, (_, index) => command(`cmd${index}`))
  const connection = serve({ "/api/command": { location, data }, "/extension": [] })
  expect(await connection.commands("/srv/project")).toHaveLength(300)
  expect(await connection.resolveCommand("/cmd299 go", "/srv/project")).toEqual({ command: "cmd299", arguments: "go" })
})

test("a duplicate or unaddressable command name is skipped, not fatal", async () => {
  const data = [command("review"), command("review"), command("ns/tool"), command("ship")]
  const connection = serve({ "/api/command": { location, data }, "/extension": [] })
  expect((await connection.commands("/srv/project")).map((item) => item.name)).toEqual(["review", "ship"])
  expect(await connection.resolveCommand("/ship now", "/srv/project")).toEqual({ command: "ship", arguments: "now" })
})

test("a 300-part assistant message keeps its first and last parts around one omission marker", async () => {
  const parts = Array.from({ length: 300 }, (_, index) => ({ id: `prt_${index}`, type: "text", text: `part ${index}` }))
  const connection = serve({ "/api/session/ses_page/message": page(user("msg_a"), assistant("msg_b", parts)) })
  const content = ((await messages(connection)).data[1] as unknown as { content: { id: string; text: string }[] })
    .content
  expect(content).toHaveLength(129)
  expect(content.slice(0, 32).map((part) => part.text)).toEqual(parts.slice(0, 32).map((part) => part.text))
  expect(content[32]!.text).toBe("[172 parts omitted]")
  expect(content.slice(33).map((part) => part.text)).toEqual(parts.slice(-96).map((part) => part.text))
  expect(content.at(-1)!.text).toBe("part 299")
})

test("the omission marker takes an identifier no real part uses", async () => {
  const parts = Array.from({ length: 200 }, (_, index) => ({
    id: index === 150 ? "omitted_parts" : `prt_${index}`,
    type: "text",
    text: `part ${index}`,
  }))
  const connection = serve({ "/api/session/ses_page/message": page(assistant("msg_b", parts)) })
  const content = ((await messages(connection)).data[0] as unknown as { content: { id: string; text: string }[] })
    .content
  expect(new Set(content.map((part) => part.id)).size).toBe(content.length)
  expect(content.find((part) => part.text.includes("parts omitted"))!.id).not.toBe("omitted_parts")
})

test("a 200-part assistant message keeps its first parts and marks the omission", async () => {
  const parts = Array.from({ length: 200 }, (_, index) => ({ id: `prt_${index}`, type: "text", text: `part ${index}` }))
  const connection = serve({ "/api/session/ses_page/message": page(user("msg_a"), assistant("msg_b", parts)) })
  const result = await messages(connection)
  expect(result.data.map((item) => item.id)).toEqual(["msg_a", "msg_b"])
  const content = (result.data[1] as unknown as { content: { text: string }[] }).content
  expect(content.length).toBeLessThanOrEqual(129)
  expect(content[0]!.text).toBe("part 0")
  expect(content[32]!.text).toContain("72 parts omitted")
  expect(content.at(-1)!.text).toBe("part 199")
})

test("a 2 MiB tool output is truncated with a marker and the rest of the page renders", async () => {
  const big = "x".repeat(2 * 1024 * 1024)
  const tool = {
    id: "prt_tool",
    type: "tool",
    name: "read",
    state: { status: "completed", input: {}, structured: {}, content: [{ type: "text", text: big }] },
  }
  const shell = { id: "msg_c", type: "shell", command: "cat big", output: big, time }
  const connection = serve({
    "/api/session/ses_page/message": page(user("msg_a"), assistant("msg_b", [tool]), shell, user("msg_d")),
  })
  const result = await messages(connection)
  expect(result.data.map((item) => item.id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_d"])
  const output = (result.data[1] as unknown as { content: { state: { content: { text: string }[] } }[] }).content[0]!.state.content[0]!.text
  expect(output.length).toBeLessThan(1024 * 1024 + 200)
  expect(output).toContain("truncated")
  expect((result.data[2] as unknown as { output: string }).output).toContain("truncated")
})

test("message identity checks stay strict", async () => {
  const connection = serve({ "/api/session/ses_page/message": page({ ...user("msg_a"), id: "../escape" }) })
  await expect(messages(connection)).rejects.toThrow()
})

test("tool input summary fields are clipped or skipped, never a reason to reject the page", async () => {
  const tool = (input: unknown, id = "prt_tool") => ({
    id,
    type: "tool",
    name: "bash",
    state: { status: "completed", input, structured: {}, content: [] },
  })
  const connection = serve({
    "/api/session/ses_page/message": page(
      assistant("msg_a", [tool({ command: "x".repeat(5000), path: 7, url: { a: 1 }, other: 1 }), tool("not an object", "prt_other")]),
      user("msg_b"),
    ),
  })
  const result = await messages(connection)
  expect(result.data.map((item) => item.id)).toEqual(["msg_a", "msg_b"])
  const content = (result.data[0] as unknown as { content: { state: { input: Record<string, unknown> } }[] }).content
  expect((content[0]!.state.input.command as string).length).toBe(1024)
  expect(content[0]!.state.input).not.toHaveProperty("path")
  expect(content[0]!.state.input).not.toHaveProperty("url")
  expect(content[0]!.state.input.other).toBe(1)
})
