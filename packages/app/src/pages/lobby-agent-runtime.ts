import type { ForgeClient, SessionDurableEvent } from "@turenlabs/sdk/v2/client"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { assistantPublicText, type LobbyAgentSessionRuntime } from "./lobby-agent-controller"
import { lobbyDiagnosticError, type LobbyDiagnosticFields, type LobbyDiagnosticLevel } from "./lobby-diagnostics"

const LOBBY_AGENT_ID = "lobby"
const lobbySessionMetadata = (input: {
  lobbyBaseURL: string
  roomID: string
  agentMemberID: string
  capabilityProfile: LobbySession.CapabilityProfile
}) => ({
  "forge.internal": true,
  "forge.origin": "lobby",
  [LobbySession.MetadataKey]: {
    baseURL: input.lobbyBaseURL,
    roomID: input.roomID,
    agentMemberID: input.agentMemberID,
    capabilityProfile: input.capabilityProfile,
  },
})

export function createLobbyAgentSessionRuntime(input: {
  client(directory: string): ForgeClient
  diagnostic?(event: string, fields?: LobbyDiagnosticFields, level?: LobbyDiagnosticLevel): void
}): LobbyAgentSessionRuntime {
  const log = (
    event: string,
    sessionID: string,
    fields: LobbyDiagnosticFields = {},
    level: LobbyDiagnosticLevel = "info",
  ) => input.diagnostic?.(event, { sessionID, ...fields }, level)
  return {
    async ensure(options) {
      const startedAt = performance.now()
      const metadata = lobbySessionMetadata(options)
      log("runtime.ensure.started", options.sessionID)
      const client = input.client(options.directory)
      const session = await client.v2.session
        .get({ sessionID: options.sessionID }, { signal: options.signal })
        .then((response) => response.data?.data)
        .catch((error) => {
          if (!isNotFound(error)) throw error
          return undefined
        })
      if (!session) {
        log("runtime.session.create.started", options.sessionID)
        await client.v2.session.create(
          {
            id: options.sessionID,
            agent: LOBBY_AGENT_ID,
            model: options.model,
            metadata,
            location: { directory: options.directory },
          },
          { signal: options.signal },
        )
        log("runtime.ensure.completed", options.sessionID, {
          phase: "created",
          durationMs: Math.round(performance.now() - startedAt),
        })
        return
      }
      if (
        session.metadata?.["forge.internal"] !== true ||
        JSON.stringify(session.metadata?.[LobbySession.MetadataKey]) !==
          JSON.stringify(metadata[LobbySession.MetadataKey])
      )
        await client.session.update(
          { sessionID: options.sessionID, metadata: { ...session.metadata, ...metadata } },
          { signal: options.signal },
        )
      if (session.location.directory !== options.directory)
        throw new Error("The saved lobby agent session belongs to another project directory.")
      if (session.agent !== LOBBY_AGENT_ID)
        await client.v2.session.switchAgent(
          { sessionID: options.sessionID, agent: LOBBY_AGENT_ID },
          { signal: options.signal },
        )
      if (sameModel(session.model, options.model)) {
        log("runtime.ensure.completed", options.sessionID, {
          phase: "adopted",
          durationMs: Math.round(performance.now() - startedAt),
        })
        return
      }
      await client.v2.session.switchModel(
        { sessionID: options.sessionID, model: options.model },
        { signal: options.signal },
      )
      log("runtime.ensure.completed", options.sessionID, {
        phase: "adopted",
        durationMs: Math.round(performance.now() - startedAt),
      })
    },
    async respond(options) {
      const startedAt = performance.now()
      const client = input.client(options.directory)
      const cursor = await sessionCursor(client, options.sessionID, options.promptID, options.signal)
      log("runtime.cursor.loaded", options.sessionID, {
        promptID: options.promptID,
        cursor: cursor.latest,
        eventCount: cursor.eventCount,
        phase: cursor.assistantID ? "completed" : cursor.prompt ? "admitted" : "new",
      })
      if (cursor.assistantID) {
        log("runtime.message.read.started", options.sessionID, { promptID: options.promptID })
        const response = await client.v2.session.message(
          { sessionID: options.sessionID, messageID: cursor.assistantID },
          { signal: options.signal },
        )
        const text = response.data?.data ? assistantPublicText(response.data.data) : undefined
        if (text) {
          log("runtime.respond.completed", options.sessionID, {
            promptID: options.promptID,
            phase: "cached",
            durationMs: Math.round(performance.now() - startedAt),
            textLength: text.length,
          })
          return text
        }
      }
      log("runtime.prompt.started", options.sessionID, { promptID: options.promptID, cursor: cursor.latest })
      await client.v2.session.prompt(
        {
          sessionID: options.sessionID,
          id: options.promptID,
          prompt: { text: options.prompt },
          delivery: "queue",
          agent: LOBBY_AGENT_ID,
          model: options.model,
          resume: true,
        },
        { signal: options.signal },
      )
      log("runtime.prompt.admitted", options.sessionID, { promptID: options.promptID })
      const assistantID = await waitForAssistant(
        client,
        options.sessionID,
        options.promptID,
        cursor.latest,
        cursor.prompt > 0,
        options.signal,
        (event, fields, level) => log(event, options.sessionID, { promptID: options.promptID, ...fields }, level),
      )
      log("runtime.message.read.started", options.sessionID, { promptID: options.promptID })
      const response = await client.v2.session.message(
        { sessionID: options.sessionID, messageID: assistantID },
        { signal: options.signal },
      )
      const text = response.data?.data ? assistantPublicText(response.data.data) : undefined
      if (!text) throw new Error("The room agent completed without a public text response.")
      log("runtime.respond.completed", options.sessionID, {
        promptID: options.promptID,
        phase: "live",
        durationMs: Math.round(performance.now() - startedAt),
        textLength: text.length,
      })
      return text
    },
    async interrupt(sessionID, directory) {
      log("runtime.interrupt.started", sessionID)
      await input
        .client(directory)
        .v2.session.interrupt({ sessionID })
        .catch(() => undefined)
      log("runtime.interrupt.completed", sessionID)
    },
  }
}

