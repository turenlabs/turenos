import type { Message, Session } from "@turenlabs/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@turenlabs/core/util/encode"
import { Binary } from "@turenlabs/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@turenlabs/ui/v2/dialog-v2"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Identifier } from "@/utils/id"
import { beginSessionInteractionTrace, sessionInteractionTrace } from "@/utils/session-interaction-trace"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { toLegacySummary } from "@/context/global-sync/home-session-index"
import {
  resolveSessionGoalSubmission,
  resolveSessionLoopSubmission,
  sessionGoalSubmissionMutation,
  sessionGoalObjectiveError,
  type SessionGoalInfo,
} from "@/pages/session/goal/session-goal"
import { markSessionV2 } from "@/pages/session/goal/session-v2-delta-gate"
import {
  sessionPromptOutbox,
  sessionPromptPending,
  sessionPromptStartup,
} from "@/pages/session/goal/session-v2-timeline-controller"
import { loopApi, responseData } from "@/pages/loops/api"
import { parseAutomationCommand, parseLoopCommand } from "@/pages/loops/loop-command"
import { localLoopServer } from "@/pages/loops/local-server"
import { deriveStepID } from "@/pages/loops/workflow"
import type { SkillSlashInvocation } from "@/pages/session/skill-slash"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  client: DirectorySDK["client"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  delivery?: "steer" | "queue"
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  command?: SkillSlashInvocation
}

export type PromptGoalControls = {
  mode: Accessor<boolean>
  current: Accessor<SessionGoalInfo | undefined>
  pending: Accessor<boolean>
  toggleMode: () => void
  requestEdit: () => void
  start: (input: {
    sessionID: string
    objective: string
    agent: string
    model: { providerID: string; id: string; variant?: string }
    client: DirectorySDK["client"]
  }) => Promise<SessionGoalInfo>
  edit: (input: {
    sessionID: string
    objective: string
    goal: SessionGoalInfo
    client: DirectorySDK["client"]
  }) => Promise<SessionGoalInfo>
  pause: (sessionID: string) => Promise<SessionGoalInfo>
  resume: (sessionID: string) => Promise<SessionGoalInfo>
  clear: (sessionID: string) => Promise<void>
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

/** Format interval seconds into human-readable form (e.g., 300 -> "5 minutes") */
const formatIntervalSeconds = (seconds: number): string => {
  if (seconds < 60) return `${seconds} seconds`
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60)
    return `${minutes} minute${minutes !== 1 ? "s" : ""}`
  }
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600)
    return `${hours} hour${hours !== 1 ? "s" : ""}`
  }
  const days = Math.round(seconds / 86400)
  return `${days} day${days !== 1 ? "s" : ""}`
}

type LoopConfirmationDialogProps = {
  prompt: string
  intervalSeconds: number
  onConfirm: () => Promise<void>
}

