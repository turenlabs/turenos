// A scripted OpenAI-compatible chat endpoint for the sandbox server. Run as its own process by
// `sandbox start`; it prints `MODEL_READY <port>` once listening and logs one line per request.
import { plan, type Message, type Plan } from "./scenarios"

const encoder = new TextEncoder()
const model = "scripted"
const usage = { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 }

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: model, object: "model", owned_by: "sandbox" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await request.json()) as {
      messages: Message[]
      stream?: boolean
      tools?: { function: { name: string } }[]
    }
    const tools = (body.tools ?? []).map((tool) => tool.function.name)
    const reply = plan(body.messages, tools)
    console.log(
      `REQUEST stream=${body.stream !== false} roles=${body.messages.map((message) => message.role).join(",")} tools=${tools.join(",")} -> ${reply.kind}${reply.kind === "tool" ? `:${reply.name}` : ""}`,
    )
    if (reply.kind === "fail")
      return Response.json({ error: { message: reply.message, type: "server_error" } }, { status: reply.status })
    if (body.stream === false) return Response.json(completion(reply))
    return stream(request.signal, reply)
  },
})
console.log(`MODEL_READY ${server.port}`)

function stream(signal: AbortSignal, reply: Exclude<Plan, { kind: "fail" }>) {
  const frames = reply.kind === "tool" ? toolFrames(reply) : textFrames(reply)
  const delay = reply.kind === "tool" ? 20 : reply.delay
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const frame of frames) {
          if (signal.aborted) break
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          if (delay) await Bun.sleep(delay)
        }
        if (!signal.aborted) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "chatcmpl-sandbox",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function done() {
  return { id: "chatcmpl-sandbox", object: "chat.completion.chunk", created: 1, model, choices: [], usage }
}

function toolFrames(reply: Extract<Plan, { kind: "tool" }>) {
  const call = {
    index: 0,
    id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name: reply.name, arguments: "" },
  }
  return [
    chunk({ role: "assistant", tool_calls: [call] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }),
    chunk({}, "tool_calls"),
    done(),
  ]
}

function textFrames(reply: Extract<Plan, { kind: "text" }>) {
  const reasoning = reply.reasoning
    ? reply.reasoning.split(/(?<= )/).map((word) => chunk({ reasoning_content: word }))
    : []
  const words = reply.text.split(/(?<=\s)/).map((word) => chunk({ content: word }))
  return [chunk({ role: "assistant", content: "" }), ...reasoning, ...words, chunk({}, "stop"), done()]
}

function completion(reply: Exclude<Plan, { kind: "fail" }>) {
  const message =
    reply.kind === "tool"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_sandbox",
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
      : { role: "assistant", content: reply.text }
  return {
    id: "chatcmpl-sandbox",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === "tool" ? "tool_calls" : "stop" }],
    usage,
  }
}
