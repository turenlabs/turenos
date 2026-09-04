import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@turenlabs/core/util/encode"
import { findLast } from "@turenlabs/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@turenlabs/ui/icon"
import { Accordion } from "@turenlabs/ui/accordion"
import { StickyAccordionHeader } from "@turenlabs/ui/sticky-accordion-header"
import { File } from "@turenlabs/session-ui/file"
import { Markdown } from "@turenlabs/session-ui/markdown"
import { ScrollView } from "@turenlabs/ui/scroll-view"
import type { Message, Part, Todo, ToolPart, UserMessage } from "@turenlabs/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContext } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab(props: {
  objective?: () => string | undefined
  todos?: () => Todo[]
  onRevealMessage?: (messageID: string) => void
} = {}) {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.prompt, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.prompt) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync().data.part as Record<string, Part[] | undefined>,
          input: c.prompt,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const evidence = createMemo(() =>
    messages()
      .flatMap((message) =>
        getParts(message.id).flatMap((part) =>
          part.type === "tool" && part.state.status !== "pending" && part.state.status !== "running"
            ? [{ messageID: message.id, part }]
            : [],
        ),
      )
      .filter((item) => !toolCompacted(item.part))
      .slice(-8),
  )
  const archived = createMemo(() =>
    messages().flatMap((message) =>
      getParts(message.id).flatMap((part) =>
        part.type === "tool" && toolCompacted(part)
          ? [{ messageID: message.id, part }]
          : [],
      ),
    ),
  )
  const taskState = createMemo(() => {
    const todos = props.todos?.() ?? []
    const completed = todos.filter((todo) => todo.status === "completed")
    const unresolved = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress")
    return {
      verified: completed.length ? `${completed.length} completed ${completed.length === 1 ? "item" : "items"}` : "None yet",
      unresolved: unresolved.length ? `${unresolved.length} open ${unresolved.length === 1 ? "item" : "items"}` : "None",
      next:
        unresolved.find((todo) => todo.status === "in_progress")?.content ??
        unresolved[0]?.content ??
        "Awaiting user review",
    }
  })

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.contextUsed", value: () => formatter().number(ctx()?.total) },
    { label: "context.stats.usage", value: () => formatter().percent(ctx()?.usage) },
    { label: "context.stats.promptTokens", value: () => formatter().number(ctx()?.prompt) },
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(ctx()?.message.tokens.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(ctx()?.message.tokens.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () =>
        `${formatter().number(ctx()?.message.tokens.cache.read)} / ${formatter().number(ctx()?.message.tokens.cache.write)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-10">
        <section class="overflow-hidden rounded-surface border border-v2-border-border-base bg-v2-background-bg-base">
          <header class="flex flex-wrap items-center justify-between gap-3 border-b border-v2-border-border-muted px-5 py-3">
            <div>
              <p class="text-[13px] font-medium text-v2-text-strong">Context used for latest response</p>
              <p class="mt-0.5 text-[10px] text-v2-text-faint">Projected from the active provider transcript</p>
            </div>
            <span class="font-mono text-[11px] text-v2-text-muted">
              {formatter().number(ctx()?.total)} / {formatter().number(ctx()?.limit)}
            </span>
          </header>
          <div class="grid gap-0 @[44rem]:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)]">
            <div class="border-b border-v2-border-border-muted p-5 @[44rem]:border-b-0 @[44rem]:border-r">
              <p class="font-mono text-[10px] uppercase tracking-wide text-v2-text-faint">Current task</p>
              <p class="mt-2 break-words text-[13px] leading-5 text-v2-text-strong">
                {props.objective?.() ?? "No active session goal"}
              </p>
              <p class="mt-5 font-mono text-[10px] uppercase tracking-wide text-v2-text-faint">Included evidence</p>
              <Show
                when={evidence().length > 0}
                fallback={<p class="mt-2 text-[11px] text-v2-text-muted">No completed tool evidence in the active context.</p>}
              >
                <div class="mt-2 flex flex-col">
                  <For each={evidence()}>
                    {(item) => (
                      <button
                        type="button"
                        disabled={!props.onRevealMessage}
                        class="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 border-t border-v2-border-border-muted py-2 text-left first:border-t-0"
                        onClick={() => props.onRevealMessage?.(item.messageID)}
                      >
                        <span
                          aria-hidden="true"
                          class={
                            item.part.state.status === "error"
                              ? "text-v2-state-fg-danger"
                              : "text-v2-state-fg-success"
                          }
                        >
                          {item.part.state.status === "error" ? "!" : "✓"}
                        </span>
                        <span class="min-w-0 truncate text-[11px] text-v2-text-base">{contextEvidenceLabel(item.part)}</span>
                        <span class="font-mono text-[9px] text-v2-text-faint">{item.part.callID}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <div class="p-5">
              <p class="font-mono text-[10px] uppercase tracking-wide text-v2-text-faint">State</p>
              <dl class="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
                <dt class="text-v2-text-faint">Evidence</dt>
                <dd class="text-v2-text-base">{evidence().length} current calls</dd>
                <dt class="text-v2-text-faint">Archived</dt>
                <dd class="text-v2-text-base">{archived().length} pruned results</dd>
                <dt class="text-v2-text-faint">Status</dt>
                <dd class="text-v2-text-base">{ctx() ? "Latest response projected" : "Awaiting response"}</dd>
                <dt class="text-v2-text-faint">Verified</dt>
                <dd class="text-v2-text-base">{taskState().verified}</dd>
                <dt class="text-v2-text-faint">Unresolved</dt>
                <dd class="text-v2-text-base">{taskState().unresolved}</dd>
                <dt class="text-v2-text-faint">Next action</dt>
                <dd class="break-words text-v2-text-base">{taskState().next}</dd>
              </dl>
              <Show when={archived().length > 0}>
                <p class="mt-5 font-mono text-[10px] uppercase tracking-wide text-v2-text-faint">Archived</p>
                <div class="mt-2 flex flex-col gap-1.5">
                  <For each={archived().slice(-4)}>
                    {(item) => (
                      <button
                        type="button"
                        disabled={!props.onRevealMessage}
                        class="flex min-w-0 items-center gap-2 text-left text-[11px] text-v2-text-muted hover:text-v2-text-base"
                        onClick={() => props.onRevealMessage?.(item.messageID)}
                      >
                        <span aria-hidden="true">⊘</span>
                        <span class="truncate">{contextEvidenceLabel(item.part)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </section>
        <div class="flex flex-col gap-3">
          <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
            <For each={stats}>
              {(stat) => (
                <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />
              )}
            </For>
          </div>
          <div class="text-11-regular text-text-weaker">{language.t("context.stats.note")}</div>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="hidden text-11-regular text-text-weaker">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}

function contextEvidenceLabel(part: ToolPart) {
  const path = part.state.input.path
  if (typeof path === "string") return `${part.tool}: ${path}`
  const command = part.state.input.command
  if (typeof command === "string") return command
  return part.tool
}

function toolCompacted(part: ToolPart) {
  if (typeof part.metadata?.prunedAt === "number") return true
  return "time" in part.state && part.state.time && "compacted" in part.state.time && !!part.state.time.compacted
}
