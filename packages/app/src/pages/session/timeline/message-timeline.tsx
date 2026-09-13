import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@tanstack/solid-virtual"
import { Accordion } from "@turenlabs/ui/accordion"
import { Button } from "@turenlabs/ui/button"
import { Card } from "@turenlabs/ui/card"
import { CompactionSummary } from "./compaction-summary"
import {
  ContextToolGroup,
  FailureToolGroup,
  Message,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  type UserActions,
} from "@turenlabs/session-ui/message-part"
import { DiffChanges } from "@turenlabs/ui/diff-changes"
import { FileIcon } from "@turenlabs/ui/file-icon"
import { Icon } from "@turenlabs/ui/icon"
import { IconButton } from "@turenlabs/ui/icon-button"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { IconButtonV2 } from "@turenlabs/ui/v2/icon-button-v2"
import { DropdownMenu } from "@turenlabs/ui/dropdown-menu"
import { MenuV2 } from "@turenlabs/ui/v2/menu-v2"
import { Dialog } from "@turenlabs/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@turenlabs/ui/v2/dialog-v2"
import { InlineInput } from "@turenlabs/ui/inline-input"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { SessionRetry } from "@turenlabs/session-ui/session-retry"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner, ScrollView } from "@turenlabs/ui/scroll-view"
import { StickyAccordionHeader } from "@turenlabs/ui/sticky-accordion-header"
import { TextReveal } from "@turenlabs/ui/text-reveal"
import { Thinking } from "@turenlabs/ui/thinking"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@turenlabs/sdk/v2"
import { showToast } from "@/utils/toast"
import { getDirectory, getFilename } from "@turenlabs/core/util/path"
import { normalize } from "@turenlabs/session-ui/session-diff"
import { useFileComponent } from "@turenlabs/ui/context/file"
import {
  followScrollEndThreshold,
  shouldMarkBoundaryGesture,
  normalizeWheelDelta,
} from "@/pages/session/message-gesture"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useSessionKey } from "@/pages/session/session-layout"
import { useServerSDK } from "@/context/server-sdk"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { useSDK } from "@/context/sdk"
import { PromptAdmissionStatus } from "@/components/prompt-input/prompt-admission-status"
import { useSync } from "@/context/sync"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import {
  expandSessionV2ToolBody,
  sessionPromptPending,
  sessionPromptStartup,
  sessionTurnActivity,
  type TurnStatus,
} from "@/pages/session/goal/session-v2-timeline-controller"
import { isSessionV2ToolStub } from "@/pages/session/goal/session-v2-presentation"
import { sessionTitle } from "@/utils/session-title"
import { scheduleConnectedMeasure } from "./measure"
import { observeElementOffsetReconnectAware } from "./observe-element-offset"
import { createTimelineProjection } from "./projection"
import { MessageComment, SummaryDiff, TimelineRow, TimelineRowMap } from "./rows"
import { dataUrlFromMediaValue, mediaKindFromPath } from "@turenlabs/session-ui/pierre/media"
import { filterVirtualIndexes } from "./virtual-items"
import "./message-timeline.css"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyTools: ToolPart[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const timelineFallbackItemSize = 60
/*
 * Per-session measurement snapshots, so re-entering a tab paints at the right
 * offset instead of re-measuring up from the estimate.
 *
 * The Map is module-scoped and purely in-memory: written in onCleanup, read at
 * setup, never persisted. Every page load therefore starts empty, and that — not
 * any version stamp — is why a snapshot can never have been taken under
 * different geometry. An earlier pass prefixed the key with a hand-bumped
 * "geometry version" to guard exactly that; it could not, because the state it
 * guarded against does not exist at runtime, and a mitigation that reads as done
 * while doing nothing is worse than none. It is gone.
 *
 * The one case where a snapshot really can outlive the geometry that produced it
 * is dev. A CSS-only HMR of message-timeline.css / message-part.css /
 * basic-tool.css patches the stylesheet without re-executing this module, so the
 * Map survives holding pre-change heights and no version constant would have
 * moved either. Vite tells the client when it has patched anything, so drop the
 * snapshots there. Production never reaches this branch.
 */
const timelineCache = new Map<string, { measurements: VirtualItem[]; toolOpen: Record<string, boolean | undefined> }>()
if (import.meta.hot) import.meta.hot.on("vite:afterUpdate", () => timelineCache.clear())

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return true
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
    return true
  }
  return false
}

const turnSpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// The static mark shown in the glyph column when the status has no spinner: TUI idioms —
// ? for a question, ! for a retry notice, & for background jobs (subagents). Writing has
// no leading mark; its cursor blinks after the word instead.
const turnStatusGlyph: Partial<Record<TurnStatus["kind"], string>> = {
  question: "?",
  retrying: "!",
  agents: "&",
}

/**
 * Human text for a compaction failure the provider gave no message for.
 *
 * The durable `reason` is a closed vocabulary shared with the core, but it is written for logs.
 * An unrecognised value falls back to the generic sentence rather than leaking an identifier into
 * the transcript.
 */
const COMPACTION_FAILURE_REASONS = new Set([
  "providerFailed",
  "emptySummary",
  "invalidSummary",
  "emptyConversation",
  "contextTooLarge",
  "unknownContextWindow",
  "sessionBusy",
])