function DialogCreateLoop(props: LoopConfirmationDialogProps) {
  const dialog = useDialog()
  const [state, setState] = createStore({ pending: false, error: "" })

  const handleConfirm = async () => {
    if (state.pending) return
    setState({ pending: true, error: "" })
    try {
      await props.onConfirm()
      dialog.close()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create loop"
      setState({ pending: false, error: message })
    }
  }

  const promptPreview = props.prompt.length > 100 ? props.prompt.slice(0, 100) + "..." : props.prompt
  const intervalDisplay = formatIntervalSeconds(props.intervalSeconds)

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title="Create Recurring Loop?" description="" />
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-3 px-4 pb-1 pt-1">
        <div class="space-y-2 text-[12px] font-[440] leading-[1.45] text-v2-text-text-secondary">
          <p>
            <span class="text-v2-text-text-muted">Interval:</span> {intervalDisplay}
          </p>
          <p class="break-words">
            <span class="text-v2-text-text-muted">Prompt:</span> {promptPreview}
          </p>
        </div>
        <Show when={state.error}>
          <p data-slot="loop-create-error" class="text-[12px] font-[440] text-v2-text-text-danger">
            {state.error}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" disabled={state.pending} onClick={() => dialog.close()}>
          Cancel
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={state.pending} onClick={handleConfirm}>
          Create Loop
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const messageID = input.messageID ?? Identifier.ascending("message")
  const [head, ...tail] = text.split(" ")
  const name = head?.startsWith("/") ? head.slice(1) : undefined
  const command =
    input.command ??
    (name && input.sync.data.command.find((item) => item.name === name)
      ? { name, arguments: tail.join(" ") }
      : undefined)
  const delivery = command ? "steer" : (input.delivery ?? "steer")
  const kind = command ? "command" : "prompt"
  sessionInteractionTrace("followup.started", { delivery, kind })
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const requestPartsStarted = performance.now()
  const requestParts = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })
  const optimisticParts = requestParts.optimisticParts
  const v2Prompt = requestParts.v2Prompt
  sessionInteractionTrace("followup.parts-built", {
    durationMs: performance.now() - requestPartsStarted,
    kind,
    optimisticParts: optimisticParts.length,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = (clearOutbox = true) => {
    sessionPromptStartup.clear(messageID)
    sessionPromptPending.clear(messageID)
    if (clearOutbox) sessionPromptOutbox.clear(messageID)
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })
  }

  // Read before setBusy() flips the optimistic status: only a prompt sent into an
  // already-running turn is awaiting promotion. The admitted event re-confirms the
  // same value; the prompted event (or a failed send, via remove()) clears it.
  const working = input.sync.data.session_working(input.draft.sessionID)

  const optimisticStarted = performance.now()
  batch(() => {
    setBusy()
    add()
    if (!command)
      sessionPromptOutbox.put({
        sessionID: input.draft.sessionID,
        message,
        parts: optimisticParts,
      })
    sessionPromptStartup.mark(input.draft.sessionID, messageID)
    sessionPromptPending.mark(messageID, delivery, { label: working })
  })
  sessionInteractionTrace("followup.optimistic-applied", {
    durationMs: performance.now() - optimisticStarted,
    kind,
    messageID,
    working,
  })

  try {
    const waitStarted = performance.now()
    const ready = await wait()
    sessionInteractionTrace("followup.before-completed", {
      durationMs: performance.now() - waitStarted,
      kind,
      ready,
    })
    if (!ready) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    if (command) {
      const payload = {
        sessionID: input.draft.sessionID,
        sessionCommandPayload: {
          id: messageID,
          command: command.name,
          arguments: command.arguments,
          agent: input.draft.agent,
          model: {
            providerID: input.draft.model.providerID,
            id: input.draft.model.modelID,
            variant: input.draft.variant,
          },
          files: v2Prompt.files,
          resume: true,
        },
      }
      sessionInteractionTrace("followup.request-started", { kind, messageID })
      const requestStarted = performance.now()
      await retryV2MutationOnce(() => input.client.v2.session.command(payload))
      sessionInteractionTrace("followup.request-completed", {
        durationMs: performance.now() - requestStarted,
        kind,
        messageID,
      })
      markSessionV2(input.draft.sessionID)
      return true
    }

    const payload = {
      sessionID: input.draft.sessionID,
      id: messageID,
      prompt: v2Prompt,
      delivery,
      agent: input.draft.agent,
      model: {
        providerID: input.draft.model.providerID,
        id: input.draft.model.modelID,
        variant: input.draft.variant,
      },
      resume: true,
    } as const
    sessionInteractionTrace("followup.request-started", { kind, messageID })
    const requestStarted = performance.now()
    const reconciled = await retryV2MutationOnce(() => input.client.v2.session.prompt(payload))
      .then(() => false)
      .catch(async (error) => {
        if (!isAmbiguousV2MutationError(error)) throw error
        const outcome = await reconcilePromptAdmission(input.client, input.draft.sessionID, messageID)
        if (outcome === "failed") throw error
        if (outcome === "pending") sessionPromptPending.mark(messageID, delivery)
        return true
      })
    sessionInteractionTrace("followup.request-completed", {
      durationMs: performance.now() - requestStarted,
      kind,
      messageID,
      reconciled,
    })
    markSessionV2(input.draft.sessionID)
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      if (command) remove()
      else {
        sessionPromptStartup.clear(messageID)
        sessionPromptPending.clear(messageID)
      }
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onAbort?: () => Promise<void> | void
  onSubmit?: () => void
  onPendingPrompt?: (prompt: Prompt | undefined) => void
  resolveSkillSlash?: (text: string) => SkillSlashInvocation | undefined
  model?: ModelSelection
  goal?: PromptGoalControls
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const global = useGlobal()
  const server = useServer()
  const local = useLocal()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const settings = useSettings()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const dialog = useDialog()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const isTranscriptAdoptionError = (err: unknown) => {
    if (!err || typeof err !== "object" || !("data" in err)) return false
    return (err as { data?: { kind?: string } }).data?.kind === "session_transcript_adoption"
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    const ready = await Promise.resolve(input.onAbort?.())
      .then(() => true)
      .catch((err) => {
        showToast({
          title: language.t("session.goal.error.update"),
          description: errorMessage(err),
        })
        return false
      })
    if (!ready) return

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .client.v2.session.interrupt({
        sessionID,
      })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event, steer?: boolean) => {
    event.preventDefault()
    beginSessionInteractionTrace({ sessionID: params.id, eventType: event.type })
    if (input.goal?.pending()) return

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const capturedPrompt = submission.prompt
    const context = submission.context
    const capturedText = capturedPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()
    const slashName = capturedText.match(/^\/([^\s/]+)/)?.[1]
    const hasCustomSlash = slashName
      ? sync().data.command.some((item) => item.name === slashName && item.source !== "skill")
      : false
    const skillResolveStarted = performance.now()
    const skillInvocation =
      mode === "normal" && capturedText.startsWith("/") && !hasCustomSlash
        ? input.resolveSkillSlash?.(capturedText)
        : undefined
    if (slashName && !hasCustomSlash) {
      sessionInteractionTrace("submit.skill-resolved", {
        durationMs: performance.now() - skillResolveStarted,
        found: skillInvocation !== undefined,
      })
    }
    const currentPrompt = capturedPrompt
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const goalCommand =
      mode === "normal" && input.goal ? resolveSessionGoalSubmission(text, input.goal.mode()) : undefined
    const slashLoopCommand = mode === "normal" && input.goal ? resolveSessionLoopSubmission(text, false) : undefined

    if (goalCommand?.type === "toggle") {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
      input.goal!.toggleMode()
      return
    }

    if (goalCommand?.type === "edit") {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
      input.goal!.requestEdit()
      return
    }

    if (goalCommand && goalCommand.type !== "set") {
      const sessionID = params.id
      if (!sessionID || !input.goal!.current()) {
        showToast({
          title: language.t("session.goal.error.update"),
          description: language.t("common.requestFailed"),
        })
        return
      }
      const mutation =
        goalCommand.type === "pause"
          ? input.goal!.pause(sessionID)
          : goalCommand.type === "resume"
            ? input.goal!.resume(sessionID)
            : input.goal!.clear(sessionID)
      await mutation
        .then(() => {
          submission.clear()
          input.setMode("normal")
          input.setPopover(null)
        })
        .catch((err) => {
          showToast({
            title: language.t("session.goal.error.update"),
            description: errorMessage(err),
          })
        })
      return
    }

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (goalCommand?.type === "set") {
        showToast({
          title: language.t("session.goal.error.required"),
          description: language.t("session.goal.placeholder"),
        })
        return
      }
      if (input.working()) void abort()
      return
    }

    const automationCommand =
      mode === "normal" && settings.general.newLayoutDesigns()
        ? parseAutomationCommand(text)
        : { type: "none" as const }
    if (automationCommand.type === "invalid") {
      showToast({ title: "Could not create automation", description: automationCommand.message })
      return
    }
    if (automationCommand.type === "automation") {
      if (
        images.length > 0 ||
        context.length > 0 ||
        input.commentCount() > 0 ||
        currentPrompt.some(
          (part) => part.type === "file" || part.type === "image" || part.type === "agent" || part.type === "surface",
        )
      ) {
        showToast({ title: "Could not create automation", description: "Automations cannot include attachments" })
        return
      }
      const localServer = localLoopServer(server.list, server.scope)
      if (!localServer) {
        showToast({ title: "Could not create automation", description: "Local server unavailable" })
        return
      }
      await loopApi(global.ensureServerCtx(localServer).sdk.client)
        .create({
          ...automationCommand.value,
          location: { directory: sdk().directory },
          workflow: {
            version: 1,
            steps: [
              {
                id: deriveStepID(automationCommand.value.name, []),
                name: automationCommand.value.name,
                type: "agent",
                prompt: automationCommand.value.prompt,
              },
            ],
            delivery: { type: "turen" },
          },
        })
        .then((result) => {
          const loop = responseData(result)
          submission.clear()
          input.setMode("normal")
          input.setPopover(null)
          navigate(`/automations/${loop.id}?directory=${encodeURIComponent(sdk().directory)}`)
        })
        .catch((err) => {
          showToast({ title: "Could not create automation", description: errorMessage(err) })
        })
      return
    }

    const loopCommand =
      mode === "normal" && settings.general.newLayoutDesigns() ? parseLoopCommand(text) : { type: "none" as const }
    if (loopCommand.type === "invalid") {
      showToast({ title: "Could not start loop", description: loopCommand.message })
      return
    }
    if (loopCommand.type === "loop") {
      if (
        images.length > 0 ||
        context.length > 0 ||
        currentPrompt.some((part) => part.type === "file" || part.type === "image" || part.type === "agent")
      ) {
        showToast({ title: "Could not start loop", description: "Loops cannot include attachments" })
        return
      }

      const modelSelection = input.model ?? local.model
      const loopModel = modelSelection.current()
      const loopAgent = local.agent.current()
      const loopVariant = modelSelection.variant.current()

      if (!loopModel || !loopAgent || !loopModel.provider?.id || !loopModel.id) {
        showToast({ title: "Could not create loop", description: "Model and agent are required" })
        return
      }

      // Show confirmation dialog before creating the loop
      const createLoop = async () => {
        const projectDirectory = sdk().directory
        const loopResponse = await sdk().client.v2.loop.create({
          loopCreateInput: {
            name: `Loop: ${loopCommand.value.prompt}`,
            prompt: loopCommand.value.prompt,
            intervalSeconds: loopCommand.value.intervalSeconds,
            location: { directory: projectDirectory },
            agent: loopAgent.name,
            model: { providerID: loopModel.provider.id, id: loopModel.id, variant: loopVariant },
          },
        })
        const loop = responseData(loopResponse)
        submission.clear()
        input.setMode("normal")
        input.setPopover(null)
        const nextRunIn = loop.nextRunAt ? ` Next run: ${new Date(loop.nextRunAt).toLocaleTimeString()}` : ""
        showToast({
          title: "Loop created",
          description: `${loopCommand.value.prompt} (every ${loopCommand.value.intervalSeconds}s)${nextRunIn}`,
        })
      }

      dialog.show(() => (
        <DialogCreateLoop
          prompt={loopCommand.value.prompt}
          intervalSeconds={loopCommand.value.intervalSeconds}
          onConfirm={createLoop}
        />
      ))
      return
    }

    if (goalCommand?.type === "set") {
      const objectiveError = sessionGoalObjectiveError(goalCommand.objective)
      if (objectiveError) {
        showToast({
          title: language.t(`session.goal.error.${objectiveError}`),
          description: language.t("session.goal.placeholder"),
        })
        return
      }
      if (
        images.length > 0 ||
        context.length > 0 ||
        currentPrompt.some((part) => part.type === "file" || part.type === "image" || part.type === "agent")
      ) {
        showToast({
          title: language.t("session.goal.error.attachments"),
          description: language.t("session.goal.placeholder"),
        })
        return
      }
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    // Handle /loop slash commands - start autonomous goal loop
    if (slashLoopCommand?.type === "set") {
      const objectiveError = sessionGoalObjectiveError(slashLoopCommand.objective)
      if (objectiveError) {
        showToast({
          title: language.t(`session.goal.error.${objectiveError}`),
          description: language.t("session.goal.placeholder"),
        })
        return
      }
      if (
        images.length > 0 ||
        context.length > 0 ||
        currentPrompt.some((part) => part.type === "file" || part.type === "image" || part.type === "agent")
      ) {
        showToast({
          title: language.t("session.goal.error.attachments"),
          description: language.t("session.goal.placeholder"),
        })
        return
      }

      const sessionID = params.id
      if (!sessionID) {
        showToast({
          title: language.t("session.goal.error.start"),
          description: language.t("common.requestFailed"),
        })
        return
      }

      await input
        .goal!.start({
          sessionID,
          objective: slashLoopCommand.objective,
          agent: currentAgent.name,
          model: { providerID: currentModel.provider.id, id: currentModel.id, variant },
          client: sdk().client,
        })
        .then(() => {
          submission.clear()
          input.setMode("normal")
          input.setPopover(null)
        })
        .catch((err) => {
          showToast({
            title: language.t("session.goal.error.start"),
            description: errorMessage(err),
          })
        })
      return
    }

    if (goalCommand?.type !== "set") {
      input.addToHistory(currentPrompt, mode)
      input.resetHistoryNavigation()
    }

    const projectDirectory = sdk().directory
    const isNewSession = !params.id
    const draftID = search.draftId
    const draftServer = draftID ? tabs.draft(draftID).server : undefined
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && isNewSession) {
      const created = await client.v2.session
        .create({
          agent: currentAgent.name,
          model: {
            id: currentModel.id,
            providerID: currentModel.provider.id,
            variant,
          },
          location: { directory: sessionDirectory },
        })
        .then((x) => (x.data?.data ? toLegacySummary(x.data.data) : undefined))
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        const sessionTarget = prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id })
        batch(() => {
          if (!session) return
          local.session.promote(sessionDirectory, session.id, {
            agent: currentAgent.name,
            model: { providerID: currentModel.provider.id, modelID: currentModel.id },
            variant: variant ?? null,
          })
          layout.activation.start({
            scope: sdk().scope,
            directory: base64Encode(sessionDirectory),
            sessionID: session.id,
            draftID,
            title: created.title,
          })
          submission.retarget(sessionTarget)
          if (draftID && draftServer) tabs.promoteDraft(draftID, { server: draftServer, sessionId: session.id })
          else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
        })
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (goalCommand?.type === "set") {
      const existing = input.goal!.current()
      const goalMutation = sessionGoalSubmissionMutation(existing)
      const requestStarted = performance.now()
      if (goalMutation === "edit" && existing) {
        await prepareSessionV2(client, draft)
          .then(() =>
            input.goal!.edit({
              sessionID: session.id,
              objective: goalCommand.objective,
              goal: existing,
              client,
            }),
          )
          .then(() => {
            sessionInteractionTrace("goal.request-completed", {
              durationMs: performance.now() - requestStarted,
              mutation: goalMutation,
            })
            input.addToHistory(currentPrompt, mode)
            input.resetHistoryNavigation()
            input.onSubmit?.()
            clearInput()
          })
          .catch((err) => {
            sessionInteractionTrace("goal.request-failed", {
              durationMs: performance.now() - requestStarted,
              mutation: goalMutation,
            })
            showToast({
              title: language.t("session.goal.error.update"),
              description: errorMessage(err),
            })
          })
        return
      }

      input.addToHistory(currentPrompt, mode)
      input.resetHistoryNavigation()
      const callbackStarted = performance.now()
      input.onSubmit?.()
      sessionInteractionTrace("submit.callback-completed", { durationMs: performance.now() - callbackStarted })
      batch(() => {
        input.onPendingPrompt?.([
          { type: "text", content: goalCommand.objective, start: 0, end: goalCommand.objective.length },
        ])
        if (sessionDirectory === projectDirectory)
          serverSync().session.set("session_status", session.id, { type: "busy" })
      })
      clearInput()
      sessionInteractionTrace("goal.optimistic-applied", { mutation: goalMutation })
      await retryV2MutationOnce(() =>
        input.goal!.start({
          sessionID: session.id,
          objective: goalCommand.objective,
          agent,
          model: {
            providerID: model.providerID,
            id: model.modelID,
            variant,
          },
          client,
        }),
      )
        .then(() => {
          sessionInteractionTrace("goal.request-completed", {
            durationMs: performance.now() - requestStarted,
            mutation: goalMutation,
          })
        })
        .catch((err) => {
          sessionInteractionTrace("goal.request-failed", {
            durationMs: performance.now() - requestStarted,
            mutation: goalMutation,
          })
          batch(() => {
            input.onPendingPrompt?.(undefined)
            if (sessionDirectory === projectDirectory)
              serverSync().session.set("session_status", session.id, { type: "idle" })
          })
          restoreInput()
          showToast({
            title: language.t(
              isTranscriptAdoptionError(err) ? "session.error.transcriptAdoption" : "session.goal.error.start",
            ),
            description: errorMessage(err),
          })
        })
      return
    }

    // A follow-up sent while the agent is working is admitted durably as a queued
    // input and promoted by the runner at the next provider-turn boundary (after the
    // current tool calls settle). An explicit steer cuts ahead at the same boundary.
    const delivery =
      !steer && !isNewSession && mode === "normal" && input.shouldQueue?.() ? ("queue" as const) : ("steer" as const)

    const callbackStarted = performance.now()
    input.onSubmit?.()
    sessionInteractionTrace("submit.callback-completed", { durationMs: performance.now() - callbackStarted })

    if (mode === "shell") {
      const messageID = Identifier.ascending("message")
      const payload = {
        sessionID: session.id,
        sessionShellPayload: {
          id: messageID,
          command: text,
        },
      }
      clearInput()
      await prepareSessionV2(client, draft)
        .then(() => retryV2MutationOnce(() => client.v2.session.shell(payload)))
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName && c.source !== "skill")
      if (customCommand || skillInvocation?.name === commandName) {
        const messageID = Identifier.ascending("message")
        clearInput()
        await sendFollowupDraft({
          client,
          sync: sync(),
          serverSync: serverSync(),
          draft,
          messageID,
          optimisticBusy: true,
          command: {
            name: commandName,
            arguments: skillInvocation?.name === commandName ? skillInvocation.arguments : args.join(" "),
          },
        }).catch((err) => {
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    input.onPendingPrompt?.(currentPrompt)

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    const clearStarted = performance.now()
    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()
    sessionInteractionTrace("submit.input-cleared", { durationMs: performance.now() - clearStarted })

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    const dispatchStarted = performance.now()
    const followup = sendFollowupDraft({
      client,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      delivery,
      messageID,
      optimisticBusy: true,
      before: waitForWorktree,
    })
    sessionInteractionTrace("submit.followup-dispatched", { durationMs: performance.now() - dispatchStarted })

    void followup
      .then((sent) => {
        sessionInteractionTrace("submit.followup-settled", { sent })
        if (!sent) input.onPendingPrompt?.(undefined)
      })
      .catch((err) => {
        sessionInteractionTrace("submit.followup-failed", {
          error: err instanceof Error ? err.message : String(err),
        })
        input.onPendingPrompt?.(undefined)
        pending.delete(pendingKey(session.id))
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        showToast({
          title: language.t(
            isTranscriptAdoptionError(err) ? "session.error.transcriptAdoption" : "prompt.toast.promptSendFailed.title",
          ),
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      })
  }

  return {
    abort,
    handleSubmit,
  }
}

// A restarting server makes every in-flight mutation fail ambiguously for as long as it is
// down, which is longer than one immediate retry. Treating that ambiguity as failure is not
// neutral: a prompt the server already admitted looks dropped, and a user re-send mints a new
// message ID that server-side idempotency cannot collapse. Re-send the identical payload across
// a bounded restart window; normal prompts that exhaust it switch to read-only reconciliation
// below, while the other mutation callers retain their existing failure behavior.
const AMBIGUOUS_RETRY_BACKOFF_MS = [0, 250, 750, 1500]

export const retryV2MutationOnce = <T,>(send: () => Promise<T>) => {
  const attempt = (index: number): Promise<T> =>
    send().catch((error) => {
      const delay = AMBIGUOUS_RETRY_BACKOFF_MS[index]
      if (delay === undefined || !isAmbiguousV2MutationError(error)) return Promise.reject(error)
      return new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => attempt(index + 1))
    })
  return attempt(0)
}

type PromptAdmissionOutcome = "pending" | "projected" | "failed"

// Once writes have exhausted their retry budget, reconcile with reads only. Keeping this
// promise open also keeps the original optimistic row and composer snapshot owned by this
// submission until the server can give an authoritative answer.
async function reconcilePromptAdmission(
  client: DirectorySDK["client"],
  sessionID: string,
  messageID: string,
): Promise<PromptAdmissionOutcome> {
  while (true) {
    const outcome = await readPromptAdmission(client, sessionID, messageID)
    if (outcome) return outcome
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
  }
}

export async function readPromptAdmission(
  client: DirectorySDK["client"],
  sessionID: string,
  messageID: string,
): Promise<PromptAdmissionOutcome | undefined> {
  const durable = await client.v2.session
    .inputStatus({ sessionID, messageID })
    .then((response) => response.data?.data?.status)
    .catch((error) => {
      if (!error || typeof error !== "object") return
      return errorStatus(error) === 404 ? ("missing" as const) : undefined
    })
  if (durable === "admitted") return "pending"
  if (durable === "promoted") return "projected"
  if (durable === "cancelled") return "failed"

  // Inbox first, projected message second: promotion between the reads moves the same ID
  // from the former to the latter, so a successful empty/404 pair is a real non-admission.
  const pending = await client.v2.session
    .pendingInputs({ sessionID })
    .then((response) => (response.data?.data.some((input) => input.id === messageID) ? "pending" : "missing"))
    .catch((error) => {
      if (!error || typeof error !== "object") return
      return errorStatus(error) === 404 ? ("failed" as const) : undefined
    })
  if (pending === "pending") return pending
  if (pending === "failed") return pending

  const projected = await client.v2.session
    .message({ sessionID, messageID })
    .then(() => "projected" as const)
    .catch((error) => {
      if (!error || typeof error !== "object") return
      return errorStatus(error) === 404 ? ("missing" as const) : undefined
    })
  if (projected === "projected") return projected
  if (pending === "missing" && projected === "missing") return "failed"
}

export function isAmbiguousV2MutationError(error: unknown) {
  if (!error || typeof error !== "object") return false
  if (error instanceof Error && error.name === "AbortError") return false
  const reason = "reason" in error ? error.reason : undefined
  if (reason === "Transport") return true
  const status = errorStatus(error)
  if (reason === "UnexpectedStatus") return status !== undefined && status >= 500
  if (status !== undefined) return status >= 500
  return error instanceof TypeError
}

function errorStatus(error: object) {
  if ("status" in error && typeof error.status === "number") return error.status
  if (!("cause" in error) || !error.cause || typeof error.cause !== "object") return
  return "status" in error.cause && typeof error.cause.status === "number" ? error.cause.status : undefined
}

async function prepareSessionV2(client: DirectorySDK["client"], draft: FollowupDraft) {
  const response = await client.v2.session.get({ sessionID: draft.sessionID })
  const session = response.data!.data
  if (session.agent !== draft.agent) {
    await client.v2.session.switchAgent({
      sessionID: draft.sessionID,
      agent: draft.agent,
    })
  }
  if (
    session.model?.providerID === draft.model.providerID &&
    session.model.id === draft.model.modelID &&
    (session.model.variant ?? "default") === (draft.variant ?? "default")
  ) {
    markSessionV2(draft.sessionID)
    return
  }
  await client.v2.session.switchModel({
    sessionID: draft.sessionID,
    model: {
      providerID: draft.model.providerID,
      id: draft.model.modelID,
      variant: draft.variant,
    },
  })
  markSessionV2(draft.sessionID)
}
