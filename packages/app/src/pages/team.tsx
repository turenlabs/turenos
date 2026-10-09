import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Icon } from "@turenlabs/ui/v2/icon"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { TextareaV2 } from "@turenlabs/ui/v2/textarea-v2"
import { DropdownMenu } from "@turenlabs/ui/dropdown-menu"
import { createStore } from "solid-js/store"
import { For, Show, createEffect, onCleanup, untrack } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useNavRail } from "@/components/nav-rail"
import { sessionHref } from "@/utils/session-route"
import { loopApi, loopCatalog, responseData, type LoopInfo, type LoopModel } from "./loops/api"
import { teamApi } from "./team/api"
import { TeamMentionInput } from "./team/mention-input"
import { TeamMessageContent } from "./team/message-content"
import { createTeamScroll } from "./team/scroll"
import { PixelAvatar, PixelAvatarEditor, generatePixelAvatar } from "./team/pixel-avatar"
import {
  assignedHandles,
  roomActivity,
  mergeMessages,
  replyContext,
  ownsTeamResponse,
  pendingFactoryOperation,
  parseFactoryParameters,
  pendingMessage,
  selectFactoryTeammate,
  timeLabel,
  roomCoordinator,
  roomDeleteBlocker,
} from "./team/model"
import type { Team } from "@turenlabs/schema/team"

const surface = "flex h-full min-h-0 w-full min-w-0 bg-v2-background-bg-base text-v2-text-text-base"
const button = "rounded-[6px] px-2.5 py-1.5 text-[12px] hover:bg-v2-overlay-simple-overlay-hover"
const statusLabel = {
  running: "Running",
  succeeded: "Completed",
  needs_input: "Needs input",
  failed: "Failed",
  cancelled: "Stopped",
  stale: "Interrupted",
  queued: "Queued",
  claimed: "Starting",
}
const phaseLabel = { plan: "Planning", work: "Working", check: "Checking", done: "Finished" }
const roomActionLabel = { edit: "Save", archive: "Archive", restore: "Restore", delete: "Delete permanently" }
const roomActionTitle = {
  edit: "Edit room",
  archive: "Archive room?",
  restore: "Restore room?",
  delete: "Delete room permanently?",
}
const roomActionDescription = {
  edit: "Change the room name and topic.",
  archive: "This room becomes read-only. Attached schedules pause. Active work must finish before archive can succeed.",
  restore: "This room accepts messages and changes again. Paused schedules stay paused.",
  delete:
    "This removes room history, teammates, and Team work records. Native Sessions are kept. This cannot be undone.",
}

