import {
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk"
import { InstallationVersion } from "@turenlabs/core/installation/version"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import type { AssistantMessage, Message, ForgeClient, SessionMessageResponse } from "@turenlabs/sdk/v2"
import { Context, Effect, ManagedRuntime } from "effect"
import * as ACPError from "./error"
import { buildConfigOptions, parseModelSelection } from "./config-option"
import { promptContentToParts } from "./content"
import { Directory } from "./directory"
import { ACPEvent } from "./event"
import { ACPSession } from "./session"
import { UsageService } from "./usage"
import { ACPProfile } from "./profile"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"

export const AuthMethodID = "forge-login"

export type Error = ACPError.Error
type ServiceConnection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>

export type Interface = {
  readonly initialize: (input: InitializeRequest) => Effect.Effect<InitializeResponse, Error>
  readonly authenticate: (input: AuthenticateRequest) => Effect.Effect<AuthenticateResponse, Error>
  readonly newSession: (input: NewSessionRequest) => Effect.Effect<NewSessionResponse, Error>
  readonly loadSession: (input: LoadSessionRequest) => Effect.Effect<LoadSessionResponse, Error>
  readonly listSessions: (input: ListSessionsRequest) => Effect.Effect<ListSessionsResponse, Error>
  readonly resumeSession: (input: ResumeSessionRequest) => Effect.Effect<ResumeSessionResponse, Error>
  readonly closeSession: (input: CloseSessionRequest) => Effect.Effect<CloseSessionResponse, Error>
  readonly forkSession: (input: ForkSessionRequest) => Effect.Effect<ForkSessionResponse, Error>
  readonly setSessionConfigOption: (
    input: SetSessionConfigOptionRequest,
  ) => Effect.Effect<SetSessionConfigOptionResponse, Error>
  readonly setSessionMode: (input: SetSessionModeRequest) => Effect.Effect<SetSessionModeResponse, Error>
  readonly setSessionModel: (input: SetSessionModelRequest) => Effect.Effect<SetSessionModelResponse, Error>
  readonly prompt: (input: PromptRequest) => Effect.Effect<PromptResponse, Error>
  readonly cancel: (input: CancelNotification) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/ACP/Service") {}

export function make(input: {
  sdk: ForgeClient
  connection?: ServiceConnection
  directory?: Directory.Interface
  session?: ACPSession.Interface
  usage?: UsageService.Interface
  eventSubscription?: (subscription: ACPEvent.Subscription) => void
}): Interface {
  const session = input.session ?? makeSessionService()
  const directoryService = input.directory ?? makeDirectoryService()
  const sessionSnapshots = new Map<string, Directory.Snapshot>()
  const events = input.connection
    ? ACPEvent.start({ sdk: input.sdk, connection: input.connection, session })
    : undefined
  if (events) input.eventSubscription?.(events)

  const initialize = Effect.fn("ACP.initialize")(function* (params: InitializeRequest) {
    const started = performance.now()
    const authMethod: AuthMethod = {
      description: "Run `forge auth login` in the terminal",
      name: "Login with TurenOS",
      id: AuthMethodID,
    }

    if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
      authMethod._meta = {
        "terminal-auth": {
          command: "forge",
          args: ["auth", "login"],
          label: "TurenOS Login",
        },
      }
    }

    const response = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          close: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      authMethods: [authMethod],
      agentInfo: {
        name: "TurenOS",
        version: InstallationVersion,
      },
    }
    ACPProfile.duration("acp.initialize", started)
    return response
  })

  const authenticate = Effect.fn("ACP.authenticate")(function* (params: AuthenticateRequest) {
    if (params.methodId !== AuthMethodID) {
      return yield* new ACPError.UnknownAuthMethodError({ methodId: params.methodId })
    }
    return {}
  })

  const directorySnapshot = Effect.fn("ACP.directorySnapshot")(function* (cwd: string) {
    const started = performance.now()
    const snapshot = yield* directoryService.get(cwd)
    ACPProfile.duration("acp.directory.snapshot", started)
    return snapshot
  })

  const configSnapshot = Effect.fn("ACP.configSnapshot")(function* (state: ACPSession.Info) {
    const snapshot = sessionSnapshots.get(state.id)
    if (snapshot) return snapshot
    const loaded = yield* directorySnapshot(state.cwd)
    sessionSnapshots.set(state.id, loaded)
    return loaded
  })

  const newSession = Effect.fn("ACP.newSession")(function* (params: NewSessionRequest) {
    yield* rejectMcpServers(params.mcpServers)
    const started = performance.now()
    const snapshot = yield* directorySnapshot(params.cwd)
    const selected = selectDefaultModel(snapshot)
    const variant = selectVariant(snapshot, selected)
    const modeId = snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined
    const created = yield* profiledRequest(
      "acp.newSession.session.create",
      () =>
        input.sdk.session.create(
          {
            directory: params.cwd,
            ...(modeId ? { agent: modeId } : {}),
            model: {
              providerID: selected.providerID,
              id: selected.modelID,
              ...(variant ? { variant } : {}),
            },
          },
          { throwOnError: true },
        ),
      "session",
    )
    const state = yield* session.create({
      id: created.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model: selected,
      variant,
      modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* sendAvailableCommands(input.connection, state.id, snapshot)

    const response = {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? selected,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
    ACPProfile.duration("acp.newSession", started)
    return response
  })

  const loadSession = Effect.fn("ACP.loadSession")(function* (params: LoadSessionRequest) {
    yield* rejectMcpServers(params.mcpServers)
    const snapshot = yield* directorySnapshot(params.cwd)
    yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () => input.sdk.session.messages({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* sendAvailableCommands(input.connection, state.id, snapshot)
    yield* replayMessages(events, messages)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const listSessions = Effect.fn("ACP.listSessions")(function* (params: ListSessionsRequest) {
    const cursor = params.cursor ? Number(params.cursor) : undefined
    const limit = 100
    const sessions = yield* request(
      () =>
        input.sdk.session.list(
          {
            ...(params.cwd ? { directory: params.cwd } : {}),
            roots: true,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const serverEntries = sessions.map(
      (item): SessionInfo => ({
        sessionId: item.id,
        cwd: item.directory,
        title: item.title,
        updatedAt: new Date(item.time.updated).toISOString(),
      }),
    )
    const liveEntries = (yield* session.list(params.cwd ?? undefined))
      .filter((item) => !serverEntries.some((entry) => entry.sessionId === item.id))
      .map(
        (item): SessionInfo => ({
          sessionId: item.id,
          cwd: item.cwd,
          updatedAt: item.createdAt.toISOString(),
        }),
      )
    const sorted = [...liveEntries, ...serverEntries].toSorted(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
    )
    const filtered =
      cursor === undefined || !Number.isFinite(cursor)
        ? sorted
        : sorted.filter((item) => new Date(item.updatedAt ?? 0).getTime() < cursor)
    const page = filtered.slice(0, limit)
    const last = page.at(-1)
    return {
      sessions: page,
      ...(filtered.length > limit && last ? { nextCursor: String(new Date(last.updatedAt ?? 0).getTime()) } : {}),
    }
  })

  const resumeSession = Effect.fn("ACP.resumeSession")(function* (params: ResumeSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages(
          { directory: params.cwd, sessionID: params.sessionId, limit: 20 },
          { throwOnError: true },
        ),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* rejectMcpServers(params.mcpServers ?? [])
    yield* sendAvailableCommands(input.connection, state.id, snapshot)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const abortBackingSession = Effect.fn("ACP.abortBackingSession")(function* (current: ACPSession.Info) {
    yield* request(
      () => input.sdk.session.abort({ directory: current.cwd, sessionID: current.id }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("failed to abort ACP backing session", { error: error, sessionID: current.id }),
      ),
    )
  })

  const closeSession = Effect.fn("ACP.closeSession")(function* (params: CloseSessionRequest) {
    const removed = yield* session.remove(params.sessionId)
    sessionSnapshots.delete(params.sessionId)
    if (!removed) return {}

    yield* abortBackingSession(removed)
    return {}
  })

  const cancel = Effect.fn("ACP.cancel")(function* (params: CancelNotification) {
    const current = yield* session.get(params.sessionId)
    yield* abortBackingSession(current)
  })

  const forkSession = Effect.fn("ACP.forkSession")(function* (params: ForkSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const forked = yield* request(
      () =>
        input.sdk.session.fork(
          {
            directory: params.cwd,
            sessionID: params.sessionId,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages({ directory: params.cwd, sessionID: forked.id, limit: 20 }, { throwOnError: true }),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: forked.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* rejectMcpServers(params.mcpServers ?? [])
    yield* sendAvailableCommands(input.connection, state.id, snapshot)
    yield* replayMessages(events, messages)

    return {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const setSessionConfigOption = Effect.fn("ACP.setSessionConfigOption")(function* (
    params: SetSessionConfigOptionRequest,
  ) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (typeof params.value !== "string") {
      return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
    }

    if (params.configId === "model") {
      const selected = yield* parseSelectedModel(snapshot, params.value)
      const variant = selected.variant ?? selectVariant(snapshot, selected.model)
      const state = yield* session
        .setVariant(params.sessionId, Directory.variants(snapshot, selected.model) ? variant : undefined)
        .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selected.model,
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    if (params.configId === "effort") {
      const model = current.model ?? selectDefaultModel(snapshot)
      const variants = Directory.variants(snapshot, model)
      if (!variants || !Object.keys(variants).includes(params.value)) {
        return yield* new ACPError.InvalidEffortError({ effort: params.value })
      }
      const state = yield* session.setVariant(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? model,
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    if (params.configId === "mode") {
      if (!snapshot.availableModes.some((mode) => mode.id === params.value)) {
        return yield* new ACPError.InvalidModeError({ mode: params.value })
      }
      const state = yield* session.setMode(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selectDefaultModel(snapshot),
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
  })

  const setSessionMode = Effect.fn("ACP.setSessionMode")(function* (params: SetSessionModeRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (!snapshot.availableModes.some((mode) => mode.id === params.modeId)) {
      return yield* new ACPError.InvalidModeError({ mode: params.modeId })
    }
    yield* session.setMode(params.sessionId, params.modeId)
    return {}
  })

  const setSessionModel = Effect.fn("ACP.setSessionModel")(function* (params: SetSessionModelRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    const selected = yield* parseSelectedModel(snapshot, params.modelId)
    yield* session
      .setVariant(
        params.sessionId,
        Directory.variants(snapshot, selected.model)
          ? (selected.variant ?? selectVariant(snapshot, selected.model))
          : undefined,
      )
      .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
    return {}
  })

  return {
    initialize,
    authenticate,
    newSession,
    loadSession,
    listSessions,
    resumeSession,
    closeSession,
    forkSession,
    setSessionConfigOption,
    setSessionMode,
    setSessionModel,
    prompt: Effect.fn("ACP.prompt")(function* (params: PromptRequest) {
      const current = yield* session.get(params.sessionId)
      const snapshot = yield* directorySnapshot(current.cwd)
      const selected = current.model ?? selectDefaultModel(snapshot)
      if (!current.model) {
        yield* session.setModel(params.sessionId, selected)
      }
      const variant = current.variant ?? selectVariant(snapshot, selected)
      const modeId = current.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined)
      const parts = promptContentToParts(params.prompt)
      const command = detectSlashCommand(parts)

      if (!command) {
        const response = yield* request(
          () =>
            input.sdk.session.prompt(
              {
                sessionID: current.id,
                model: {
                  providerID: selected.providerID,
                  modelID: selected.modelID,
                },
                ...(variant ? { variant } : {}),
                parts,
                ...(modeId ? { agent: modeId } : {}),
                directory: current.cwd,
              },
              { throwOnError: true },
            ),
          "session",
        )
        yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId)
      }

      const known = snapshot.availableCommands.find((item) => item.name === command.name)
      if (known) {
        const response = yield* request(
          () =>
            input.sdk.session.command(
              {
                sessionID: current.id,
                command: known.name,
                arguments: command.args,
                model: `${selected.providerID}/${selected.modelID}`,
                ...(variant ? { variant } : {}),
                ...(modeId ? { agent: modeId } : {}),
                directory: current.cwd,
              },
              { throwOnError: true },
            ),
          "session",
        )
        yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId)
      }

      if (command.name === "compact") {
        yield* request(
          () =>
            input.sdk.session.summarize(
              {
                sessionID: current.id,
                directory: current.cwd,
                providerID: selected.providerID,
                modelID: selected.modelID,
              },
              { throwOnError: true },
            ),
          "session",
        )
      }

      yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
      return yield* promptResponse(undefined, params.messageId)
    }),
    cancel,
  }
}

function makeSessionService() {
  return ManagedRuntime.make(AppNodeBuilder.build(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function makeDirectoryService() {
  // ACP runs beside the server, so directory metadata comes from the same
  // internal provider, agent, command, and Extension-backed skill services.
  const runtime = ManagedRuntime.make(AppNodeBuilderV1.build(Directory.node))
  const ready = runtime.runPromise(Directory.Service.use((service) => Effect.succeed(service)))
  const use = <A>(f: (service: Directory.Interface) => Effect.Effect<A, Error>) =>
    Effect.promise(() => ready).pipe(Effect.flatMap(f))
  return {
    get: (directory: string) => use((service) => service.get(directory)),
    refresh: (directory: string) => use((service) => service.refresh(directory)),
    variants: Directory.variants,
  } satisfies Directory.Interface
}

function makeUsageService(sdk: ForgeClient) {
  return ManagedRuntime.make(
    AppNodeBuilderV1.build(UsageService.node, [[UsageService.messageLoaderNode, UsageService.messageLoaderLayer(sdk)]]),
  ).runSync(UsageService.Service.use((service) => Effect.succeed(service)))
}

function replayMessages(subscription: ACPEvent.Subscription | undefined, messages: SessionMessageResponse[]) {
  if (!subscription) return Effect.void
  return Effect.promise(async () => {
    for (const message of messages) {
      await subscription.replayMessage(message).catch(() => {})
    }
  })
}

type ConfigState = {
  readonly model: Directory.DefaultModel
  readonly variant?: string
  readonly modeId?: string
}

type SdkResponse<T> = {
  readonly data?: T
  readonly error?: unknown
}

type MessageInfo = {
  readonly role?: Message["role"]
  readonly model?: Extract<Message, { role: "user" }>["model"]
  readonly providerID?: Extract<Message, { role: "assistant" }>["providerID"]
  readonly modelID?: Extract<Message, { role: "assistant" }>["modelID"]
  readonly variant?: Extract<Message, { role: "assistant" }>["variant"]
  readonly mode?: Extract<Message, { role: "assistant" }>["mode"]
  readonly agent?: Message["agent"]
}

type AssistantError = NonNullable<AssistantMessage["error"]>
type AssistantInfo = (UsageService.AssistantTokenCost & Pick<AssistantMessage, "error">) | undefined

function request<T>(fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return Effect.tryPromise({
    try: async () => {
      const result = await fn()
      if (isSdkResponse<T>(result)) {
        if (result.error) throw result.error
        if (result.data !== undefined) return result.data
      }
      return result as T
    },
    catch: (error) => fromUnknownError(error, service),
  })
}

function profiledRequest<T>(name: string, fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return request(() => ACPProfile.measure(name, fn), service)
}

function selectDefaultModel(snapshot: Directory.Snapshot) {
  if (snapshot.defaultModel) return snapshot.defaultModel
  const model = snapshot.modelOptions[0]
  if (model) return { providerID: model.providerID, modelID: model.modelID }
  return { providerID: "unknown" as ProviderV2.ID, modelID: "unknown" as ModelV2.ID }
}

function detectSlashCommand(parts: ReturnType<typeof promptContentToParts>) {
  const text = parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
  if (!text.startsWith("/")) return

  const [name, ...rest] = text.slice(1).split(/\s+/)
  if (!name) return
  return { name, args: rest.join(" ").trim() }
}

const promptResponse = Effect.fn("ACP.promptResponse")(function* (
  info: AssistantInfo,
  messageId: string | null | undefined,
) {
  if (!info?.error) {
    return {
      stopReason: "end_turn" as const,
      ...(info ? { usage: UsageService.buildUsage(info) } : {}),
      ...(messageId ? { userMessageId: messageId } : {}),
      _meta: {},
    }
  }

  const base = {
    usage: UsageService.buildUsage(info),
    ...(messageId ? { userMessageId: messageId } : {}),
    _meta: {},
  }

  if (info.error.name === "MessageAbortedError") {
    return {
      stopReason: "cancelled" as const,
      ...base,
    }
  }

  if (info.error.name === "MessageOutputLengthError") {
    return {
      stopReason: "max_tokens" as const,
      ...base,
    }
  }

  if (info.error.name === "ContentFilterError") {
    return {
      stopReason: "refusal" as const,
      ...base,
    }
  }

  if (info.error.name === "ProviderAuthError") {
    return yield* new ACPError.AuthRequiredError({ providerId: info.error.data.providerID })
  }

  return yield* new ACPError.ServiceFailureError({
    service: "session",
    safeMessage: promptErrorMessage(info.error),
    errorName: info.error.name,
  })
})

function promptErrorMessage(error: AssistantError) {
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return "TurenOS prompt failed"
}

function sendUsageUpdate(
  usage: UsageService.Interface | undefined,
  sdk: ForgeClient,
  connection: ServiceConnection | undefined,
  sessionID: string,
  directory: string,
) {
  if (!connection) return Effect.void
  return (usage ?? makeUsageService(sdk)).sendUpdate({
    connection,
    sessionID,
    directory,
  })
}

function selectVariant(snapshot: Directory.Snapshot, model: Directory.DefaultModel) {
  const variants = Directory.variants(snapshot, model)
  if (!variants) return
  if (variants.default) return "default"
  return Object.keys(variants)[0]
}

function configOptions(snapshot: Directory.Snapshot, session: ConfigState) {
  return buildConfigOptions({
    providers: Object.values(snapshot.providers),
    currentModel: session.model,
    currentVariant: session.variant,
    modes: snapshot.availableModes,
    currentModeId: session.modeId,
  })
}

function parseSelectedModel(snapshot: Directory.Snapshot, modelId: string) {
  const selected = parseModelSelection(modelId, Object.values(snapshot.providers))
  const provider = snapshot.providers[ProviderV2.ID.make(selected.model.providerID)]
  const model = provider?.models[ModelV2.ID.make(selected.model.modelID)]
  if (!model) {
    return Effect.fail(
      new ACPError.InvalidModelError({
        providerId: selected.model.providerID,
        modelId,
      }),
    )
  }
  if (selected.variant && !model.variants?.[selected.variant]) {
    return Effect.fail(new ACPError.InvalidEffortError({ effort: selected.variant }))
  }
  return Effect.succeed({
    model: {
      providerID: provider.id,
      modelID: model.id,
    },
    variant: selected.variant,
  })
}

function sendAvailableCommands(
  connection: Pick<AgentSideConnection, "sessionUpdate"> | undefined,
  sessionId: string,
  snapshot: Directory.Snapshot,
) {
  if (!connection) return Effect.void
  return Effect.sync(() => {
    setTimeout(() => {
      void connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: snapshot.availableCommands.map((command) => ({
            name: command.name,
            description: command.description ?? "",
          })),
        },
      })
    }, 0)
  })
}

function rejectMcpServers(servers: readonly unknown[]) {
  if (servers.length === 0) return Effect.void
  return Effect.fail(new ACPError.McpServersUnsupportedError({ count: servers.length }))
}

function restoreFromMessages(messages: readonly MessageInfo[]) {
  const user = messages.findLast(
    (message) => message.role === "user" && message.model?.providerID && message.model.modelID,
  )
  if (user?.model?.providerID && user.model.modelID) {
    return {
      model: { providerID: user.model.providerID as ProviderV2.ID, modelID: user.model.modelID as ModelV2.ID },
      variant: user.model.variant,
      modeId: user.agent,
    }
  }

  const assistant = messages.findLast((message) => message.providerID && message.modelID)
  if (assistant?.providerID && assistant.modelID) {
    return {
      model: { providerID: assistant.providerID as ProviderV2.ID, modelID: assistant.modelID as ModelV2.ID },
      variant: assistant.variant,
      modeId: assistant.mode ?? assistant.agent,
    }
  }

  return {}
}

function isSdkResponse<T>(value: T | SdkResponse<T>): value is SdkResponse<T> {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

/**
 * A name for a failure we did not recognise, safe to hand to a client.
 *
 * Prefers an Effect tag, then the constructor name, then the error's own
 * `name`. Never the message, which is where user paths and provider payloads
 * would leak.
 */
function nameOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return typeof error === "string" ? undefined : typeof error
  const tag = (error as { _tag?: unknown })._tag
  if (typeof tag === "string" && tag) return tag
  const constructed = error.constructor?.name
  if (typeof constructed === "string" && constructed && constructed !== "Object") return constructed
  const name = (error as { name?: unknown }).name
  return typeof name === "string" && name ? name : undefined
}

function fromUnknownError(error: unknown, service?: string): Error {
  if (isACPError(error)) return error
  if (isAuthRequired(error)) {
    return new ACPError.AuthRequiredError({ providerId: findProviderID(error) })
  }
  // `safeMessage` is deliberately fixed, because it crosses the wire to an ACP
  // client that must not receive internal detail. `errorName` is the channel
  // built for the other half of that trade and was never filled, so every
  // unrecognised failure arrived as "TurenOS service failure" and nothing else —
  // no name, no tag, nothing to tell two unrelated faults apart in a log.
  return new ACPError.ServiceFailureError({ safeMessage: "TurenOS service failure", service, errorName: nameOf(error) })
}

function isACPError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("ACP")
  )
}

function isAuthRequired(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  if (value instanceof Error && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if (
    value instanceof Error &&
    (value.message.includes("ProviderAuthError") || value.message.includes("LoadAPIKeyError"))
  ) {
    return true
  }
  if ("name" in value && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if ("_tag" in value && (value._tag === "ProviderAuthError" || value._tag === "LoadAPIKeyError")) return true
  if ("error" in value && isAuthRequired(value.error)) return true
  if ("data" in value && isAuthRequired(value.data)) return true
  return false
}

function findProviderID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return
  if ("providerID" in value && typeof value.providerID === "string") return value.providerID
  if ("providerId" in value && typeof value.providerId === "string") return value.providerId
  if ("data" in value) return findProviderID(value.data)
  if ("error" in value) return findProviderID(value.error)
}
