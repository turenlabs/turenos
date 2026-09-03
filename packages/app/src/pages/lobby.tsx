import { useNavigate, useParams } from "@solidjs/router"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { useAgentsPanel } from "@/components/agents-panel-state"
import { PageHeader } from "@/components/page-header"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { useSettings } from "@/context/settings"
import { usePlatform } from "@/context/platform"
import { Persist, persisted, writePersisted } from "@/utils/persist"
import {
  createLobbyClient,
  isLobbyNetworkError,
  isLobbyRevisionConflict,
  loadLobbyRoom,
  lobbyErrorMessage,
  mergeLobbyMessages,
  type LobbyClient,
  type LobbyMember,
  type LobbyMessage,
  type LobbyPresence,
  type LobbyPresenceSnapshot,
  type LobbyRoom,
} from "./lobby-client"
import { createLobbyDirectoryController, type LobbyConnection } from "./lobby-directory-controller"
import {
  createLobbyAgentController,
  lobbyAgentHandle,
  lobbyAgentInstanceHandle,
  lobbyAgentKillSignal,
  lobbyAgentStorageKey,
  recoverLobbyAgentMappings,
  type LobbyAgentMapping,
  type LobbyAgentModel,
} from "./lobby-agent-controller"
import { createLobbyAgentSessionRuntime } from "./lobby-agent-runtime"
import {
  emptyLobbyAgentStore,
  lobbyAgentStoreNormalizer,
  lobbyRoomAgentDrafts,
  lobbyRoomAgentMappings,
  removeLobbyRoomAgents,
  removeLobbyAgentMapping,
  setLobbyPendingAgents,
  snapshotLobbyAgentDrafts,
  snapshotLobbyAgentStore,
  upsertLobbyAgentMapping,
  type LobbyAgentDraft,
  type LobbyAgentStore,
} from "./lobby-agent-store"
import { lobbyConnectionLabel, lobbyParticipantPresence, lobbyRoomIsActive } from "./lobby-view"
import {
  lobbyDiagnostic,
  lobbyDiagnosticError,
  lobbyDiagnosticsSnapshot,
  subscribeLobbyDiagnostics,
} from "./lobby-diagnostics"

export default function LobbyPage() {
  const params = useParams<{ roomID?: string }>()
  const navigate = useNavigate()
  const settings = useSettings()
  const models = useModels()
  const panel = useAgentsPanel()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const agentStorage = {
    ...Persist.global("lobby-agents"),
    migrate: lobbyAgentStoreNormalizer,
  }
  const [agents, setAgents, , agentsReady] = persisted(agentStorage, createStore(emptyLobbyAgentStore()))
  let persistQueue = Promise.resolve()

  const directory = createMemo(() => panel.selectedProject()?.worktree ?? panel.newSessionProject()?.worktree)
  const runtime = createLobbyAgentSessionRuntime({
    client: (target) => serverSDK().createClient({ directory: target, throwOnError: true }),
    diagnostic: lobbyDiagnostic,
  })
  const updateAgents = (update: (store: LobbyAgentStore) => LobbyAgentStore) => {
    const next = update(snapshotLobbyAgentStore(agents))
    setAgents(reconcile(next))
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(async () => {
        await writePersisted(agentStorage, platform, next)
      })
    return persistQueue
  }

  return (
    <LobbyWorkspace
      roomID={() => params.roomID}
      baseURL={settings.general.lobbyAPIURL}
      navigate={(roomID) => navigate(`/lobby/${encodeURIComponent(roomID)}`)}
      models={models}
      runtime={runtime}
      directory={directory}
      mappingsReady={agentsReady}
      loadMappings={(baseURL, roomID) => lobbyRoomAgentMappings(agents, lobbyAgentStorageKey(baseURL, roomID))}
      loadPendingAgents={(baseURL, roomID) => lobbyRoomAgentDrafts(agents, lobbyAgentStorageKey(baseURL, roomID))}
      recoverMappings={async (room, messages) => {
        const target = directory()
        if (!target) return []
        try {
          const response = await serverSDK()
            .createClient({ directory: target, throwOnError: true })
            .v2.session.list({ internal: "lobby", limit: 200, order: "desc" })
          return recoverLobbyAgentMappings(room, messages, response.data?.data ?? [], settings.general.lobbyAPIURL())
        } catch {
          return []
        }
      }}
      savePendingAgents={(baseURL, roomID, drafts) =>
        updateAgents((store) => setLobbyPendingAgents(store, lobbyAgentStorageKey(baseURL, roomID), drafts))
      }
      saveMapping={(mapping) =>
        updateAgents((store) =>
          upsertLobbyAgentMapping(store, lobbyAgentStorageKey(mapping.lobbyBaseURL, mapping.roomID), mapping),
        )
      }
      clearRoomAgents={(baseURL, roomID) =>
        updateAgents((store) => removeLobbyRoomAgents(store, lobbyAgentStorageKey(baseURL, roomID)))
      }
      removeAgent={(baseURL, roomID, instanceID) =>
        updateAgents((store) => removeLobbyAgentMapping(store, lobbyAgentStorageKey(baseURL, roomID), instanceID))
      }
      subscribeKill={lobbyAgentKillSignal.subscribe}
      killGeneration={lobbyAgentKillSignal.generation}
    />
  )
}

