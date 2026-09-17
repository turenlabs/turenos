import type { ExtensionItem, ExtensionMcp, ExtensionSkill } from "@turenlabs/sdk/v2/client"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@turenlabs/ui/v2/dialog-v2"
import { Icon } from "@turenlabs/ui/v2/icon"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useSettingsDialog } from "@/components/settings-dialog"
import { PageHeader } from "@/components/page-header"
import {
  catalogHomepage,
  extensionAction,
  extensionCategories,
  extensionCategory,
  extensionCategoryLabel,
  dataForgeExtension,
  directOAuthConnect,
  extensionSortOptions,
  extensionStatusFilters,
  filterExtensionItems,
  sortExtensionItems,
  type ExtensionCategory,
  type ExtensionKind,
  type ExtensionSort,
  type ExtensionStatusFilter,
} from "./extend-model"
import { ExtensionLogo } from "./extend-logo"

const tabs = {
  skills: "Skills / Subagents",
  mcp: "MCP",
  data: "Data",
} as const

type ExtendTab = keyof typeof tabs

const traceCatalog = (phase: string, fields: Record<string, unknown>) =>
  console.info("[developer-catalog]", { phase, ...fields })

const selectedTab = (value: unknown, kind: unknown): ExtendTab => {
  if (value === "mcp" || kind === "mcp") return "mcp"
  if (value === "data" || kind === "data") return "data"
  return "skills"
}

const statusLabel = (status: ExtensionItem["status"]) =>
  status
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")

const activeStatus = (item: ExtensionItem) =>
  item.status === "connected" || (item.enabled && item.status === "available")

const displayStatus = (item: ExtensionItem) => {
  if (item.enabled && item.status === "available") return "Enabled"
  return statusLabel(item.status)
}

const extensionIcon = (
  item: ExtensionItem,
): "workspace" | "terminal" | "archive" | "skills" | "status" | "branch" | "monitor" | "review" => {
  if (item.manifest.contributions.some((contribution) => contribution.type === "skill")) return "skills"
  if (item.manifest.contributions.some((contribution) => contribution.type === "data")) return "archive"
  if (!item.manifest.contributions.some((contribution) => contribution.type === "mcp")) return "terminal"
  const category = extensionCategory(item)
  if (category === "vulnerability-intelligence" || category === "incident-response") return "review"
  if (category === "threat-intelligence" || category === "security-operations" || category === "observability")
    return "status"
  if (category === "security-knowledge") return "archive"
  if (category === "application-security" || category === "software-engineering") return "branch"
  if (category === "supply-chain") return "archive"
  if (category === "identity-access") return "monitor"
  return "workspace"
}

const capabilityLabel = (value: string) => value.replace(/^mcp_[a-z]+_/, "").replaceAll(/[-_]+/g, " ")

const extensionMcps = (item: ExtensionItem) =>
  item.manifest.contributions.filter((contribution): contribution is ExtensionMcp => contribution.type === "mcp")

const extensionSkills = (item: ExtensionItem) =>
  item.manifest.contributions.filter((contribution): contribution is ExtensionSkill => contribution.type === "skill")

const skillKind = (skill: ExtensionSkill) => (skill.agent ? "Subagent" : "Skill")

const skillProfile = (skill: ExtensionSkill) => {
  if (skill.agent?.profile === "data") return "Read + Data"
  if (skill.agent?.profile === "binary") return "Static analysis"
  return "Read-only"
}

const skillContent = (skill: ExtensionSkill) => (skill.source.type === "catalog" ? skill.source.content : undefined)

const cardActionLabel = (item: ExtensionItem) => {
  if (!item.mutable) return "View details"
  if (item.installed === false) return "Install"
  if (directOAuthConnect(item)) return "Connect"
  return item.enabled ? "Manage" : "Configure"
}

const extensionMcpTools = (item: ExtensionItem) => [
  ...new Set(extensionMcps(item).flatMap((contribution) => contribution.tools.allow)),
]

