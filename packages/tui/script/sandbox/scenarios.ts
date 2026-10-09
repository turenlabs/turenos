/**
 * The scripted model's behaviour. The latest user message picks a scenario by its first matching
 * trigger word, so a person or an agent can exercise any TUI feature by typing a word.
 */
export type Message = { role: string; content?: unknown; tool_calls?: unknown[] }

export type Plan =
  | { kind: "text"; text: string; delay: number; reasoning?: string }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "fail"; status: number; message: string }

type Scenario = { trigger: RegExp; about: string; tool?: string; plan: (lower: string, prompt: string) => Plan }

const scenarios: Scenario[] = [
  // The factory prompts carry the outcome and room text, which may contain any trigger word below, so these two come first.
  {
    trigger: /return only factoryplan json/,
    about: "a Team factory coordinator's plan: one short assignment per selected teammate",
    plan: (_, prompt) => ({ kind: "text", text: factoryPlan(prompt), delay: 5 }),
  },
  {
    trigger: /return only factorycheck json/,
    about: "a Team factory coordinator's check: accepts the outputs",
    plan: () => ({
      kind: "text",
      text: JSON.stringify({ status: "accepted", summary: "Sandbox check accepted the outputs." }),
      delay: 5,
    }),
  },
  {
    trigger: /reply with one short line about the outcome/,
    about: "a Team factory worker's assignment (its prompt mentions the factory run, which would trigger run)",
    plan: () => ({ kind: "text", text: "Sandbox worker line: the outcome is covered.", delay: 5 }),
  },
  {
    trigger: /\brun\b/,
    about: "bash tool call (permission request when checks are on)",
    tool: "bash",
    plan: () => tool("bash", { command: "echo sandbox-marker && ls", description: "Print a marker and list files" }),
  },
  {
    trigger: /\bask twice\b/,
    about: "two questions, the second multiple choice",
    tool: "question",
    plan: () => tool("question", { questions: [colour, toppings] }),
  },
  {
    trigger: /\bask me\b/,
    about: "one single-choice question",
    tool: "question",
    plan: () => tool("question", { questions: [colour] }),
  },
  {
    trigger: /\bwrite\b/,
    about: "write tool creating notes.md (Changes view, undo)",
    tool: "write",
    plan: () => tool("write", { path: "notes.md", content: "# Notes\n\nWritten by the sandbox model.\n" }),
  },
  {
    trigger: /\bedit\b/,
    about: "edit tool changing answer.ts",
    tool: "edit",
    plan: () => tool("edit", { path: "answer.ts", oldString: "42", newString: "43" }),
  },
  {
    trigger: /\bread\b/,
    about: "read tool on README.md",
    tool: "read",
    plan: () => tool("read", { path: "README.md" }),
  },
  { trigger: /\btodo\b/, about: "todo list (Tasks view)", tool: "todowrite", plan: () => tool("todowrite", { todos }) },
  {
    trigger: /\bdelegate\b/,
    about: "subagent task (child session)",
    tool: "spawn_agent",
    plan: () =>
      tool("spawn_agent", {
        agent: "general",
        description: "Summarise the readme",
        prompt: `Summarise README.md in one sentence. ${childMarker}`,
      }),
  },
  {
    trigger: /\bslow\b/,
    about: "a long, slow stream (about 40 s; interrupt it)",
    plan: () => ({ kind: "text", text: numbered(300), delay: 120 }),
  },
  {
    trigger: /\blong\b/,
    about: "a long reply (scrolling and history)",
    plan: () => ({ kind: "text", text: paragraphs(60), delay: 2 }),
  },
  {
    trigger: /\bmarkdown\b/,
    about: "headings, lists, code, a table and a link",
    plan: () => ({ kind: "text", text: markdown, delay: 10 }),
  },
  {
    trigger: /\bthink\b/,
    about: "reasoning before the answer",
    plan: () => ({
      kind: "text",
      reasoning: "The user asked me to think. I will consider it briefly.",
      text: "Thought about it: the answer is 42.",
      delay: 20,
    }),
  },
  {
    trigger: /\bfail\b/,
    about: "the provider refuses the key (HTTP 401, not retried)",
    plan: () => ({ kind: "fail", status: 401, message: "sandbox provider refused the key" }),
  },
  {
    trigger: /\bflaky\b/,
    about: "HTTP 503 five times, then a reply (the server retries; about 10 s)",
    plan: (prompt) =>
      attempt(prompt) <= 5
        ? { kind: "fail", status: 503, message: "sandbox provider is busy" }
        : { kind: "text", text: "Recovered after the retries.", delay: 10 },
  },
]

