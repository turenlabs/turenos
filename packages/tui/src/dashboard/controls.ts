import { createContextLimits } from "../context-meter"
import { createCopyControls } from "../copy"
import { createConversation } from "../conversation"
import { createLiveSession } from "../live-session"
import { createDialogs } from "../dialogs"
import { createSlashCommands } from "../slash"
import { createMentions } from "../mentions"
import { createRequests } from "../requests"
import { createRewindControls } from "../rewind"
import { createSessionControls } from "../session-controls"
import { createModelVariants } from "../model-variants"
import { createGoalControls } from "../goal-controls"
import { createHarnessControls } from "../harness"
import { createQueueControls } from "../queue"
import { createChanges } from "../changes"
import { createFiles } from "../files"
import { createTerminals } from "../terminals"
import { createSwarmRoom } from "../swarm"
import { createAutomations } from "../automations"
import { createExtensions } from "../extensions"
import { createMemories } from "../memories"
import { createIntel } from "../intel"
import { createInspect } from "../inspect"
import { createSettings } from "../settings"
import { createModels } from "../models"
import { createLaunch } from "../launch"
import { createSessionActions } from "../session-actions"
import { createMenus } from "../menus"
import { renderActions } from "./actions"
import { slashCommands } from "./commands"
import { refresh } from "./refresh"
import { resize } from "./status"
import { toggleMotion, toggleRaw } from "./toggles"
import { openServers } from "./lifecycle"
import type { DashboardContext } from "./context"

/**
 * Builds every feature controller in dependency order. Each group is installed on `d.c` before the next
 * is built; callbacks reach controllers through `d.c`, so they see the finished set.
 */
export function createControls(d: DashboardContext) {
  Object.assign(d.c, createTranscriptControls(d))
  Object.assign(d.c, createInputControls(d))
  Object.assign(d.c, createSessionControlGroup(d))
  Object.assign(d.c, createWorkspaceControls(d))
  Object.assign(d.c, createSettingsControls(d))
  Object.assign(d.c, createNavigationControls(d))
}

/** The controllers that paint the transcript and own the dialog stack. */
function createTranscriptControls(d: DashboardContext) {
  const limits = createContextLimits(d.connection, () => renderActions(d))
  const copy = createCopyControls(d.renderer, d.state, d.say)
  d.ui.detail.onMouseDown = copy.rightClick
  const conversation = createConversation(d.state, d.connection, d.ui, {
    questionsInPanel: true,
    actions: () => renderActions(d),
    say: d.say,
    clearNotice: (message) => {
      if (d.run.noticeMessage === message) d.say("")
    },
    project: (sessionID, messages) => d.c.live.project(sessionID, messages),
  })
  const live = createLiveSession(d.state, d.connection, {
    paint: conversation.updateLive,
    snapshot: (metadata) => {
      if (metadata) void refresh(d)
      else void conversation.render()
    },
    status: () => renderActions(d),
    invalidate: (sessionID) => {
      if (sessionID) conversation.invalidateSession(sessionID)
      else conversation.invalidateAll()
    },
  })
  const dialogs = createDialogs(d.renderer, d.state, d.ui, {
    rememberPosition: conversation.rememberPosition,
    cancelPosition: conversation.cancelPosition,
    changed: (reload) => {
      renderActions(d)
      resize(d)
      if (reload) void conversation.render()
    },
    submitted: async () => {
      // Join any pre-mutation read before requesting a fresh snapshot.
      if (d.run.refreshing) await d.run.refreshing
      await refresh(d)
    },
    say: d.say,
    recall: () => {
      if (d.state.detail?.sessionID !== d.state.selected) return
      const previous = d.state.detail.messages
        .toReversed()
        .find((message) => message.type === "user" && (!message.source || message.source === "user"))
      return previous?.type === "user" ? previous.text : undefined
    },
  })
  return { limits, copy, conversation, live, dialogs }
}

/** The slash, mention and reply-request controllers that share the editor. */
function createInputControls(d: DashboardContext) {
  const slash = createSlashCommands(
    d.renderer,
    d.state,
    d.connection,
    () => slashCommands(d),
    (name, dialog, editor) => {
      const action = slashCommands(d).find((item) => item.name === name)
      if (!action) return
      if (LOCAL_ONLY_COMMANDS.includes(name) && dialog.inline)
        return d.say(`Start this new session before using /${name}.`)
      editor.setText("")
      if (name === "model" && dialog.chooseModel) return dialog.chooseModel()
      if (name === "editor") return void d.c.dialogs.compose()
      if (name === "agent" && dialog.chooseAgent) return dialog.chooseAgent()
      if ((name === "effort" || name === "variant") && dialog.chooseVariant) return dialog.chooseVariant()
      dialog.save?.()
      d.c.dialogs.close(false)
      action.run()
    },
    d.c.dialogs.resize,
  )
  const mentions = createMentions(d.renderer, d.state, d.connection, d.c.dialogs.resize)
  const requests = createRequests(d.renderer, d.state, d.connection, d.c.dialogs, d.say, d.openSession, slash, mentions)
  return { slash, mentions, requests }
}

