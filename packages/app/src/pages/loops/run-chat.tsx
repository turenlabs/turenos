import { useDialog } from "@turenlabs/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@turenlabs/ui/v2/dialog-v2"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { For, Show, createSignal, onMount } from "solid-js"

export type ChatClient = {
  readonly v2: {
    readonly session: {
      readonly messages: (
        parameters: { readonly sessionID: string; readonly limit?: number },
        options?: { readonly signal?: AbortSignal },
      ) => Promise<{
        readonly data?: { readonly data: ReadonlyArray<ChatSourceMessage> }
      }>
    }
  }
}

/**
 * Newest-first page is all the generated client can express (`order`/`cursor`
 * never reach the wire), so one bounded fetch serves the whole dialog. Run
 * conversations are short; hitting the cap just notes the truncation.
 */
const CHAT_MESSAGE_LIMIT = 200

export type ChatTurn =
  | { readonly role: "user"; readonly text: string; readonly at?: number }
  | {
      readonly role: "assistant"
      readonly agent: string
      readonly text: string
      readonly tools: ReadonlyArray<string>
      readonly error?: string
      readonly at?: number
    }

/** Minimal transcript shape the projection reads; satisfied by the wire messages as-is. */
export type ChatSourceMessage = {
  readonly type: string
  readonly text?: string
  readonly agent?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly name?: string }>
  readonly error?: string | { readonly message?: string }
  readonly time?: { readonly created: number }
}

/**
 * Read-only projection of a run's conversation. Reasoning, shell calls, and
 * system/compaction notices stay out: the dialog answers "what did the run
 * say and do", not "how did the model think".
 */
export function chatTurns(messages: ReadonlyArray<ChatSourceMessage>): ChatTurn[] {
  return messages.flatMap((message): ChatTurn[] => {
    if (message.type === "user") {
      const text = message.text?.trim() ?? ""
      if (!text) return []
      return [{ role: "user", text, ...(message.time ? { at: message.time.created } : {}) }]
    }
    if (message.type === "assistant") {
      const text = (message.content ?? [])
        .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
        .join("\n\n")
        .trim()
      const tools = (message.content ?? []).flatMap((part) =>
        part.type === "tool" && part.name ? [part.name] : [],
      )
      const error =
        typeof message.error === "string"
          ? message.error
          : typeof message.error?.message === "string"
            ? message.error.message
            : undefined
      if (!text && !tools.length && !error) return []
      return [
        {
          role: "assistant",
          agent: message.agent ?? "agent",
          text,
          tools,
          ...(error ? { error } : {}),
          ...(message.time ? { at: message.time.created } : {}),
        },
      ]
    }
    return []
  })
}

const turnTime = (at?: number) =>
  at !== undefined && Number.isFinite(at)
    ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : ""

function ChatTurnView(props: { turn: ChatTurn }) {
  const turn = props.turn
  const label = turn.role === "user" ? "You" : turn.agent
  const tools = turn.role === "assistant" ? turn.tools : []
  const failure = turn.role === "assistant" ? turn.error : undefined
  return (
    <div
      data-component={turn.role === "user" ? "run-chat-user" : "run-chat-assistant"}
      class={`min-w-0 rounded-[8px] border px-3.5 py-2.5 ${
        turn.role === "user"
          ? "border-v2-border-border-base bg-v2-background-bg-layer-02"
          : "border-v2-border-border-subtle bg-v2-background-bg-base"
      }`}
    >
      <div class="flex items-baseline gap-2">
        <span class="text-[11px] text-v2-text-text-strong [font-weight:600]">{label}</span>
        <Show when={turnTime(turn.at)}>
          {(time) => <span class="font-mono text-[10px] text-v2-text-text-faint">{time()}</span>}
        </Show>
      </div>
      <Show when={tools.length > 0}>
        <p class="mt-1.5 truncate font-mono text-[10.5px] text-v2-text-text-muted">⚙ {tools.join(" · ")}</p>
      </Show>
      <Show when={turn.text}>
        <p class="mt-1 whitespace-pre-wrap text-[12.5px] leading-5 text-v2-text-text-base">{turn.text}</p>
      </Show>
      <Show when={failure}>
        {(error) => <p class="mt-1.5 text-[12px] text-v2-state-fg-danger">{error()}</p>}
      </Show>
    </div>
  )
}

export function RunChatDialog(props: {
  sessionID: string
  title: string
  subtitle: string
  client: ChatClient
  onOpenInChat: () => void
}) {
  const dialog = useDialog()
  const [turns, setTurns] = createSignal<ChatTurn[]>([])
  const [truncated, setTruncated] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const abort = new AbortController()

  const refresh = () => {
    setLoading(true)
    setError()
    return props.client.v2.session.messages(
      { sessionID: props.sessionID, limit: CHAT_MESSAGE_LIMIT },
      { signal: abort.signal },
    )
      .then((response) => {
        const messages = [...(response.data?.data ?? [])].reverse()
        setTruncated((response.data?.data.length ?? 0) >= CHAT_MESSAGE_LIMIT)
        setTurns(chatTurns(messages))
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(cause instanceof Error ? cause.message : "Could not load the run chat")
      })
      .finally(() => setLoading(false))
  }

  onMount(() => {
    void refresh()
    return () => abort.abort()
  })

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup title={props.title} description={props.subtitle} />
      </DialogHeader>
      <DialogBody class="flex max-h-[60vh] min-w-0 flex-col gap-2.5 overflow-y-auto px-4 pb-2 pt-1">
        <Show when={loading()}>
          <p class="py-8 text-center text-[12px] text-v2-text-text-muted">Loading run chat…</p>
        </Show>
        <Show when={error()}>
          {(message) => (
            <div class="flex flex-col items-center gap-3 py-8">
              <p role="alert" class="text-[12px] text-v2-state-fg-danger">
                {message()}
              </p>
              <ButtonV2 size="small" variant="neutral" onClick={() => void refresh()}>
                Retry
              </ButtonV2>
            </div>
          )}
        </Show>
        <Show when={!loading() && !error()}>
          <Show when={truncated()}>
            <p class="text-center font-mono text-[10px] text-v2-text-text-faint">
              Showing the {CHAT_MESSAGE_LIMIT} most recent messages
            </p>
          </Show>
          <Show
            when={turns().length > 0}
            fallback={<p class="py-8 text-center text-[12px] text-v2-text-text-muted">No messages yet.</p>}
          >
            <For each={turns()}>{(turn) => <ChatTurnView turn={turn} />}</For>
          </Show>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 size="small" variant="ghost-muted" onClick={() => dialog.close()}>
          Close
        </ButtonV2>
        <ButtonV2
          size="small"
          variant="neutral"
          onClick={() => {
            dialog.close()
            props.onOpenInChat()
          }}
        >
          Open in agent chat →
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