export default function TeamPage() {
  const serverSDK = useServerSDK()
  const rail = useNavRail()
  const params = useParams<{ roomID?: string }>()
  const navigate = useNavigate()
  const [state, setState] = createStore<{
    value?: Team.State
    error?: string
    loadError?: string
    loading: boolean
    busy: boolean
    text: string
    selected?: string
    createOpen: boolean
    roomOpen: boolean
    archivedOpen: boolean
    roomAction?: "edit" | "archive" | "restore" | "delete"
    olderLoading: boolean
    mobilePanel?: "channels" | "members"
    agents: string[]
    models: LoopModel[]
    dutyDefinitions: LoopInfo[]
    factoryOpen: boolean
    factoryRunOpen: Record<string, boolean>
    factoryConfig: Team.FactoryConfig
    factoryParameters: string
    createAvatar?: string[]
    createHandle: string
  }>({
    loading: true,
    busy: false,
    text: "",
    createOpen: false,
    roomOpen: false,
    archivedOpen: false,
    olderLoading: false,
    agents: [],
    models: [],
    dutyDefinitions: [],
    factoryOpen: false,
    factoryRunOpen: {},
    factoryConfig: {
      outcome: "",
      parameters: {},
      constraints: "",
      acceptanceCriteria: "",
      directory: "",
      coordinatorTeammateID: "",
      teammateIDs: [],
    },
    factoryParameters: "{}",
    createHandle: "",
  })
  const [profile, setProfile] = createStore({
    role: "",
    mission: "",
    directory: "",
    agent: "",
    model: "",
    avatar: [] as string[],
  })

  let generation = 0
  let roomRevision = 0
  const loadingKeys = new Set<string>()
  const scroll = createTeamScroll()
  let pendingPost:
    | { id: string; roomID: string; text: string; client: ReturnType<typeof serverSDK>["client"]; generation: number }
    | undefined
  let pendingFactoryRun:
    | { id: string; roomID: string; client: ReturnType<typeof serverSDK>["client"]; generation: number }
    | undefined
  const global = useGlobal()
  const server = useServer()

  const load = async (mode: "initial" | "poll" | "older" = "initial") => {
    const current = generation
    const revision = roomRevision
    const roomID = params.roomID
    const sdk = serverSDK()
    const key = `${current}:${revision}:${sdk.url}:${roomID ?? "default"}:${mode === "older" ? "older" : "fresh"}`
    if (loadingKeys.has(key)) return
    loadingKeys.add(key)
    const api = teamApi(sdk.client)
    if (mode === "initial") setState("loading", true)
    if (mode === "older") setState("olderLoading", true)
    try {
      const cursor = mode === "older" ? state.value?.messages[0]?.seq : state.value?.messages.at(-1)?.seq
      let result = await api.state({
        roomID,
        ...(mode === "older" && cursor ? { before: cursor } : mode === "poll" && cursor ? { after: cursor } : {}),
        limit: 100,
      })
      let received = result.messages
      let page = result.messages
      while (mode === "poll" && page.length === 100) {
        const next = await api.state({ roomID, after: page[page.length - 1]?.seq, limit: 100 })
        page = next.messages
        received = [...received, ...page]
        result = { ...next, messages: received }
      }
      const dutyDefinitions = mode === "older" ? state.dutyDefinitions : responseData(await loopApi(sdk.client).list())
      if (current !== generation || revision !== roomRevision || roomID !== params.roomID) return
      setState("dutyDefinitions", dutyDefinitions)
      const previous = state.value
      const messages =
        mode === "older"
          ? mergeMessages(result.messages, previous?.messages ?? [])
          : mergeMessages(previous?.messages ?? [], result.messages)
      if (mode === "older") scroll.prepend()
      setState("value", {
        ...result,
        hasMore: mode === "poll" ? (previous?.hasMore ?? result.hasMore) : result.hasMore,
        messages,
      })
      if (mode === "initial" && result.room.factory) {
        setState("factoryConfig", result.room.factory.config)
        setState("factoryParameters", JSON.stringify(result.room.factory.config.parameters, null, 2))
      }
      setState("loadError", undefined)
      if (!roomID && result.room.id) navigate(`/team/${result.room.id}`, { replace: true })
      scroll.update()
    } catch (error) {
      if (current === generation && revision === roomRevision)
        setState("loadError", error instanceof Error ? error.message : "Could not load Team room")
    } finally {
      loadingKeys.delete(key)
      if (current === generation) {
        setState("loading", false)
        setState("olderLoading", false)
      }
    }
  }

  createEffect(() => {
    const roomID = params.roomID
    const sdk = serverSDK()
    void sdk
    generation++
    setState("value", undefined)
    untrack(() => scroll.reset())
    onCleanup(() => scroll.cancel())
    setState("roomAction", undefined)
    setState("createOpen", false)
    setState("factoryOpen", false)
    setState("selected", undefined)
    setState("error", undefined)
    setState("busy", false)
    setState("olderLoading", false)
    setState("factoryConfig", {
      outcome: "",
      parameters: {},
      constraints: "",
      acceptanceCriteria: "",
      directory: "",
      coordinatorTeammateID: "",
      teammateIDs: [],
    })
    setState("factoryParameters", "{}")
    untrack(() => void load("initial"))
    setState("agents", [])
    const catalogOwner = { client: sdk.client, generation }
    void loopCatalog(sdk.client)
      .then((catalog) => {
        if (!ownsTeamResponse(catalogOwner, { client: serverSDK().client, generation })) return
        setState(
          "agents",
          catalog.agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden).map((agent) => agent.id),
        )
      })
      .catch((error) => {
        if (!ownsTeamResponse(catalogOwner, { client: serverSDK().client, generation })) return
        setState("error", error instanceof Error ? error.message : "Could not load agent catalogue")
      })
    const connection = server.current
    if (!connection) return
    const provider = global.ensureServerCtx(connection).sync.data.provider
    setState(
      "models",
      provider.connected.flatMap((providerID) => {
        const entry = provider.all.get(providerID)
        return entry
          ? Object.values(entry.models).map((item) => ({
              id: item.id,
              providerID: item.providerID,
              name: item.name,
              enabled: true,
              variants: Object.keys(item.variants ?? {}).map((id) => ({ id })),
            }))
          : []
      }),
    )
    const timer = window.setInterval(() => void load("poll"), 2_000)
    onCleanup(() => {
      generation++
      window.clearInterval(timer)
    })
    void roomID
  })

  const send = async () => {
    if (state.busy || !state.text.trim() || !state.value || archived()) return
    const sendGeneration = generation
    const roomID = state.value.room.id
    const text = state.text.trim()
    pendingPost = pendingMessage(pendingPost, { roomID, text, client: serverSDK().client, generation }, () =>
      crypto.randomUUID(),
    )
    const submitted = pendingPost
    setState("busy", true)
    try {
      const posted = await teamApi(submitted.client).messagePost({
        id: submitted.id,
        roomID: submitted.roomID,
        text: submitted.text,
      })
      if (
        ownsTeamResponse(
          { client: submitted.client, roomID: submitted.roomID, generation: sendGeneration },
          { client: serverSDK().client, roomID: state.value?.room.id, generation },
        )
      ) {
        setState("value", (previous) =>
          previous ? { ...previous, messages: mergeMessages(previous.messages, [posted.message]) } : previous,
        )
        if (state.text.trim() === submitted.text) setState("text", "")
        scroll.resume()
      }
      pendingPost = undefined
      void load("poll")
    } catch (error) {
      if (sendGeneration === generation)
        setState("error", error instanceof Error ? error.message : "Message was not sent. Retry to reconcile it.")
    } finally {
      if (sendGeneration === generation) setState("busy", false)
    }
  }

  const createTeammate = async (form: FormData) => {
    if (archived()) return
    const currentGeneration = generation
    const client = serverSDK().client
    const roomID = state.value?.room.id
    const name = String(form.get("name") ?? "").trim()
    const handle = String(form.get("handle") ?? "")
      .trim()
      .replace(/^@/, "")
    if (!name || !handle) return
    await teamApi(client).teammateCreate({
      roomID,
      name,
      handle,
      role: String(form.get("role") ?? "").trim() || "Security teammate",
      mission: String(form.get("mission") ?? ""),
      avatar: state.createAvatar ?? generatePixelAvatar(handle),
      directory: String(form.get("directory") ?? "") || undefined,
      agent: String(form.get("agent") ?? "") || undefined,
      model: String(form.get("model") ?? "")
        ? (() => {
            const [providerID, ...id] = String(form.get("model")).split("/")
            return { providerID, id: id.join("/") }
          })()
        : undefined,
    } as Team.CreateTeammate)
    if (generation !== currentGeneration || serverSDK().client !== client) return
    setState("createOpen", false)
    setState("createAvatar", undefined)
    setState("createHandle", "")
    void load("poll")
  }

  const createRoom = async (form: FormData) => {
    const currentGeneration = generation
    const client = serverSDK().client
    const room = await teamApi(client).roomCreate({
      name: String(form.get("name") ?? "").trim(),
      topic: String(form.get("topic") ?? ""),
    })
    if (generation !== currentGeneration || serverSDK().client !== client) return
    setState("roomOpen", false)
    navigate(`/team/${room.id}`)
  }

  const safeAction = async (action: () => Promise<unknown>) => {
    if (state.busy) return
    const owner = { client: serverSDK().client, roomID: state.value?.room.id, generation }
    const owns = () => ownsTeamResponse(owner, { client: serverSDK().client, roomID: state.value?.room.id, generation })
    setState("busy", true)
    setState("error", undefined)
    try {
      await action()
    } catch (error) {
      if (owns()) setState("error", error instanceof Error ? error.message : "Team action failed")
    } finally {
      if (owns()) setState("busy", false)
    }
  }

  const saveFactory = async () => {
    if (archived()) throw new Error("Archived rooms are read-only")
    const roomID = state.value?.room.id
    if (!roomID) return
    const client = serverSDK().client
    const currentGeneration = generation
    const config = { ...state.factoryConfig, parameters: parseFactoryParameters(state.factoryParameters) }
    if (!config.outcome.trim() || !config.acceptanceCriteria.trim() || !config.directory.trim())
      throw new Error("Outcome, acceptance criteria, and directory are required")
    if (!config.coordinatorTeammateID || !config.teammateIDs.includes(config.coordinatorTeammateID))
      throw new Error("Select a coordinator from the selected teammates")
    if (config.teammateIDs.length < 1 || config.teammateIDs.length > 10)
      throw new Error("Select between 1 and 10 teammates")
    if (config.teammateIDs.some((id) => !state.value?.teammates.some((teammate) => teammate.id === id)))
      throw new Error("Factory teammates must belong to this room")
    const saved = await teamApi(client).factoryConfigure({ roomID, config })
    if (
      !ownsTeamResponse(
        { client, roomID, generation: currentGeneration },
        {
          client: serverSDK().client,
          roomID: state.value?.room.id,
          generation,
        },
      )
    )
      return
    setState("factoryConfig", config)
    setState("value", (previous) => (previous ? { ...previous, room: saved } : previous))
    setState("factoryOpen", false)
  }

  const runFactory = async () => {
    if (archived()) return
    const roomID = state.value?.room.id
    if (!roomID) return
    const client = serverSDK().client
    const currentGeneration = generation
    const pending = pendingFactoryOperation(pendingFactoryRun, { roomID, client, generation: currentGeneration }, () =>
      crypto.randomUUID(),
    )
    pendingFactoryRun = pending
    setState("busy", true)
    setState("error", undefined)
    try {
      const run = await teamApi(pending.client).factoryRun({ roomID: pending.roomID, id: pending.id })
      if (ownsTeamResponse(pending, { client: serverSDK().client, roomID: state.value?.room.id, generation })) {
        setState("value", (previous) =>
          previous
            ? {
                ...previous,
                factoryRuns: [run, ...(previous.factoryRuns ?? []).filter((item) => item.id !== run.id)],
              }
            : previous,
        )
        pendingFactoryRun = undefined
      }
    } catch (error) {
      if (ownsTeamResponse(pending, { client: serverSDK().client, roomID: state.value?.room.id, generation }))
        setState("error", error instanceof Error ? error.message : "Factory run failed. Retry to reconcile it.")
    } finally {
      if (currentGeneration === generation) setState("busy", false)
    }
  }

  const stopFactory = async () => {
    const run = state.value?.factoryRuns?.find((item) => item.status === "running")
    if (!run) return
    await safeAction(async () => {
      const client = serverSDK().client
      const roomID = state.value?.room.id
      const currentGeneration = generation
      const result = await teamApi(client).factoryRunCancel({ runID: run.id })
      if (
        !ownsTeamResponse(
          { client, roomID, generation: currentGeneration },
          {
            client: serverSDK().client,
            roomID: state.value?.room.id,
            generation,
          },
        )
      )
        return
      setState("value", (previous) =>
        previous
          ? {
              ...previous,
              factoryRuns: [result, ...(previous.factoryRuns ?? []).filter((item) => item.id !== result.id)],
            }
          : previous,
      )
    })
  }

  const editTeammate = async (teammate: Team.Teammate) => {
    if (archived()) return false
    const currentGeneration = generation
    const client = serverSDK().client
    const agent = profile.agent
    const model = profile.model
    await teamApi(client).teammateEdit({
      teammateID: teammate.id,
      edit: {
        role: profile.role.trim(),
        mission: profile.mission.trim(),
        directory: profile.directory.trim(),
        avatar: profile.avatar,
        ...(agent ? { agent } : { resetAgent: true }),
        ...(model
          ? {
              model: (() => {
                const [providerID, ...id] = model.split("/")
                return { providerID, id: id.join("/") }
              })(),
            }
          : { resetModel: true }),
      } as Team.EditTeammate,
    })
    if (generation !== currentGeneration || serverSDK().client !== client) return false
    await load("poll")
    return true
  }

  const selected = () => state.value?.teammates.find((item) => item.id === state.selected)
  const archived = () => !!state.value?.room.archived
  const coordinator = () => state.value && roomCoordinator(state.value.room, state.value.teammates)
  const deleteBlocker = () => state.value && roomDeleteBlocker(state.value, state.dutyDefinitions)
  const changeRoom = async (form?: FormData) => {
    const value = state.value
    const action = state.roomAction
    if (!value || !action) return
    const owner = { client: serverSDK().client, roomID: value.room.id, generation }
    const api = teamApi(owner.client)
    if (action === "delete") {
      const blocker = roomDeleteBlocker(value, state.dutyDefinitions)
      if (blocker) throw new Error(blocker)
      await api.roomDelete({ roomID: owner.roomID })
    } else {
      const room =
        action === "edit"
          ? await api.roomEdit({
              roomID: owner.roomID,
              edit: {
                name: String(form?.get("name") ?? "").trim(),
                topic: String(form?.get("topic") ?? ""),
              },
            })
          : action === "archive"
            ? await api.roomArchive({ roomID: owner.roomID })
            : await api.roomRestore({ roomID: owner.roomID })
      if (!ownsTeamResponse(owner, { client: serverSDK().client, roomID: state.value?.room.id, generation })) return
      roomRevision++
      setState("value", (previous) =>
        previous
          ? {
              ...previous,
              room,
              rooms: previous.rooms.map((item) => (item.id === room.id ? room : item)),
            }
          : previous,
      )
    }
    if (!ownsTeamResponse(owner, { client: serverSDK().client, roomID: state.value?.room.id, generation })) return
    if (action === "delete") roomRevision++
    setState("roomAction", undefined)
    if (action === "archive" || action === "delete") {
      const next = value.rooms.find((room) => room.id !== owner.roomID && !room.archived)
      if (next) navigate(`/team/${next.id}`, { replace: true })
      // Keep the last archived room visible when no active room remains.
      if (!next && action === "delete") navigate("/team", { replace: true })
    }
    void load("poll")
  }
  const roomMenu = (room: () => Team.Room) => (
    <DropdownMenu>
      <DropdownMenu.Trigger class={button} aria-label={`Room actions for ${room().name}`} disabled={state.busy}>
        ···
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <Show
            when={room().id === state.value?.room.id}
            fallback={
              <DropdownMenu.Item onSelect={() => navigate(`/team/${room().id}`)}>Open room to manage</DropdownMenu.Item>
            }
          >
            <Show when={!room().archived}>
              <DropdownMenu.Item onSelect={() => setState("roomAction", "edit")}>Edit name and topic</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => setState("roomAction", "archive")}>Archive room</DropdownMenu.Item>
            </Show>
            <Show when={room().archived}>
              <DropdownMenu.Item onSelect={() => setState("roomAction", "restore")}>Restore room</DropdownMenu.Item>
              <DropdownMenu.Item disabled={!!deleteBlocker()} onSelect={() => setState("roomAction", "delete")}>
                Delete room
              </DropdownMenu.Item>
            </Show>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
  const factorySaved = () => {
    const saved = state.value?.room.factory?.config
    if (!saved) return false
    try {
      return (
        JSON.stringify({ ...state.factoryConfig, parameters: parseFactoryParameters(state.factoryParameters) }) ===
        JSON.stringify(saved)
      )
    } catch {
      return false
    }
  }
  const openProfile = (teammate: Team.Teammate) => {
    setProfile({
      role: teammate.role,
      mission: teammate.mission,
      directory: teammate.directory,
      agent: teammate.agent ?? "",
      model: teammate.model ? `${teammate.model.providerID}/${teammate.model.id}` : "",
      avatar: teammate.avatar ? [...teammate.avatar] : generatePixelAvatar(teammate.handle),
    })
    setState("selected", teammate.id)
  }
  const assigned = () => (state.value ? assignedHandles(state.text, state.value.teammates) : [])
  const activeRun = () => state.value?.factoryRuns?.find((run) => run.status === "running")
  // Controlled because polling replaces the run object every few seconds; a plain `open`
  // binding would reset a run the user expanded or collapsed.
  const factoryRunOpen = (run: Team.FactoryRun) =>
    state.factoryRunOpen[run.id] ??
    (run.status === "failed" || run.status === "running" || run.status === "needs_input")
  const activeTasks = () => state.value?.tasks.filter((task) => ["queued", "claimed", "running"].includes(task.status))
  const finishedTasks = () =>
    state.value?.tasks.filter((task) => !["queued", "claimed", "running"].includes(task.status))

  return (
    <div
      class={surface}
      data-component="team-page"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !state.mobilePanel) return
        event.preventDefault()
        setState("mobilePanel", undefined)
      }}
    >
      {/* Field styles target the native input. The shared wrappers have a fixed width. */}
      <style>{`[data-component="team-page"] [data-component="textarea-v2"],
        [data-component="team-page"] [data-component="text-input-v2"] { width: 100%; min-width: 0; }`}</style>
      <Show when={!rail.collapsed("team") || state.mobilePanel === "channels"}>
        <aside
          data-component="team-channel-panel"
          class={`flex w-[208px] shrink-0 flex-col border-r border-v2-border-border-base bg-v2-background-bg-base px-3 py-4 max-md:fixed max-md:inset-y-0 max-md:left-[52px] max-md:z-30 max-md:bg-v2-background-bg-layer-01 ${state.mobilePanel === "channels" ? "max-md:flex" : "max-md:hidden"}`}
        >
          <div class="flex items-center justify-between px-2">
            <h1 class="text-[14px] [font-weight:550]">Team</h1>
            <button
              class={`${button} md:hidden`}
              aria-label="Close rooms"
              onClick={() => setState("mobilePanel", undefined)}
            >
              Close
            </button>
          </div>
          <div class="mt-6 flex items-center justify-between px-2 text-[10px] font-mono uppercase tracking-wide text-v2-text-text-faint">
            <span>Rooms</span>
            <button class={button} aria-label="Create room" onClick={() => setState("roomOpen", true)}>
              +
            </button>
          </div>
          <div class="mt-2 flex flex-col gap-0.5">
            <For each={state.value?.rooms.filter((room) => !room.archived || state.archivedOpen)}>
              {(room) => (
                <div class="flex items-center">
                  <button
                    class={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-[13px] ${state.value?.room.id === room.id ? "bg-v2-background-bg-layer-02" : "hover:bg-v2-overlay-simple-overlay-hover"}`}
                    onClick={() => {
                      navigate(`/team/${room.id}`)
                      setState("mobilePanel", undefined)
                    }}
                  >
                    # {room.name}
                    {room.archived ? " · Archived" : ""}
                  </button>
                  {roomMenu(() => room)}
                </div>
              )}
            </For>
          </div>
          <button
            class={`${button} mt-2 text-left`}
            aria-pressed={state.archivedOpen}
            onClick={() => setState("archivedOpen", !state.archivedOpen)}
          >
            {state.archivedOpen ? "Hide archived rooms" : "Show archived rooms"}
          </button>
          <Show when={state.value?.rooms.length === 0}>
            <p class="px-2 py-3 text-[12px] text-v2-text-text-muted">No shared rooms yet.</p>
          </Show>
          <div class="mt-auto border-t border-v2-border-border-base px-2 pt-3 text-[11px] text-v2-text-text-muted">
            Shared room history
          </div>
        </aside>
      </Show>
      <main class="flex min-w-0 flex-1 flex-col">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-3 border-b border-v2-border-border-base px-5 py-3 max-sm:px-4">
          <button
            class={`${button} md:hidden`}
            onClick={() => setState("mobilePanel", state.mobilePanel === "channels" ? undefined : "channels")}
            aria-label="Toggle rooms"
          >
            <Icon name="menu" />
          </button>
          <div class="min-w-0 flex-1 basis-[120px]">
            <h2 class="text-[16px] leading-6 [font-weight:550]"># {state.value?.room.name ?? "Team"}</h2>
            <Show when={state.value?.room.topic}>
              <p class="truncate text-[12px] leading-4 text-v2-text-text-muted">{state.value?.room.topic}</p>
            </Show>
            <p class="mt-1 text-[12px] leading-4 text-v2-text-text-muted max-sm:hidden">Shared work and updates</p>
          </div>
          <button
            class={`${button} whitespace-nowrap lg:hidden`}
            onClick={() => setState("mobilePanel", "members")}
            aria-label="Open members"
          >
            Activity
          </button>
          <Show when={state.value?.room}>{(room) => roomMenu(room)}</Show>
        </header>
        <Show when={archived()}>
          <p class="border-b border-v2-border-border-base px-5 py-2 text-[12px] text-v2-text-text-muted">
            Archived · read-only. Restore does not resume paused schedules.
          </p>
          <Show when={deleteBlocker()}>
            <p class="px-5 py-1 text-[11px] text-v2-text-text-muted">{deleteBlocker()}</p>
          </Show>
        </Show>
        <Show when={state.roomAction} keyed>
          {(action) => (
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
              <form
                class="w-full max-w-[420px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-5"
                role="dialog"
                aria-modal="true"
                aria-labelledby="team-room-action-title"
                tabIndex={-1}
                ref={(element) => focusDialog(element, () => setState("roomAction", undefined))}
                onSubmit={(event) => {
                  event.preventDefault()
                  const form = new FormData(event.currentTarget)
                  void safeAction(() => changeRoom(form))
                }}
              >
                <h2 id="team-room-action-title" class="mb-3 text-[16px] [font-weight:550]">
                  {roomActionTitle[action]}
                </h2>
                <Show when={action === "edit"}>
                  <label class="mb-3 block text-[12px]">
                    Room name
                    <TextInputV2 name="name" required value={state.value?.room.name} />
                  </label>
                  <label class="mb-3 block text-[12px]">
                    Topic
                    <TextInputV2 name="topic" value={state.value?.room.topic} />
                  </label>
                </Show>
                <p class="mb-4 text-[12px] leading-5 text-v2-text-text-muted">{roomActionDescription[action]}</p>
                <Show when={state.error}>
                  <p role="alert" class="mb-3 text-[12px] text-v2-state-fg-danger">
                    {state.error}
                  </p>
                </Show>
                <div class="flex justify-end gap-2">
                  <button type="button" class={button} onClick={() => setState("roomAction", undefined)}>
                    Cancel
                  </button>
                  <ButtonV2 type="submit" disabled={state.busy || (action === "delete" && !!deleteBlocker())}>
                    {state.busy ? "Saving..." : roomActionLabel[action]}
                  </ButtonV2>
                </div>
              </form>
            </div>
          )}
        </Show>
        <Show when={state.factoryOpen && !archived()}>
          <div
            class="fixed inset-0 z-50 flex justify-end bg-black/30"
            onClick={(event) => event.target === event.currentTarget && setState("factoryOpen", false)}
          >
            <section
              class="h-full w-[440px] max-w-full overflow-y-auto border-l border-v2-border-border-base bg-v2-background-bg-layer-01 p-5"
              role="dialog"
              aria-modal="true"
              aria-labelledby="team-factory-title"
              aria-describedby="team-factory-description"
              tabIndex={-1}
              ref={(element) => focusDialog(element, () => setState("factoryOpen", false))}
            >
              <div class="mb-4 flex items-center justify-between">
                <h2 id="team-factory-title" class="text-[16px] [font-weight:550]">
                  Factory setup
                </h2>
                <button class={button} onClick={() => setState("factoryOpen", false)}>
                  Close
                </button>
              </div>
              <p id="team-factory-description" class="mb-5 text-[12px] leading-5 text-v2-text-text-muted">
                Define the outcome and inputs. The coordinator plans work, assigns teammates, and checks the result.
                Save settings first, then run the factory or add a trigger.
              </p>
              <form
                class="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void safeAction(saveFactory)
                }}
              >
                <h3 class="text-[12px] [font-weight:550]">Outcome and inputs</h3>
                <label class="block text-[12px]">
                  Desired outcome
                  <TextareaV2
                    style={{ width: "100%" }}
                    placeholder="What should this team produce?"
                    required
                    value={state.factoryConfig.outcome}
                    onInput={(event) =>
                      setState("factoryConfig", { ...state.factoryConfig, outcome: event.currentTarget.value })
                    }
                    class="mt-1 w-full"
                  />
                </label>
                <label class="block text-[12px]">
                  Inputs (JSON object)
                  <TextareaV2
                    style={{ width: "100%", "font-family": "monospace" }}
                    value={state.factoryParameters}
                    onInput={(event) => setState("factoryParameters", event.currentTarget.value)}
                    class="mt-1 w-full font-mono"
                    rows={5}
                  />
                </label>
                <label class="block text-[12px]">
                  Constraints (optional)
                  <TextareaV2
                    style={{ width: "100%" }}
                    placeholder="Limits, requirements, or work to avoid"
                    value={state.factoryConfig.constraints}
                    onInput={(event) =>
                      setState("factoryConfig", { ...state.factoryConfig, constraints: event.currentTarget.value })
                    }
                    class="mt-1 w-full"
                  />
                </label>
                <label class="block text-[12px]">
                  Acceptance criteria
                  <TextareaV2
                    style={{ width: "100%" }}
                    placeholder="How should the coordinator check the result?"
                    required
                    value={state.factoryConfig.acceptanceCriteria}
                    onInput={(event) =>
                      setState("factoryConfig", {
                        ...state.factoryConfig,
                        acceptanceCriteria: event.currentTarget.value,
                      })
                    }
                    class="mt-1 w-full"
                  />
                </label>
                <h3 class="border-t border-v2-border-border-base pt-4 text-[12px] [font-weight:550]">Execution</h3>
                <label class="block text-[12px]">
                  Execution directory
                  <TextInputV2
                    style={{ width: "100%" }}
                    required
                    value={state.factoryConfig.directory}
                    onInput={(event) =>
                      setState("factoryConfig", { ...state.factoryConfig, directory: event.currentTarget.value })
                    }
                    class="mt-1 w-full"
                    placeholder="/absolute/project/path"
                  />
                </label>
                <div class="border-t border-v2-border-border-base pt-3">
                  <h3 class="mb-1 text-[12px] [font-weight:550]">Teammates</h3>
                  <p class="mb-2 text-[11px] leading-4 text-v2-text-text-muted">
                    Select up to 10 teammates. Choose one as the coordinator.
                  </p>
                  <Show when={state.value?.teammates.length === 0}>
                    <p class="mb-2 text-[12px] leading-5 text-v2-text-text-muted">
                      Add a teammate before you configure the factory.
                    </p>
                    <ButtonV2
                      type="button"
                      size="small"
                      variant="neutral"
                      onClick={() => {
                        setState("factoryOpen", false)
                        setState("createOpen", true)
                      }}
                    >
                      Add teammate
                    </ButtonV2>
                  </Show>
                  <For each={state.value?.teammates}>
                    {(teammate) => (
                      <label class="flex items-start gap-2 py-1.5 text-[12px]">
                        <input
                          type="checkbox"
                          checked={state.factoryConfig.teammateIDs.includes(teammate.id)}
                          onChange={(event) => {
                            try {
                              const teammateIDs = selectFactoryTeammate(
                                state.factoryConfig.teammateIDs,
                                teammate.id,
                                event.currentTarget.checked,
                              )
                              setState("factoryConfig", {
                                ...state.factoryConfig,
                                teammateIDs,
                                coordinatorTeammateID:
                                  event.currentTarget.checked && !state.factoryConfig.coordinatorTeammateID
                                    ? teammate.id
                                    : !event.currentTarget.checked &&
                                        state.factoryConfig.coordinatorTeammateID === teammate.id
                                      ? ""
                                      : state.factoryConfig.coordinatorTeammateID,
                              })
                              setState("error", undefined)
                            } catch (error) {
                              setState("error", error instanceof Error ? error.message : "Could not select teammate")
                            }
                          }}
                        />
                        <span class="min-w-0 break-words">
                          @{teammate.handle} · {teammate.role}
                          {teammate.status === "paused" ? " · Paused" : ""}
                        </span>
                      </label>
                    )}
                  </For>
                </div>
                <label class="block text-[12px]">
                  Coordinator
                  <select
                    class="mt-1 w-full border border-v2-border-border-base bg-v2-background-bg-base px-2 py-2"
                    value={state.factoryConfig.coordinatorTeammateID}
                    disabled={!state.factoryConfig.teammateIDs.length}
                    onChange={(event) =>
                      setState("factoryConfig", {
                        ...state.factoryConfig,
                        coordinatorTeammateID: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="">
                      {state.factoryConfig.teammateIDs.length ? "Choose a coordinator" : "Select teammates first"}
                    </option>
                    <For
                      each={state.value?.teammates.filter((item) => state.factoryConfig.teammateIDs.includes(item.id))}
                    >
                      {(teammate) => <option value={teammate.id}>@{teammate.handle}</option>}
                    </For>
                  </select>
                </label>
                <Show when={state.error}>
                  <p role="alert" class="text-[11px] text-v2-state-fg-danger">
                    {state.error}
                  </p>
                </Show>
                <p class="text-[11px] leading-5 text-v2-text-text-muted">
                  Saving does not start work. Triggers use the duty editor and its expiry limits. Open linked Sessions
                  to answer questions or approve native permission requests.
                </p>
                <div class="flex flex-wrap justify-end gap-2 border-t border-v2-border-border-base pt-4">
                  <ButtonV2
                    type="button"
                    size="small"
                    variant="neutral"
                    disabled={state.busy || !state.value?.teammates.length}
                    onClick={() =>
                      void safeAction(async () => {
                        await saveFactory()
                        navigate(
                          `/team/duties/new?factoryRoomID=${encodeURIComponent(state.value?.room.id ?? "")}&directory=${encodeURIComponent(state.factoryConfig.directory)}`,
                        )
                      })
                    }
                  >
                    Save and add trigger
                  </ButtonV2>
                  <ButtonV2 type="submit" size="small" disabled={state.busy || !state.value?.teammates.length}>
                    {state.busy ? "Saving..." : "Save settings"}
                  </ButtonV2>
                </div>
              </form>
            </section>
          </div>
        </Show>
        <Show when={state.error ?? state.loadError}>
          <div
            role="alert"
            class="flex items-center justify-between border-b border-v2-state-border-danger bg-v2-state-bg-danger px-4 py-2 text-[12px]"
          >
            <span>{state.error ?? state.loadError}</span>
            <button class={button} onClick={() => void load("poll")}>
              Retry
            </button>
          </div>
        </Show>
        <Show when={!state.loading && state.value?.hasMore}>
          <div class="px-4 pt-2">
            <button class={button} disabled={state.olderLoading} onClick={() => void load("older")}>
              {state.olderLoading ? "Loading older messages..." : "Load older messages"}
            </button>
          </div>
        </Show>
        <div
          ref={scroll.scrollRef}
          onScroll={scroll.handleScroll}
          onPointerDown={scroll.handleInteraction}
          onPointerUp={scroll.handleInteraction}
          role="log"
          aria-label="Room messages"
          aria-live="polite"
          class="min-h-0 flex-1 overflow-y-auto px-6 py-5 font-mono text-[12px] max-sm:px-4"
        >
          <Show when={state.loading}>
            <p class="text-v2-text-text-muted">Loading room history...</p>
          </Show>
          <Show when={!state.loading && state.value?.messages.length === 0}>
            <div class="mx-auto flex min-h-full max-w-[460px] flex-col justify-center py-8 font-sans">
              <p class="text-[16px] [font-weight:550]">Bring your team into this channel</p>
              <p class="mt-2 text-[13px] leading-5 text-v2-text-text-muted">
                Ask an agent to set up a factory here. Give it an outcome, and let it create the team and configure the
                work.
              </p>
              <ol class="mt-5 space-y-3 text-[12px] leading-5">
                <li>
                  <span class="text-v2-text-text-faint">1.</span> Ask an agent to create teammates with clear roles and
                  missions.
                </li>
                <li>
                  <span class="text-v2-text-text-faint">2.</span> Describe the outcome, inputs, and acceptance criteria.
                </li>
                <li>
                  <span class="text-v2-text-text-faint">3.</span> Ask it to run the factory when you are ready.
                </li>
              </ol>
              <div class="mt-5 flex flex-wrap gap-2">
                <ButtonV2 size="small" disabled={archived()} onClick={() => setState("createOpen", true)}>
                  Add teammate
                </ButtonV2>
                <ButtonV2
                  size="small"
                  variant="neutral"
                  disabled={archived()}
                  onClick={() => setState("factoryOpen", true)}
                >
                  Factory setup
                </ButtonV2>
              </div>
              <p class="mt-5 text-[12px] leading-5 text-v2-text-text-muted">
                Keep shared notes and work updates in this channel.
              </p>
            </div>
          </Show>
          <div ref={scroll.contentRef} class="flow-root">
            <For each={state.value?.messages}>
              {(message) => (
                <article class="mb-4 grid grid-cols-[128px_minmax(0,1fr)] gap-3 max-sm:grid-cols-[76px_minmax(0,1fr)]">
                  <div class="flex justify-between gap-2 text-[10px] text-v2-text-text-faint">
                    <time>{timeLabel(message.time)}</time>
                    <b class="truncate font-sans text-v2-text-text-base">{message.author}</b>
                  </div>
                  <div class="min-w-0 break-words font-sans text-[13px] leading-5">
                    <Show when={message.replyTo}>
                      <div
                        role="note"
                        aria-label="Reply context"
                        class="mb-2 min-w-0 border-l-2 border-v2-border-border-base pl-2 text-[11px] leading-4 text-v2-text-text-muted"
                      >
                        <Show
                          when={replyContext(message, state.value?.messages ?? [])}
                          fallback={<p>Reply to a message not loaded.</p>}
                        >
                          {(source) => (
                            <>
                              <p class="break-words">Reply to {source().author}</p>
                              <p class="break-words">{source().excerpt}</p>
                            </>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <TeamMessageContent message={message} />
                    <Show when={message.kind === "system"}>
                      <span class="text-v2-text-text-muted"> · update</span>
                    </Show>
                    <Show when={message.sessionID}>
                      <a
                        class="ml-2 text-v2-text-text-accent underline"
                        href={sessionHref(server.key, message.sessionID!)}
                      >
                        Open Session
                      </a>
                    </Show>
                  </div>
                </article>
              )}
            </For>
          </div>
        </div>
        <div class="border-t border-v2-border-border-base px-5 py-3 max-sm:px-4">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            class="mb-2 flex min-h-4 items-center gap-2 text-[11px] leading-4 text-v2-text-text-muted"
          >
            <Show when={state.value && roomActivity(state.value.room.id, state.value.tasks, state.value.teammates)}>
              {(activity) => (
                <>
                  <span aria-hidden="true" class="flex shrink-0 gap-1 motion-safe:animate-pulse">
                    <span class="size-1 rounded-full bg-current" />
                    <span class="size-1 rounded-full bg-current" />
                    <span class="size-1 rounded-full bg-current" />
                  </span>
                  <span class="min-w-0 truncate">{activity()}</span>
                </>
              )}
            </Show>
          </div>
          <label for="team-message" class="mb-2 block text-[12px] [font-weight:550]">
            Message #{state.value?.room.name ?? "team"}
          </label>
          <TeamMentionInput
            disabled={!state.value || archived()}
            value={state.text}
            teammates={state.value?.teammates ?? []}
            onInput={(value) => {
              setState("text", value)
              if (pendingPost && value.trim() !== pendingPost.text) pendingPost = undefined
            }}
            onSend={() => void send()}
          />
          <div class="mt-2 flex items-end gap-3 text-[11px] leading-4 text-v2-text-text-muted">
            <div id="team-message-hint" class="min-w-0 flex-1">
              <p>
                {pendingPost
                  ? `Retrying original message to #${state.value?.rooms.find((room) => room.id === pendingPost?.roomID)?.name ?? "previous room"}`
                  : assigned().length
                    ? `Assigning to ${assigned()
                        .map((handle) => `@${handle}`)
                        .join(", ")}`
                    : archived()
                      ? "Archived rooms are read-only."
                      : coordinator()?.status === "active"
                        ? `@${coordinator()!.handle} coordinates messages without a mention. Mention @handle for a direct task.`
                        : coordinator()
                          ? `Coordinator @${coordinator()!.handle} is paused. Mention an active teammate for a direct task.`
                          : state.value?.room.factory?.config.coordinatorTeammateID
                            ? "The configured coordinator is unavailable. Mention an active teammate for a direct task."
                            : "The coordinator handles messages without a mention. Add an active teammate to start work. Mention @handle for a direct task."}
              </p>
              <p class="mt-1 text-v2-text-text-faint">Enter to send · Shift+Enter for a new line</p>
            </div>
            <ButtonV2
              class="shrink-0"
              size="small"
              disabled={state.busy || !state.text.trim() || !state.value || archived()}
              onClick={send}
            >
              {state.busy ? "Sending..." : "Send"}
            </ButtonV2>
          </div>
        </div>
      </main>
      <aside
        aria-label="Room teammates and work"
        class={`hidden w-[256px] max-w-[90vw] shrink-0 overflow-y-auto border-l border-v2-border-border-base px-4 py-4 lg:block ${state.mobilePanel === "members" ? "!fixed inset-y-0 right-0 z-40 !block bg-v2-background-bg-layer-01" : ""}`}
      >
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 class="whitespace-nowrap text-[13px] [font-weight:550]">
            Teammates <span class="text-v2-text-text-muted">{state.value?.teammates.length ?? 0}</span>
          </h3>
          <div class="flex gap-1">
            <button class={`${button} lg:hidden`} onClick={() => setState("mobilePanel", undefined)}>
              Close
            </button>
            <ButtonV2
              size="small"
              variant="neutral"
              class="whitespace-nowrap"
              disabled={!state.value || archived()}
              onClick={() => setState("createOpen", true)}
            >
              Add
            </ButtonV2>
          </div>
        </div>
        <For each={state.value?.teammates}>
          {(teammate) => (
            <button
              class="flex w-full gap-2 rounded-md px-1 py-2 text-left hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => openProfile(teammate)}
            >
              <PixelAvatar
                avatar={teammate.avatar}
                seed={teammate.handle}
                size={28}
                label={`${teammate.name} avatar`}
              />
              <span class="min-w-0">
                <span class="block truncate text-[12px]">@{teammate.handle}</span>
                <span class="block truncate text-[10px] text-v2-text-text-muted">
                  {teammate.role} · {teammate.status}
                </span>
              </span>
            </button>
          )}
        </For>
        <Show when={state.value?.teammates.length === 0}>
          <p class="text-[12px] leading-5 text-v2-text-text-muted">
            No teammates yet. Add teammates with roles and missions, then choose a coordinator in Factory setup.
          </p>
        </Show>
        <div class="my-4 border-t border-v2-border-border-base" />
        <section aria-label="Factory activity" class="mb-5">
          <h3 class="text-[12px] [font-weight:550]">Factory</h3>
          <Show
            when={state.value?.factoryRuns?.[0]}
            fallback={
              <p class="mt-2 text-[12px] leading-5 text-v2-text-text-muted">
                Ask a teammate to set up a factory with an outcome, roles, and acceptance criteria.
              </p>
            }
          >
            {(run) => (
              <details class="mt-2" open={factoryRunOpen(run())}>
                <summary
                  class="cursor-pointer text-[12px] leading-5"
                  onClick={(event) => {
                    event.preventDefault()
                    setState("factoryRunOpen", run().id, !factoryRunOpen(run()))
                  }}
                >
                  {statusLabel[run().status]}
                  <Show when={run().status === "running"}> · {phaseLabel[run().phase]}</Show>
                </summary>
                <Show when={run().error}>
                  <p role="alert" class="mt-2 break-words text-[12px] leading-5 text-v2-state-fg-danger">
                    {run().error}
                  </p>
                </Show>
                <Show when={run().result}>
                  <p class="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5">{run().result}</p>
                </Show>
                <For each={run().taskIDs}>
                  {(id) => {
                    const task = () => state.value?.tasks.find((item) => item.id === id)
                    return (
                      <Show when={task()}>
                        {(item) => (
                          <a
                            class="mt-2 block text-[12px] leading-5 underline"
                            href={sessionHref(server.key, item().sessionID)}
                          >
                            @
                            {state.value?.teammates.find((mate) => mate.id === item().teammateID)?.handle ?? "teammate"}{" "}
                            · {statusLabel[item().status]}
                          </a>
                        )}
                      </Show>
                    )
                  }}
                </For>
                <Show when={activeRun() && !archived()}>
                  <button
                    class="mt-3 text-[12px] text-v2-state-fg-danger"
                    disabled={state.busy}
                    onClick={() => void stopFactory()}
                  >
                    Stop factory
                  </button>
                </Show>
              </details>
            )}
          </Show>
          <details class="mt-3 text-[11px] text-v2-text-text-muted">
            <summary class="cursor-pointer">Manual controls</summary>
            <div class="mt-2 flex flex-wrap gap-2">
              <ButtonV2
                size="small"
                variant="neutral"
                disabled={!state.value || archived()}
                onClick={() => setState("factoryOpen", true)}
              >
                Settings
              </ButtonV2>
              <ButtonV2
                size="small"
                disabled={state.busy || !factorySaved() || !!activeRun() || archived()}
                onClick={() => void runFactory()}
              >
                Run
              </ButtonV2>
            </div>
          </details>
        </section>
        <div class="font-mono text-[10px] uppercase tracking-wide text-v2-text-text-faint">Active work</div>
        <Show when={!activeTasks()?.length}>
          <p class="mt-2 text-[12px] leading-5 text-v2-text-text-muted">
            No active tasks. Run the factory or mention a teammate to start work.
          </p>
        </Show>
        <For each={activeTasks()}>
          {(task) => (
            <div class="mt-3 border-b border-v2-border-border-base pb-3">
              <div class="text-[11px]">
                {state.value?.teammates.find((item) => item.id === task.teammateID)?.handle ?? "Teammate"} ·{" "}
                {statusLabel[task.status]}
              </div>
              <div class="mt-2 flex gap-2">
                <a class="text-[11px] underline" href={sessionHref(server.key, task.sessionID)}>
                  Open Session
                </a>
                <Show when={!archived() && ["queued", "claimed", "running"].includes(task.status)}>
                  <button
                    class="text-[11px] text-v2-state-fg-danger"
                    disabled={state.busy}
                    onClick={() =>
                      void safeAction(async () => {
                        await teamApi(serverSDK().client).taskCancel({ taskID: task.id })
                        await load("poll")
                      })
                    }
                  >
                    Stop
                  </button>
                </Show>
              </div>
              <Show when={task.error}>
                <p class="mt-1 text-[10px] text-v2-state-fg-danger">{task.error}</p>
              </Show>
            </div>
          )}
        </For>
        <Show when={finishedTasks()?.length}>
          <details class="mt-5 border-t border-v2-border-border-base pt-3">
            <summary class="cursor-pointer text-[11px] text-v2-text-text-muted">
              Recent finished tasks · {finishedTasks()?.length}
            </summary>
            <For each={finishedTasks()}>
              {(task) => (
                <div class="mt-3 border-b border-v2-border-border-base pb-3 text-[11px]">
                  <p>
                    {state.value?.teammates.find((item) => item.id === task.teammateID)?.handle ?? "Teammate"} ·{" "}
                    {statusLabel[task.status]}
                  </p>
                  <a class="mt-1 inline-block underline" href={sessionHref(server.key, task.sessionID)}>
                    Open Session
                  </a>
                  <Show when={task.error}>
                    <p class="mt-1 break-words text-v2-state-fg-danger">{task.error}</p>
                  </Show>
                </div>
              )}
            </For>
          </details>
        </Show>
      </aside>
      <Show when={state.selected && selected() ? state.selected : undefined} keyed>
        {(_teammateID) => (
          <div
            class="fixed inset-0 z-40 flex justify-end bg-black/30"
            onClick={(event) => event.target === event.currentTarget && setState("selected", undefined)}
          >
            <section
              class="h-full w-[380px] max-w-full overflow-y-auto border-l border-v2-border-border-base bg-v2-background-bg-layer-01 p-5"
              role="dialog"
              aria-modal="true"
              aria-labelledby="team-profile-title"
              tabIndex={-1}
              ref={(element) => focusDialog(element, () => setState("selected", undefined))}
            >
              <button class={button} onClick={() => setState("selected", undefined)}>
                Close
              </button>
              <h2 id="team-profile-title" class="mt-4 text-[16px] [font-weight:550]">
                @{selected()?.handle}
              </h2>
              <p class="text-[12px] text-v2-text-text-muted">
                {selected()?.role} · {selected()?.status}
              </p>
              <form
                class="mt-4 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void safeAction(async () => {
                    const saved = await editTeammate(selected()!)
                    if (saved) setState("selected", undefined)
                  })
                }}
              >
                <fieldset disabled={archived()} class="space-y-3">
                  <PixelAvatarEditor
                    value={profile.avatar}
                    seed={selected()?.handle ?? "teammate"}
                    onChange={(avatar) => setProfile("avatar", avatar)}
                  />
                  <label class="block text-[11px]">
                    Role
                    <TextInputV2
                      name="role"
                      style={{ width: "100%" }}
                      value={profile.role}
                      onInput={(event) => setProfile("role", event.currentTarget.value)}
                      class="mt-1 w-full"
                    />
                  </label>
                  <label class="block text-[11px]">
                    Mission
                    <TextareaV2
                      name="mission"
                      style={{ width: "100%" }}
                      value={profile.mission}
                      onInput={(event) => setProfile("mission", event.currentTarget.value)}
                      class="mt-1 w-full"
                    />
                  </label>
                  <label class="block text-[11px]">
                    Execution directory
                    <TextInputV2
                      name="directory"
                      style={{ width: "100%" }}
                      value={profile.directory}
                      onInput={(event) => setProfile("directory", event.currentTarget.value)}
                      class="mt-1 w-full"
                    />
                  </label>
                  <label class="block text-[11px]">
                    Agent
                    <select
                      name="agent"
                      value={profile.agent}
                      onChange={(event) => setProfile("agent", event.currentTarget.value)}
                      class="mt-1 w-full border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5"
                    >
                      <option value="">Default Agent</option>
                      <For each={state.agents}>{(agent) => <option value={agent}>{agent}</option>}</For>
                    </select>
                  </label>
                  <label class="block text-[11px]">
                    Model
                    <select
                      name="model"
                      value={profile.model}
                      onChange={(event) => setProfile("model", event.currentTarget.value)}
                      class="mt-1 w-full border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5"
                    >
                      <option value="">Default model</option>
                      <For each={state.models}>
                        {(model) => (
                          <option value={`${model.providerID}/${model.id}`}>
                            {model.name} · {model.providerID}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <ButtonV2 type="submit" size="small" disabled={state.busy || archived()}>
                    {state.busy ? "Saving..." : "Save profile"}
                  </ButtonV2>
                </fieldset>
              </form>
              <Show when={!archived()}>
                <div class="mt-4 flex flex-wrap gap-2">
                  <ButtonV2
                    size="small"
                    disabled={state.busy}
                    onClick={() =>
                      void safeAction(async () => {
                        await teamApi(serverSDK().client).teammateEdit({
                          teammateID: selected()!.id,
                          edit: { status: selected()!.status === "paused" ? "active" : "paused" },
                        })
                        await load("poll")
                      })
                    }
                  >
                    {selected()?.status === "paused" ? "Resume" : "Pause future work"}
                  </ButtonV2>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={state.busy}
                    onClick={() =>
                      void safeAction(async () => {
                        await teamApi(serverSDK().client).teammateStop({ teammateID: selected()!.id })
                        await load("poll")
                      })
                    }
                  >
                    Stop active work
                  </ButtonV2>
                </div>
              </Show>
              <h3 class="mt-7 font-mono text-[10px] uppercase text-v2-text-text-faint">Duties</h3>
              <For each={state.value?.duties.filter((duty) => duty.teammateID === selected()?.id)}>
                {(duty) => (
                  <Show
                    when={!archived()}
                    fallback={
                      <p class="mt-2 text-[12px]">
                        {state.dutyDefinitions.find((item) => item.id === duty.loopID)?.name ?? duty.loopID} · Paused
                      </p>
                    }
                  >
                    <a class="mt-2 block text-[12px] underline" href={`/team/duties/${duty.loopID}`}>
                      {state.dutyDefinitions.find((item) => item.id === duty.loopID)?.name ??
                        `Open duty ${duty.loopID}`}
                    </a>
                  </Show>
                )}
              </For>
              <Show when={!archived()}>
                <a class="mt-3 block text-[12px] underline" href={`/team/duties/new?teammate=${selected()?.id}`}>
                  Add duty
                </a>
              </Show>
            </section>
          </div>
        )}
      </Show>
      <Show when={state.createOpen && !archived()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={(event) => event.target === event.currentTarget && setState("createOpen", false)}
        >
          <form
            class="max-h-full w-full max-w-[460px] overflow-y-auto border border-v2-border-border-base bg-v2-background-bg-layer-01 p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-create-title"
            tabIndex={-1}
            ref={(element) => focusDialog(element, () => setState("createOpen", false))}
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              void safeAction(() => createTeammate(form))
            }}
          >
            <h2 id="team-create-title" class="mb-2 text-[16px] [font-weight:550]">
              Create teammate
            </h2>
            <p class="mb-4 text-[12px] leading-5 text-v2-text-text-muted">
              Give this teammate a role and mission. Use their handle for direct tasks, or select them in Factory setup.
            </p>
            <PixelAvatarEditor
              value={state.createAvatar}
              seed={state.createHandle || "teammate"}
              onChange={(avatar) => setState("createAvatar", avatar)}
            />
            <Show when={state.error}>
              <p role="alert" class="mb-3 text-[12px] text-v2-state-fg-danger">
                {state.error}
              </p>
            </Show>
            <label class="mb-3 block text-[11px]">
              Name
              <TextInputV2 name="name" required class="mt-1 w-full" style={{ width: "100%" }} />
            </label>
            <label class="mb-3 block text-[11px]">
              Handle
              <TextInputV2
                name="handle"
                onInput={(event) => setState("createHandle", event.currentTarget.value.replace(/^@/, ""))}
                required
                class="mt-1 w-full"
                style={{ width: "100%" }}
                placeholder="e.g. reviewer"
              />
            </label>
            <label class="mb-3 block text-[11px]">
              Role
              <TextInputV2
                name="role"
                class="mt-1 w-full"
                style={{ width: "100%" }}
                placeholder="Application security"
              />
            </label>
            <label class="mb-3 block text-[11px]">
              Mission
              <TextareaV2
                name="mission"
                required
                class="mt-1 w-full"
                style={{ width: "100%" }}
                placeholder="Describe the work this teammate owns"
              />
            </label>
            <label class="mb-3 block text-[11px]">
              Execution directory
              <TextInputV2
                name="directory"
                class="mt-1 w-full"
                style={{ width: "100%" }}
                placeholder="/absolute/project/path"
              />
            </label>
            <label class="mb-3 block text-[11px]">
              Agent
              <select
                name="agent"
                class="mt-1 w-full border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5"
              >
                <option value="">Default Agent</option>
                <For each={state.agents}>{(agent) => <option value={agent}>{agent}</option>}</For>
              </select>
            </label>
            <label class="mb-3 block text-[11px]">
              Model
              <select
                name="model"
                class="mt-1 w-full border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5"
              >
                <option value="">Default model</option>
                <For each={state.models}>
                  {(model) => (
                    <option value={`${model.providerID}/${model.id}`}>
                      {model.name} · {model.providerID}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <p class="mb-4 text-[10px] text-v2-text-text-muted">
              Tools and permissions use your existing Agent configuration.
            </p>
            <div class="flex justify-end gap-2">
              <button type="button" class={button} onClick={() => setState("createOpen", false)}>
                Cancel
              </button>
              <ButtonV2 type="submit" disabled={state.busy}>
                {state.busy ? "Creating..." : "Create"}
              </ButtonV2>
            </div>
          </form>
        </div>
      </Show>
      <Show when={state.roomOpen}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={(event) => event.target === event.currentTarget && setState("roomOpen", false)}
        >
          <form
            class="max-h-full w-full max-w-[420px] overflow-y-auto border border-v2-border-border-base bg-v2-background-bg-layer-01 p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-room-title"
            tabIndex={-1}
            ref={(element) => focusDialog(element, () => setState("roomOpen", false))}
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              void safeAction(() => createRoom(form))
            }}
          >
            <h2 id="team-room-title" class="mb-4 text-[16px] [font-weight:550]">
              Create room
            </h2>
            <Show when={state.error}>
              <p role="alert" class="mb-3 text-[12px] text-v2-state-fg-danger">
                {state.error}
              </p>
            </Show>
            <label class="mb-3 block text-[11px]">
              Room name
              <TextInputV2 name="name" required class="mt-1 w-full" style={{ width: "100%" }} />
            </label>
            <label class="mb-4 block text-[11px]">
              Topic
              <TextInputV2 name="topic" class="mt-1 w-full" style={{ width: "100%" }} />
            </label>
            <div class="flex justify-end gap-2">
              <button type="button" class={button} onClick={() => setState("roomOpen", false)}>
                Cancel
              </button>
              <ButtonV2 type="submit" disabled={state.busy}>
                {state.busy ? "Creating..." : "Create room"}
              </ButtonV2>
            </div>
          </form>
        </div>
      </Show>
    </div>
  )
}

function focusDialog(element: HTMLElement, close: () => void) {
  const previous = document.activeElement
  const frame = requestAnimationFrame(() => element.focus())
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== "Tab") return
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
      ),
    ).filter((control) => control.getClientRects().length)
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) {
      event.preventDefault()
      element.focus()
      return
    }
    if (
      document.activeElement === element ||
      (event.shiftKey ? document.activeElement === first : document.activeElement === last)
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
  element.addEventListener("keydown", keydown)
  onCleanup(() => {
    cancelAnimationFrame(frame)
    element.removeEventListener("keydown", keydown)
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
  })
}