/** Slash commands that need an existing session, so a not-yet-created one refuses them. */
const LOCAL_ONLY_COMMANDS = [
  "compact",
  "undo",
  "redo",
  "goal",
  "harness",
  "queued",
  "delete",
  "changes",
  "files",
  "terminal",
  "room",
]

/** Rewind and the per-session model, agent, goal, harness and queue controls. */
function createSessionControlGroup(d: DashboardContext) {
  const { renderer, state, connection, say } = d
  const dialogs = d.c.dialogs
  const requests = d.c.requests
  const rewind = createRewindControls(renderer, state, connection, dialogs, say, {
    blocked: requests.replyBlocked,
    restoreDraft: requests.restoreDraft,
    clearRestoredDraft: requests.clearRestoredDraft,
    changed: (session) => {
      if (state.snapshot)
        state.snapshot.sessions = state.snapshot.sessions.map((item) => (item.id === session.id ? session : item))
      if (state.inspected?.id === session.id) state.inspected = session
      requests.updateRecipient(session)
      d.c.live.invalidate(session.id)
      d.c.conversation.invalidateSession(session.id)
    },
  })
  const controls = createSessionControls(
    renderer,
    state,
    connection,
    dialogs,
    say,
    requests.updateRecipient,
    requests.replyBlocked,
  )
  const variants = createModelVariants(
    renderer,
    state,
    connection,
    dialogs,
    say,
    requests.updateRecipient,
    requests.replyBlocked,
  )
  const goals = createGoalControls(renderer, state, connection, dialogs, say, requests.replyBlocked)
  const harness = createHarnessControls(renderer, state, connection, dialogs, say, requests.replyBlocked)
  const queue = createQueueControls(renderer, state, connection, dialogs, say, {
    blocker: requests.restoreBlocker,
    restore: requests.restoreDraft,
    reply: requests.followup,
  })
  return { rewind, controls, variants, goals, harness, queue }
}

/** The panels that work on files, terminals, automations and what agents know. */
function createWorkspaceControls(d: DashboardContext) {
  const { renderer, state, connection, say } = d
  const dialogs = d.c.dialogs
  const drafts = { mention: d.c.requests.mention, reply: d.c.requests.followup }
  const changes = createChanges(renderer, state, connection, dialogs, say, drafts)
  const files = createFiles(renderer, state, connection, dialogs, say, drafts)
  const terminals = createTerminals(renderer, state, connection, dialogs, say, () => refresh(d))
  const room = createSwarmRoom(renderer, state, connection, dialogs, say)
  const automations = createAutomations(renderer, state, connection, dialogs, say, d.openSession)
  const extensions = createExtensions(
    renderer,
    state,
    connection,
    dialogs,
    () =>
      state.snapshot?.sessions.find((item) => item.id === state.selected)?.location.directory ??
      state.snapshot?.location.directory ??
      "/",
  )
  const memories = createMemories(renderer, state, connection, dialogs, say)
  const intel = createIntel(renderer, state, connection, dialogs, say)
  const inspect = createInspect(renderer, state, connection, dialogs, say)
  return { changes, files, terminals, room, automations, extensions, memories, intel, inspect }
}

/** The settings dialog, which reaches the controllers it opens through `d.c`. */
function createSettingsControls(d: DashboardContext) {
  const { renderer, state, connection, say } = d
  const settings = createSettings(renderer, state, connection, d.c.dialogs, say, {
    connectProvider: () => d.c.models.connect(),
    extensions: d.c.extensions.open,
    memories: (back) => void d.c.memories.open(back),
    servers: d.options.servers ? () => openServers(d) : undefined,
    appearance: () => [
      { name: state.reducedMotion ? "Turn animation on" : "Reduce motion", run: () => toggleMotion(d) },
      {
        name: state.rawResponses ? "Show formatted responses" : "Show raw responses",
        description: "Tool results and agent updates in the transcript",
        run: () => toggleRaw(d),
      },
    ],
  })
  return { settings }
}

/** Models, new-session launch, session actions and the session switcher menus. */
function createNavigationControls(d: DashboardContext) {
  const { renderer, state, connection, say } = d
  const dialogs = d.c.dialogs
  const requests = d.c.requests
  const models = createModels(
    renderer,
    state,
    connection,
    dialogs,
    say,
    requests.updateRecipient,
    requests.replyBlocked,
  )
  const launch = createLaunch(
    renderer,
    state,
    connection,
    dialogs,
    say,
    d.openSession,
    models,
    d.c.slash,
    d.c.variants,
    d.c.mentions,
  )
  const sessions = createSessionActions(
    renderer,
    state,
    connection,
    dialogs,
    say,
    d.openSession,
    requests.updateRecipient,
    (id) => {
      requests.forget(id)
      if (state.inspected?.id === id) state.inspected = undefined
      if (state.snapshot) state.snapshot.sessions = state.snapshot.sessions.filter((item) => item.id !== id)
      if (state.selected !== id) return
      state.selected = ""
      state.detail = undefined
    },
  )
  const menus = createMenus(renderer, state, dialogs, connection, {
    launch: launch.open,
    openSession: d.openSession,
    hasDraft: requests.hasDraft,
  })
  return { models, launch, sessions, menus }
}