/** Picks the reply for one chat request. */
export function plan(messages: Message[], tools: string[]): Plan {
  const user = messages.findLast((message) => message.role === "user")
  const prompt = text(user?.content)
  if (/^generate a title for this conversation:/i.test(prompt)) return { kind: "text", text: title(prompt), delay: 0 }
  // Server notices (a child's result, room updates) arrive as user messages that quote the human's
  // instruction inside a tag; answering their trigger word again would loop forever.
  if (prompt.trimStart().startsWith("<")) return { kind: "text", text: "Noted.", delay: 5 }
  // A delegated child answers plainly; otherwise it would see the trigger word and delegate again.
  if (messages.some((message) => message.role === "user" && text(message.content).includes(childMarker)))
    return { kind: "text", text: "Child summary: README.md introduces the sandbox project.", delay: 10 }
  // A Team task wraps the request in the teammate's mission and the room's history; only the request picks a
  // scenario, or a mission such as "Write summaries" or a past "Factory run …" would fire a tool on every task.
  const request = prompt.split(/\n\n(?:Earlier|Waiting) room messages[^\n]*untrusted context/)[0]!
  const asked = request.includes("User message: ") ? request.slice(request.lastIndexOf("User message: ")) : request
  const lower = asked.toLowerCase()
  const scenario = scenarios.find((item) => item.trigger.test(lower))
  const after = messages.slice(messages.lastIndexOf(user!) + 1)
  // A tool result after the prompt means the call already ran: finish instead of calling again.
  if (scenario?.tool && after.some((message) => message.role === "tool"))
    return {
      kind: "text",
      text: `Done: the ${scenario.tool} tool returned:\n\n${clip(text(after.findLast((message) => message.role === "tool")?.content), 400)}`,
      delay: 10,
    }
  if (scenario?.tool && !tools.includes(scenario.tool))
    return {
      kind: "text",
      text: `The server did not offer the ${scenario.tool} tool to this agent, so nothing ran.`,
      delay: 10,
    }
  if (scenario) return scenario.plan(lower, prompt)
  return { kind: "text", text: `Sandbox reply to: ${clip(prompt, 200)}\n\n${menu()}`, delay: 15 }
}

/** The trigger list, also printed by `sandbox start` and in every default reply. */
export function menu() {
  return [
    "Scripted model. Include one of these words to choose a reply:",
    ...scenarios.map((item) => `- ${item.trigger.source.replaceAll("\\b", "")}: ${item.about}`),
  ].join("\n")
}

export function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : "")).join("")
}

const childMarker = "[sandbox child task]"

const attempts = new Map<string, number>()

/** Counts requests for the same prompt, so a scenario can fail a set number of times. */
function attempt(prompt: string) {
  attempts.set(prompt, (attempts.get(prompt) ?? 0) + 1)
  return attempts.get(prompt)!
}

/** The factory prompt lists the selected teammate IDs as a JSON array; the plan gives each one a short task. */
function factoryPlan(prompt: string) {
  const ids: unknown = JSON.parse(/Selected IDs: (\[[^\]]*\])/.exec(prompt)?.[1] ?? "[]")
  return JSON.stringify({
    assignments: (Array.isArray(ids) ? ids : []).map((teammateID) => ({
      teammateID,
      prompt: "Reply with one short line about the outcome.",
    })),
  })
}

function tool(name: string, args: unknown): Plan {
  return { kind: "tool", name, args }
}

function clip(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** The first words of the conversation being titled, so sessions are distinguishable. */
function title(prompt: string) {
  const words = prompt
    .replace(/^[^:]*:/, "")
    .replace(/<[^>]+>/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words.slice(0, 6).join(" ") || "Sandbox session"
}

function numbered(count: number) {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ")
}

// Varied words, not a repeated sentence: the server ends a turn whose text starts repeating itself.
const vocabulary =
  "amber basin cedar delta ember fjord granite harbor island juniper kestrel lantern meadow nectar orchard pebble quartz river saffron tundra umber valley willow yarrow zephyr anchor beacon canyon dune estuary fern glacier heron inlet jade knoll lagoon maple".split(
    " ",
  )

function paragraphs(count: number) {
  const seed = { value: 7 }
  const word = () => {
    seed.value = (seed.value * 1103515245 + 12345) % 2147483648
    return vocabulary[(seed.value >>> 16) % vocabulary.length]
  }
  return Array.from(
    { length: count },
    (_, index) => `Paragraph ${index + 1}. ${Array.from({ length: 24 }, word).join(" ")}.`,
  ).join("\n\n")
}

const colour = {
  header: "Colour",
  question: "Which colour should the sandbox use?",
  options: [
    { label: "Red", description: "A warm colour" },
    { label: "Blue", description: "A cool colour" },
  ],
}

const toppings = {
  header: "Toppings",
  question: "Which toppings should the sandbox add?",
  multiple: true,
  options: [
    { label: "Cheese", description: "Melted" },
    { label: "Olives", description: "Black" },
    { label: "Basil", description: "Fresh" },
  ],
}

const todos = [
  { content: "Read the sandbox README", status: "completed", priority: "high" },
  { content: "Write the notes file", status: "in_progress", priority: "medium" },
  { content: "Review the changes", status: "pending", priority: "low" },
]

const markdown = [
  "# Sandbox heading",
  "",
  "Some **bold**, some _italic_ and some `inline code`.",
  "",
  "## A list",
  "",
  "- first item",
  "- second item with a [link](https://example.com)",
  "  - nested item",
  "",
  "1. numbered one",
  "2. numbered two",
  "",
  "```ts",
  "export const answer = 42",
  "```",
  "",
  "| Column | Value |",
  "| ------ | ----- |",
  "| alpha  | 1     |",
  "| beta   | 2     |",
  "",
  "> A quoted line.",
].join("\n")
