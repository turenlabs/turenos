import { TextareaV2 } from "@turenlabs/ui/v2/textarea-v2"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId } from "solid-js"
import type { Team } from "@turenlabs/schema/team"
import { insertMention, mentionMatches, mentionToken } from "@turenlabs/client/team"
import { PixelAvatar } from "./pixel-avatar"

export { insertMention, mentionMatches, mentionToken }

export interface TeamMentionInputProps {
  value: string
  teammates: readonly Team.Teammate[]
  disabled?: boolean
  onInput: (value: string) => void
  onSend: () => void
}

export function TeamMentionInput(props: TeamMentionInputProps) {
  let field: HTMLTextAreaElement | undefined
  let list: HTMLDivElement | undefined
  const listID = `team-mentions-${createUniqueId()}`
  const [selection, setSelection] = createSignal({ value: "", start: 0, end: 0 })
  const [focused, setFocused] = createSignal(false)
  const [dismissed, setDismissed] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const token = createMemo(() => {
    if (!focused() || props.disabled || selection().value !== props.value) return
    return mentionToken(props.value, selection().start, selection().end)
  })
  const matches = createMemo(() => mentionMatches(props.teammates, token()?.query ?? ""))
  const open = () => !!token() && !dismissed() && matches().length > 0
  const selected = () => matches()[Math.min(active(), matches().length - 1)]
  const optionID = (teammate: Team.Teammate) => `${listID}-${teammate.id}`

  createEffect(() => {
    token()
    props.teammates
    setActive(0)
  })
  createEffect(() => {
    if (!open()) return
    list?.querySelector<HTMLElement>(`[data-index="${active()}"]`)?.scrollIntoView?.({ block: "nearest" })
  })

  function readCaret() {
    if (!field) return
    const previous = selection()
    if (
      previous.value === field.value &&
      previous.start === field.selectionStart &&
      previous.end === field.selectionEnd
    )
      return
    setSelection({ value: field.value, start: field.selectionStart, end: field.selectionEnd })
    setDismissed(false)
  }

  function choose(teammate: Team.Teammate) {
    if (!field || props.disabled) return
    const current = mentionToken(field.value, field.selectionStart, field.selectionEnd)
    if (!current) return
    const next = insertMention(field.value, current, teammate.handle)
    props.onInput(next.value)
    field.value = next.value
    field.focus()
    field.setSelectionRange(next.caret, next.caret)
    readCaret()
    setDismissed(true)
  }

  return (
    <div class="relative w-full min-w-0 [&_[data-component=textarea-v2]]:w-full">
      <Show when={open()}>
        <div
          ref={list}
          id={listID}
          role="listbox"
          aria-label="Room teammates"
          class="absolute inset-x-0 bottom-full z-20 mb-1 max-h-[240px] overflow-y-auto rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-1 text-[12px] shadow-md"
        >
          <For each={matches()}>
            {(teammate, index) => (
              <div
                id={optionID(teammate)}
                role="option"
                aria-selected={selected()?.id === teammate.id}
                data-index={index()}
                class="cursor-pointer rounded-[4px] px-2.5 py-2 text-v2-text-text-base"
                classList={{ "bg-v2-overlay-simple-overlay-hover": selected()?.id === teammate.id }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index())}
                onClick={() => choose(teammate)}
              >
                <div class="flex items-center gap-2">
                  <PixelAvatar avatar={teammate.avatar} seed={teammate.id} size={24} />
                  <span class="font-medium">@{teammate.handle}</span>
                  <span class="truncate text-v2-text-text-muted">{teammate.name}</span>
                  <Show when={teammate.status === "paused"}>
                    <span class="ml-auto shrink-0 text-[10px] text-v2-text-text-muted">Paused</span>
                  </Show>
                </div>
                <p class="truncate text-[11px] text-v2-text-text-muted">{teammate.role}</p>
              </div>
            )}
          </For>
        </div>
      </Show>
      <TextareaV2
        ref={field}
        id="team-message"
        aria-describedby="team-message-hint"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? listID : undefined}
        aria-activedescendant={open() && selected() ? optionID(selected()!) : undefined}
        style={{ width: "100%", "line-height": "1.5" }}
        rows={3}
        disabled={props.disabled}
        placeholder="Message your team..."
        value={props.value}
        onInput={(event) => {
          props.onInput(event.currentTarget.value)
          readCaret()
        }}
        onFocus={() => {
          setFocused(true)
          readCaret()
        }}
        onBlur={() => setFocused(false)}
        onClick={readCaret}
        onSelect={readCaret}
        onKeyUp={readCaret}
        onKeyDown={(event) => {
          if (props.disabled || event.isComposing) return
          readCaret()
          if (token() && !dismissed() && event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            setDismissed(true)
            return
          }
          if (open()) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              event.stopPropagation()
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : matches().length - 1)) % matches().length)
              return
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
              event.preventDefault()
              event.stopPropagation()
              choose(selected()!)
              return
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            props.onSend()
          }
        }}
      />
    </div>
  )
}