const extensionMcpAuthentication = (item: ExtensionItem) => {
  const authentication = extensionMcps(item)[0]?.authentication
  if (authentication === "oauth") return "OAuth"
  if (authentication === "key") return "API key"
  if (authentication === "client-credentials") return "Client credentials"
  if (authentication === "desktop") return "Desktop auth"
  return "No credentials"
}

const extensionMcpDeployment = (item: ExtensionItem) => {
  const deployment = extensionMcps(item)[0]?.deployment
  if (!deployment) return undefined
  if (deployment.type === "customer-url") return "Customer endpoint"
  return deployment.type === "hosted" ? "Hosted" : "Local"
}

const extensionConfiguration = (item: ExtensionItem) => [
  ...new Map(
    item.manifest.contributions
      .flatMap((contribution) =>
        "configuration" in contribution && Array.isArray(contribution.configuration) ? contribution.configuration : [],
      )
      .map((field) => [field.id, field]),
  ).values(),
]

const extensionSecrets = (item: ExtensionItem) => [
  ...new Map(
    item.manifest.contributions.flatMap((contribution) => contribution.secrets).map((secret) => [secret.id, secret]),
  ).values(),
]

const filterSelectClass =
  "h-8 rounded-[7px] border-0 bg-v2-background-bg-layer-01 px-2 text-[11px] text-v2-text-text-base outline-none [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] focus:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-focus)]"

