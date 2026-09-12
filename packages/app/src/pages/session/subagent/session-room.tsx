import { Button } from "@turenlabs/ui/button"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { agentColor } from "@/utils/agent"
import type { SwarmRoomActor, SwarmRoomEntry } from "@turenlabs/sdk/v2/client"
import type { SessionSubagentController } from "./session-subagent-controller"

export function SessionSubagentRoom(props: { controller: SessionSubagentController }) {
  const language = useLanguage()
  const room = createMemo(() => props.controller.room())
  const entries = createMemo(() => props.controller.roomEntries())
  const byEntry = createMemo(() => new Map(entries().map((entry) => [entry.id, entry])))
  let stream: HTMLDivElement | undefined
  // Pin the stream to the tail when new entries land, unless the reader scrolled up.
  createEffect(() => {
    entries()
    if (!stream) return
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160)
      stream.scrollTop = stream.scrollHeight
  })

  return (
    <section
      data-component="session-swarm-room"
      class="flex min-h-0 flex-col border-b border-border-weak-base pb-3"
    >
      <header class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-3">
        <h2 class="shrink-0 text-13-medium text-text-strong">{language.t("session.room.title")}</h2>
        <Show when={room()}>
          {(state) => (
            <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-10-regular text-text-weak">
              <span class="truncate">
                {language.t("session.room.revision", { head: state().room.head })}
              </span>
              <Show when={state().room.budget > 0}>
                <span aria-hidden="true">·</span>
                <span>
                  {language.t("session.room.workers", {
                    count: state().members.filter((member) => member.type === "worker").length,
                    budget: state().room.budget,
                  })}
                </span>
              </Show>
              <Show when={state().room.objective}>
                <span aria-hidden="true">·</span>
                <span class="min-w-0 flex-1 truncate" title={state().room.objective}>
                  {state().room.objective}
                </span>
              </Show>
            </div>
          )}
        </Show>
        <Button
          size="small"
          variant="ghost"
          class="ml-auto shrink-0"
          disabled={props.controller.roomLoading()}
          onClick={() => void props.controller.refreshRoom()}
        >
          {language.t("session.room.refresh")}
        </Button>
      </header>

      <Show when={room() && room()!.lanes.length > 0}>
        <div
          data-slot="session-room-lanes"
          class="mb-3 flex min-w-0 flex-wrap gap-1.5"
          aria-label={language.t("session.room.lanesLabel")}
        >
          <For each={room()!.lanes}>
            {(lane) => (
              <span
                data-slot="session-room-lane"
                data-status={lane.status}
                class="flex max-w-full items-center gap-1.5 rounded-control border border-border-weak-base bg-surface-raised-base px-2 py-1 text-10-regular"
                title={lane.claimedByName ?? lane.detail ?? lane.title}
              >
                <span
                  aria-hidden="true"
                  class="inline-block size-1.5 shrink-0 rounded-full"
                  classList={{
                    "bg-success-base": lane.status === "done",
                    "bg-info-base": lane.status === "claimed",
                    "bg-warning-base": lane.status === "blocked",
                    "bg-border-weak-base": lane.status === "open",
                  }}
                />
                <span
                  class="truncate text-text-base"
                  classList={{ "line-through opacity-60": lane.status === "done" }}
                >
                  {lane.title}
                </span>
                <Show when={lane.claimedByName}>
                  <span class="shrink-0 text-text-weak">{lane.claimedByName}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.controller.roomFailure()}>
        {(failure) => (
          <div
            data-slot="session-room-error"
            class="mb-2 flex flex-wrap items-center gap-2 rounded-control border border-critical-base/30 px-2.5 py-2"
            role="alert"
          >
            <span class="min-w-0 flex-1 text-11-regular text-text-base">
              {language.t("session.room.error")}: {failure()}
            </span>
            <Button size="small" variant="secondary" onClick={() => void props.controller.refreshRoom()}>
              {language.t("session.room.retry")}
            </Button>
          </div>
        )}
      </Show>

      <div
        ref={stream}
        data-slot="session-room-stream"
        class="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto"
        aria-busy={props.controller.roomLoading()}
      >
        <Show
          when={entries().length > 0}
          fallback={
            <p class="py-4 text-center text-12-regular text-text-weak">
              {language.t("session.room.empty")}
            </p>
          }
        >
          <For each={entries()}>
            {(entry) => <SessionRoomEntry entry={entry} lookup={byEntry} />}
          </For>
        </Show>
      </div>

      <SessionRoomComposer controller={props.controller} />
    </section>
  )
}

function actorColor(actor: SwarmRoomActor) {
  if (actor.type === "human") return "var(--text-success-base)"
  if (actor.type === "system") return "var(--text-weak)"
  return agentColor(actor.agent ?? actor.name)
}