function compactionFailureReason(language: ReturnType<typeof useLanguage>, reason: string) {
  return language.t(
    COMPACTION_FAILURE_REASONS.has(reason)
      ? (`session.compaction.reason.${reason}` as "session.compaction.reason.providerFailed")
      : "session.compaction.reason.unknown",
  )
}

function TimelineThinkingRow(props: {
  status: TurnStatus
  reasoningHeading?: string
  showReasoningSummaries: boolean
}) {
  const language = useLanguage()
  const label = () => {
    const status = props.status
    switch (status.kind) {
      case "question":
        return language.t("session.turnStatus.waitingForYou")
      case "agents":
        return language.t(
          status.count === 1 ? "session.turnStatus.waitingOnAgents.one" : "session.turnStatus.waitingOnAgents.other",
          { count: String(status.count) },
        )
      case "compacting":
        return language.t("session.turnStatus.compacting")
      case "retrying":
        return language.t("session.turnStatus.retrying")
      case "tool":
        return language.t("session.turnStatus.runningTool", { tool: status.tool.toLowerCase() })
      case "thinking":
        return language.t("session.turnStatus.thinking")
      case "writing":
        return language.t("session.turnStatus.writing")
      case "working":
        return language.t("session.turnStatus.working")
    }
  }
  // thinking and working keep the app's existing canvas indicator; everything else is a
  // mono glyph animated in CSS (message-timeline.css owns the keyframes).
  const canvas = () => props.status.kind === "thinking" || props.status.kind === "working"
  const spinner = () =>
    props.status.kind === "tool" ? "fast" : props.status.kind === "compacting" ? "slow" : undefined

  return (
    <div
      data-slot="session-turn-thinking"
      data-status={props.status.kind}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <Show when={!canvas()} fallback={<Thinking state="solving" size={20} aria-hidden="true" />}>
        <span data-slot="session-turn-status-glyph" data-spinner={spinner()} aria-hidden="true">
          <Show when={spinner()} fallback={turnStatusGlyph[props.status.kind] ?? ""}>
            <span data-slot="session-turn-status-glyph-strip">
              <For each={turnSpinnerFrames}>{(frame) => <span>{frame}</span>}</For>
            </span>
          </Show>
        </span>
      </Show>
      <span data-slot="session-turn-thinking-status">
        {label()}
        <Show when={props.status.kind === "agents"}>
          <span data-slot="session-turn-status-dots" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </Show>
        <Show when={props.status.kind === "writing"}>
          <span data-slot="session-turn-status-cursor" aria-hidden="true">
            {"▊"}
          </span>
        </Show>
      </span>
      <Show when={!props.showReasoningSummaries && props.status.kind === "thinking"}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
    </div>
  )
}

function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[] }) {
  const language = useLanguage()
  const maxFiles = 10
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {language.t(
            props.diffs.length === 1 ? "ui.sessionTurn.diffs.changed.one" : "ui.sessionTurn.diffs.changed.other",
            { count: String(props.diffs.length) },
          )}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !showAll())}>
            {showAll() ? language.t("ui.sessionTurn.diffs.showLess") : language.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const opened = createMemo(() => expanded().includes(diff.file))

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <div data-slot="session-turn-diff-trigger">
                        <span data-slot="session-turn-diff-path">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                          </Show>
                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                        </span>
                        <div data-slot="session-turn-diff-meta">
                          <span data-slot="session-turn-diff-changes">
                            <DiffChanges changes={diff} />
                          </span>
                          <span data-slot="session-turn-diff-chevron">
                            <Icon name="chevron-down" size="small" />
                          </span>
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={opened()}>
                      <TimelineDiffView diff={diff} />
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!showAll() && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
          </div>
        </Show>
      </div>
    </div>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)

  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={view.fileDiff} />
    </div>
  )
}

