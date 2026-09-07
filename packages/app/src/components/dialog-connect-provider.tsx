import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@turenlabs/sdk/v2/client"
import { Button } from "@turenlabs/ui/button"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { Dialog } from "@turenlabs/ui/dialog"
import { Icon } from "@turenlabs/ui/icon"
import { IconButton } from "@turenlabs/ui/icon-button"
import { List, type ListRef } from "@turenlabs/ui/list"
import { ProviderIcon } from "@turenlabs/ui/provider-icon"
import { Spinner } from "@turenlabs/ui/spinner"
import { Tag } from "@turenlabs/ui/tag"
import { TextField } from "@turenlabs/ui/text-field"
import { showToast } from "@/utils/toast"
import { Link } from "@/components/link"
import {
  type Accessor,
  type Component,
  createEffect,
  createMemo,
  createResource,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { ServerSDKProvider, useServerSDK } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { useProviderConnection } from "@/hooks/use-provider-connection"
import { CustomProviderForm } from "./dialog-custom-provider"

const CUSTOM_ID = "_custom"

export function useProviderConnectController(options: { onBack?: () => void } = {}) {
  const serverSDK = useServerSDK()
  const [store, setStore] = createStore({
    selected: undefined as string | undefined,
    server: serverSDK().server,
  })
  const reset = () => setStore("selected", undefined)

  return {
    get server() {
      return store.server
    },
    selected: () => store.selected,
    select(provider?: string) {
      setStore({ selected: provider, server: serverSDK().server })
    },
    back: options.onBack ?? reset,
  }
}

export const DialogConnectProvider: Component<{
  directory?: Accessor<string | undefined>
  controller?: ReturnType<typeof useProviderConnectController>
}> = (props) => {
  const fallback = useProviderConnectController()
  const controller = props.controller ?? fallback
  return (
    <ServerSDKProvider server={() => controller.server}>
      <ServerSyncProvider server={() => controller.server}>
        <DialogConnectProviderContent directory={props.directory} controller={controller} />
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

const DialogConnectProviderContent: Component<{
  directory?: Accessor<string | undefined>
  controller: ReturnType<typeof useProviderConnectController>
}> = (props) => {
  const controller = props.controller
  const language = useLanguage()
  const reset = controller.back
  const back = { current: reset }
  const select = (provider?: string) => {
    back.current = reset
    controller.select(provider)
  }

  return (
    <Dialog
      class="h-full"
      transition
      title={
        <Show when={controller.selected()} fallback={language.t("command.provider.connect")}>
          <IconButton
            tabIndex={-1}
            icon="arrow-left"
            variant="ghost"
            onClick={() => back.current()}
            aria-label={language.t("common.goBack")}
          />
        </Show>
      }
    >
      <Switch>
        <Match when={controller.selected() === CUSTOM_ID}>
          <CustomProviderForm />
        </Match>
        <Match when={controller.selected() && controller.selected() !== CUSTOM_ID ? controller.selected() : undefined}>
          {(provider) => (
            <ProviderConnection
              provider={provider()}
              directory={props.directory}
              onBack={reset}
              setBack={(handler) => (back.current = handler)}
            />
          )}
        </Match>
        <Match when={true}>
          <ProviderPicker directory={props.directory} onSelect={select} />
        </Match>
      </Switch>
    </Dialog>
  )
}

function ProviderPicker(props: { directory?: Accessor<string | undefined>; onSelect: (provider: string) => void }) {
  const providers = useProviders(props.directory)
  const connection = useProviderConnection()
  const language = useLanguage()
  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const note = (id: string) => {
    if (id === "anthropic") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id.startsWith("github-copilot")) return language.t("dialog.provider.copilot.note")
    return undefined
  }

  return (
    <List
      class="px-3"
      search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
      emptyMessage={language.t("dialog.provider.empty")}
      activeIcon="plus-small"
      key={(x) => x?.id}
      items={() => {
        language.locale()
        const excluded = new Set(connection.excluded())
        return [
          { id: CUSTOM_ID, name: customLabel() },
          ...[...providers.all().values()].filter((provider) => !excluded.has(provider.id)),
        ]
      }}
      filterKeys={["id", "name"]}
      groupBy={(x) => (popularProviders.includes(x.id) ? popularGroup() : otherGroup())}
      sortBy={(a, b) => {
        if (a.id === CUSTOM_ID) return -1
        if (b.id === CUSTOM_ID) return 1
        if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
          return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
        return a.name.localeCompare(b.name)
      }}
      sortGroupsBy={(a, b) => {
        const popular = popularGroup()
        if (a.category === popular && b.category !== popular) return -1
        if (b.category === popular && a.category !== popular) return 1
        return 0
      }}
      onSelect={(x) => {
        if (!x) return
        props.onSelect(x.id)
      }}
    >
      {(i) => (
        <div class="px-1.25 w-full flex items-center gap-x-3">
          <ProviderIcon data-slot="list-item-extra-icon" id={i.id} />
          <span>{i.name}</span>
          <Show when={i.id === CUSTOM_ID}>
            <Tag>{language.t("settings.providers.tag.custom")}</Tag>
          </Show>
          <Show when={note(i.id)}>{(value) => <div class="text-14-regular text-text-weak">{value()}</div>}</Show>
        </div>
      )}
    </List>
  )
}

function ProviderConnection(props: {
  provider: string
  directory?: Accessor<string | undefined>
  onBack: () => void
  setBack: (handler: () => void) => void
}) {
  if (props.provider === "claude-code" || props.provider === "muse-code") return <LocalCliConnection {...props} />

  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const providers = useProviders(props.directory)
  const connection = useProviderConnection()

  const alive = { value: true }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    alive.value = false
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const provider = createMemo(
    () => providers.all().get(props.provider) ?? serverSync().data.provider.all.get(props.provider),
  )
  const providerName = createMemo(() => provider()?.name ?? props.provider)
  const fallback = createMemo<ProviderAuthMethod[]>(() => [
    {
      type: "api" as const,
      label: language.t("provider.connect.method.apiKey"),
    },
  ])
  const [auth] = createResource(
    () => props.provider,
    async () => {
      const cached = serverSync().data.provider_auth[props.provider]
      if (cached) return cached
      const res = await serverSDK().client.provider.auth()
      if (!alive.value) return fallback()
      serverSync().set("provider_auth", res.data ?? {})
      return res.data?.[props.provider] ?? fallback()
    },
  )
  const loading = createMemo(() => auth.loading && !serverSync().data.provider_auth[props.provider])
  const methods = createMemo(() => auth.latest ?? serverSync().data.provider_auth[props.provider] ?? fallback())
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    promptInputs: undefined as undefined | Record<string, string>,
    state: "pending" as undefined | "pending" | "complete" | "error" | "prompt",
    error: undefined as string | undefined,
  })

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.inputs"; inputs: Record<string, string> }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: ProviderAuthAuthorization }
    | { type: "auth.error"; error: string }

  function dispatch(action: Action) {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.promptInputs = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.promptInputs = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.inputs") {
          draft.promptInputs = action.inputs
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))

  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "api") return language.t("provider.connect.method.apiKey")
    return value.label ?? ""
  }

  function formatError(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && "data" in value) {
      const data = (value as { data?: { message?: unknown } }).data
      if (typeof data?.message === "string" && data.message) return data.message
    }
    if (value && typeof value === "object" && "error" in value) {
      const nested = formatError((value as { error?: unknown }).error, "")
      if (nested) return nested
    }
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message
      if (typeof message === "string" && message) return message
    }
    if (value instanceof Error && value.message) return value.message
    if (typeof value === "string" && value) return value
    return fallback
  }

  async function selectMethod(index: number, inputs?: Record<string, string>) {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    const method = methods()[index]
    dispatch({ type: "method.select", index })

    if (method.type === "api" && method.prompts?.length) {
      if (!inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.inputs", inputs })
      return
    }

    if (method.type === "oauth") {
      if (method.prompts?.length && !inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.pending" })
      const start = Date.now()
      await serverSDK()
        .client.provider.oauth.authorize(
          {
            providerID: props.provider,
            method: index,
            inputs,
          },
          { throwOnError: true },
        )
        .then((x) => {
          if (!alive.value) return
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              if (!alive.value) return
              dispatch({ type: "auth.complete", authorization: x.data! })
            }, delay)
            return
          }
          dispatch({ type: "auth.complete", authorization: x.data! })
        })
        .catch((e) => {
          if (!alive.value) return
          dispatch({ type: "auth.error", error: formatError(e, language.t("common.requestFailed")) })
        })
    }
  }

  function AuthPromptsView() {
    const [formStore, setFormStore] = createStore({
      value: {} as Record<string, string>,
      index: 0,
    })

    const prompts = createMemo<NonNullable<ProviderAuthMethod["prompts"]>>(() => {
      const value = method()
      return value?.prompts ?? []
    })
    const matches = (prompt: NonNullable<ReturnType<typeof prompts>[number]>, value: Record<string, string>) => {
      if (!prompt.when) return true
      const actual = value[prompt.when.key]
      if (actual === undefined) return false
      return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
    }
    const current = createMemo(() => {
      const all = prompts()
      const index = all.findIndex((prompt, index) => index >= formStore.index && matches(prompt, formStore.value))
      if (index === -1) return
      return {
        index,
        prompt: all[index],
      }
    })
    const valid = createMemo(() => {
      const item = current()
      if (!item || item.prompt.type !== "text") return false
      const value = formStore.value[item.prompt.key] ?? ""
      return value.trim().length > 0
    })

    async function next(index: number, value: Record<string, string>) {
      if (store.methodIndex === undefined) return
      const next = prompts().findIndex((prompt, i) => i > index && matches(prompt, value))
      if (next !== -1) {
        setFormStore("index", next)
        return
      }
      if (method()?.type === "api") {
        dispatch({ type: "auth.inputs", inputs: value })
        return
      }
      await selectMethod(store.methodIndex, value)
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      const item = current()
      if (!item || item.prompt.type !== "text") return
      if (!valid()) return
      await next(item.index, formStore.value)
    }

    const item = () => current()
    const text = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "text") return
      return prompt
    })
    const select = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "select") return
      return prompt
    })

    return (
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <Switch>
          <Match when={item()?.prompt.type === "text"}>
            <TextField
              type="text"
              label={text()?.message ?? ""}
              placeholder={text()?.placeholder}
              value={text() ? (formStore.value[text()!.key] ?? "") : ""}
              onChange={(value) => {
                const prompt = text()
                if (!prompt) return
                setFormStore("value", prompt.key, value)
              }}
            />
            <Button class="w-auto" type="submit" size="large" variant="primary" disabled={!valid()}>
              {language.t("common.continue")}
            </Button>
          </Match>
          <Match when={item()?.prompt.type === "select"}>
            <div class="w-full flex flex-col gap-1.5">
              <div class="text-14-regular text-text-base">{select()?.message}</div>
              <div>
                <List
                  class="px-3"
                  items={select()?.options ?? []}
                  key={(x) => x.value}
                  current={select()?.options.find((x) => x.value === formStore.value[select()!.key])}
                  onSelect={(value) => {
                    if (!value) return
                    const prompt = select()
                    if (!prompt) return
                    const nextValue = {
                      ...formStore.value,
                      [prompt.key]: value.value,
                    }
                    setFormStore("value", prompt.key, value.value)
                    void next(item()!.index, nextValue)
                  }}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{option.label}</span>
                      <span class="text-14-regular text-text-weak">{option.hint}</span>
                    </div>
                  )}
                </List>
              </div>
            </div>
          </Match>
        </Switch>
      </form>
    )
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  let auto = false
  createEffect(() => {
    if (auto) return
    if (loading()) return
    if (methods().length === 1) {
      auto = true
      void selectMethod(0)
    }
  })

  async function complete() {
    // A provider hidden from the picker must become visible after reconnecting.
    await connection.enable(props.provider)
    await serverSDK().client.global.dispose()
    await serverSync().refreshProviders()
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: providerName() }),
      description: language.t("provider.connect.toast.connected.description", { provider: providerName() }),
    })
  }

  function goBack() {
    if (methods().length > 1 && store.methodIndex !== undefined) {
      dispatch({ type: "method.reset" })
      return
    }
    props.onBack()
  }

  props.setBack(goBack)

  function MethodSelection() {
    return (
      <>
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.selectMethod", { provider: providerName() })}
        </div>
        <div>
          <List
            class="px-3"
            ref={(ref) => {
              listRef = ref
            }}
            items={methods}
            key={(m) => m?.label}
            onSelect={async (selected, index) => {
              if (!selected) return
              void selectMethod(index)
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-x-2">
                <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                  <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                </div>
                <span>{methodLabel(i)}</span>
              </div>
            )}
          </List>
        </div>
      </>
    )
  }

  function ApiAuthView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const apiKey = formData.get("apiKey") as string

      if (!apiKey?.trim()) {
        setFormStore("error", language.t("provider.connect.apiKey.required"))
        return
      }

      setFormStore("error", undefined)
      await serverSDK().client.auth.set({
        providerID: props.provider,
        auth: {
          type: "api",
          key: apiKey,
          ...(store.promptInputs ? { metadata: store.promptInputs } : {}),
        },
      })
      await complete()
    }

    return (
      <div class="flex flex-col gap-6">
        <Switch>
          <Match when={props.provider === "opencode"}>
            <div class="flex flex-col gap-4">
              <div class="text-14-regular text-text-base">{language.t("provider.connect.opencodeZen.line1")}</div>
              <div class="text-14-regular text-text-base">{language.t("provider.connect.opencodeZen.line2")}</div>
              <div class="text-14-regular text-text-base">
                {language.t("provider.connect.opencodeZen.visit.prefix")}
                <Link href="https://opencode.ai/zen" tabIndex={-1}>
                  {language.t("provider.connect.opencodeZen.visit.link")}
                </Link>
                {language.t("provider.connect.opencodeZen.visit.suffix")}
              </div>
            </div>
          </Match>
          <Match when={true}>
            <div class="text-14-regular text-text-base">
              {language.t("provider.connect.apiKey.description", { provider: providerName() })}
            </div>
          </Match>
        </Switch>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("provider.connect.apiKey.label", { provider: providerName() })}
            placeholder={language.t("provider.connect.apiKey.placeholder")}
            name="apiKey"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthCodeView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const code = formData.get("code") as string

      if (!code?.trim()) {
        setFormStore("error", language.t("provider.connect.oauth.code.required"))
        return
      }

      if (store.methodIndex === undefined) return
      setFormStore("error", undefined)
      const result = await serverSDK()
        .client.provider.oauth.callback({
          providerID: props.provider,
          method: store.methodIndex,
          code,
        })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      if (result.ok) {
        await complete()
        return
      }
      setFormStore("error", formatError(result.error, language.t("provider.connect.oauth.code.invalid")))
    }

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: providerName() })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
            placeholder={language.t("provider.connect.oauth.code.placeholder")}
            name="code"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthAutoView() {
    const code = createMemo(() => {
      const instructions = store.authorization?.instructions
      if (instructions?.includes(":")) {
        return instructions.split(":").pop()?.trim()
      }
      return instructions
    })

    onMount(() => {
      void (async () => {
        if (store.methodIndex === undefined) return
        const result = await serverSDK()
          .client.provider.oauth.callback({
            providerID: props.provider,
            method: store.methodIndex,
          })
          .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
          .catch((error) => ({ ok: false as const, error }))

        if (!alive.value) return

        if (!result.ok) {
          const message = formatError(result.error, language.t("common.requestFailed"))
          dispatch({ type: "auth.error", error: message })
          return
        }

        await complete()
      })()
    })

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.auto.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.auto.visit.link")}</Link>
          {language.t("provider.connect.oauth.auto.visit.suffix", { provider: providerName() })}
        </div>
        <TextField
          label={language.t("provider.connect.oauth.auto.confirmationCode")}
          class="font-mono"
          value={code()}
          readOnly
          copyable
        />
        <div class="text-14-regular text-text-base flex items-center gap-4">
          <Spinner />
          <span>{language.t("provider.connect.status.waiting")}</span>
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">
          <Switch>
            <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
              {language.t("provider.connect.title.anthropicProMax")}
            </Match>
            <Match when={true}>{language.t("provider.connect.title", { provider: providerName() })}</Match>
          </Switch>
        </div>
      </div>
      <div class="px-2.5 pb-10 flex flex-col gap-6">
        <div onKeyDown={handleKey} tabIndex={0} autofocus={store.methodIndex === undefined ? true : undefined}>
          <Switch>
            <Match when={loading()}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Spinner />
                  <span>{language.t("provider.connect.status.inProgress")}</span>
                </div>
              </div>
            </Match>
            <Match when={store.methodIndex === undefined}>
              <MethodSelection />
            </Match>
            <Match when={store.state === "pending"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Spinner />
                  <span>{language.t("provider.connect.status.inProgress")}</span>
                </div>
              </div>
            </Match>
            <Match when={store.state === "prompt"}>
              <AuthPromptsView />
            </Match>
            <Match when={store.state === "error"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                  <span>{language.t("provider.connect.status.failed", { error: store.error ?? "" })}</span>
                </div>
              </div>
            </Match>
            <Match when={method()?.type === "api"}>
              <ApiAuthView />
            </Match>
            <Match when={method()?.type === "oauth"}>
              <Switch>
                <Match when={store.authorization?.method === "code"}>
                  <OAuthCodeView />
                </Match>
                <Match when={store.authorization?.method === "auto"}>
                  <OAuthAutoView />
                </Match>
              </Switch>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}

function LocalCliConnection(props: { provider: string; onBack: () => void; setBack: (handler: () => void) => void }) {
  const dialog = useDialog()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const language = useLanguage()
  const connection = useProviderConnection()
  const [state, setState] = createStore({ pending: false, error: undefined as string | undefined })
  const muse = props.provider === "muse-code"
  const provider = muse ? "Muse Code (local)" : "Claude Code (local)"
  const notReady = () =>
    muse
      ? "Muse Code is not available. Install it, run muse login, then refresh."
      : language.t("provider.connect.claudeCode.notReady")

  props.setBack(props.onBack)

  const refresh = async () => {
    setState({ pending: true, error: undefined })
    try {
      await connection.enable(props.provider)
      await serverSDK().client.global.dispose()
      await serverSync().refreshProviders()
      if (!serverSync().data.provider.connected.includes(props.provider)) {
        setState({ pending: false, error: notReady() })
        return
      }
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider }),
        description: language.t("provider.connect.toast.connected.description", { provider }),
      })
    } catch (error) {
      setState({
        pending: false,
        error: error instanceof Error ? error.message : language.t("common.requestFailed"),
      })
    }
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">{language.t("provider.connect.title", { provider })}</div>
      </div>
      <div class="px-2.5 pb-10 flex flex-col items-start gap-4">
        <div class="text-14-regular text-text-base">
          {muse
            ? "Muse Code uses its own local login. Sign in with the command below, then refresh. No Meta API key is stored in TurenOS."
            : language.t("provider.connect.claudeCode.description")}
        </div>
        <TextField
          class="font-mono"
          label={language.t("provider.connect.claudeCode.command")}
          value={muse ? "muse login" : "claude auth login"}
          readOnly
          copyable
        />
        <Show when={state.error}>
          <div class="text-14-regular text-text-base flex items-center gap-x-2">
            <Icon name="circle-ban-sign" class="text-icon-critical-base" />
            <span>{state.error}</span>
          </div>
        </Show>
        <Button class="w-auto" size="large" variant="primary" disabled={state.pending} onClick={() => void refresh()}>
          <Show when={state.pending} fallback={language.t("common.refresh")}>
            <Spinner />
            {language.t("provider.connect.status.inProgress")}
          </Show>
        </Button>
      </div>
    </div>
  )
}
