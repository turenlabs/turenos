/**
 * Live check that the ChatGPT backend accepts client-executed tool search, before FORGE_NATIVE_TOOL_SEARCH is
 * turned on. It talks to the backend directly, not through this repo's protocol code, so it checks the backend's
 * contract rather than our lowering of it (the unit tests cover that).
 *
 *   CHATGPT_ACCESS_TOKEN=... CHATGPT_ACCOUNT_ID=... bun run script/smoke-tool-search.ts [model]
 *
 * It sends two small requests with your ChatGPT account, so it uses a little of your quota. The token comes only
 * from the environment: nothing is read from disk.
 *
 * 1. Declares `tool_search` and asks for a capability the model has no tool for. Expects a `tool_search_call`.
 * 2. Replays it with a `tool_search_output` that carries one deferred function. Expects a `function_call` to it,
 *    which proves the backend injects the loaded definition and lets the model call it.
 */

const endpoint = "https://chatgpt.com/backend-api/codex/responses"
const token = process.env["CHATGPT_ACCESS_TOKEN"]
const account = process.env["CHATGPT_ACCOUNT_ID"]
const model = process.argv[2] ?? "gpt-6-sol"

if (!token) {
  console.error("Set CHATGPT_ACCESS_TOKEN (and CHATGPT_ACCOUNT_ID if your account needs it).")
  process.exit(2)
}

type Item = Record<string, unknown> & { type?: string }

const searchTool = {
  type: "tool_search",
  execution: "client",
  description: "Search for tools by name or description and load the best matches.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    additionalProperties: false,
  },
}

const loadedTool = {
  type: "function",
  name: "notion_search",
  description: "Search Notion pages by keyword.",
  defer_loading: true,
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
}

const sessionID = crypto.randomUUID()

async function request(input: Item[]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: "opencode",
      "session-id": sessionID,
      ...(account ? { "ChatGPT-Account-Id": account } : {}),
    },
    body: JSON.stringify({
      model,
      instructions: "You are a test agent. When you lack a tool for a task, call tool_search to find one.",
      input,
      tools: [searchTool],
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: sessionID,
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`)
  const done: Item[] = []
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      if (!data || data === "[DONE]") continue
      const event = JSON.parse(data) as { type?: string; item?: Item; response?: { error?: { message?: string } } }
      if (event.type === "response.output_item.done" && event.item) done.push(event.item)
      if (event.type === "response.failed" || event.type === "error")
        throw new Error(`stream failed: ${JSON.stringify(event).slice(0, 600)}`)
    }
  }
  return done
}

const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
  if (!ok) {
    if (detail !== undefined) console.log(JSON.stringify(detail, null, 2).slice(0, 1_500))
    process.exit(1)
  }
}

const user = (text: string): Item => ({ role: "user", content: [{ type: "input_text", text }] })
const question = user("Find me a tool that can search Notion pages for 'launch plan', then use it.")

console.log(`model ${model}`)
const first = await request([question])
const searchCall = first.find((item) => item.type === "tool_search_call")
check(searchCall !== undefined, "the model emits a tool_search_call", first.map((item) => item.type))
check(searchCall!["execution"] === "client", "the call is client-executed", searchCall)
check(typeof searchCall!["call_id"] === "string", "the call carries a call_id to answer", searchCall)
console.log(`      arguments ${JSON.stringify(searchCall!["arguments"])}`)

const replay: Item[] = [
  question,
  // Reasoning is replayed without its id, as the store:false path does.
  ...first
    .filter((item) => item.type === "reasoning")
    .map((item) => ({ type: "reasoning", summary: item["summary"] ?? [], encrypted_content: item["encrypted_content"] })),
  {
    type: "tool_search_call",
    call_id: searchCall!["call_id"],
    execution: "client",
    arguments: searchCall!["arguments"],
  },
  {
    type: "tool_search_output",
    call_id: searchCall!["call_id"],
    status: "completed",
    execution: "client",
    tools: [loadedTool],
  },
]
const second = await request(replay)
const call = second.find((item) => item.type === "function_call")
check(call !== undefined, "the model calls the tool the search loaded", second.map((item) => item.type))
check(call!["name"] === "notion_search", "it calls the loaded function by name", call)
console.log(`      arguments ${String(call!["arguments"])}`)

console.log("\nThe backend accepts client-executed tool search. Safe to try FORGE_NATIVE_TOOL_SEARCH=true.")
