import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "../src/agent"
import { assistant, session, turen, type Route } from "./support"

// Never created: no saved servers, and nothing of the operator's is read.
export const home = join(tmpdir(), "turen-agent-test-home")

export function user(id: string, text: string) {
  return { id: `msg_${id}`, type: "user", time: { created: 1 }, text }
}

export const permission = (id = "per_1", extra: Record<string, unknown> = {}) => ({
  id,
  sessionID: "ses_main",
  action: "bash",
  resources: ["echo sandbox-marker && ls"],
  ...extra,
})

export const question = (id = "que_1", extra: Record<string, unknown> = {}) => ({
  id,
  sessionID: "ses_main",
  questions: [
    {
      header: "Pick a colour",
      question: "Which colour should the sandbox use?",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "cool" },
      ],
      custom: false,
    },
  ],
  ...extra,
})

/** What the fixture server believes, which tests change while a command runs. */
export type World = {
  active: Set<string>
  /** Oldest first. */
  messages: unknown[]
  permissions: unknown[]
  questions: unknown[]
  prompts: { id: string; sessionID?: string; prompt?: unknown; delivery?: string }[]
}

/**
 * A TurenOS-shaped server for `ses_main` whose messages page newest-first by offset cursor, and whose
 * prompt admission drops a repeated message ID, as the real server does.
 */
export function world(routes: Record<string, Route> = {}, password?: string) {
  const state: World = {
    active: new Set(),
    messages: [assistant("a", "hello", { finish: "stop" })],
    permissions: [],
    questions: [],
    prompts: [],
  }
  const server = turen({
    password,
    routes: {
      "GET /api/session/active": () => ({
        data: Object.fromEntries([...state.active].map((id) => [id, { type: "running" }])),
      }),
      "GET /api/session/ses_main/message": (_, url) => {
        const newest = state.messages.toReversed()
        const offset = Number(url.searchParams.get("cursor") ?? 0)
        const limit = Number(url.searchParams.get("limit") ?? 30)
        const next = offset + limit < newest.length ? String(offset + limit) : undefined
        return { data: newest.slice(offset, offset + limit), cursor: next ? { next } : {} }
      },
      "GET /api/session/ses_main/permission": () => ({ data: state.permissions }),
      "GET /api/session/ses_main/question": () => ({ data: state.questions }),
      "POST /api/session/ses_main/prompt": async (request) => {
        const body = (await request.json()) as World["prompts"][number]
        if (!state.prompts.some((item) => item.id === body.id)) {
          state.prompts.push(body)
          state.messages.push(user(body.id.slice(4), (body.prompt as { text: string }).text))
        }
        return { data: { id: body.id, sessionID: "ses_main" } }
      },
      ...routes,
    },
  })
  return { ...server, state, session: session("main") }
}

/**
 * Runs the agent CLI in-process against a server, with no terminal, capturing what it prints. `cwd` is the folder it
 * runs in; without it no folder applies, as for a command run in the home folder.
 */
export async function agent(
  args: string[],
  options: { url?: string; env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string } = {},
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runAgent(args, {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      ...(options.url ? { TURENOS_SERVER_URL: options.url } : {}),
      ...options.env,
    },
    cwd: options.cwd,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdin: { tty: options.stdin === undefined, read: async () => options.stdin ?? "" },
  })
  return { code, stdout: stdout.join(""), stderr: stderr.join("") }
}

/** The one JSON document a `--json` run prints. */
export const document = (result: { stdout: string }) => JSON.parse(result.stdout) as Record<string, unknown>

export const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  rootSessionID: "ses_main",
  parentSessionID: "ses_main",
  childSessionID: `ses_${id}`,
  agent: "explore",
  description: id,
  depth: 1,
  status: "running",
  revision: 1,
  time: { created: 1, updated: 1 },
  ...extra,
})

/** The server's slash-command inventory, with one command named `review`. */
export const inventory = {
  "GET /api/command": () => ({
    location: { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } },
    data: [{ name: "review", description: "Review a change", template: "Review $ARGUMENTS", subtask: false }],
  }),
}

export const refusal = () => Response.json({ _tag: "InvalidRequestError", message: "Prompt rejected" }, { status: 400 })
