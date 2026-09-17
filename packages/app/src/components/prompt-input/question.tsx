import { For, Show, createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Icon } from "@turenlabs/ui/icon"
import type { QuestionAnswer, QuestionRequest } from "@turenlabs/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ScopedKey } from "@/utils/server-scope"
import { showToast } from "@/utils/toast"
import { formatServerError } from "@/utils/server-errors"

const cache = new Map<string, { tab: number; answers: QuestionAnswer[] }>()

/**
 * Composer-takeover version of the question dock: the pending request renders as a
 * strip inside the composer and plain text submission becomes the answer. Single
 * pick chips answer immediately; multi-pick chips toggle until Enter/Done commits.
 */
export function createComposerQuestion(input: {
  request: Accessor<QuestionRequest | undefined>
  text: () => string
  clearText: () => void
  refocus?: () => void
  onSubmit?: () => void
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  let replied = false

  const [store, setStore] = createStore({
    id: undefined as string | undefined,
    tab: 0,
    answers: [] as QuestionAnswer[],
  })

  const cacheKey = () => {
    const request = input.request()
    return request ? ScopedKey.from(serverSDK().scope, request.id) : undefined
  }

  const stash = (id: string | undefined) => {
    if (!id || replied) return
    cache.set(ScopedKey.from(serverSDK().scope, id), {
      tab: store.tab,
      answers: store.answers.map((answer) => [...answer]),
    })
  }

  createEffect(
    on(
      () => input.request()?.id,
      (id, prev) => {
        if (id === store.id) return
        stash(prev)
        replied = false
        const cached = id ? cache.get(ScopedKey.from(serverSDK().scope, id)) : undefined
        setStore({ id, tab: cached?.tab ?? 0, answers: cached?.answers.map((answer) => [...answer]) ?? [] })
      },
    ),
  )

  onCleanup(() => stash(store.id))

  const fail = (err: unknown) => {
    showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) => {
      const request = input.request()
      if (!request) return Promise.reject(new Error("question request is gone"))
      return sdk().client.v2.session.question.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        questionV2Reply: { answers },
      })
    },
    onMutate: () => input.onSubmit?.(),
    onSuccess: () => {
      replied = true
      const key = cacheKey()
      if (key) cache.delete(key)
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => {
      const request = input.request()
      if (!request) return Promise.reject(new Error("question request is gone"))
      return sdk().client.v2.session.question.reject({ sessionID: request.sessionID, requestID: request.id })
    },
    onMutate: () => input.onSubmit?.(),
    onSuccess: () => {
      replied = true
      const key = cacheKey()
      if (key) cache.delete(key)
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const active = () => !!input.request() && !replied
  const questions = () => input.request()?.questions ?? []
  const answered = (tab: number) => (store.answers[tab]?.length ?? 0) > 0
  const total = () => questions().length
  const index = () => Math.min(store.tab, Math.max(0, total() - 1))
  const current = () => questions()[index()]
  const multi = () => current()?.multiple === true
  const picked = (label: string) => store.answers[index()]?.includes(label) ?? false
  const hasAnswer = () => answered(index())

  const submit = () => {
    if (!input.request() || sending() || replied) return
    void replyMutation.mutateAsync(questions().map((_, i) => store.answers[i] ?? []))
  }

  const advance = () => {
    if (index() >= total() - 1) {
      submit()
      return
    }
    setStore("tab", index() + 1)
    input.refocus?.()
  }

  const select = (label: string) => {
    if (sending() || replied) return
    if (multi()) {
      setStore("answers", index(), (current = []) =>
        current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
      )
      return
    }
    setStore("answers", index(), [label])
    advance()
  }

  /** Enter in the composer: consume the draft as a custom answer, else commit picks. */
  const commit = () => {
    if (sending() || replied || !current()) return
    const value = input.text().trim()
    if (value) {
      setStore("answers", index(), (current = []) => (multi() ? [...new Set([...current, value])] : [value]))
      input.clearText()
      advance()
      return
    }
    if (hasAnswer()) advance()
  }

  const next = () => {
    if (sending() || replied || !hasAnswer()) return
    advance()
  }

  const jump = (tab: number) => {
    if (sending() || replied || tab < 0 || tab >= total()) return
    setStore("tab", tab)
    input.refocus?.()
  }

  const dismiss = () => {
    if (sending() || replied) return
    void rejectMutation.mutateAsync()
  }

  return {
    active,
    current,
    questions,
    index,
    total,
    answered,
    multi,
    picked,
    hasAnswer,
    sending,
    select,
    commit,
    next,
    jump,
    dismiss,
  }
}

export type ComposerQuestion = ReturnType<typeof createComposerQuestion>

export function ComposerQuestionStrip(props: { state: ComposerQuestion }) {
  const language = useLanguage()

  return (
    <Show when={props.state.active() && props.state.current()} keyed>
      {(question) => (
        <div data-component="composer-question" class="px-4 pt-3">
          <div class="flex items-baseline gap-2">
            <span class="shrink-0 font-mono text-[12px] leading-5 text-v2-text-text-accent" aria-hidden="true">
              ?
            </span>
            <span class="min-w-0 flex-1 text-[13px] leading-5 text-v2-text-text-base">{question.question}</span>
            <span class="flex shrink-0 items-center gap-2 whitespace-nowrap text-[10px] leading-5 text-v2-text-text-faint">
              <Show when={props.state.total() > 1}>
                <span class="flex items-center gap-1">
                  <For each={props.state.questions()}>
                    {(_, i) => (
                      <button
                        type="button"
                        class="size-1.5 rounded-full transition-colors hover:bg-v2-icon-icon-muted"
                        classList={{
                          "bg-v2-icon-icon-accent": i() === props.state.index(),
                          "bg-v2-icon-icon-muted": i() !== props.state.index() && props.state.answered(i()),
                          "bg-v2-background-bg-layer-03": i() !== props.state.index() && !props.state.answered(i()),
                        }}
                        onClick={() => props.state.jump(i())}
                        aria-label={`${language.t("ui.common.question.one")} ${i() + 1}`}
                      />
                    )}
                  </For>
                </span>
              </Show>
              {language.t(
                props.state.multi() ? "session.question.composer.hintMulti" : "session.question.composer.hint",
              )}
            </span>
          </div>
          <Show when={question.options.length > 0 || props.state.multi()}>
            <div
              class="mt-2 flex flex-wrap items-center gap-1.5"
              role={props.state.multi() ? "group" : "radiogroup"}
              aria-label={question.question}
            >
              <For each={question.options}>
                {(option) => (
                  <button
                    type="button"
                    data-slot="composer-question-chip"
                    data-picked={props.state.picked(option.label) || undefined}
                    role={props.state.multi() ? "checkbox" : "radio"}
                    aria-checked={props.state.picked(option.label)}
                    disabled={props.state.sending()}
                    title={option.description}
                    class="rounded-full border border-v2-border-border-base px-3 py-1 font-mono text-[11px] leading-4 text-v2-text-text-muted transition-colors hover:border-v2-border-border-strong hover:text-v2-text-text-base"
                    classList={{
                      "!border-[var(--v2-icon-icon-accent)] !text-v2-text-text-accent": props.state.picked(
                        option.label,
                      ),
                    }}
                    onClick={() => props.state.select(option.label)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
              <Show when={props.state.multi()}>
                <button
                  type="button"
                  data-slot="composer-question-done"
                  disabled={props.state.sending() || !props.state.hasAnswer()}
                  class="flex items-center gap-1 rounded-full border border-v2-border-border-base px-3 py-1 font-mono text-[11px] leading-4 text-v2-text-text-muted transition-colors enabled:hover:border-v2-border-border-strong enabled:hover:text-v2-text-text-base disabled:opacity-40"
                  onClick={props.state.next}
                >
                  {language.t("session.question.composer.done")}
                  <Icon name="enter" size="small" />
                </button>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