export function LobbyWorkspace(props: {
  roomID: () => string | undefined
  baseURL: () => string
  navigate(roomID: string): void
  createClient?: (baseURL: string) => LobbyClient
  models?: ReturnType<typeof useModels>
  runtime?: import("./lobby-agent-controller").LobbyAgentSessionRuntime
  directory?: () => string | undefined
  mappingsReady?: () => boolean
  loadMappings?: (baseURL: string, roomID: string) => LobbyAgentMapping[]
  loadPendingAgents?: (baseURL: string, roomID: string) => LobbyAgentDraft[]
  recoverMappings?: (room: LobbyRoom, messages: readonly LobbyMessage[]) => Promise<LobbyAgentMapping[]>
  savePendingAgents?: (baseURL: string, roomID: string, drafts: LobbyAgentDraft[] | undefined) => Promise<void> | void
  saveMapping?: (mapping: LobbyAgentMapping) => Promise<void> | void
  clearRoomAgents?: (baseURL: string, roomID: string) => Promise<void> | void
  removeAgent?: (baseURL: string, roomID: string, instanceID: string) => Promise<void> | void
  subscribeKill?: (listener: () => void) => VoidFunction
  killGeneration?: () => number
}) {
  const settings = useSettings()
  const [wizard, setWizard] = createStore({
    mode: undefined as "create" | "join" | undefined,
    step: 1 as 1 | 2,
    room: "",
    agents: [] as LobbyAgentDraft[],
  })
  const [draft, setDraft] = createSignal("")
  const [idempotencyKey, setIdempotencyKey] = createSignal(newActionID())
  const [agentMappings, setAgentMappings] = createSignal<LobbyAgentMapping[]>([])
  const [mentionQuery, setMentionQuery] = createSignal<string | undefined>()
  const [mentionStart, setMentionStart] = createSignal(-1)
  const [mentionIndex, setMentionIndex] = createSignal(0)
  const [renameDraft, setRenameDraft] = createSignal("")
  const [editingRoom, setEditingRoom] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [composerFocused, setComposerFocused] = createSignal(false)
  const [showDiagnostics, setShowDiagnostics] = createSignal(false)
  const [diagnostics, setDiagnostics] = createSignal(lobbyDiagnosticsSnapshot())
  let messageInput!: HTMLTextAreaElement
  const [state, setState] = createStore({
    rooms: [] as LobbyRoom[],
    selectedID: undefined as string | undefined,
    room: undefined as LobbyRoom | undefined,
    messages: [] as LobbyMessage[],
    presence: {} as Record<string, LobbyPresence | undefined>,
    connection: "not_configured" as LobbyConnection,
    error: undefined as string | undefined,
    loading: false,
    creating: false,
    joining: false,
    sending: false,
    renaming: false,
    deleting: false,
    leaving: false,
  })
  let roomRequest: AbortController | undefined
  let streamRequest: AbortController | undefined
  let streamRetry: ReturnType<typeof setTimeout> | undefined
  let presenceHeartbeat: ReturnType<typeof setInterval> | undefined
  let typingTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribeDiagnostics = subscribeLobbyDiagnostics((entries) => setDiagnostics(entries.slice()))
  onCleanup(unsubscribeDiagnostics)
  let roomGeneration = 0
  let previousBaseURL: string | undefined
  const agentControllers = new Map<string, ReturnType<typeof createLobbyAgentController>>()
  let agentLoadGeneration = 0
  const mutations = new Set<AbortController>()
  const directory = createLobbyDirectoryController({
    createClient: props.createClient ?? ((baseURL) => createLobbyClient({ baseURL, diagnostic: lobbyDiagnostic })),
    onState: (next) => setState({ connection: next.connection, rooms: next.rooms, error: next.error }),
  })

  const actorID = createMemo(() => settings.general.lobbyGuestID())
  const identityName = createMemo(() => settings.general.lobbyGuestName().trim() || "TurenOS guest")
  const selectedMember = createMemo(() => state.room?.members.find((member) => member.id === actorID()))
  const typingMembers = createMemo(() =>
    (state.room?.members ?? []).filter((member) => member.id !== actorID() && state.presence[member.id]?.typing),
  )
  const roomDiagnostics = createMemo(() => {
    const roomID = state.room?.id
    return diagnostics()
      .filter((entry) => !entry.roomID || entry.roomID === roomID)
      .slice(-30)
  })
  const mentionCandidates = createMemo(() => {
    const query = mentionQuery()
    if (query === undefined) return []
    return (state.room?.members ?? [])
      .filter((member) => member.type !== "system")
      .map((member) => ({ member, handle: lobbyMemberHandle(member, agentMappings()) }))
      .filter((item) => item.handle.includes(query.toLowerCase()))
      .slice(0, 8)
  })
  const findModel = (model: LobbyAgentModel | undefined) =>
    model && props.models ? props.models.find({ providerID: model.providerID, modelID: model.id }) : undefined
  const modelPicker = (draft: LobbyAgentDraft) => {
    if (!props.models) return
    return {
      current: () => findModel(draft.model),
      list: props.models.list,
      recent: () =>
        props
          .models!.recent.list()
          .map(props.models!.find)
          .filter((model) => !!model),
      set: (model: { providerID: string; modelID: string } | undefined) =>
        updateWizardAgent(draft.id, model ? { providerID: model.providerID, id: model.modelID } : undefined),
      visible: props.models.visible,
    }
  }

  const updateWizardAgent = (id: string, model: LobbyAgentModel | undefined, name?: string) => {
    setWizard("agents", (agents) =>
      agents.map((agent) => (agent.id === id ? { ...agent, model, name: name ?? agent.name } : agent)),
    )
  }
  const updateWizardCapability = (id: string, capabilityProfile: LobbySession.CapabilityProfile) =>
    setWizard("agents", (agents) => agents.map((agent) => (agent.id === id ? { ...agent, capabilityProfile } : agent)))
  const addWizardAgent = () =>
    setWizard("agents", (agents) => [...agents, nextLobbyAgentDraft(agents.length, agentMappings())])
  const closeWizard = () => setWizard({ mode: undefined, step: 1, room: "", agents: [] })

  const stopAgentControllers = () => {
    const roomID = state.room?.id
    for (const mapping of agentMappings())
      publishPresence({ id: mapping.agentMemberID, type: "agent" }, "offline", false, roomID)
    agentControllers.forEach((controller) => controller.dispose())
    agentControllers.clear()
  }
  const updateAgentMapping = (next: LobbyAgentMapping | undefined) => {
    if (!next) return
    setAgentMappings((mappings) =>
      [...mappings.filter((mapping) => mapping.instanceID !== next.instanceID), next].toSorted((left, right) =>
        left.instanceID.localeCompare(right.instanceID),
      ),
    )
  }
  const createAgentController = (mapping: LobbyAgentMapping | undefined, instanceID: string) => {
    const roomID = props.roomID()
    const client = directory.client()
    if (!roomID || !client || !props.runtime || !props.saveMapping) return
    const controller = createLobbyAgentController({
      client,
      runtime: props.runtime,
      load: () =>
        props.loadMappings?.(props.baseURL(), roomID).find((candidate) => candidate.instanceID === instanceID) ??
        mapping,
      save: props.saveMapping,
      onState: (next) => {
        if (props.roomID() !== roomID || !next) return
        updateAgentMapping(next)
        publishPresence(
          { id: next.agentMemberID, type: "agent" },
          next.status === "stopped" ? "offline" : "online",
          next.status === "responding",
        )
      },
      onRoom: (joined) => {
        if (props.roomID() !== roomID || state.selectedID !== joined.id) return
        const projected = mergeRoomMembers(joined, state.room)
        remember(projected)
        setState("room", projected)
      },
      onMessage: (message) => {
        if (props.roomID() === roomID) applyMessage(message)
      },
      subscribeKill: props.subscribeKill,
      killGeneration: props.killGeneration,
      diagnostic: lobbyDiagnostic,
    })
    agentControllers.set(instanceID, controller)
    return controller
  }
  const loadAgentControllers = async (room = state.room) => {
    const loadGeneration = ++agentLoadGeneration
    stopAgentControllers()
    const roomID = props.roomID()
    if (!roomID || !props.loadMappings) {
      setAgentMappings([])
      return
    }
    let mappings = props.loadMappings(props.baseURL(), roomID)
    if (!mappings.length && room && props.recoverMappings) {
      const recovered = await props.recoverMappings(room, state.messages)
      if (loadGeneration !== agentLoadGeneration || props.roomID() !== roomID) return
      await Promise.all(recovered.map((mapping) => props.saveMapping?.(mapping)))
      mappings = recovered
    }
    if (loadGeneration !== agentLoadGeneration || props.roomID() !== roomID) return
    setAgentMappings(mappings)
    await Promise.all(
      mappings.map(async (mapping) => {
        const controller = createAgentController(mapping, mapping.instanceID)
        if (mapping.status === "stopped" || !controller) return
        await controller.adopt(identity())
        controller.messages(state.messages, room)
      }),
    )
  }

  createEffect(() => {
    if (!actorID()) settings.general.setLobbyGuestID(`forge-guest-${newActionID()}`)
  })

  const identity = (): Omit<LobbyMember, "joined_at"> => ({ id: actorID(), type: "human", name: identityName() })
  const updateMentionState = (value: string, cursor: number) => {
    const match = value.slice(0, cursor).match(/(?:^|\s)@([a-z0-9-]*)$/i)
    if (!match) {
      setMentionQuery(undefined)
      setMentionStart(-1)
      return
    }
    setMentionQuery(match[1]!.toLowerCase())
    setMentionStart(cursor - match[1]!.length - 1)
    setMentionIndex(0)
  }
  const insertMention = (handle: string) => {
    const start = mentionStart()
    if (start < 0 || !messageInput) return
    const value = draft()
    const cursor = messageInput.selectionStart
    const next = `${value.slice(0, start)}@${handle} ${value.slice(cursor)}`
    const nextCursor = start + handle.length + 2
    setDraft(next)
    setIdempotencyKey(newActionID())
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      messageInput.focus()
      messageInput.setSelectionRange(nextCursor, nextCursor)
    })
  }
  const remember = (room: LobbyRoom) => {
    setState("rooms", (rooms) =>
      [...rooms.filter((item) => item.id !== room.id), room].toSorted((left, right) => left.id.localeCompare(right.id)),
    )
  }
  const applyPresence = (snapshot: LobbyPresenceSnapshot) => {
    if (snapshot.room_id !== state.selectedID) return
    setState(
      "presence",
      reconcile(Object.fromEntries(snapshot.members.map((presence) => [presence.member_id, presence]))),
    )
  }
  const publishPresence = (
    member: Pick<LobbyMember, "id" | "type">,
    presenceState: "online" | "away" | "offline",
    typing: boolean,
    roomID = state.room?.id,
  ) => {
    if (member.type === "system" || !roomID) return
    const client = directory.client()
    if (!client) return
    void client
      .setPresence(roomID, {
        actor_id: member.id,
        actor_type: member.type,
        state: presenceState,
        typing,
      })
      .then(applyPresence)
      .catch(() => undefined)
  }
  const applyMessage = (message: LobbyMessage) => {
    if (message.room_id !== state.selectedID) return
    const projectedRoom = state.room ? { ...state.room, head: Math.max(state.room.head, message.sequence) } : state.room
    setState("messages", (messages) => mergeLobbyMessages(messages, [message]))
    setState("room", projectedRoom)
    if (projectedRoom) remember(projectedRoom)
    agentControllers.forEach((controller) => controller.messages([message], projectedRoom))
  }
  const stopRoomLoad = () => {
    roomRequest?.abort()
    roomRequest = undefined
  }
  const stopRoomStream = () => {
    streamRequest?.abort()
    streamRequest = undefined
    if (streamRetry !== undefined) clearTimeout(streamRetry)
    streamRetry = undefined
    setState("presence", reconcile({}))
  }
  createEffect(() => {
    const roomID = state.room?.id
    const member = selectedMember()
    if (!roomID || !member || member.type === "system") return
    const publishCurrentPresence = () =>
      publishPresence(
        member,
        document.visibilityState === "hidden" ? "away" : "online",
        untrack(composerFocused) && Boolean(untrack(draft).trim()),
        roomID,
      )
    publishCurrentPresence()
    document.addEventListener("visibilitychange", publishCurrentPresence)
    presenceHeartbeat = setInterval(() => {
      publishPresence(
        member,
        document.visibilityState === "hidden" ? "away" : "online",
        untrack(composerFocused) && Boolean(untrack(draft).trim()),
        roomID,
      )
      for (const mapping of untrack(agentMappings)) {
        if (mapping.status !== "stopped")
          publishPresence(
            { id: mapping.agentMemberID, type: "agent" },
            "online",
            mapping.status === "responding",
            roomID,
          )
      }
    }, 15_000)
    onCleanup(() => {
      if (presenceHeartbeat !== undefined) clearInterval(presenceHeartbeat)
      presenceHeartbeat = undefined
      document.removeEventListener("visibilitychange", publishCurrentPresence)
      publishPresence(member, "offline", false, roomID)
    })
  })
  createEffect(() => {
    const roomID = state.room?.id
    const member = selectedMember()
    const typing = composerFocused() && Boolean(draft().trim())
    if (typingTimer !== undefined) clearTimeout(typingTimer)
    if (!roomID || !member || member.type === "system") return
    typingTimer = setTimeout(() => publishPresence(member, "online", typing, roomID), 250)
    onCleanup(() => {
      if (typingTimer !== undefined) clearTimeout(typingTimer)
      typingTimer = undefined
    })
  })
  const closeDeletedRoom = async (room: LobbyRoom) => {
    stopRoomStream()
    await Promise.all([...agentControllers.values()].map((controller) => controller.stop()))
    stopAgentControllers()
    await props.clearRoomAgents?.(props.baseURL(), room.id)
    setAgentMappings([])
    setState({
      rooms: state.rooms.filter((item) => item.id !== room.id),
      selectedID: undefined,
      room: undefined,
      messages: [],
      presence: {},
      loading: false,
    })
    directory.refresh(props.baseURL())
    props.navigate("")
  }
  const streamRoom = (client: LobbyClient, roomID: string, after: number, generation: number) => {
    stopRoomStream()
    const controller = new AbortController()
    streamRequest = controller
    let cursor = after
    const startedAt = performance.now()
    lobbyDiagnostic("stream.connecting", { roomID, cursor })
    void client
      .stream(
        roomID,
        cursor,
        {
          open: () => {
            if (controller.signal.aborted || generation !== roomGeneration || state.selectedID !== roomID) return
            lobbyDiagnostic("stream.opened", {
              roomID,
              cursor,
              durationMs: Math.round(performance.now() - startedAt),
            })
            setState({ connection: "connected", error: undefined })
          },
          message: (message) => {
            if (controller.signal.aborted || generation !== roomGeneration || state.selectedID !== roomID) return
            cursor = Math.max(cursor, message.sequence)
            lobbyDiagnostic("stream.message", { roomID, sequence: message.sequence, cursor })
            applyMessage(message)
          },
          room: (projection) => {
            if (controller.signal.aborted || generation !== roomGeneration || state.selectedID !== roomID) return
            cursor = Math.max(cursor, projection.sequence)
            lobbyDiagnostic("stream.room_updated", {
              roomID,
              sequence: projection.sequence,
              cursor,
              revision: projection.room.head,
              memberCount: projection.room.members.length,
            })
            remember(projection.room)
            setState("room", projection.room)
          },
          deleted: (projection) => {
            if (controller.signal.aborted || generation !== roomGeneration || state.selectedID !== roomID) return
            cursor = Math.max(cursor, projection.sequence)
            lobbyDiagnostic("stream.room_deleted", { roomID, sequence: projection.sequence, cursor }, "warn")
            void closeDeletedRoom(projection.room)
          },
          presence: (snapshot) => {
            lobbyDiagnostic("stream.presence", {
              roomID,
              presenceVersion: snapshot.version,
              memberCount: snapshot.members.length,
            })
            applyPresence(snapshot)
          },
          cursor: (sequence) => {
            cursor = Math.max(cursor, sequence)
          },
        },
        controller.signal,
      )
      .then(
        () => {
          if (controller.signal.aborted || generation !== roomGeneration || state.selectedID !== roomID) return
          lobbyDiagnostic(
            "stream.closed",
            { roomID, cursor, durationMs: Math.round(performance.now() - startedAt) },
            "warn",
          )
          setState({ connection: "offline", error: "The lobby stream disconnected. Reconnecting..." })
          streamRetry = setTimeout(() => streamRoom(client, roomID, cursor, generation), 1_000)
        },
        (error: unknown) => {
          if (controller.signal.aborted || generation !== roomGeneration || state.selectedID !== roomID) return
          lobbyDiagnostic(
            "stream.failed",
            {
              roomID,
              cursor,
              durationMs: Math.round(performance.now() - startedAt),
              ...lobbyDiagnosticError(error),
            },
            "error",
          )
          setState({
            connection: isLobbyNetworkError(error) ? "offline" : "local_error",
            error: lobbyErrorMessage(error, "The lobby stream disconnected."),
          })
          if (isLobbyNetworkError(error))
            streamRetry = setTimeout(() => streamRoom(client, roomID, cursor, generation), 1_000)
        },
      )
  }
  const loadSelectedRoom = () => {
    roomGeneration += 1
    const current = roomGeneration
    stopRoomLoad()
    stopRoomStream()
    const roomID = props.roomID()
    const client = directory.client()
    if (!roomID || !client) {
      setState({ selectedID: undefined, room: undefined, messages: [], loading: false })
      return
    }
    const controller = new AbortController()
    const startedAt = performance.now()
    roomRequest = controller
    setState({ selectedID: roomID, room: undefined, messages: [], loading: true })
    lobbyDiagnostic("room.load.started", { roomID })
    void loadLobbyRoom(client, roomID, controller.signal).then(
      async (history) => {
        if (controller.signal.aborted || current !== roomGeneration) return
        if (history.room.deleted_at) {
          await closeDeletedRoom(history.room)
          return
        }
        const projected = mergeRoomMembers(history.room, state.room)
        lobbyDiagnostic("room.load.completed", {
          roomID,
          revision: projected.head,
          cursor: history.ledgerAfter,
          eventCount: history.messages.length,
          memberCount: projected.members.length,
          durationMs: Math.round(performance.now() - startedAt),
        })
        remember(projected)
        setState({ room: projected, messages: history.messages, loading: false, error: undefined })
        await loadAgentControllers(projected)
        void startPendingAgents(history.room)
        streamRoom(client, roomID, history.ledgerAfter, current)
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== roomGeneration) return
        lobbyDiagnostic(
          "room.load.failed",
          { roomID, durationMs: Math.round(performance.now() - startedAt), ...lobbyDiagnosticError(error) },
          "error",
        )
        setState({
          loading: false,
          connection: isLobbyNetworkError(error) ? "offline" : "local_error",
          error: lobbyErrorMessage(error, "The selected room could not be loaded."),
        })
      },
    )
  }
  const refresh = () => {
    directory.refresh(props.baseURL())
    loadSelectedRoom()
  }

  const revisionMutation = async (run: (baseRevision: number) => Promise<LobbyRoom>) => {
    const client = directory.client()
    const selected = state.room
    if (!client || !selected) throw new Error("The selected room is unavailable.")
    const roomID = selected.id
    let room = selected
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await run(room.head)
      } catch (error) {
        if (!isLobbyRevisionConflict(error)) throw error
        room = await client.snapshot(roomID)
      }
    }
    throw new Error("The room changed too frequently. Try again.")
  }
  const renameRoom = async () => {
    const room = state.room
    const client = directory.client()
    const name = renameDraft().trim()
    if (!room || !client || !selectedMember() || !name) return
    const key = `rename-${newActionID()}`
    setState({ renaming: true, error: undefined })
    try {
      const updated = await revisionMutation((base_revision) =>
        client.updateRoom(room.id, {
          actor_id: actorID(),
          actor_type: "human",
          name,
          base_revision,
          idempotency_key: key,
        }),
      )
      remember(updated)
      setState("room", updated)
      directory.refresh(props.baseURL())
      setEditingRoom(false)
    } catch (error) {
      setState("error", lobbyErrorMessage(error, "The room could not be renamed."))
    } finally {
      setState("renaming", false)
    }
  }
  const deleteRoom = async () => {
    const room = state.room
    const client = directory.client()
    if (!room || !client || !selectedMember()) return
    const key = `delete-${newActionID()}`
    setState({ deleting: true, error: undefined })
    try {
      const deleted = await revisionMutation((base_revision) =>
        client.deleteRoom(room.id, {
          actor_id: actorID(),
          actor_type: "human",
          base_revision,
          idempotency_key: key,
        }),
      )
      await closeDeletedRoom(deleted)
    } catch (error) {
      setState("error", lobbyErrorMessage(error, "The room could not be deleted."))
    } finally {
      setState("deleting", false)
      setConfirmDelete(false)
    }
  }
  const leaveRoomMember = (memberID: string, memberType: "human" | "agent", key: string) => {
    const client = directory.client()
    const roomID = state.room?.id
    if (!client || !roomID) throw new Error("The selected room is unavailable.")
    return revisionMutation((base_revision) =>
      client.leave(roomID, memberID, {
        actor_id: memberID,
        actor_type: memberType,
        base_revision,
        idempotency_key: key,
      }),
    ).then((updated) => {
      remember(updated)
      setState("room", updated)
      return updated
    })
  }
  const leaveRoom = async () => {
    const room = state.room
    if (!room || !selectedMember()) return
    setState({ leaving: true, error: undefined })
    try {
      for (const mapping of agentMappings()) {
        await agentControllers.get(mapping.instanceID)?.stop()
        if (state.room?.members.some((member) => member.id === mapping.agentMemberID))
          await leaveRoomMember(mapping.agentMemberID, "agent", `leave-${mapping.instanceID}`)
      }
      publishPresence(identity(), "offline", false, room.id)
      await leaveRoomMember(actorID(), "human", `leave-${newActionID()}`)
      stopRoomStream()
      stopAgentControllers()
      await props.clearRoomAgents?.(props.baseURL(), room.id)
      setAgentMappings([])
      setState({ selectedID: undefined, room: undefined, messages: [], presence: {}, loading: false })
      props.navigate("")
    } catch (error) {
      setState("error", lobbyErrorMessage(error, "The room could not be left."))
    } finally {
      setState("leaving", false)
    }
  }
  const leaveAgent = async (mapping: LobbyAgentMapping) => {
    setState("error", undefined)
    try {
      await agentControllers.get(mapping.instanceID)?.stop()
      if (state.room?.members.some((member) => member.id === mapping.agentMemberID))
        await leaveRoomMember(mapping.agentMemberID, "agent", `leave-${mapping.instanceID}`)
      agentControllers.get(mapping.instanceID)?.dispose()
      agentControllers.delete(mapping.instanceID)
      await props.removeAgent?.(props.baseURL(), mapping.roomID, mapping.instanceID)
      setAgentMappings((mappings) => mappings.filter((item) => item.instanceID !== mapping.instanceID))
    } catch (error) {
      setState("error", lobbyErrorMessage(error, "The agent could not leave this room."))
    }
  }

  const startAgent = async (draft: LobbyAgentDraft, room = state.room) => {
    const target = props.directory?.()
    if (!room || !draft.model || !target) {
      setState("error", !target ? "Select a local project before starting an agent." : "Agent setup is incomplete.")
      return false
    }
    const controller = agentControllers.get(draft.id) ?? createAgentController(undefined, draft.id)
    if (!controller) {
      setState("error", "The local agent runtime is not ready. Refresh the room and try again.")
      return false
    }
    await controller.start({
      instanceID: draft.id,
      lobbyBaseURL: props.baseURL(),
      roomID: room.id,
      roomHead: room.head,
      directory: target,
      model: draft.model,
      agentName: `@${draft.agentHandle ?? uniqueLobbyAgentHandle(draft.name, draft.id, agentMappings())}`,
      agentHandle: draft.agentHandle ?? uniqueLobbyAgentHandle(draft.name, draft.id, agentMappings()),
      capabilityProfile: draft.capabilityProfile ?? "workspace",
      human: identity(),
    })
    controller.messages(state.messages, room)
    return true
  }
  const startPendingAgents = async (room: LobbyRoom) => {
    const drafts = props.loadPendingAgents?.(props.baseURL(), room.id) ?? []
    if (!drafts.length) return
    if ((await Promise.all(drafts.map((draft) => startAgent(draft, room)))).every(Boolean))
      await props.savePendingAgents?.(props.baseURL(), room.id, undefined)
  }

  const finishWizard = (event: SubmitEvent) => {
    event.preventDefault()
    const roomInput = wizard.room.trim()
    const client = directory.client()
    if (!client) {
      setState("error", "Configure TurenOS lobby API URL before continuing.")
      return
    }
    if (!roomInput || !wizard.mode) {
      setState("error", wizard.mode === "join" ? "Enter an existing room ID first." : "Enter a room name first.")
      return
    }
    if (wizard.agents.some((agent) => !agent.model)) {
      setState("error", "Choose a provider and model for every configured agent.")
      return
    }
    const pendingAgents = snapshotLobbyAgentDrafts(assignLobbyAgentHandles(wizard.agents))
    const controller = new AbortController()
    mutations.add(controller)
    setState({ creating: wizard.mode === "create", joining: wizard.mode === "join", error: undefined })
    const resolveRoom =
      wizard.mode === "create"
        ? client.createRoom(roomInput, controller.signal)
        : client.snapshot(roomInput, controller.signal)
    void resolveRoom
      .then((room) => client.join(room.id, identity(), controller.signal))
      .then(async (room) => {
        controller.signal.throwIfAborted()
        await props.savePendingAgents?.(props.baseURL(), room.id, pendingAgents)
        remember(room)
        closeWizard()
        if (props.roomID() === room.id) {
          await startPendingAgents(room)
          return
        }
        props.navigate(room.id)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          connection: isLobbyNetworkError(error) ? "offline" : state.connection,
          error: lobbyErrorMessage(error, "The lobby could not create or join that room."),
        })
      })
      .finally(() => {
        mutations.delete(controller)
        if (!controller.signal.aborted) setState({ creating: false, joining: false })
      })
  }
  const joinSelectedRoom = () => {
    const room = state.room
    const client = directory.client()
    if (!room || !client) return
    const controller = new AbortController()
    mutations.add(controller)
    setState({ joining: true, error: undefined })
    void client
      .join(room.id, identity(), controller.signal)
      .then(
        (joined) => {
          if (controller.signal.aborted || state.selectedID !== room.id) return
          remember(joined)
          setState("room", joined)
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          setState({
            connection: isLobbyNetworkError(error) ? "offline" : state.connection,
            error: lobbyErrorMessage(error, "The lobby could not join this room."),
          })
        },
      )
      .finally(() => {
        mutations.delete(controller)
        if (!controller.signal.aborted) setState("joining", false)
      })
  }
  const sendMessage = (event: SubmitEvent) => {
    event.preventDefault()
    const room = state.room
    const client = directory.client()
    const text = draft().trim()
    if (!room || !client || !text) return
    const controller = new AbortController()
    const key = idempotencyKey()
    mutations.add(controller)
    setState({ sending: true, error: undefined })
    publishPresence(identity(), "online", false, room.id)
    void (async () => {
      let snapshot = await client.join(room.id, identity(), controller.signal)
      controller.signal.throwIfAborted()
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await client.send(
            room.id,
            {
              actor_id: actorID(),
              actor_type: "human",
              text,
              base_revision: snapshot.head,
              idempotency_key: key,
            },
            controller.signal,
          )
        } catch (error) {
          if (!isLobbyRevisionConflict(error) || attempt === 7) throw error
          snapshot = await client.snapshot(room.id, controller.signal)
          controller.signal.throwIfAborted()
        }
      }
      throw new Error("The lobby rejected every revision retry.")
    })()
      .then(
        (message) => {
          if (controller.signal.aborted || state.selectedID !== room.id) return
          applyMessage(message)
          setDraft("")
          setIdempotencyKey(newActionID())
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          setState({
            connection: isLobbyNetworkError(error) ? "offline" : state.connection,
            error: lobbyErrorMessage(error, "Message not sent."),
          })
        },
      )
      .finally(() => {
        mutations.delete(controller)
        if (!controller.signal.aborted) setState("sending", false)
      })
  }

  createEffect(() => {
    const baseURL = props.baseURL()
    props.roomID()
    if (previousBaseURL !== baseURL) {
      previousBaseURL = baseURL
      mutations.forEach((controller) => controller.abort())
      directory.refresh(baseURL)
    }
    loadSelectedRoom()
  })

  createEffect(() => {
    props.roomID()
    props.baseURL()
    if (props.mappingsReady && !props.mappingsReady()) return
    void untrack(loadAgentControllers)
  })

  onCleanup(() => {
    mutations.forEach((controller) => controller.abort())
    stopRoomLoad()
    stopRoomStream()
    stopAgentControllers()
    directory.dispose()
  })

  return (
    <main
      data-component="lobby-page"
      class="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base"
    >
      <PageHeader title="Lobby" description="Local development room relay" />

      <div class="grid min-h-0 flex-1 grid-rows-[minmax(300px,46%)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[250px_minmax(0,1fr)] lg:grid-rows-1">
        <aside class="flex min-h-0 flex-col border-b border-v2-border-border-base bg-v2-background-bg-layer-01 font-mono lg:border-b-0 lg:border-r">
          <div class="space-y-2 border-b border-v2-border-border-base p-2">
            <Show
              when={wizard.mode}
              fallback={
                <div class="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-action="lobby-open-create-wizard"
                    class="border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5 text-[11px] text-v2-text-text-accent hover:border-v2-border-border-focus"
                    onClick={() => setWizard({ mode: "create", step: 1, room: "", agents: [] })}
                  >
                    Create room
                  </button>
                  <button
                    type="button"
                    data-action="lobby-open-join-wizard"
                    class="border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5 text-[11px] text-v2-text-text-accent hover:border-v2-border-border-focus"
                    onClick={() => setWizard({ mode: "join", step: 1, room: "", agents: [] })}
                  >
                    Join room
                  </button>
                </div>
              }
            >
              <form
                data-component="lobby-room-wizard"
                class="space-y-2"
                onSubmit={(event) => {
                  if (wizard.step === 1) {
                    event.preventDefault()
                    if (wizard.room.trim()) setWizard("step", 2)
                    return
                  }
                  finishWizard(event)
                }}
              >
                <div class="flex items-center justify-between text-[9px] uppercase tracking-[0.12em] text-v2-text-text-faint">
                  <span>
                    {wizard.mode} room · step {wizard.step}/2
                  </span>
                  <button type="button" class="hover:text-v2-text-text-base" onClick={closeWizard}>
                    Cancel
                  </button>
                </div>
                <Show
                  when={wizard.step === 1}
                  fallback={
                    <div class="space-y-2">
                      <div class="flex items-center justify-between">
                        <p class="text-[10px] text-v2-text-text-muted">Optional TurenOS agents</p>
                        <button
                          type="button"
                          data-action="lobby-wizard-add-agent"
                          class="text-[10px] text-v2-text-text-accent hover:text-v2-text-text-base"
                          onClick={addWizardAgent}
                        >
                          + Add agent
                        </button>
                      </div>
                      <For
                        each={wizard.agents}
                        fallback={
                          <p class="text-[9px] leading-4 text-v2-text-text-faint">
                            No agents. This will be a human-only room.
                          </p>
                        }
                      >
                        {(agent) => (
                          <div class="space-y-1 border border-v2-border-border-subtle bg-v2-background-bg-base p-1.5">
                            <div class="flex gap-1">
                              <input
                                value={agent.name}
                                aria-label="Agent display name"
                                class="min-w-0 flex-1 bg-transparent text-[10px] text-v2-text-text-base outline-none"
                                onInput={(event) => updateWizardAgent(agent.id, agent.model, event.currentTarget.value)}
                              />
                              <button
                                type="button"
                                aria-label={`Remove ${agent.name}`}
                                class="text-[10px] text-v2-state-fg-critical"
                                onClick={() =>
                                  setWizard("agents", (agents) => agents.filter((item) => item.id !== agent.id))
                                }
                              >
                                Remove
                              </button>
                            </div>
                            <p class="text-[9px] text-v2-text-text-faint">
                              Public handle: @{wizardAgentHandle(agent.id, wizard.agents)}
                            </p>
                            <Show when={modelPicker(agent)} keyed>
                              {(picker) => (
                                <ModelSelectorPopoverV2
                                  model={picker}
                                  selected={
                                    agent.model
                                      ? { providerID: agent.model.providerID, modelID: agent.model.id }
                                      : undefined
                                  }
                                  onSelect={(model) =>
                                    updateWizardAgent(agent.id, { providerID: model.providerID, id: model.modelID })
                                  }
                                  triggerAs="button"
                                  triggerProps={{
                                    type: "button",
                                    "data-action": "lobby-wizard-agent-model",
                                    class:
                                      "flex w-full items-center justify-between text-left text-[9px] text-v2-text-text-muted hover:text-v2-text-text-base",
                                  }}
                                >
                                  <span class="truncate">
                                    {findModel(agent.model)?.name ?? "Choose provider / model"}
                                  </span>
                                  <IconV2 name="chevron-down" size="small" />
                                </ModelSelectorPopoverV2>
                              )}
                            </Show>
                            <label class="flex items-center justify-between gap-2 text-[9px] text-v2-text-text-muted">
                              <span>Local capability scope</span>
                              <select
                                data-action="lobby-wizard-agent-capability"
                                class="rounded border border-v2-border-border-muted bg-v2-background-bg-base px-1 py-0.5 text-v2-text-text-base outline-none"
                                value={agent.capabilityProfile ?? "workspace"}
                                onChange={(event) =>
                                  updateWizardCapability(
                                    agent.id,
                                    event.currentTarget.value as LobbySession.CapabilityProfile,
                                  )
                                }
                              >
                                <option value="workspace">Workspace</option>
                                <option value="read_only">Read only</option>
                                <option value="full">Full local</option>
                              </select>
                            </label>
                            <p class="text-[9px] leading-4 text-v2-text-text-faint">
                              {capabilityProfileDescription(agent.capabilityProfile ?? "workspace")}
                            </p>
                          </div>
                        )}
                      </For>
                      <Show when={wizard.agents.length > 0 && !props.directory?.()}>
                        <p class="text-[9px] text-v2-state-fg-warning">
                          Select a local project before starting agents.
                        </p>
                      </Show>
                      <div class="flex justify-between">
                        <button
                          type="button"
                          class="text-[10px] text-v2-text-text-muted"
                          onClick={() => setWizard("step", 1)}
                        >
                          Back
                        </button>
                        <button
                          type="submit"
                          data-action="lobby-wizard-finish"
                          class="text-[10px] text-v2-text-text-accent disabled:text-v2-text-text-faint"
                          disabled={
                            state.creating ||
                            state.joining ||
                            wizard.agents.some((agent) => !agent.model) ||
                            (wizard.agents.length > 0 && !props.directory?.())
                          }
                        >
                          {state.creating
                            ? "Creating"
                            : state.joining
                              ? "Joining"
                              : wizard.mode === "create"
                                ? "Create and join"
                                : "Join room"}
                        </button>
                      </div>
                    </div>
                  }
                >
                  <input
                    data-action="lobby-wizard-room"
                    value={wizard.room}
                    placeholder={wizard.mode === "create" ? "Room name" : "Existing room ID"}
                    aria-label={wizard.mode === "create" ? "New room name" : "Existing room ID"}
                    class="w-full border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5 text-[11px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint focus:border-v2-border-border-focus"
                    onInput={(event) => setWizard("room", event.currentTarget.value)}
                  />
                  <div class="flex justify-end">
                    <button
                      type="button"
                      data-action="lobby-wizard-next"
                      class="text-[10px] text-v2-text-text-accent disabled:text-v2-text-text-faint"
                      disabled={!wizard.room.trim()}
                      onClick={() => setWizard("step", 2)}
                    >
                      Configure agents
                    </button>
                  </div>
                </Show>
              </form>
            </Show>
          </div>
          <div class="flex items-center justify-between border-b border-v2-border-border-base px-3 py-2">
            <span class="text-[10px] uppercase tracking-[0.15em] text-v2-text-text-muted">rooms</span>
            <span
              data-slot="lobby-connection"
              data-state={state.connection}
              class="text-[10px] text-v2-text-text-muted"
            >
              {lobbyConnectionLabel(state.connection)}
            </span>
          </div>
          <div data-component="lobby-room-list" class="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
            <For
              each={state.rooms}
              fallback={
                <p class="px-1.5 py-3 text-[11px] leading-5 text-v2-text-text-faint">
                  {directoryHelp(state.connection)}
                </p>
              }
            >
              {(room) => (
                <button
                  type="button"
                  data-action="lobby-select-room"
                  data-room-id={room.id}
                  aria-current={lobbyRoomIsActive(room.id, state.selectedID) ? "page" : undefined}
                  class="mb-px flex w-full min-w-0 items-center gap-1.5 border-l-2 border-transparent px-2 py-1.5 text-left text-[12px] text-v2-text-text-muted outline-none hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover"
                  classList={{
                    "border-v2-text-text-accent bg-v2-background-bg-layer-02 text-v2-text-text-base": lobbyRoomIsActive(
                      room.id,
                      state.selectedID,
                    ),
                  }}
                  onClick={() => props.navigate(room.id)}
                >
                  <span class="min-w-0 flex-1 truncate">{room.name}</span>
                  <Show when={lobbyRoomIsActive(room.id, state.selectedID)}>
                    <span class="text-[10px] text-v2-text-text-accent">active</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div class="border-t border-v2-border-border-base p-2">
            <div class="mb-1 text-[10px] text-v2-text-text-faint">{lobbyConnectionLabel(state.connection)}</div>
            <label class="flex items-center gap-1.5 border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5 focus-within:border-v2-border-border-focus">
              <span class="text-[10px] text-v2-text-text-faint">LOCAL GUEST</span>
              <input
                value={settings.general.lobbyGuestName()}
                aria-label="Local anonymous guest display name"
                class="min-w-0 flex-1 bg-transparent text-[12px] text-v2-text-text-base outline-none"
                onInput={(event) => settings.general.setLobbyGuestName(event.currentTarget.value)}
              />
            </label>
            <p class="mt-1 text-[9px] leading-4 text-v2-text-text-faint">
              Guest identity is local and anonymous. It does not authenticate you.
            </p>
          </div>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-col bg-v2-background-bg-base font-mono">
          <Show
            when={state.selectedID}
            fallback={
              <div class="flex min-h-0 flex-1 items-start p-6 text-[12px] leading-6 text-v2-text-text-muted">
                <div>
                  <p class="text-v2-text-text-accent">TurenOS local lobby</p>
                  <p>{welcomeMessage(state.connection)}</p>
                  <Show when={state.error}>
                    <p class="mt-2 text-v2-state-fg-critical">{state.error}</p>
                  </Show>
                </div>
              </div>
            }
          >
            <Show
              when={state.room}
              keyed
              fallback={
                <div class="flex min-h-0 flex-1 items-start p-6 text-[12px] leading-6 text-v2-text-text-muted">
                  <Show
                    when={state.loading}
                    fallback={
                      <div>
                        <p class="text-v2-state-fg-critical">{lobbyConnectionLabel(state.connection)}</p>
                        <p>{state.error ?? "The selected room could not be loaded."}</p>
                      </div>
                    }
                  >
                    <p role="status">Loading room...</p>
                  </Show>
                </div>
              }
            >
              {(room) => (
                <>
                  <header class="flex flex-wrap items-center justify-between gap-3 border-b border-v2-border-border-base px-4 py-2.5">
                    <div class="min-w-0">
                      <Show
                        when={editingRoom()}
                        fallback={
                          <h2 data-slot="lobby-room-name" class="truncate text-[14px] text-v2-text-text-base">
                            {room.name}
                          </h2>
                        }
                      >
                        <form
                          class="flex items-center gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void renameRoom()
                          }}
                        >
                          <input
                            value={renameDraft()}
                            class="w-56 border-b border-v2-border-border-focus bg-transparent text-[13px] text-v2-text-text-base outline-none"
                            onInput={(event) => setRenameDraft(event.currentTarget.value)}
                          />
                          <button class="text-[10px] text-v2-text-text-accent" disabled={state.renaming}>
                            {state.renaming ? "Saving" : "Save"}
                          </button>
                          <button
                            type="button"
                            class="text-[10px] text-v2-text-text-muted"
                            onClick={() => setEditingRoom(false)}
                          >
                            Cancel
                          </button>
                        </form>
                      </Show>
                      <p class="mt-0.5 truncate text-[10px] text-v2-text-text-faint">Local room / {room.id}</p>
                    </div>
                    <div class="flex items-center gap-3 text-[10px]">
                      <span class="text-v2-text-text-faint">{lobbyConnectionLabel(state.connection)}</span>
                      <button
                        data-action="lobby-reconnect"
                        class="text-v2-text-text-accent hover:text-v2-text-text-base disabled:text-v2-text-text-faint"
                        disabled={state.loading}
                        onClick={refresh}
                      >
                        Refresh
                      </button>
                      <Show when={selectedMember()?.type === "human"}>
                        <button
                          class="text-v2-text-text-accent hover:text-v2-text-text-base"
                          onClick={() => {
                            setRenameDraft(room.name)
                            setEditingRoom(true)
                          }}
                        >
                          Rename
                        </button>
                        <button
                          class="text-v2-text-text-muted hover:text-v2-text-text-base disabled:text-v2-text-text-faint"
                          disabled={state.leaving}
                          onClick={() => void leaveRoom()}
                        >
                          {state.leaving ? "Leaving" : "Leave"}
                        </button>
                        <button
                          class="text-v2-state-fg-critical hover:text-v2-text-text-base"
                          onClick={() => setConfirmDelete(true)}
                        >
                          Delete
                        </button>
                      </Show>
                    </div>
                  </header>
                  <Show when={confirmDelete()}>
                    <div class="flex items-center justify-between gap-3 border-b border-v2-state-border-warning bg-v2-state-bg-warning px-4 py-2 text-[10px] text-v2-state-fg-warning">
                      <span>Delete {room.name}? The room closes immediately; its audit ledger remains tombstoned.</span>
                      <div class="flex gap-3">
                        <button disabled={state.deleting} onClick={() => void deleteRoom()}>
                          {state.deleting ? "Deleting" : "Confirm delete"}
                        </button>
                        <button onClick={() => setConfirmDelete(false)}>Cancel</button>
                      </div>
                    </div>
                  </Show>
                  <Show when={state.error}>
                    <div
                      role="alert"
                      class="border-b border-v2-state-border-warning bg-v2-state-bg-warning px-4 py-1.5 text-[11px] text-v2-state-fg-warning"
                    >
                      {state.error}
                    </div>
                  </Show>
                  <div class="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_208px] xl:grid-rows-1">
                    <section class="flex min-h-0 min-w-0 flex-col">
                      <div class="flex items-center justify-between border-b border-v2-border-border-subtle px-4 py-2 text-[10px] text-v2-text-text-faint">
                        <span>Messages remain in this local in-memory relay only.</span>
                        <span>rev:{room.head}</span>
                      </div>
                      <div data-component="lobby-messages" class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                        <For
                          each={state.messages}
                          fallback={
                            <p class="text-[11px] leading-6 text-v2-text-text-faint">No messages in {room.name} yet.</p>
                          }
                        >
                          {(message) => (
                            <article class="mb-1 grid max-w-5xl grid-cols-[42px_max-content_minmax(0,1fr)] gap-x-2 text-[12px] leading-5">
                              <span class="text-right text-[10px] text-v2-text-text-faint">
                                [{String(message.sequence).padStart(3, "0")}]
                              </span>
                              <span class="text-v2-text-text-accent">
                                &lt;
                                {lobbyMessageActorName(message, room, agentMappings())}
                                &gt;
                              </span>
                              <p class="whitespace-pre-wrap break-words text-v2-text-text-base">{message.text}</p>
                            </article>
                          )}
                        </For>
                      </div>
                      <Show when={typingMembers().length > 0}>
                        <div role="status" class="px-4 pb-1 text-[10px] text-v2-text-text-faint">
                          {typingMembers()
                            .map((member) => `@${lobbyMemberHandle(member, agentMappings())}`)
                            .join(", ")}{" "}
                          {typingMembers().length === 1 ? "is" : "are"} typing...
                        </div>
                      </Show>
                      <form class="relative border-t border-v2-border-border-base p-2" onSubmit={sendMessage}>
                        <div class="flex items-center gap-2 border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2 py-1.5 focus-within:border-v2-border-border-focus">
                          <textarea
                            data-action="lobby-message"
                            ref={messageInput}
                            value={draft()}
                            rows={1}
                            disabled={state.sending || state.connection !== "connected"}
                            placeholder="Write a message"
                            class="min-h-5 min-w-0 flex-1 resize-none bg-transparent text-[12px] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:cursor-not-allowed disabled:opacity-60"
                            onInput={(event) => {
                              setDraft(event.currentTarget.value)
                              setIdempotencyKey(newActionID())
                              updateMentionState(event.currentTarget.value, event.currentTarget.selectionStart)
                            }}
                            onFocus={() => setComposerFocused(true)}
                            onBlur={() => setComposerFocused(false)}
                            onKeyDown={(event) => {
                              const candidates = mentionCandidates()
                              if (candidates.length && event.key === "ArrowDown") {
                                event.preventDefault()
                                setMentionIndex((index) => (index + 1) % candidates.length)
                                return
                              }
                              if (candidates.length && event.key === "ArrowUp") {
                                event.preventDefault()
                                setMentionIndex((index) => (index - 1 + candidates.length) % candidates.length)
                                return
                              }
                              if (candidates.length && event.key === "Escape") {
                                event.preventDefault()
                                setMentionQuery(undefined)
                                return
                              }
                              if (candidates.length && event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault()
                                insertMention(candidates[mentionIndex()]!.handle)
                                return
                              }
                              if (event.isComposing || event.keyCode === 229 || event.key !== "Enter" || event.shiftKey)
                                return
                              event.preventDefault()
                              event.currentTarget.form?.requestSubmit()
                            }}
                          />
                          <Show when={mentionCandidates().length > 0}>
                            <div
                              role="listbox"
                              aria-label="Room members"
                              class="absolute bottom-full left-2 right-2 mb-1 border border-v2-border-border-base bg-v2-background-bg-layer-01 p-1 shadow-lg"
                            >
                              <For each={mentionCandidates()}>
                                {(candidate, index) => (
                                  <button
                                    type="button"
                                    role="option"
                                    aria-selected={index() === mentionIndex()}
                                    class={`block w-full px-2 py-1 text-left text-[10px] ${
                                      index() === mentionIndex()
                                        ? "bg-v2-background-bg-base text-v2-text-text-accent"
                                        : "text-v2-text-text-muted"
                                    }`}
                                    onMouseDown={(event) => {
                                      event.preventDefault()
                                      insertMention(candidate.handle)
                                    }}
                                  >
                                    @{candidate.handle}{" "}
                                    <span class="text-v2-text-text-faint">{candidate.member.name}</span>
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                          <button
                            type="submit"
                            class="shrink-0 text-[10px] text-v2-text-text-accent hover:text-v2-text-text-base disabled:text-v2-text-text-faint"
                            disabled={!draft().trim() || state.sending || state.connection !== "connected"}
                          >
                            {state.sending ? "Sending" : "Send"}
                          </button>
                        </div>
                        <p class="mt-1 px-1 text-[9px] text-v2-text-text-faint">
                          Sending joins this local guest first. Revision retries retain this message key.
                        </p>
                      </form>
                    </section>
                    <aside class="min-h-0 border-t border-v2-border-border-base bg-v2-background-bg-layer-01 xl:border-l xl:border-t-0">
                      <div class="border-b border-v2-border-border-subtle p-3">
                        <div class="flex items-center justify-between gap-2">
                          <h3 class="text-[10px] uppercase tracking-[0.14em] text-v2-text-text-muted">room agents</h3>
                          <span class="text-[9px] text-v2-text-text-faint">{agentMappings().length}</span>
                        </div>
                        <For
                          each={agentMappings()}
                          fallback={
                            <p class="mt-2 text-[9px] leading-4 text-v2-text-text-faint">
                              No TurenOS agents in this room.
                            </p>
                          }
                        >
                          {(mapping) => (
                            <div
                              data-agent-id={mapping.instanceID}
                              class="mt-2 border-l border-v2-border-border-subtle pl-2"
                            >
                              <div class="flex items-center justify-between gap-2">
                                <p class="min-w-0 truncate text-[10px] text-v2-text-text-muted">{mapping.agentName}</p>
                                <span
                                  data-slot="lobby-agent-status"
                                  data-state={mapping.status}
                                  class="shrink-0 text-[9px] text-v2-text-text-faint"
                                >
                                  {agentStatusLabel(mapping.status)}
                                </span>
                              </div>
                              <p class="truncate text-[9px] text-v2-text-text-accent">@{mapping.agentHandle}</p>
                              <p class="truncate text-[9px] text-v2-text-text-faint">
                                {mapping.model.providerID}/{mapping.model.id}
                              </p>
                              <p class="truncate text-[9px] text-v2-text-text-faint">
                                Scope: {mapping.capabilityProfile ?? "workspace"}
                              </p>
                              <div class="mt-1 flex gap-3">
                                <Show when={mapping.status === "error"}>
                                  <button
                                    type="button"
                                    data-action="lobby-agent-retry"
                                    class="text-[10px] text-v2-text-text-accent hover:text-v2-text-text-base"
                                    onClick={() =>
                                      mapping.pending
                                        ? agentControllers.get(mapping.instanceID)?.retry()
                                        : agentControllers.get(mapping.instanceID)?.adopt(identity())
                                    }
                                  >
                                    Retry
                                  </button>
                                </Show>
                                <Show when={mapping.status !== "stopped"}>
                                  <button
                                    type="button"
                                    data-action="lobby-agent-stop"
                                    class="text-[10px] text-v2-state-fg-critical hover:text-v2-text-text-base"
                                    onClick={() => void agentControllers.get(mapping.instanceID)?.stop()}
                                  >
                                    Stop locally
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  data-action="lobby-agent-leave"
                                  class="text-[10px] text-v2-state-fg-critical hover:text-v2-text-text-base"
                                  onClick={() => void leaveAgent(mapping)}
                                >
                                  Leave
                                </button>
                                <Show when={mapping.status === "stopped"}>
                                  <button
                                    type="button"
                                    data-action="lobby-agent-start"
                                    class="text-[10px] text-v2-text-text-accent hover:text-v2-text-text-base"
                                    onClick={() =>
                                      void startAgent(
                                        {
                                          id: mapping.instanceID,
                                          name: mapping.agentName,
                                          model: mapping.model,
                                        },
                                        room,
                                      )
                                    }
                                  >
                                    Start
                                  </button>
                                </Show>
                              </div>
                              <Show when={mapping.error}>
                                <p role="alert" class="mt-1 break-words text-[9px] leading-4 text-v2-state-fg-critical">
                                  {mapping.error}
                                </p>
                              </Show>
                            </div>
                          )}
                        </For>
                        <button
                          type="button"
                          data-action="lobby-add-another-agent"
                          class="mt-2 text-[10px] text-v2-text-text-accent hover:text-v2-text-text-base"
                          onClick={() =>
                            setWizard({
                              mode: "join",
                              step: 2,
                              room: room.id,
                              agents: [nextLobbyAgentDraft(0, agentMappings())],
                            })
                          }
                        >
                          + Configure another agent
                        </button>
                        <p class="mt-2 text-[9px] leading-4 text-v2-text-text-faint">
                          Each agent has a private TurenOS session. Presence and typing are shared; private state is
                          not.
                        </p>
                        <button
                          type="button"
                          data-action="lobby-toggle-diagnostics"
                          class="mt-2 text-[9px] uppercase tracking-[0.1em] text-v2-text-text-muted hover:text-v2-text-text-base"
                          onClick={() => setShowDiagnostics((value) => !value)}
                        >
                          {showDiagnostics() ? "Hide" : "Show"} diagnostics ({roomDiagnostics().length})
                        </button>
                        <Show when={showDiagnostics()}>
                          <div
                            data-component="lobby-diagnostics"
                            class="mt-1 max-h-48 overflow-y-auto border border-v2-border-border-subtle bg-v2-surface-surface-base p-1 font-mono text-[8px] leading-3 text-v2-text-text-faint"
                          >
                            <For
                              each={roomDiagnostics().slice(-15)}
                              fallback={<p class="p-1">No room diagnostics yet.</p>}
                            >
                              {(entry) => (
                                <p class={entry.level === "error" ? "text-v2-state-fg-critical" : undefined}>
                                  {entry.at.slice(11, 19)} {entry.event}
                                  {entry.sequence !== undefined ? ` seq=${entry.sequence}` : ""}
                                  {entry.promptID ? ` prompt=${entry.promptID}` : ""}
                                  {entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : ""}
                                  {entry.errorName ? ` error=${entry.errorName}` : ""}
                                </p>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                      <div class="flex items-center justify-between border-b border-v2-border-border-subtle px-3 py-2">
                        <h3 class="text-[10px] uppercase tracking-[0.14em] text-v2-text-text-muted">members</h3>
                        <span class="text-[10px] text-v2-text-text-faint">{room.members.length}</span>
                      </div>
                      <div data-component="lobby-members" class="max-h-48 overflow-y-auto p-1.5 xl:max-h-none">
                        <For
                          each={room.members}
                          fallback={<p class="px-1.5 py-2 text-[10px] text-v2-text-text-faint">No members.</p>}
                        >
                          {(member) => (
                            <div class="flex items-center gap-1.5 px-1.5 py-1 text-[11px]">
                              <span
                                class={
                                  state.presence[member.id] ? "text-v2-state-fg-success" : "text-v2-text-text-faint"
                                }
                              >
                                {state.presence[member.id] ? "●" : "○"}
                              </span>
                              <button
                                type="button"
                                class="min-w-0 flex-1 truncate text-left text-v2-text-text-base hover:text-v2-text-text-accent"
                                onClick={() => {
                                  if (member.type === "system") return
                                  const handle = lobbyMemberHandle(member, agentMappings())
                                  setDraft((text) => `${text}${text && !text.endsWith(" ") ? " " : ""}@${handle} `)
                                  setIdempotencyKey(newActionID())
                                  setMentionQuery(undefined)
                                }}
                              >
                                @{lobbyMemberHandle(member, agentMappings())}{" "}
                                <span class="text-v2-text-text-faint">{member.name}</span>
                              </button>
                              <span class="shrink-0 text-[9px] text-v2-text-text-faint">
                                {lobbyParticipantPresence(member, actorID(), state.presence[member.id])}
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                      <Show when={!selectedMember()}>
                        <div class="border-t border-v2-border-border-subtle p-3">
                          <p class="text-[10px] leading-5 text-v2-text-text-faint">
                            Join as local guest {identityName()} to speak.
                          </p>
                          <button
                            data-action="lobby-join-selected-room"
                            class="mt-1 text-[11px] text-v2-text-text-accent hover:text-v2-text-text-base disabled:text-v2-text-text-faint"
                            disabled={state.joining}
                            onClick={joinSelectedRoom}
                          >
                            {state.joining ? "Joining" : "Join room"}
                          </button>
                        </div>
                      </Show>
                    </aside>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </section>
      </div>
    </main>
  )
}

function newActionID() {
  return crypto.randomUUID()
}

function nextLobbyAgentDraft(index: number, mappings: readonly LobbyAgentMapping[]): LobbyAgentDraft {
  const name = `TurenOS agent ${index + 1}`
  const id = newActionID()
  const handle = uniqueLobbyAgentHandle(name, id, mappings)
  return {
    id,
    name: handle === lobbyAgentHandle(name) ? name : `${name} ${mappings.length + 1}`,
    capabilityProfile: "workspace",
  }
}

function uniqueLobbyAgentHandle(name: string, instanceID: string, mappings: readonly LobbyAgentMapping[]) {
  const base = lobbyAgentHandle(name)
  const used = new Set(
    mappings
      .filter((mapping) => mapping.instanceID !== instanceID)
      .map((mapping) => mapping.agentHandle || lobbyAgentHandle(mapping.agentName)),
  )
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, 48 - String(suffix).length - 1)}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${base.slice(0, 39)}-${instanceID.replaceAll("-", "").slice(0, 8)}`
}

function assignLobbyAgentHandles(drafts: readonly LobbyAgentDraft[]): LobbyAgentDraft[] {
  return drafts.map((draft) => ({ ...draft, agentHandle: lobbyAgentInstanceHandle(draft.name, draft.id) }))
}

function wizardAgentHandle(instanceID: string, drafts: readonly LobbyAgentDraft[]) {
  return assignLobbyAgentHandles(drafts).find((draft) => draft.id === instanceID)?.agentHandle ?? "agent"
}

function mergeRoomMembers(next: LobbyRoom, current: LobbyRoom | undefined) {
  if (!current || current.id !== next.id) return next
  if (next.head > current.head) return next
  if (next.head < current.head) return current
  return {
    ...next,
    head: Math.max(next.head, current.head),
    members: [
      ...next.members,
      ...current.members.filter((member) => !next.members.some((item) => item.id === member.id)),
    ],
  }
}

function lobbyMessageActorName(message: LobbyMessage, room: LobbyRoom, mappings: readonly LobbyAgentMapping[]) {
  const member = room.members.find((item) => item.id === message.actor_id)
  if (!member) return message.actor_id
  if (member.type !== "agent") return member.name
  return `@${mappings.find((mapping) => mapping.agentMemberID === member.id)?.agentHandle ?? lobbyAgentHandle(member.name)}`
}

function lobbyMemberHandle(member: LobbyMember, mappings: readonly LobbyAgentMapping[]) {
  return mappings.find((mapping) => mapping.agentMemberID === member.id)?.agentHandle ?? lobbyAgentHandle(member.name)
}

function directoryHelp(connection: LobbyConnection) {
  if (connection === "not_configured") return "Configure TurenOS lobby API URL in Settings to list local rooms."
  if (connection === "connecting") return "Loading local rooms..."
  if (connection === "offline") return "Lobby is offline. Retrying connection..."
  if (connection === "local_error") return "The configured local server returned an error."
  return "No rooms in this local process."
}

function welcomeMessage(connection: LobbyConnection) {
  if (connection === "not_configured")
    return "Configure TurenOS lobby API URL in Settings to connect to a local development relay."
  if (connection === "connecting") return "Connecting to the configured local lobby..."
  if (connection === "offline") return "The configured lobby is offline and will be retried."
  if (connection === "local_error") return "The configured local server returned an error."
  return "Select a listed room, create a room, or join an existing room by ID."
}

function agentStatusLabel(status: import("./lobby-agent-controller").LobbyAgentStatus) {
  if (status === "not_joined") return "Not joined"
  if (status === "selecting") return "Selecting"
  if (status === "starting") return "Starting"
  if (status === "ready") return "Ready"
  if (status === "responding") return "Responding"
  if (status === "error") return "Error"
  return "Stopped"
}

function capabilityProfileDescription(profile: LobbySession.CapabilityProfile) {
  if (profile === "read_only") return "Room requests can inspect approved public and local data but cannot mutate it."
  if (profile === "full") return "Uses normal local permissions, including separately approved external scope."
  return "Autonomous inside the selected project; external filesystem scope cannot be granted by room text."
}