async function sessionCursor(client: ForgeClient, sessionID: string, promptID: string, signal: AbortSignal) {
  let after = 0
  let eventCount = 0
  let prompt = 0
  let assistantID: string | undefined
  let completed = false
  for (;;) {
    const response = await client.v2.session.history({ sessionID, limit: 100, after: after || undefined }, { signal })
    const page = response.data!
    page.data.forEach((event) => {
      eventCount += 1
      after = Math.max(after, event.durable?.seq ?? 0)
      if (
        (event.type === "session.next.prompt.admitted" || event.type === "session.next.prompted") &&
        event.data.messageID === promptID
      )
        prompt = prompt || (event.durable?.seq ?? 0)
      if (event.type === "session.next.step.started" && prompt && (event.durable?.seq ?? 0) > prompt)
        assistantID = event.data.assistantMessageID
      if (
        event.type === "session.next.step.ended" &&
        event.data.assistantMessageID === assistantID &&
        event.data.finish !== "tool-calls" &&
        event.data.finish !== "unknown"
      )
        completed = true
    })
    if (!page.hasMore) return { latest: after, prompt, assistantID: completed ? assistantID : undefined, eventCount }
  }
}

async function waitForAssistant(
  client: ForgeClient,
  sessionID: string,
  promptID: string,
  after: number,
  admitted: boolean,
  signal: AbortSignal,
  log: (event: string, fields?: LobbyDiagnosticFields, level?: LobbyDiagnosticLevel) => void,
) {
  log("runtime.events.opened", { cursor: after })
  const events = await client.v2.session.events({ sessionID, after: after ? String(after) : undefined }, { signal })
  let prompted = admitted
  let assistantID: string | undefined
  for await (const value of events.stream) {
    const event = parseSessionEvent(value)
    if (
      (event?.type === "session.next.prompt.admitted" || event?.type === "session.next.prompted") &&
      event.data.messageID === promptID
    ) {
      prompted = true
      log("runtime.events.prompt_seen", { cursor: event.durable?.seq })
      continue
    }
    if (event?.type === "session.next.step.started" && prompted) {
      assistantID = event.data.assistantMessageID
      log("runtime.events.step_started", { cursor: event.durable?.seq })
      continue
    }
    if (event?.type === "session.next.step.failed" && event.data.assistantMessageID === assistantID) {
      log(
        "runtime.events.step_failed",
        { cursor: event.durable?.seq, ...lobbyDiagnosticError(event.data.error) },
        "error",
      )
      throw new Error(event.data.error.message)
    }
    if (event?.type !== "session.next.step.ended" || event.data.assistantMessageID !== assistantID) continue
    if (event.data.finish === "tool-calls" || event.data.finish === "unknown") continue
    log("runtime.events.step_ended", { cursor: event.durable?.seq })
    return event.data.assistantMessageID
  }
  log("runtime.events.closed", {}, "warn")
  throw new Error("The room agent event stream ended before completion.")
}

function parseSessionEvent(value: unknown): SessionDurableEvent | undefined {
  if (isSessionEvent(value)) return value
  if (!value || typeof value !== "object" || !("data" in value)) return
  if (typeof value.data !== "string") return isSessionEvent(value.data) ? value.data : undefined
  try {
    const parsed: unknown = JSON.parse(value.data)
    return isSessionEvent(parsed) ? parsed : undefined
  } catch {
    return
  }
}

function isSessionEvent(value: unknown): value is SessionDurableEvent {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.startsWith("session.next.") &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
  )
}

function sameModel(
  left: { providerID: string; id: string; variant?: string } | undefined,
  right: { providerID: string; id: string; variant?: string },
) {
  return (
    left?.providerID === right.providerID &&
    left.id === right.id &&
    (left.variant ?? "default") === (right.variant ?? "default")
  )
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  if ("status" in error && error.status === 404) return true
  return (
    "cause" in error &&
    !!error.cause &&
    typeof error.cause === "object" &&
    "status" in error.cause &&
    error.cause.status === 404
  )
}