export default function ExtendPage() {
  const dialog = useDialog()
  const serverSdk = useServerSDK()
  const showSubagents = useSettingsDialog("agents")
  const params = useParams<{ view?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  let listRequest: AbortController | undefined
  let listGeneration = 0
  const [catalog, { mutate, refetch }] = createResource(
    () => serverSdk(),
    async (sdk) => {
      const operationID = crypto.randomUUID()
      const startedAt = performance.now()
      traceCatalog("catalog.load.started", { operationID })
      listRequest?.abort()
      const request = new AbortController()
      const generation = ++listGeneration
      listRequest = request
      try {
        const response = await sdk.client.extension.list(undefined, {
          signal: request.signal,
          throwOnError: true,
        })
        if (generation !== listGeneration || sdk !== serverSdk()) throw new DOMException("Stale request", "AbortError")
        const items = response.data ?? []
        traceCatalog("catalog.load.completed", {
          operationID,
          itemCount: items.length,
          durationMs: Math.round(performance.now() - startedAt),
        })
        return { sdk, items }
      } catch (cause) {
        traceCatalog("catalog.load.failed", {
          operationID,
          error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "Unknown catalog load error",
          durationMs: Math.round(performance.now() - startedAt),
        })
        throw cause
      } finally {
        if (listRequest === request) listRequest = undefined
      }
    },
  )
  const [search, setSearch] = createSignal(typeof location.query.q === "string" ? location.query.q : "")
  const [category, setCategory] = createSignal<ExtensionCategory>("all")
  const [status, setStatus] = createSignal<ExtensionStatusFilter>("all")
  const [sort, setSort] = createSignal<ExtensionSort>("recommended")
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [secrets, setSecrets] = createSignal<Record<string, string>>({})
  const requests = new Set<AbortController>()
  createEffect(() => {
    serverSdk()
    requests.forEach((request) => request.abort())
    requests.clear()
    setPending(undefined)
    setError(undefined)
    setSecrets({})
  })
  onCleanup(() => {
    listGeneration += 1
    listRequest?.abort()
    requests.forEach((request) => request.abort())
  })
  const refresh = setInterval(() => {
    if (!pending() && !catalog.loading) void refetch()
  }, 10_000)
  onCleanup(() => clearInterval(refresh))

  const loaded = createMemo(() => {
    const current = catalog.latest
    return current?.sdk === serverSdk() ? current : undefined
  })
  const catalogError = createMemo(() => {
    const cause = catalog.error
    if (!cause || (cause instanceof DOMException && cause.name === "AbortError")) return undefined
    if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
      return cause.message
    }
    return "Could not load extensions"
  })
  const installed = createMemo(() => params.view === "installed" || location.pathname.endsWith("/installed"))
  const tab = createMemo(() => selectedTab(location.query.tab, location.query.kind))
  const tabKind = createMemo((): ExtensionKind | ReadonlyArray<ExtensionKind> => {
    const value = tab()
    if (value === "skills") return "skill"
    if (value === "mcp") return "mcp"
    return "data"
  })
  const items = createMemo(() => {
    const filtered = filterExtensionItems(loaded()?.items ?? [], {
      installed: installed(),
      kind: tabKind(),
      search: search(),
      category: category(),
      status: status(),
    })
    return sortExtensionItems(tab() === "data" ? filtered.filter(dataForgeExtension) : filtered, sort())
  })

  const navigateTab = (value: ExtendTab) => navigate(`/extend/${installed() ? "installed" : "catalog"}?tab=${value}`)

  const updateSecret = (extensionID: string, name: string, value: string) =>
    setSecrets((current) => ({ ...current, [`${extensionID}:${name}`]: value }))

  const toggle = async (item: ExtensionItem) => {
    const sdk = loaded()?.sdk
    const contribution = item.manifest.contributions[0]
    const action = extensionAction(item, secrets())
    if (!sdk || sdk !== serverSdk() || !contribution || !item.mutable || !action || action.blocked || pending())
      return false
    if (
      item.manifest.contributions.some((contribution) => "localOnly" in contribution && contribution.localOnly) &&
      !ServerConnection.local(sdk.server)
    )
      return false
    if (action.missingRequired) {
      setError(`Enter the required credentials for ${item.manifest.name}`)
      return false
    }
    const request = new AbortController()
    const operationID = crypto.randomUUID()
    const startedAt = performance.now()
    requests.add(request)
    setPending(item.manifest.id)
    setError(undefined)
    traceCatalog("extension.update.requested", {
      operationID,
      extensionID: item.manifest.id,
      action: action.label,
      enabled: action.payload.enabled,
      connect: action.payload.connect === true,
    })
    try {
      const result = await sdk.client.extension.update(
        {
          id: item.manifest.id,
          extensionUpdate: { ...action.payload, operationID },
        },
        { signal: request.signal, throwOnError: true },
      )
      if (sdk !== serverSdk()) return false
      mutate({ sdk, items: result.data ?? [] })
      traceCatalog("extension.update.completed", {
        operationID,
        extensionID: item.manifest.id,
        itemCount: result.data?.length ?? 0,
        durationMs: Math.round(performance.now() - startedAt),
      })
      setSecrets((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${item.manifest.id}:`))),
      )
      return true
    } catch (cause) {
      if (sdk === serverSdk() && !(cause instanceof DOMException && cause.name === "AbortError")) {
        const message =
          cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
            ? cause.message
            : `Could not update ${item.manifest.name}`
        setError(message)
        traceCatalog("extension.update.failed", {
          operationID,
          extensionID: item.manifest.id,
          error: message,
          durationMs: Math.round(performance.now() - startedAt),
        })
      }
      return false
    } finally {
      requests.delete(request)
      if (sdk === serverSdk()) setPending(undefined)
      traceCatalog("extension.update.settled", {
        operationID,
        extensionID: item.manifest.id,
        durationMs: Math.round(performance.now() - startedAt),
      })
    }
  }

  const openExtension = (item: ExtensionItem) => {
    setError(undefined)
    void dialog.show(
      () => (
        <ExtensionConfigDialog
          item={item}
          pending={pending}
          error={error}
          secrets={secrets}
          updateSecret={updateSecret}
          localServer={!!loaded()?.sdk && ServerConnection.local(loaded()!.sdk.server)}
          submit={() => toggle(item)}
        />
      ),
      undefined,
      () => pending() === undefined,
    )
  }

  return (
    <main class="flex h-full min-h-0 flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base">
      <PageHeader
        title="Extend"
        description="Add MCP servers, cybersecurity data, skills, and subagents."
        actions={
          <div class="flex rounded-[8px] bg-v2-background-bg-layer-01 p-0.5 [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
            <button
              type="button"
              class="rounded-[6px] px-3 py-1.5 text-[12px]"
              classList={{ "bg-v2-background-bg-layer-02": !installed() }}
              onClick={() => navigate(`/extend/catalog?tab=${tab()}`)}
            >
              Catalog
            </button>
            <button
              type="button"
              class="rounded-[6px] px-3 py-1.5 text-[12px]"
              classList={{ "bg-v2-background-bg-layer-02": installed() }}
              onClick={() => navigate(`/extend/installed?tab=${tab()}`)}
            >
              Installed
            </button>
          </div>
        }
      />

      <section class="flex shrink-0 flex-col gap-3 border-b border-v2-border-border-muted px-6 py-3">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex gap-1" role="group" aria-label="Extension type">
            <For each={Object.entries(tabs) as [ExtendTab, string][]}>
              {([value, label]) => (
                <button
                  type="button"
                  aria-pressed={tab() === value}
                  class="rounded-[7px] px-3 py-1.5 text-[11px] text-v2-text-text-muted"
                  classList={{ "bg-v2-background-bg-layer-02 text-v2-text-text-base": tab() === value }}
                  onClick={() => navigateTab(value)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <Show when={tab() === "skills"}>
            <button
              type="button"
              class="rounded-[7px] px-3 py-1.5 text-[11px] text-v2-text-text-muted [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
              onClick={showSubagents}
            >
              Manage local subagents
            </button>
          </Show>
          <div class="relative min-w-[220px] flex-1">
            <Icon name="magnifying-glass" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-v2-icon-icon-muted" />
            <input
              aria-label="Search extensions"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search extensions"
              class="h-8 w-full rounded-[7px] border-0 bg-v2-background-bg-layer-01 pl-8 pr-3 text-[12px] outline-none [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] focus:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-focus)]"
            />
          </div>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-1 text-[10px] text-v2-text-text-muted">
            Focus
            <select
              aria-label="Security focus"
              value={category()}
              onChange={(event) => setCategory(event.currentTarget.value as ExtensionCategory)}
              class={filterSelectClass}
            >
              <For each={extensionCategories}>{(option) => <option value={option.value}>{option.label}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[10px] text-v2-text-text-muted">
            Status
            <select
              aria-label="Extension status"
              value={status()}
              onChange={(event) => setStatus(event.currentTarget.value as ExtensionStatusFilter)}
              class={filterSelectClass}
            >
              <For each={extensionStatusFilters}>
                {(option) => <option value={option.value}>{option.label}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[10px] text-v2-text-text-muted">
            Sort
            <select
              aria-label="Sort extensions"
              value={sort()}
              onChange={(event) => setSort(event.currentTarget.value as ExtensionSort)}
              class={filterSelectClass}
            >
              <For each={extensionSortOptions}>{(option) => <option value={option.value}>{option.label}</option>}</For>
            </select>
          </label>
          <span aria-live="polite" class="pb-2 text-[11px] text-v2-text-text-muted">
            {items().length} {items().length === 1 ? "extension" : "extensions"}
          </span>
        </div>
      </section>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <Show when={error()}>
          {(message) => (
            <div role="alert" class="mb-4 text-[12px] text-v2-state-fg-danger">
              {message()}
            </div>
          )}
        </Show>
        <Show when={catalogError()}>
          {(message) => (
            <div role="alert" class="mb-4 text-[12px] text-v2-state-fg-danger">
              {message()}
            </div>
          )}
        </Show>
        <Show when={loaded()} fallback={<div class="text-[12px] text-v2-text-text-muted">Loading extensions...</div>}>
          <Show
            when={items().length}
            fallback={
              <div class="rounded-[9px] bg-v2-background-bg-layer-01 p-8 text-center text-[12px] text-v2-text-text-muted [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
                No extensions match this view. Adjust focus, status, or search.
              </div>
            }
          >
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <For each={items()}>
                {(item) => {
                  const mcp = () => extensionMcps(item)[0]
                  const mcpTools = () => extensionMcpTools(item)
                  const skill = () => extensionSkills(item)[0]
                  return (
                    <button
                      type="button"
                      aria-busy={pending() === item.manifest.id}
                      onClick={() => {
                        const sdk = loaded()?.sdk
                        if (directOAuthConnect(item) && sdk && ServerConnection.local(sdk.server)) {
                          void toggle(item)
                          return
                        }
                        openExtension(item)
                      }}
                      class="group relative flex min-h-[176px] w-full flex-col overflow-hidden rounded-[11px] bg-v2-background-bg-layer-01 p-3.5 text-left transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:[box-shadow:inset_0_0_0_0.5px_var(--v2-state-fg-success),0_8px_22px_color-mix(in_srgb,var(--v2-background-bg-deep)_20%,transparent)] focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-state-fg-success)] [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] motion-reduce:transform-none motion-reduce:transition-none"
                    >
                      <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-v2-state-fg-success/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                      <div class="flex items-start gap-2.5">
                        <ExtensionLogo item={item} fallback={extensionIcon(item)} />
                        <span class="min-w-0 flex-1 truncate pt-0.5 text-[12px] [font-weight:650]">
                          {item.manifest.name}
                        </span>
                        <span
                          class="flex shrink-0 items-center gap-1.5 rounded-full bg-v2-background-bg-base px-2 py-1 text-[9px] text-v2-text-text-muted"
                          classList={{ "text-v2-state-fg-success": activeStatus(item) }}
                        >
                          <span
                            class="size-1.5 rounded-full bg-v2-icon-icon-muted"
                            classList={{
                              "bg-v2-state-fg-success": activeStatus(item),
                              "bg-v2-state-fg-warning":
                                item.status === "needs-auth" ||
                                item.status === "needs-config" ||
                                item.status === "needs-install",
                              "bg-v2-state-fg-danger": item.status === "failed" || item.status === "unavailable",
                            }}
                          />
                          {displayStatus(item)}
                        </span>
                      </div>

                      <p class="mt-2.5 line-clamp-2 text-[11px] leading-[1.45] text-v2-text-text-muted">
                        {item.manifest.description}
                      </p>
                      <div class="mt-2.5 flex flex-wrap gap-1 text-[9px] text-v2-text-text-muted">
                        <span class="rounded-full bg-v2-background-bg-base px-2 py-0.5">
                          {extensionCategoryLabel(extensionCategory(item))}
                        </span>
                        <Show when={mcp()}>
                          <span class="rounded-full bg-v2-background-bg-base px-2 py-0.5">
                            {extensionMcpDeployment(item)}
                          </span>
                          <span class="rounded-full bg-v2-background-bg-base px-2 py-0.5">
                            {mcpTools().length} {mcpTools().length === 1 ? "tool" : "tools"}
                          </span>
                        </Show>
                        <Show when={skill()}>
                          {(value) => (
                            <>
                              <span class="rounded-full bg-v2-background-bg-base px-2 py-0.5">
                                {skillKind(value())}
                              </span>
                              <span class="rounded-full bg-v2-background-bg-base px-2 py-0.5">
                                {value().agent ? skillProfile(value()) : `${value().requires.length} requirements`}
                              </span>
                            </>
                          )}
                        </Show>
                      </div>
                      <div class="mt-auto flex items-center justify-between pt-3 text-[10px]">
                        <span class="text-v2-text-text-muted">{cardActionLabel(item)}</span>
                        <Icon
                          name="chevron-down"
                          class="size-3.5 -rotate-90 text-v2-icon-icon-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                        />
                      </div>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </main>
  )
}

function ExtensionField(props: {
  label: string
  type?: "text" | "password" | "url"
  value: string
  required?: boolean
  configured?: boolean
  placeholder?: string
  onInput: (value: string) => void
}) {
  return (
    <label class="block text-[10px] text-v2-text-text-muted">
      {props.label}
      <Show when={props.required}>
        <span class="ml-1">Required</span>
      </Show>
      <Show when={props.configured}>
        <span class="ml-1 text-v2-state-fg-success">Configured</span>
      </Show>
      <input
        type={props.type ?? "text"}
        autocomplete={props.type === "password" ? "off" : undefined}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        class="mt-1.5 h-9 w-full rounded-[7px] border-0 bg-v2-background-bg-layer-01 px-2.5 text-[12px] text-v2-text-text-base outline-none [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] focus:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-focus)]"
      />
    </label>
  )
}

function ExtensionConfigDialog(props: {
  item: ExtensionItem
  pending: () => string | undefined
  error: () => string | undefined
  secrets: () => Record<string, string>
  updateSecret: (extensionID: string, name: string, value: string) => void
  localServer: boolean
  submit: () => Promise<boolean>
}) {
  const dialog = useDialog()
  const mcps = () => extensionMcps(props.item)
  const mcpTools = () => extensionMcpTools(props.item)
  const skill = () => extensionSkills(props.item)[0]
  const customerUrl = () => mcps().find((mcp) => mcp.deployment.type === "customer-url")
  const configuration = () => extensionConfiguration(props.item)
  const declaredSecrets = () => extensionSecrets(props.item)
  const homepage = () => catalogHomepage(props.item.manifest.homepage)
  const action = () => extensionAction(props.item, props.secrets())
  const remoteBlocked = () =>
    props.item.manifest.contributions.some((contribution) => "localOnly" in contribution && contribution.localOnly) &&
    !props.localServer
  const busy = () => props.pending() !== undefined
  const submit = async () => {
    if (await props.submit()) dialog.close()
  }

  return (
    <Dialog size="large" containerClass="!h-[min(calc(100vh_-_16px),720px)] !w-[min(calc(100vw_-_16px),680px)]">
      <DialogHeader>
        <div class="flex min-w-0 items-center gap-3 pr-8">
          <ExtensionLogo item={props.item} fallback={extensionIcon(props.item)} size="dialog" />
          <DialogTitleGroup
            title={props.item.manifest.name}
            description={
              <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{extensionCategoryLabel(extensionCategory(props.item))}</span>
                <span aria-hidden="true">·</span>
                <span classList={{ "text-v2-state-fg-success": activeStatus(props.item) }}>
                  {displayStatus(props.item)}
                </span>
              </span>
            }
          />
        </div>
      </DialogHeader>
      <DialogBody class="min-h-0 flex-1 overscroll-contain overflow-y-auto px-4 py-4">
        <div class="flex flex-col gap-5">
          <section>
            <p class="text-[12px] leading-[1.55] text-v2-text-text-muted">{props.item.manifest.description}</p>
            <Show when={mcps().length > 0}>
              <div class="mt-3 flex flex-wrap gap-1.5 text-[10px] text-v2-text-text-muted">
                <span class="rounded-full bg-v2-background-bg-layer-01 px-2 py-1">
                  {extensionMcpDeployment(props.item)}
                </span>
                <span class="rounded-full bg-v2-background-bg-layer-01 px-2 py-1">
                  {extensionMcpAuthentication(props.item)}
                </span>
                <span class="rounded-full bg-v2-background-bg-layer-01 px-2 py-1">
                  {mcpTools().length} {mcpTools().length === 1 ? "tool" : "tools"}
                </span>
              </div>
            </Show>
            <Show when={skill()}>
              {(value) => (
                <div class="mt-3 flex flex-wrap gap-1.5 text-[10px] text-v2-text-text-muted">
                  <span class="rounded-full bg-v2-background-bg-layer-01 px-2 py-1">{skillKind(value())}</span>
                  <Show when={value().agent}>
                    <span class="rounded-full bg-v2-background-bg-layer-01 px-2 py-1">{skillProfile(value())}</span>
                  </Show>
                  <span class="rounded-full bg-v2-background-bg-layer-01 px-2 py-1">
                    v{props.item.manifest.version}
                  </span>
                </div>
              )}
            </Show>
          </section>

          <Show when={props.item.manifest.id === "turenlabs/automox"}>
            <section class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 text-[11px] leading-[1.45] text-v2-text-text-muted [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
              Recommended: Automox hosts and updates this MCP. Paste an org-scoped API key and TurenOS connects directly
              to the reviewed read-only capability set.
            </section>
          </Show>

          <Show when={props.item.manifest.id === "turenlabs/automox-local"}>
            <section class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 text-[11px] leading-[1.45] text-v2-text-text-muted [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
              TurenOS downloads checksum-verified uv 0.12.6, starts pinned automox-mcp 2.2.9, and keeps package and
              Python caches in TurenOS-managed storage. The server is forced into read-only mode.
            </section>
          </Show>

          <Show when={props.item.manifest.id === "turenlabs/crowdstrike-falcon"}>
            <section class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 text-[11px] leading-[1.45] text-v2-text-text-muted [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
              TurenOS downloads checksum-verified uv 0.12.6, starts pinned falcon-mcp 0.16.1, and always passes the
              vendor --read-only control.
            </section>
          </Show>

          <Show when={props.item.detail}>
            {(detail) => (
              <p
                class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 text-[11px] leading-[1.45] text-v2-text-text-muted"
                classList={{
                  "text-v2-state-fg-danger": props.item.status === "failed" || props.item.status === "unavailable",
                  "text-v2-state-fg-warning":
                    props.item.status === "needs-auth" ||
                    props.item.status === "needs-config" ||
                    props.item.status === "needs-install",
                }}
              >
                {detail()}
              </p>
            )}
          </Show>

          <Show when={props.item.mutable && (customerUrl() || configuration().length || declaredSecrets().length)}>
            <section data-component="extension-configuration" class="flex flex-col gap-3">
              <div>
                <h3 class="text-[12px] [font-weight:650]">Configuration</h3>
                <p class="mt-0.5 text-[10px] text-v2-text-text-muted">
                  Enter connection details here. Existing credentials stay unchanged when fields are left blank.
                </p>
              </div>

              <Show when={customerUrl()}>
                <ExtensionField
                  label="MCP server URL"
                  type="url"
                  value={props.secrets()[`${props.item.manifest.id}:endpoint`] ?? ""}
                  configured={props.item.configurationSet.endpoint}
                  placeholder="https://mcp.example.com"
                  onInput={(value) => props.updateSecret(props.item.manifest.id, "endpoint", value)}
                />
              </Show>

              <For each={configuration()}>
                {(field) => (
                  <ExtensionField
                    label={field.label}
                    value={props.secrets()[`${props.item.manifest.id}:${field.id}`] ?? ""}
                    required={field.required}
                    configured={props.item.configurationSet[field.id]}
                    onInput={(value) => props.updateSecret(props.item.manifest.id, field.id, value)}
                  />
                )}
              </For>

              <For each={declaredSecrets()}>
                {(secret) => (
                  <ExtensionField
                    label={secret.label}
                    type="password"
                    value={props.secrets()[`${props.item.manifest.id}:${secret.id}`] ?? ""}
                    required={secret.required}
                    configured={props.item.secretsSet[secret.id]}
                    onInput={(value) => props.updateSecret(props.item.manifest.id, secret.id, value)}
                  />
                )}
              </For>
            </section>
          </Show>

          <Show when={mcpTools().length > 0}>
            <details
              data-component="extension-capabilities"
              class="group rounded-[8px] bg-v2-background-bg-layer-01 [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
            >
              <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[11px] [font-weight:650] text-v2-text-text-base">
                <span class="flex-1">Capabilities</span>
                <span class="text-[10px] font-normal text-v2-text-text-muted">{mcpTools().length} tools</span>
                <span aria-hidden="true" class="text-v2-text-text-muted group-open:rotate-90">
                  ›
                </span>
              </summary>
              <div class="max-h-52 overflow-y-auto border-t border-v2-border-border-muted px-3 py-2.5">
                <div class="flex flex-wrap gap-1.5">
                  <For each={mcpTools()}>
                    {(tool) => (
                      <span
                        title={tool}
                        class="rounded-[6px] bg-v2-background-bg-layer-02 px-2 py-1 text-[10px] text-v2-text-text-muted"
                      >
                        {capabilityLabel(tool)}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </details>
          </Show>

          <Show when={skill()}>
            {(value) => (
              <>
                <section class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
                  <p class="text-[11px] [font-weight:650] text-v2-text-text-base">
                    {value().agent ? "Fixed-profile subagent" : "Prompt-only skill"}
                  </p>
                  <p class="mt-1 text-[11px] leading-[1.45] text-v2-text-text-muted">
                    {value().agent
                      ? "The catalog supplies instructions only. TurenOS constructs the read-only profile and does not accept commands, credentials, model overrides, write roots, or permission rules from the manifest."
                      : "Skill content adds instructions to the current conversation. It cannot grant tools, credentials, filesystem access, or network authority."}
                  </p>
                  <p class="mt-2 text-[11px] leading-[1.45] text-v2-text-text-muted">
                    Vigil scans this prompt package locally before installation. TurenOS downloads and verifies the
                    pinned scanner runtime automatically on the first scan.
                  </p>
                </section>

                <Show when={value().requires.length > 0}>
                  <section>
                    <p class="mb-2 text-[10px] uppercase tracking-[0.1em] text-v2-text-text-muted">
                      Expected capabilities
                    </p>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={value().requires}>
                        {(requirement) => (
                          <span
                            title={requirement}
                            class="rounded-[6px] bg-v2-background-bg-layer-01 px-2 py-1 text-[10px] text-v2-text-text-muted"
                          >
                            {capabilityLabel(requirement)}
                          </span>
                        )}
                      </For>
                    </div>
                  </section>
                </Show>

                <Show when={skillContent(value())}>
                  {(content) => (
                    <details class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
                      <summary class="cursor-pointer text-[11px] [font-weight:650] text-v2-text-text-base">
                        Review instructions
                      </summary>
                      <p class="mt-2 whitespace-pre-wrap text-[11px] leading-[1.55] text-v2-text-text-muted">
                        {content()}
                      </p>
                    </details>
                  )}
                </Show>
              </>
            )}
          </Show>

          <Show when={remoteBlocked()}>
            <p class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5 text-[11px] leading-[1.45] text-v2-state-fg-warning">
              This extension can only be configured from a local TurenOS server.
            </p>
          </Show>

          <Show when={props.error()}>
            {(message) => (
              <p role="alert" class="text-[11px] text-v2-state-fg-danger">
                {message()}
              </p>
            )}
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Show when={homepage()}>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noreferrer"
              class="mr-auto flex items-center gap-1 text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base"
            >
              Documentation
              <Icon name="outline-square-arrow" class="size-3" />
            </a>
          )}
        </Show>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          Close
        </ButtonV2>
        <Show when={props.item.mutable && action()}>
          <ButtonV2
            variant={action()?.label === "Disable" ? "danger" : "contrast"}
            disabled={busy() || remoteBlocked() || action()?.missingRequired || action()?.blocked}
            aria-busy={props.pending() === props.item.manifest.id}
            onClick={() => void submit()}
          >
            {props.pending() === props.item.manifest.id
              ? skill()
                ? "Scanning & installing..."
                : "Working..."
              : (action()?.label ?? "Update")}
          </ButtonV2>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