function SessionRoomEntry(props: {
  entry: SwarmRoomEntry
  lookup: () => Map<string, SwarmRoomEntry>
}) {
  const language = useLanguage()
  const reply = createMemo(() =>
    props.entry.replyTo ? props.lookup().get(props.entry.replyTo) : undefined,
  )
  const payload = createMemo(() => props.entry.payload as { lane?: string; lanes?: { key: string; title: string }[]; to?: string } | undefined)

  return (
    <article
      data-slot="session-room-entry"
      data-entry-id={props.entry.id}
      data-kind={props.entry.kind}
      class="min-w-0 rounded-control px-2.5 py-2"
      classList={{
        "border border-border-weak-base bg-surface-raised-base":
          props.entry.kind === "plan" || props.entry.kind === "decision",
        "border border-warning-base/30 bg-warning-base/5":
          props.entry.kind === "question" || props.entry.kind === "correction",
      }}
    >
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          data-slot="session-room-actor"
          class="shrink-0 text-11-medium"
          style={{ color: actorColor(props.entry.actor) }}
        >
          {props.entry.actor.name}
        </span>
        <Show when={props.entry.kind !== "message"}>
          <span
            data-slot="session-room-kind"
            class="shrink-0 text-10-medium uppercase tracking-wide text-text-weak"
            classList={{
              "text-warning-base": props.entry.kind === "question" || props.entry.kind === "correction",
              "text-info-base": props.entry.kind === "plan" || props.entry.kind === "decision",
            }}
          >
            {props.entry.kind}
          </span>
        </Show>
        <Show when={payload()?.to}>
          {(to) => (
            <span
              data-slot="session-room-to"
              class="shrink-0 text-10-medium text-info-base"
            >
              → {to()}
            </span>
          )}
        </Show>
        <Show when={props.entry.actor.type === "leader" || props.entry.actor.type === "human"}>
          <span class="shrink-0 text-10-regular text-text-weak">{props.entry.actor.type}</span>
        </Show>
        <span class="ml-auto shrink-0 text-10-regular text-text-weak">
          #{props.entry.seq} · {new Date(props.entry.timeCreated).toLocaleTimeString()}
        </span>
      </div>

      <Show when={reply()}>
        {(target) => (
          <div class="mt-1 min-w-0 truncate border-l-2 border-border-weak-base pl-2 text-10-regular text-text-weak">
            {language.t("session.room.replyTo", { seq: target().seq })} {target().text}
          </div>
        )}
      </Show>

      <p
        data-slot="session-room-text"
        class="mt-0.5 whitespace-pre-wrap break-words text-12-regular leading-5 text-text-base"
      >
        {props.entry.text}
      </p>

      <Show when={payload()?.lanes && payload()!.lanes!.length > 0}>
        <ul class="mt-1.5 flex min-w-0 flex-col gap-0.5">
          <For each={payload()!.lanes!}>
            {(lane) => (
              <li class="flex min-w-0 items-baseline gap-2 text-11-regular">
                <span class="shrink-0 font-mono text-10-regular text-info-base">{lane.key}</span>
                <span class="min-w-0 truncate text-text-base">{lane.title}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.entry.evidenceRefs && props.entry.evidenceRefs.length > 0}>
        <div class="mt-1 flex min-w-0 flex-wrap gap-1">
          <For each={props.entry.evidenceRefs}>
            {(ref) => (
              <span
                data-slot="session-room-evidence"
                class="max-w-full truncate rounded-control border border-border-weak-base px-1.5 py-0.5 font-mono text-10-regular text-text-weak"
              >
                {ref}
              </span>
            )}
          </For>
        </div>
      </Show>
    </article>
  )
}

function SessionRoomComposer(props: { controller: SessionSubagentController }) {
  const language = useLanguage()
  const [draft, setDraft] = createSignal("")
  const send = () => {
    const text = draft()
    if (!text.trim() || props.controller.roomSending()) return
    void props.controller.postRoomMessage(text).then((ok) => {
      if (ok) setDraft("")
    })
  }

  return (
    <form
      data-slot="session-room-composer"
      class="mt-2 flex shrink-0 items-center gap-1.5 rounded-control border border-border-weak-base bg-surface-raised-base py-1 pl-3 pr-1"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <input
        type="text"
        data-slot="session-room-composer-input"
        class="min-w-0 flex-1 bg-transparent text-12-regular text-text-strong outline-none placeholder:text-text-weak"
        placeholder={language.t("session.room.composer.placeholder")}
        aria-label={language.t("session.room.composer.placeholder")}
        value={draft()}
        onInput={(event) => setDraft(event.currentTarget.value)}
        disabled={props.controller.roomSending()}
      />
      <Button
        type="submit"
        size="small"
        variant="secondary"
        disabled={props.controller.roomSending() || !draft().trim()}
      >
        {language.t("session.room.composer.send")}
      </Button>
    </form>
  )
}