export function MessageTimeline(props: {
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onAutoScrollPause: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  centered: boolean
  hideTaskThinking?: boolean
  hideContextUsage?: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStatus: () => TurnStatus
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
  setScrollToEnd?: (fn: () => void) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: (done: boolean) => void }) => void
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const tabs = useTabs()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const ownerSessionKey = sessionKey()
  const cached = timelineCache.get(ownerSessionKey)
  const initialMeasurements = cached?.measurements
  const coldBottomMount = !initialMeasurements?.length && props.shouldAnchorBottom()
  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionID = createMemo(() => params.id)
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync().data.session_status[id] ?? idle
  })
  const sessionMessages = createMemo(() => (sessionID() ? (sync().data.message[sessionID()!] ?? []) : []))
  const markdownImageCache = new Map<string, { expires: number; request: Promise<string | undefined> }>()
  const resolveMarkdownImage = (path: string) => {
    const current = sdk()
    const key = `${serverSDK().scope}\0${current.directory}\0${path}`
    const cached = markdownImageCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.request
    const kind = mediaKindFromPath(path)
    if (kind !== "image" && kind !== "svg") return Promise.resolve(undefined)
    const request = current.client.file
      .read({ path })
      .then((response) => response.data)
      .catch(() => undefined)
      .then((content) => dataUrlFromMediaValue(content, kind))
      .then((url) => {
        if (!url) markdownImageCache.delete(key)
        return url
      })
    markdownImageCache.set(key, { expires: Date.now() + 5_000, request })
    return request
  }
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync().session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const hasLegacyShare = createMemo(() => info()?.shared === true)
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync().session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync().data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const getMsgParts = (msgId: string) => sync().data.part[msgId] ?? emptyParts
  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => getMsgParts(message.id))
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  /**
   * Compaction is the one activity with no turn to hang itself on, so the transcript reads it
   * straight from the session's activity rather than from an in-flight assistant message.
   */
  const compactionState = createMemo(() => {
    const id = sessionID()
    if (!id) return
    const activity = sessionTurnActivity.get(id)
    const failure = activity.compactionFailure
    if (!activity.compacting && !failure) return
    return {
      active: activity.compacting,
      ...(failure
        ? {
            failure: language.t("session.compaction.failed", {
              detail: failure.detail ?? compactionFailureReason(language, failure.reason),
            }),
          }
        : {}),
    }
  })
  const projection = createTimelineProjection({
    messages: sessionMessages,
    userMessages: () => props.userMessages,
    parts: getMsgParts,
    status: sessionStatus,
    starting: sessionPromptStartup.has,
    showReasoningSummaries: settings.general.showReasoningSummaries,
    inlineComments: settings.general.newLayoutDesigns,
    compaction: compactionState,
  })
  const activeMessageID = projection.activeMessageID
  const assistantMessagesByParent = projection.assistantMessagesByParent
  const lastAssistantGroupKey = projection.lastAssistantGroupKey
  const messageByID = projection.messageByID
  const messageLastRowIndex = projection.messageLastRowIndex
  const messageRowIndex = projection.messageRowIndex
  const timelineRowByKey = projection.rowByKey
  const timelineRows = projection.rows

  let prependAnchor: { key: string; offset: number } | undefined
  let prependAnchorFrame: number | undefined
  let prependLoading = false
  const clearPrependAnchor = () => {
    prependLoading = false
    prependAnchor = undefined
    if (prependAnchorFrame === undefined) return
    cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    updatePrependAnchor()
  }
  const updatePrependAnchor = () => {
    const root = listRoot()
    if (!root) return
    const view = root.getBoundingClientRect()
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!anchor) return
    if (!anchor.element.dataset.timelineKey) return
    prependAnchor = { key: anchor.element.dataset.timelineKey, offset: anchor.rect.top - view.top }
  }
  const restorePrependAnchor = (done: boolean) => {
    if (done) prependLoading = false
    applyPrependAnchor()
  }
  const applyPrependAnchor = () => {
    const root = listRoot()
    if (!root || !prependAnchor) return
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const apply = () => {
      prependAnchorFrame = undefined
      const anchor = prependAnchor
      if (!anchor) return
      const element = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(anchor.key)}"]`)
      const delta = element
        ? element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
        : undefined
      if (delta !== undefined && Math.abs(delta) > 0.5) {
        root.scrollTop += delta
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 30 || frames >= 180) {
        if (!prependLoading) prependAnchor = undefined
        return
      }
      prependAnchorFrame = requestAnimationFrame(apply)
    }
    prependAnchorFrame = requestAnimationFrame(apply)
  }

  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  // Parts whose lean-page tool body is being fetched; the card shows its loading affordance while set.
  const [toolBodyLoading, setToolBodyLoading] = createStore<Record<string, boolean | undefined>>({})

  // A truncated tool card back-fills its message's elided bodies through the single-message
  // endpoint when the user expands it; `expandSessionV2ToolBody` writes the full parts in place.
  const expandToolBody = (part: PartType) => {
    const id = sessionID()
    if (!id || part.type !== "tool" || !isSessionV2ToolStub(part)) return
    setToolBodyLoading(part.id, true)
    const messageID = part.messageID
    void expandSessionV2ToolBody({
      sessionID: id,
      part,
      load: (messageID) =>
        sdk()
          .client.v2.session.message({ sessionID: id, messageID })
          .then((response) => response.data?.data),
      parts: () => sync().data.part[messageID],
      // A fetch that resolves after the user switched sessions must not write: `data.part` is a
      // shared map and the new session is already drawing from it.
      write: (index, next) => {
        if (sessionID() !== id) return
        sync().set("part", messageID, index, reconcile(next))
      },
    })
      .catch((error) => showToast({ title: language.t("common.requestFailed"), description: errorMessage(error) }))
      .finally(() => setToolBodyLoading(part.id, undefined))
  }
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length || coldBottomMount ? 6 : 20)
  let resizePinnedIndexes: number[] = []
  let resizePinFrame: number | undefined
  let virtualContent: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    observeElementOffset: observeElementOffsetReconnectAware,
    initialOffset: () => (props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => timelineFallbackItemSize,
    scrollToFn: (offset, options, instance) => {
      // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const rows = timelineRows()
      return (index: number) => {
        const row = rows[index]
        // ResizeObserver can report a removed element after its row has left the projection.
        if (!row) return `removed:${index}`
        return TimelineRow.key(row)
      }
    },
    anchorTo: "end",
    followOnAppend: true,
    // A getter, like scrollMargin below: the adapter re-runs setOptions when the follow
    // state flips, so a user upward scroll immediately collapses the end-anchoring well
    // and streaming resizes stop snapping the view back to the bottom. See
    // followScrollEndThreshold for the full story.
    get scrollEndThreshold() {
      return followScrollEndThreshold(props.shouldAnchorBottom())
    },
    get scrollMargin() {
      return showHeader() ? 64 : 0
    },
    overscan: 50,
    paddingEnd: 64,
    rangeExtractor: (range) => {
      const id = activeMessageID()
      const active = id ? (messageLastRowIndex().get(id) ?? -1) : -1
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan() })
      return filterVirtualIndexes(
        [...new Set([...resizePinnedIndexes, ...indexes, ...(active < 0 ? [] : [active])])].sort((a, b) => a - b),
        range.count,
      )
    },
  })
  const resizeItem = virtualizer.resizeItem
  let resizeAnchorScheduled = false
  const anchorResizedBottom = () => {
    if (resizeAnchorScheduled || props.hasScrollGesture()) return
    resizeAnchorScheduled = true
    queueMicrotask(() => {
      resizeAnchorScheduled = false
      if (!props.shouldAnchorBottom() || props.hasScrollGesture()) return
      virtualizer.scrollToEnd()
    })
  }
  virtualizer.resizeItem = (index, size) => {
    const item = virtualizer.measurementsCache[index]
    const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
    const root = listRoot()
    const range = virtualizer.range
    if (root && previous !== undefined && Math.abs(size - previous) > root.clientHeight && range) {
      resizePinnedIndexes = []
      for (let i = range.startIndex; i <= range.endIndex; i++) resizePinnedIndexes.push(i)
      if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
      resizePinFrame = requestAnimationFrame(() => {
        resizePinFrame = requestAnimationFrame(() => {
          resizePinFrame = undefined
          resizePinnedIndexes = []
        })
      })
    }
    resizeItem(index, size)
    if (root && props.shouldAnchorBottom()) anchorResizedBottom()
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    if (props.shouldAnchorBottom()) return false
    const first = virtualizer.range?.startIndex
    return first !== undefined && item.index < first
  }
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key as string))
  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  let overscanFrame: number | undefined
  onMount(() => {
    overscanFrame = requestAnimationFrame(() => {
      if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      overscanFrame = requestAnimationFrame(() => {
        overscanFrame = undefined
        if (renderOverscan() < 20) setRenderOverscan(20)
        if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      })
    })
  })

  const maybeAnchorBottom = () => {
    if (timelineRows().length === 0) return
    if (!props.shouldAnchorBottom() || props.hasScrollGesture()) return
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    clearPrependAnchor()
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    virtualizer.scrollToEnd()
  }

  let measuredSessionKey = sessionKey()
  createEffect(() => {
    const key = sessionKey()
    timelineRows().length
    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
    maybeAnchorBottom()
  })

  onCleanup(() => {
    clearPrependAnchor()
    timelineCache.delete(ownerSessionKey)
    timelineCache.set(ownerSessionKey, { measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen } })
    while (timelineCache.size > 16) timelineCache.delete(timelineCache.keys().next().value!)
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    if (overscanFrame !== undefined) cancelAnimationFrame(overscanFrame)
    props.setRevealMessage?.(() => {})
    props.setScrollToEnd?.(() => {})
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
  }

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    const root = event.currentTarget
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: root.clientHeight,
    })
    if (!delta) return
    const marked = markBoundaryGesture({
      root,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })
    if (marked && delta < 0) props.onAutoScrollPause()
  }

  const handleListTouchStart = (event: TouchEvent) => {
    if (!prependLoading) clearPrependAnchor()
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    const marked = markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })
    if (marked && delta < 0) props.onAutoScrollPause()
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    props.onMarkScrollGesture(event.target)
  }

  const handleListPointerMove = (event: PointerEvent) => {
    if (event.buttons !== 1) return
    props.onMarkScrollGesture(event.target)
  }

  const handleListKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const key = scrollKey(event)
    if (!key) return
    if (!isScrollKeyTarget(event.target, key)) return
    if (scrollKeyOwner(event.currentTarget, event.target, key) !== event.currentTarget) return
    if (!prependLoading) clearPrependAnchor()
    props.onMarkScrollGesture(event.currentTarget)
    if (key === "up" || key === "page-up" || key === "home") props.onAutoScrollPause()
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (prependLoading) updatePrependAnchor()
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    if (!props.hasScrollGesture()) return
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    props.setScrollRef(undefined)
  })

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const unshareMutation = useMutation(() => ({
    mutationFn: (id: string) => serverSDK().client.session.unshare({ sessionID: id }),
    onError: (err) => {
      console.error("Failed to unshare session", err)
    },
  }))

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk().client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync().set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const unshareSession = () => {
    const id = sessionID()
    if (!id || unshareMutation.isPending) return
    if (!hasLegacyShare()) return
    unshareMutation.mutate(id)
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync().data.message[id] !== undefined) return
        void sync().session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      if (!titleRef) return
      titleRef.focus()
      titleRef.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    const href = (id: string) =>
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id)
    if (parentID) {
      navigate(href(parentID))
      return
    }
    if (nextSessionID) {
      navigate(href(nextSessionID))
      return
    }
    if (params.serverKey) {
      tabs.newDraft({ server: requireServerKey(params.serverKey), directory: sdk().directory })
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync().session.get(sessionID)
    if (!session) return

    const sessions = sync().data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk()
      .client.session.update({ sessionID, time: { archived: Date.now() } })
      .then(() => {
        sync().set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )
        sync().session.evict(sessionID)
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
        notifySessionTabsRemoved({
          server: ServerConnection.key(serverSDK().server),
          directory: sdk().directory,
          sessionIDs: [sessionID],
        })
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync().session.get(sessionID)
    if (!session) return false

    const sessions = (sync().data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk()
      .client.session.delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    const removed = new Set<string>([sessionID])
    const byParent = new Map<string, string[]>()
    for (const item of sync().data.session) {
      const parentID = item.parentID
      if (!parentID) continue
      const existing = byParent.get(parentID)
      if (existing) {
        existing.push(item.id)
        continue
      }
      byParent.set(parentID, [item.id])
    }

    const stack = [sessionID]
    while (stack.length) {
      const parentID = stack.pop()
      if (!parentID) continue

      const children = byParent.get(parentID)
      if (!children) continue

      for (const child of children) {
        if (removed.has(child)) continue
        removed.add(child)
        stack.push(child)
      }
    }

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)

    sync().set(
      produce((draft) => {
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    for (const id of removed) {
      sync().session.evict(id)
    }
    notifySessionTabsRemoved({
      server: ServerConnection.key(serverSDK().server),
      directory: sdk().directory,
      sessionIDs: [...removed],
    })
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id),
    )
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync().session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    if (settings.general.newLayoutDesigns())
      return (
        <DialogV2 fit>
          <DialogHeader hideClose>
            <DialogTitleGroup
              title={language.t("session.delete.title")}
              description={language.t("session.delete.confirm", { name: name() })}
            />
          </DialogHeader>
          <DialogFooter>
            <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 variant="danger" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </ButtonV2>
          </DialogFooter>
        </DialogV2>
      )

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (max, item) => {
        const completed = item.time.completed
        if (typeof completed !== "number") return max
        if (max === undefined) return completed
        return Math.max(max, completed)
      },
      undefined,
    )
    if (typeof end !== "number") return
    if (end < message.time.created) return
    return end - message.time.created
  }

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = getMsgParts(message.id)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }
  }

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    if (row().group.type === "context") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      const contextOpenKey = () => `context:${row().group.key}`
      const open = createMemo(() => {
        return toolOpen[contextOpenKey()] === true
      })

      return (
        <ContextToolGroup
          parts={parts()}
          open={open()}
          onOpenChange={(value) => {
            setToolOpen(contextOpenKey(), value)
            if (value) parts().forEach(expandToolBody)
          }}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        />
      )
    }

    if (row().group.type === "failure") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "failure") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      const failureOpenKey = () => `failure:${row().group.key}`
      const open = createMemo(() => toolOpen[failureOpenKey()] === true)

      return (
        <FailureToolGroup
          parts={parts()}
          open={open()}
          onOpenChange={(value) => {
            setToolOpen(failureOpenKey(), value)
            if (value) parts().forEach(expandToolBody)
          }}
          onSizeChange={onSizeChange}
        />
      )
    }

    const message = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return messageByID().get(group.ref.messageID)
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return getMsgPart(group.ref.messageID, group.ref.partID)
    })
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return
      return partDefaultOpen(
        item,
        settings.general.shellToolPartsExpanded(),
        settings.general.editToolPartsExpanded(),
        settings.general.patchToolPartsExpanded(),
      )
    })

    // A stubbed body under an expanded card is a fetch, not a layout: tools that render open by
    // default (errors, settings-driven expansion) never fire `onToolOpenChange`, so the effect —
    // not the toggle handler — is what triggers the back-fill. The stub check inside
    // `expandToolBody` makes this a no-op once the real body has landed.
    createEffect(() => {
      const item = part()
      if (item && (toolOpen[item.id] ?? defaultOpen()) === true) expandToolBody(item)
    })

    return (
      <Show when={message()}>
        {(message) => (
          <Show when={part()}>
            {(part) => (
              <MessagePart
                part={part()}
                message={message()}
                showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                useV2Actions={settings.general.newLayoutDesigns()}
                hideTaskThinking={props.hideTaskThinking}
                defaultOpen={defaultOpen()}
                toolOpen={toolOpen[part().id] ?? defaultOpen()}
                onToolOpenChange={(open) => setToolOpen(part().id, open)}
                toolBodyLoading={toolBodyLoading[part().id] === true}
                deferToolContent
                virtualizeDiff={false}
                onContentRendered={onSizeChange}
                resolveMarkdownImage={resolveMarkdownImage}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => {
      const row = input.row()
      return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
    }
    // One blank line above this row, or none — the whole of the density rule.
    // The padding lives on the framed row itself so it is inside the box the
    // virtualiser measures; a margin here would be invisible to measureElement
    // and the row would be clipped by its own recorded height.
    const separate = () => input.row().separate

    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-timeline-row={input.row()._tag}
        data-separate={separate() ? "true" : undefined}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-200 2xl:max-w-[1000px]": props.centered,
          "md:mx-auto": props.centered,
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    switch (row()._tag) {
      case "TurnGap":
        // The turn boundary is the transcript's loudest break, so it gets two
        // blank lines where an intra-turn boundary gets one. It stays a row of
        // its own rather than padding on the user turn so the gap is measured
        // once, by the virtualiser, and can never double with data-separate.
        return <div data-timeline-row="TurnGap" aria-hidden="true" style={{ height: "calc(var(--v2-cell-y) * 2)" }} />
      case "CommentStrip": {
        const commentStripRow = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-start gap-2">
                  <Index each={comments()}>
                    {(comment) => (
                      <div
                        classList={{
                          "shrink-0 max-w-[260px] rounded-[2px] border-border-weak-base bg-background-stronger px-2.5 py-2": true,
                          "border-[0.5px]": settings.general.newLayoutDesigns(),
                          border: !settings.general.newLayoutDesigns(),
                        }}
                      >
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment().path)}</span>
                          <Show when={comment().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-text-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {comment().comment}
                        </div>
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => {
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m?.role === "user") return m
        })
        const messageComments = createMemo(() => {
          if (!settings.general.newLayoutDesigns()) return []
          return getMsgParts(userMessageRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? [])
        })
        // Admitted (or optimistically sent) but not yet promoted into the turn; only worth
        // announcing while a turn is actually running to absorb it.
        const pendingDelivery = createMemo(() => {
          if (sessionStatus().type === "idle") return undefined
          return sessionPromptPending.delivery(userMessageRow().userMessageID)
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message
                      message={message()}
                      parts={getMsgParts(userMessageRow().userMessageID)}
                      actions={props.actions}
                      useV2Actions={settings.general.newLayoutDesigns()}
                      comments={messageComments()}
                    />
                  </div>
                  <Show when={pendingDelivery()}>
                    {(delivery) => (
                      <div
                        data-slot="session-turn-pending-delivery"
                        class="w-full pt-1 text-left text-[12px] leading-4 text-v2-text-text-muted"
                      >
                        {language.t(
                          delivery() === "queue" ? "session.message.pending.queue" : "session.message.pending.steer",
                        )}
                      </div>
                    )}
                  </Show>
                  <PromptAdmissionStatus sessionID={message().sessionID} messageID={message().id} />
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = row as Accessor<TimelineRowByTag<"TurnDivider">>
        const summary = createMemo(
          () =>
            getMsgParts(turnDividerRow().userMessageID).flatMap((part) =>
              part.type === "text" && part.metadata?.compactionSummary === true ? [part.text] : [],
            )[0],
        )
        return (
          <TimelineRowFrame row={turnDividerRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={language.t(
                    turnDividerRow().label === "compaction" ? "ui.messagePart.compaction" : "ui.message.interrupted",
                  )}
                />
                <Show when={summary()}>
                  <CompactionSummary
                    text={summary() ?? ""}
                    label={language.t("session.compaction.summary")}
                    onSizeChange={onSizeChange}
                  />
                </Show>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const assistantPartRow = row as Accessor<TimelineRowByTag<"AssistantPart">>
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div
                data-slot="session-turn-assistant-content"
                aria-hidden={workingTurn(assistantPartRow().userMessageID)}
              >
                {renderAssistantPartGroup(assistantPartRow, onSizeChange)}
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                status={props.turnStatus()}
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = row as Accessor<TimelineRowByTag<"Retry">>
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <SessionRetry status={sessionStatus()} show={activeMessageID() === retryRow().userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "DiffSummary": {
        const diffSummaryRow = row as Accessor<TimelineRowByTag<"DiffSummary">>
        return (
          <TimelineRowFrame row={diffSummaryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow diffs={diffSummaryRow().diffs} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "CompactionFailure": {
        const failureRow = row as Accessor<TimelineRowByTag<"CompactionFailure">>
        return (
          <TimelineRowFrame row={failureRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Card variant="error" class="error-card" data-slot="session-compaction-failure">
                {failureRow().text}
              </Card>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Error": {
        const errorRow = row as Accessor<TimelineRowByTag<"Error">>
        const transientProviderError = () =>
          /(?:server_is_overloaded|server_error|OpenAI servers are overloaded|OpenAI server error)/.test(
            errorRow().text,
          )
        return (
          <TimelineRowFrame row={errorRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Card variant="error" class="error-card">
                <Show when={transientProviderError()}>
                  <span data-slot="session-provider-error-pixel" aria-hidden="true">
                    :(
                  </span>
                </Show>
                {errorRow().text}
              </Card>
            </div>
          </TimelineRowFrame>
        )
      }
    }
  }

  function TimelineRowView(props: { row: TimelineRow.TimelineRow; onSizeChange?: () => void }) {
    return renderTimelineRow(() => props.row, props.onSizeChange)
  }

  function VirtualTimelineRow(props: { rowKey: string }) {
    let element: HTMLDivElement
    const initialItem = virtualItemByKey().get(props.rowKey)!
    const initialRow = timelineRowByKey().get(props.rowKey)!
    const item = createMemo(() => virtualItemByKey().get(props.rowKey) ?? initialItem)
    const row = createMemo(() => timelineRowByKey().get(props.rowKey) ?? initialRow)
    const tool = () => {
      const value = row()
      if (value._tag !== "AssistantPart" || value.group.type !== "part") return
      const part = getMsgPart(value.group.ref.messageID, value.group.ref.partID)
      if (part?.type === "tool") return part
    }
    const asyncFile = () => ["edit", "write", "apply_patch"].includes(tool()?.tool ?? "")
    const [ready, setReady] = createSignal(initialItem.size <= timelineFallbackItemSize || !asyncFile())
    let contentMeasureFrame: number | undefined

    onMount(() => virtualizer.measureElement(element))

    createEffect(
      on(
        () => item().index,
        () => {
          virtualizer.measureElement(element)
        },
        { defer: true },
      ),
    )

    onCleanup(() => {
      if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
    })

    return (
      <div
        data-timeline-key={props.rowKey}
        style={{
          position: "absolute",
          top: `${item().start - (showHeader() ? 64 : 0)}px`,
          left: "0",
          width: "100%",
          height: `${item().size}px`,
          overflow: "clip",
          // Rounded virtual measurements can otherwise clip a framed row's outer paint.
          "overflow-clip-margin": row()._tag === "TurnGap" ? undefined : "0.5px",
        }}
      >
        <div
          ref={(value) => {
            element = value
          }}
          data-index={item().index}
          style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
        >
          <TimelineRowView
            row={row()}
            onSizeChange={() => {
              setReady(true)
              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              contentMeasureFrame = scheduleConnectedMeasure(element, virtualizer.measureElement)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div class="relative w-full h-full min-w-0">
      <div
        class="absolute left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "bottom-8": settings.general.newLayoutDesigns(),
          "bottom-6": !settings.general.newLayoutDesigns(),
          "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
          "opacity-0 translate-y-2 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          "scale-[0.8]": (!props.scroll.overflow || !props.scroll.jump) && settings.general.newLayoutDesigns(),
          "scale-95": (!props.scroll.overflow || !props.scroll.jump) && !settings.general.newLayoutDesigns(),
        }}
      >
        <Show
          when={settings.general.newLayoutDesigns()}
          fallback={
            <button
              type="button"
              aria-label={language.t("session.messages.jumpToLatest")}
              class="pointer-events-auto flex items-center justify-center w-10 h-8 bg-transparent border-none cursor-pointer p-0 group"
              onClick={props.onResumeScroll}
            >
              <div
                class="flex items-center justify-center w-8 h-6 rounded-[6px] border border-border-weaker-base bg-[color-mix(in_srgb,var(--surface-raised-stronger-non-alpha)_80%,transparent)] backdrop-blur-[0.75px] transition-colors group-hover:border-[var(--border-weak-base)] group-hover:[--icon-base:var(--icon-hover)]"
                style={{
                  "box-shadow":
                    "0 51px 60px 0 rgba(0,0,0,0.10), 0 15px 18px 0 rgba(0,0,0,0.12), 0 6.386px 7.513px 0 rgba(0,0,0,0.12), 0 2.31px 2.717px 0 rgba(0,0,0,0.20)",
                }}
              >
                <Icon name="arrow-down-to-line" size="small" />
              </div>
            </button>
          }
        >
          <button
            type="button"
            aria-label={language.t("session.messages.jumpToLatest")}
            class="pointer-events-auto flex items-center justify-center w-8 h-7 px-2 py-1.5 rounded-[2px] cursor-pointer text-v2-text-text-base"
            style={{
              background: "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
              border: "1px solid var(--v2-border-border-base)",
            }}
            onClick={props.onResumeScroll}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
                stroke="currentColor"
                stroke-linecap="square"
              />
            </svg>
          </button>
        </Show>
      </div>
      <ScrollView
        viewportRef={bindListRoot}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
        onTouchEnd={handleListTouchEnd}
        onTouchCancel={handleListTouchEnd}
        onPointerDown={handleListPointerDown}
        onPointerMove={handleListPointerMove}
        onKeyDown={handleListKeyDown}
        onScroll={handleListScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
        style={{
          "--sticky-accordion-top": showHeader() ? "48px" : "0px",
        }}
      >
        <Show when={showHeader()}>
          <div
            data-session-title
            classList={{
              "sticky top-0 z-30": true,
              "bg-[linear-gradient(to_bottom,var(--v2-background-bg-base)_48px,transparent)]":
                settings.general.newLayoutDesigns(),
              "bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]":
                !settings.general.newLayoutDesigns(),
              "w-full": true,
              "pb-4": true,
              "pr-3": true,
              "pl-2.5": settings.general.newLayoutDesigns(),
              "pl-2 md:pl-4": !settings.general.newLayoutDesigns(),
              "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered && !settings.general.newLayoutDesigns(),
            }}
          >
            <div class="h-12 w-full flex items-center justify-between gap-2">
              <div
                classList={{
                  "flex items-center gap-1 min-w-0 flex-1": true,
                  "pr-3": !settings.general.newLayoutDesigns(),
                }}
              >
                <div class="flex items-center min-w-0 flex-1 w-full">
                  <Show when={parentID()}>
                    <button
                      type="button"
                      data-slot="session-title-parent"
                      class="min-w-0 max-w-[40%] truncate pl-2 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
                      onClick={navigateParent}
                    >
                      {parentTitle()}
                    </button>
                    <span
                      data-slot="session-title-separator"
                      class="-translate-y-[0.5px] pl-2 pr-1 text-[11px] font-medium text-v2-text-text-faint"
                      aria-hidden="true"
                    >
                      /
                    </span>
                  </Show>
                  <Show when={childTitle() || title.editing}>
                    <Show
                      when={title.editing}
                      fallback={
                        <h1
                          data-slot="session-title-child"
                          classList={{
                            "truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base": true,
                            "w-fit rounded-[6px] px-2 py-1 hover:bg-v2-overlay-simple-overlay-hover":
                              settings.general.newLayoutDesigns(),
                            "grow-1 min-w-0": !settings.general.newLayoutDesigns(),
                          }}
                          onClick={openTitleEditor}
                        >
                          {childTitle()}
                        </h1>
                      }
                    >
                      <InlineInput
                        ref={(el) => {
                          titleRef = el
                        }}
                        data-slot="session-title-child"
                        value={title.draft}
                        disabled={titleMutation.isPending}
                        classList={{
                          "block text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base": true,
                          "w-full flex-1 grow-1 min-w-0 pl-1 -ml-1 rounded-[6px]": !settings.general.newLayoutDesigns(),
                          "field-sizing-content self-start rounded-[6px] px-2 py-1 ":
                            settings.general.newLayoutDesigns(),
                        }}
                        style={{
                          "--inline-input-shadow": settings.general.newLayoutDesigns()
                            ? "none"
                            : "var(--shadow-xs-border-select)",
                        }}
                        onInput={(event) => setTitle("draft", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveTitleEditor()
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeTitleEditor()
                          }
                        }}
                        onBlur={closeTitleEditor}
                      />
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={sessionID()} keyed>
                {(id) => (
                  <div
                    classList={{
                      "shrink-0 flex items-center": true,
                      "gap-2": settings.general.newLayoutDesigns(),
                      "gap-3": !settings.general.newLayoutDesigns(),
                    }}
                  >
                    <Show when={!props.hideContextUsage}>
                      <SessionContextUsage
                        placement="bottom"
                        buttonAppearance={settings.general.newLayoutDesigns() ? "v2" : "default"}
                      />
                    </Show>
                    <Show when={!parentID()}>
                      <Show
                        when={settings.general.newLayoutDesigns()}
                        fallback={
                          <DropdownMenu
                            gutter={4}
                            placement="bottom-end"
                            open={title.menuOpen}
                            onOpenChange={(open) => {
                              setTitle("menuOpen", open)
                              if (open) return
                            }}
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              aria-label={language.t("common.moreOptions")}
                              aria-expanded={title.menuOpen}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                style={{ "min-width": "104px" }}
                                onCloseAutoFocus={(event) => {
                                  if (title.pendingRename) {
                                    event.preventDefault()
                                    setTitle("pendingRename", false)
                                    openTitleEditor()
                                  }
                                }}
                              >
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle("pendingRename", true)
                                    setTitle("menuOpen", false)
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <Show when={hasLegacyShare()}>
                                  <DropdownMenu.Item disabled={unshareMutation.isPending} onSelect={unshareSession}>
                                    <DropdownMenu.ItemLabel>
                                      {language.t("command.session.unshare")}
                                    </DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </Show>
                                <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                                  <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Separator />
                                <DropdownMenu.Item
                                  onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>
                        }
                      >
                        <MenuV2
                          gutter={6}
                          placement="bottom-end"
                          open={title.menuOpen}
                          onOpenChange={(open) => {
                            setTitle("menuOpen", open)
                            if (open) return
                          }}
                        >
                          <MenuV2.Trigger
                            as={IconButtonV2}
                            icon={<IconV2 name="outline-dots" />}
                            variant="ghost-muted"
                            size="large"
                            aria-label={language.t("common.moreOptions")}
                            aria-expanded={title.menuOpen}
                          />
                          <MenuV2.Portal>
                            <MenuV2.Content
                              style={{ width: "120px", "min-width": "120px" }}
                              onCloseAutoFocus={(event) => {
                                if (title.pendingRename) {
                                  event.preventDefault()
                                  setTitle("pendingRename", false)
                                  openTitleEditor()
                                }
                              }}
                            >
                              <MenuV2.Item
                                onSelect={() => {
                                  setTitle("pendingRename", true)
                                  setTitle("menuOpen", false)
                                }}
                              >
                                {language.t("common.rename")}
                              </MenuV2.Item>
                              <Show when={hasLegacyShare()}>
                                <MenuV2.Item disabled={unshareMutation.isPending} onSelect={unshareSession}>
                                  {language.t("command.session.unshare")}
                                </MenuV2.Item>
                              </Show>
                              <MenuV2.Item onSelect={() => void archiveSession(id)}>
                                {language.t("common.archive")}
                              </MenuV2.Item>
                              <MenuV2.Separator />
                              <MenuV2.Item onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}>
                                {language.t("common.delete")}...
                              </MenuV2.Item>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      </Show>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
        <div
          data-timeline-virtual-content
          ref={(element) => {
            virtualContent = element
            props.setContentRef(element)
          }}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          <For each={virtualRowKeys()}>{(rowKey) => <VirtualTimelineRow rowKey={rowKey} />}</For>
          <Show when={timelineRows().length > 0}>
            <div
              data-timeline-row="bottom-spacer"
              aria-hidden="true"
              class="h-16 absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 64}px)` }}
            />
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
